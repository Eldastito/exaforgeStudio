import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { JWT_SECRET } from "./config/secret.js";
import { chat, isAIConfigured } from "./llm.js";
import { normalizeProductName } from "./productMatcher.js";
import { FashionStudioService } from "./FashionStudioService.js";
import { FashionAvatarService } from "./FashionAvatarService.js";

/**
 * Consultora por ocasião + Look Builder (Fashion AI Studio FAS-2, ADR-036).
 *
 * O motor de recomendação segue a regra 19.3 do PRD à risca (anti prompt
 * injection): a IA recebe o catálogo ELEGÍVEL (FAS-0) e só pode devolver IDs
 * dessa lista — TUDO que ela retorna é revalidado aqui, server-side:
 *   - ID desconhecido é descartado;
 *   - mais de 3 looks são cortados (RF-017);
 *   - look que estoura o orçamento declarado é descartado;
 *   - item cujo NOME contém uma cor/peça que a cliente pediu para evitar é
 *     descartado (checagem determinística por texto normalizado — a IA já é
 *     instruída a evitar, isto é a rede de segurança).
 * Sem IA configurada (ou saída inválida), um compositor DETERMINÍSTICO monta
 * looks simples dentro das regras — o provador nunca quebra por falta de IA.
 *
 * As respostas do questionário viram PREFERÊNCIAS EXPLÍCITAS editáveis
 * (seção 7.4/11.2: nunca "verdades permanentes" — a cliente lista, edita e
 * apaga; base da memória de estilo do FAS-5).
 */

export interface QuizAnswers {
  occasion: string;
  dayNight?: string | null;        // 'dia' | 'noite' | 'ambos'
  style?: string | null;           // discreto | clássico | elegante | ...
  colorsAvoid?: string[];
  piecesAvoid?: string[];
  budgetMax?: number | null;       // teto para o LOOK completo
}

interface EligibleItem { id: string; name: string; category: string | null; price: number; image: string | null; }
interface ComposedLook { items: { productId: string; role: string }[]; explanation: string; source: "ai_recommended" | "customer_selected"; }

const VALID_ROLES = new Set(["main", "bottom", "outerwear", "shoes", "accessory"]);
const MAX_LOOKS = 3;
const MAX_ITEMS_PER_LOOK = 5;

export class FashionLookService {
  // ---- perfil e preferências (7.4 / 11.2 / 11.4) ----

  static ensureProfile(orgId: string, customerId: string): string {
    const existing = db.prepare(`SELECT id FROM fashion_customer_profiles WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL`).get(orgId, customerId) as any;
    if (existing) return existing.id;
    const id = uuidv4();
    db.prepare(`INSERT INTO fashion_customer_profiles (id, organization_id, customer_id, personalization_enabled) VALUES (?, ?, ?, 1)`).run(id, orgId, customerId);
    return id;
  }

  /** Respostas do questionário viram preferências explícitas (substituem as anteriores do mesmo tipo, preservando histórico como inativo). */
  static savePreferencesFromAnswers(orgId: string, customerId: string, answers: QuizAnswers): void {
    const profileId = this.ensureProfile(orgId, customerId);
    const entries: { type: string; value: any }[] = [];
    if (answers.occasion) entries.push({ type: "occasion", value: answers.occasion });
    if (answers.style) entries.push({ type: "style_like", value: answers.style });
    for (const c of answers.colorsAvoid || []) entries.push({ type: "color_avoid", value: c });
    for (const p of answers.piecesAvoid || []) entries.push({ type: "fit_avoid", value: p });
    if (answers.budgetMax != null && answers.budgetMax > 0) entries.push({ type: "budget_range", value: { max: answers.budgetMax } });
    if (!entries.length) return;

    const types = [...new Set(entries.map((e) => e.type))];
    for (const t of types) {
      db.prepare(`UPDATE fashion_preferences SET active = 0 WHERE organization_id = ? AND profile_id = ? AND preference_type = ? AND active = 1`).run(orgId, profileId, t);
    }
    const ins = db.prepare(`INSERT INTO fashion_preferences (id, organization_id, profile_id, preference_type, value_json, source, active) VALUES (?, ?, ?, ?, ?, 'explicit', 1)`);
    for (const e of entries) ins.run(uuidv4(), orgId, profileId, e.type, JSON.stringify(e.value));
    FashionStudioService.recordEvent(orgId, "FashionPreferenceSaved", { types }, customerId);
  }

  static listPreferences(orgId: string, customerId: string): { id: string; type: string; value: any }[] {
    const profile = db.prepare(`SELECT id FROM fashion_customer_profiles WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL`).get(orgId, customerId) as any;
    if (!profile) return [];
    const rows = db.prepare(`SELECT id, preference_type, value_json FROM fashion_preferences WHERE organization_id = ? AND profile_id = ? AND active = 1 ORDER BY created_at DESC`).all(orgId, profile.id) as any[];
    return rows.map((r) => {
      let value: any = null;
      try { value = JSON.parse(r.value_json); } catch { /* noop */ }
      return { id: r.id, type: r.preference_type, value };
    });
  }

  static deletePreference(orgId: string, customerId: string, preferenceId: string): boolean {
    const profile = db.prepare(`SELECT id FROM fashion_customer_profiles WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL`).get(orgId, customerId) as any;
    if (!profile) return false;
    const r = db.prepare(`UPDATE fashion_preferences SET active = 0 WHERE id = ? AND organization_id = ? AND profile_id = ?`).run(preferenceId, orgId, profile.id);
    return r.changes > 0;
  }

  // ---- memória de estilo (FAS-5, ADR-039 — seção 11 do PRD) ----

  /** Personalização ligada? Sem perfil ainda = ligada (o primeiro questionário cria com o aceite). */
  static personalizationEnabled(orgId: string, customerId: string): boolean {
    const profile = db.prepare(`SELECT personalization_enabled FROM fashion_customer_profiles WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL`).get(orgId, customerId) as any;
    return profile ? !!profile.personalization_enabled : true;
  }

  /**
   * Desligar personalização (11.4): o sistema PARA de salvar e de usar a
   * memória — mas NÃO apaga nada (apagar é o outro controle, delete-all).
   * Religar volta a usar o que já existia.
   */
  static setPersonalization(orgId: string, customerId: string, enabled: boolean): void {
    const profileId = this.ensureProfile(orgId, customerId);
    db.prepare(`UPDATE fashion_customer_profiles SET personalization_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(enabled ? 1 : 0, profileId);
    if (enabled) {
      if (!FashionAvatarService.activeConsent(orgId, customerId, "personalization")) {
        FashionAvatarService.grantConsent(orgId, customerId, "personalization", "v1-2026-07");
      }
    } else {
      // Revoga só o consentimento de personalização — avatar não é afetado.
      db.prepare(`UPDATE fashion_consents SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND customer_id = ? AND consent_type = 'personalization' AND revoked_at IS NULL`).run(orgId, customerId);
      FashionStudioService.recordEvent(orgId, "FashionConsentRevoked", { consentType: "personalization" }, customerId);
    }
  }

  /**
   * Feedback explícito de look (11.2: gostei / não gostei / não usaria) —
   * vira sinal de memória com as CATEGORIAS das peças (nunca inferência de
   * atributo sensível, 11.3). Recusado com aviso quando a personalização
   * está desligada: sem aceite, nada é gravado.
   */
  static recordLookFeedback(orgId: string, customerId: string, lookId: string, verdict: string):
    { ok: true } | { ok: false; error: string } {
    if (!["liked", "disliked", "would_not_wear"].includes(verdict)) return { ok: false, error: "Feedback inválido." };
    const look = db.prepare(
      `SELECT fl.id FROM fashion_looks fl JOIN fashion_look_requests flr ON flr.id = fl.request_id
       WHERE fl.id = ? AND fl.organization_id = ? AND flr.customer_id = ?`
    ).get(lookId, orgId, customerId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };
    if (!this.personalizationEnabled(orgId, customerId)) {
      return { ok: false, error: "Sua personalização está desligada — ligue-a no seu perfil para o feedback contar nas próximas sugestões." };
    }
    const categories = (db.prepare(
      `SELECT DISTINCT ps.category FROM fashion_look_items fli JOIN products_services ps ON ps.id = fli.product_service_id
       WHERE fli.look_id = ? AND fli.organization_id = ? AND ps.category IS NOT NULL`
    ).all(lookId, orgId) as any[]).map((r) => r.category);

    const profileId = this.ensureProfile(orgId, customerId);
    // Um feedback por look: o mais recente substitui (a cliente mudou de ideia).
    db.prepare(`UPDATE fashion_preferences SET active = 0 WHERE organization_id = ? AND profile_id = ? AND preference_type = 'look_feedback' AND active = 1 AND value_json LIKE ?`)
      .run(orgId, profileId, `%"lookId":"${lookId}"%`);
    db.prepare(`INSERT INTO fashion_preferences (id, organization_id, profile_id, preference_type, value_json, source, active) VALUES (?, ?, ?, 'look_feedback', ?, 'feedback', 1)`)
      .run(uuidv4(), orgId, profileId, JSON.stringify({ lookId, verdict, categories }));
    FashionStudioService.recordEvent(orgId, "FashionPreferenceSaved", { types: ["look_feedback"], verdict }, customerId, lookId);
    return { ok: true };
  }

  /**
   * Resumo da memória observada (11.2): categorias curtidas/recusadas pelo
   * feedback + categorias COMPRADAS (pedidos com atribuição look->pedido do
   * FAS-4, encadeados até esta cliente). Determinístico e transparente —
   * exatamente o que alimenta o prompt da recomendação, nada além.
   */
  static styleMemorySummary(orgId: string, customerId: string): { likedCategories: string[]; rejectedCategories: string[]; purchasedCategories: string[] } {
    const profile = db.prepare(`SELECT id FROM fashion_customer_profiles WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL`).get(orgId, customerId) as any;
    const liked = new Set<string>(), rejected = new Set<string>();
    if (profile) {
      const rows = db.prepare(`SELECT value_json FROM fashion_preferences WHERE organization_id = ? AND profile_id = ? AND preference_type = 'look_feedback' AND active = 1`).all(orgId, profile.id) as any[];
      for (const r of rows) {
        try {
          const v = JSON.parse(r.value_json);
          for (const c of v.categories || []) {
            if (v.verdict === "liked") liked.add(c);
            else if (v.verdict === "would_not_wear") rejected.add(c);
          }
        } catch { /* noop */ }
      }
    }
    const purchased = (db.prepare(
      `SELECT DISTINCT ps.category
       FROM orders o
       JOIN fashion_looks fl ON fl.id = o.fashion_look_id
       JOIN fashion_look_requests flr ON flr.id = fl.request_id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products_services ps ON ps.id = oi.product_service_id
       WHERE o.organization_id = ? AND flr.customer_id = ? AND ps.category IS NOT NULL`
    ).all(orgId, customerId) as any[]).map((r) => r.category);
    return { likedCategories: [...liked], rejectedCategories: [...rejected], purchasedCategories: [...new Set(purchased)] };
  }

  // ---- filtros determinísticos (rede de segurança sobre a IA) ----

  /** O nome do item contém alguma palavra evitada (cor/peça)? Normalizado, sem acento. */
  static itemAllowed(itemName: string, answers: QuizAnswers): boolean {
    const name = ` ${normalizeProductName(itemName)} `;
    for (const word of [...(answers.colorsAvoid || []), ...(answers.piecesAvoid || [])]) {
      const w = normalizeProductName(String(word || ""));
      if (w && name.includes(` ${w}`)) return false;
    }
    return true;
  }

  private static lookTotal(items: { productId: string }[], byId: Map<string, EligibleItem>): number {
    return items.reduce((sum, it) => sum + (byId.get(it.productId)?.price || 0), 0);
  }

  /**
   * Valida a saída da IA (regra 19.3): só IDs do catálogo elegível, papéis
   * conhecidos, sem duplicata, ≤3 looks, ≤5 itens, orçamento e palavras
   * evitadas respeitados. Não-privado: testado diretamente com payloads
   * adversariais em scripts/test-fashion-looks.ts.
   */
  static validateAILooks(parsed: any, eligible: EligibleItem[], answers: QuizAnswers): ComposedLook[] {
    const byId = new Map(eligible.map((e) => [e.id, e]));
    const rawLooks: any[] = Array.isArray(parsed?.looks) ? parsed.looks : [];
    const out: ComposedLook[] = [];
    for (const raw of rawLooks) {
      const seen = new Set<string>();
      const items: { productId: string; role: string }[] = [];
      for (const it of Array.isArray(raw?.items) ? raw.items : []) {
        const id = String(it?.id || "");
        const item = byId.get(id);
        if (!item || seen.has(id)) continue;                       // ID fora do catálogo elegível: descartado
        if (!this.itemAllowed(item.name, answers)) continue;       // cor/peça evitada: descartado
        seen.add(id);
        items.push({ productId: id, role: VALID_ROLES.has(it?.role) ? it.role : "main" });
        if (items.length >= MAX_ITEMS_PER_LOOK) break;
      }
      if (!items.length) continue;
      if (answers.budgetMax != null && answers.budgetMax > 0 && this.lookTotal(items, byId) > answers.budgetMax) continue;
      const explanation = String(raw?.explanation || "").trim().slice(0, 400) || this.fallbackExplanation(answers);
      out.push({ items, explanation, source: "ai_recommended" });
      if (out.length >= MAX_LOOKS) break;
    }
    return out;
  }

  private static fallbackExplanation(answers: QuizAnswers): string {
    const parts: string[] = [`Sugerimos estas peças disponíveis na loja para ${answers.occasion || "a sua ocasião"}`];
    if (answers.style) parts.push(`no estilo ${answers.style}`);
    if (answers.budgetMax != null && answers.budgetMax > 0) parts.push(`dentro da sua faixa de até R$ ${Number(answers.budgetMax).toFixed(2)}`);
    return parts.join(", ") + ".";
  }

  /**
   * Compositor determinístico (sem IA): agrupa o catálogo elegível permitido
   * por categoria e monta até 3 looks simples (1 peça de categorias distintas
   * por look, respeitando o orçamento). É o caminho de contingência — a
   * qualidade da curadoria vem da IA; isto garante que o provador nunca
   * quebra por indisponibilidade dela.
   */
  static fallbackCompose(eligible: EligibleItem[], answers: QuizAnswers): ComposedLook[] {
    const allowed = eligible.filter((e) => this.itemAllowed(e.name, answers) && (answers.budgetMax == null || answers.budgetMax <= 0 || e.price <= answers.budgetMax));
    if (!allowed.length) return [];
    const byCategory = new Map<string, EligibleItem[]>();
    for (const item of allowed) {
      const cat = item.category || "outros";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(item);
    }
    const categories = [...byCategory.keys()];
    const looks: ComposedLook[] = [];
    for (let i = 0; i < MAX_LOOKS; i++) {
      const items: { productId: string; role: string }[] = [];
      let total = 0;
      for (const cat of categories) {
        const candidates = byCategory.get(cat)!;
        const pick = candidates[i % candidates.length];
        if (!pick || items.some((x) => x.productId === pick.id)) continue;
        if (answers.budgetMax != null && answers.budgetMax > 0 && total + pick.price > answers.budgetMax) continue;
        items.push({ productId: pick.id, role: items.length === 0 ? "main" : "bottom" });
        total += pick.price;
        if (items.length >= 3) break;
      }
      if (items.length && !looks.some((l) => JSON.stringify(l.items) === JSON.stringify(items))) {
        looks.push({ items, explanation: this.fallbackExplanation(answers), source: "ai_recommended" });
      }
    }
    return looks;
  }

  // ---- pedido de look (o fluxo principal) ----

  static async createRequestAndRecommend(orgId: string, customerId: string, answers: QuizAnswers): Promise<
    { ok: true; requestId: string; looks: { id: string; explanation: string; total: number; items: { productId: string; name: string; price: number; image: string | null; role: string }[] }[] }
    | { ok: false; error: string }
  > {
    const occasion = String(answers.occasion || "").trim().slice(0, 80);
    if (!occasion) return { ok: false, error: "Conte para a consultora qual é a ocasião." };

    const eligible = FashionStudioService.eligibleItems(orgId) as EligibleItem[];
    if (!eligible.length) return { ok: false, error: "A loja ainda não tem peças disponíveis para montar looks." };

    // Memória de estilo (FAS-5): só participa quando a personalização está
    // LIGADA (11.4) — desligada, o questionário funciona normalmente mas nada
    // é salvo nem usado além das respostas desta sessão.
    const personalization = this.personalizationEnabled(orgId, customerId);
    let memory: { likedCategories: string[]; rejectedCategories: string[]; purchasedCategories: string[] } | null = null;
    if (personalization) {
      // Responder o questionário é o ato explícito de personalização — registra
      // o consentimento (revogável) e salva as preferências.
      if (!FashionAvatarService.activeConsent(orgId, customerId, "personalization")) {
        FashionAvatarService.grantConsent(orgId, customerId, "personalization", "v1-2026-07");
      }
      this.savePreferencesFromAnswers(orgId, customerId, answers);
      memory = this.styleMemorySummary(orgId, customerId);
    }

    const requestId = uuidv4();
    db.prepare(
      `INSERT INTO fashion_look_requests (id, organization_id, customer_id, occasion, answers_json, generation_window, status)
       VALUES (?, ?, ?, ?, ?, date('now'), 'submitted')`
    ).run(requestId, orgId, customerId, occasion, JSON.stringify(answers));
    FashionStudioService.recordEvent(orgId, "FashionLookRequested", { occasion }, customerId, requestId);

    // Composição: IA quando disponível; validação server-side SEMPRE; fallback
    // determinístico quando a IA falta ou devolve nada aproveitável.
    let looks: ComposedLook[] = [];
    if (isAIConfigured()) {
      try {
        const catalogLines = eligible.slice(0, 120).map((e) => `${e.id} | ${e.name} | ${e.category || "sem categoria"} | R$ ${e.price.toFixed(2)}`).join("\n");
        const system = `Você é uma consultora de moda de uma loja brasileira. Monte looks APENAS com itens da lista fornecida, referenciando-os pelo ID exato. Regras rígidas: nunca invente itens, características, tecidos ou benefícios; nunca comente corpo, peso, beleza ou aparência da cliente; nunca use "perfeito para você" ou "ideal para seu corpo"; a explicação cita só o que a cliente declarou (ocasião, estilo, orçamento) e dados reais do item (nome, categoria, preço). Responda SOMENTE JSON.`;
        // Memória observada (11.2): entra como CONTEXTO da consultora — nunca
        // como rótulo. A explicação continua citando só o que a cliente declarou.
        const memoryLine = memory && (memory.likedCategories.length || memory.rejectedCategories.length || memory.purchasedCategories.length)
          ? `\nHistórico (com aceite da cliente): gostou de looks com ${memory.likedCategories.join(", ") || "—"}; não usaria ${memory.rejectedCategories.join(", ") || "—"}; já comprou ${memory.purchasedCategories.join(", ") || "—"}. Use como orientação sutil, priorize sempre o que ela declarou HOJE.`
          : "";
        const prompt = `Itens disponíveis (id | nome | categoria | preço):\n${catalogLines}\n\nCliente respondeu: ocasião=${occasion}; período=${answers.dayNight || "não informado"}; estilo=${answers.style || "não informado"}; cores a evitar=${(answers.colorsAvoid || []).join(", ") || "nenhuma"}; peças a evitar=${(answers.piecesAvoid || []).join(", ") || "nenhuma"}; orçamento máximo do look=${answers.budgetMax ? `R$ ${answers.budgetMax}` : "não informado"}.${memoryLine}\n\nMonte até 3 looks completos (1 a 5 itens cada, papéis: main, bottom, outerwear, shoes, accessory). Responda: {"looks":[{"items":[{"id":"...","role":"main"}],"explanation":"1-2 frases"}]}`;
        const raw = await chat(prompt, { json: true, temperature: 0.4, system });
        let parsed: any = {};
        try { parsed = JSON.parse(raw || "{}"); } catch { /* fica {} */ }
        looks = this.validateAILooks(parsed, eligible, answers);
      } catch (e) {
        console.error("[FashionLook] IA falhou ao compor looks; usando fallback:", e);
      }
    }
    if (!looks.length) {
      // Fallback com memória: categoria marcada como "não usaria" sai do
      // conjunto — o único uso determinístico da memória (o resto é contexto
      // da IA). Se a exclusão zerar as opções, tenta sem ela: melhor sugerir
      // algo do que nada.
      const rejectedSet = new Set(memory?.rejectedCategories || []);
      const filtered = rejectedSet.size ? eligible.filter((e) => !rejectedSet.has(e.category || "")) : eligible;
      looks = this.fallbackCompose(filtered.length ? filtered : eligible, answers);
    }
    if (!looks.length) {
      db.prepare(`UPDATE fashion_look_requests SET status = 'failed' WHERE id = ?`).run(requestId);
      return { ok: false, error: "Não encontramos peças que combinem com o que você pediu. Tente ajustar a faixa de preço ou as restrições." };
    }

    // Persiste looks + itens (com snapshot de preço — o checkout SEMPRE revalida).
    const byId = new Map(eligible.map((e) => [e.id, e]));
    const insLook = db.prepare(`INSERT INTO fashion_looks (id, organization_id, request_id, explanation, source, status) VALUES (?, ?, ?, ?, ?, 'candidate')`);
    const insItem = db.prepare(`INSERT INTO fashion_look_items (id, organization_id, look_id, product_service_id, role, quantity, price_snapshot) VALUES (?, ?, ?, ?, ?, 1, ?)`);
    const enriched: any[] = [];
    for (const look of looks) {
      const lookId = uuidv4();
      insLook.run(lookId, orgId, requestId, look.explanation, look.source);
      const items: any[] = [];
      for (const it of look.items) {
        const item = byId.get(it.productId)!;
        insItem.run(uuidv4(), orgId, lookId, it.productId, it.role, item.price);
        items.push({ productId: it.productId, name: item.name, price: item.price, image: item.image, role: it.role });
      }
      enriched.push({ id: lookId, explanation: look.explanation, total: Math.round(this.lookTotal(look.items, byId) * 100) / 100, items });
    }
    db.prepare(`UPDATE fashion_look_requests SET status = 'completed' WHERE id = ?`).run(requestId);
    FashionStudioService.recordEvent(orgId, "FashionLookRecommended", { lookCount: enriched.length }, customerId, requestId);

    return { ok: true, requestId, looks: enriched };
  }

  /** Salvar look sem carrinho (RF-018). Só a dona do request. */
  static saveLook(orgId: string, customerId: string, lookId: string): boolean {
    const look = db.prepare(
      `SELECT fl.id FROM fashion_looks fl
       JOIN fashion_look_requests flr ON flr.id = fl.request_id
       WHERE fl.id = ? AND fl.organization_id = ? AND flr.customer_id = ?`
    ).get(lookId, orgId, customerId) as any;
    if (!look) return false;
    db.prepare(`UPDATE fashion_looks SET status = 'selected' WHERE id = ?`).run(lookId);
    FashionStudioService.recordEvent(orgId, "FashionLookSaved", {}, customerId, lookId);
    return true;
  }

  // ---- carrinho do look completo (FAS-4, ADR-038 — seção 10 do PRD) ----

  /**
   * "Comprar este look": revalida CADA item contra o estado ATUAL do catálogo
   * (cenários 10.2) — disponível (ativo+visível+preço+estoque vendável),
   * preço atual vs. snapshot (nunca cobra silenciosamente um preço diferente
   * do que a cliente viu). O carrinho da vitrine é client-side; este endpoint
   * é a validação transacional do lado do servidor — e o CHECKOUT revalida
   * tudo de novo ao criar o pedido (caminho já existente da loja).
   */
  static prepareCart(orgId: string, customerId: string, lookId: string):
    { ok: true; lookId: string; items: { productId: string; name: string; image: string | null; price: number; snapshotPrice: number; priceChanged: boolean; available: boolean; reason: string | null }[]; availableTotal: number }
    | { ok: false; error: string } {
    const look = db.prepare(
      `SELECT fl.id FROM fashion_looks fl JOIN fashion_look_requests flr ON flr.id = fl.request_id
       WHERE fl.id = ? AND fl.organization_id = ? AND flr.customer_id = ?`
    ).get(lookId, orgId, customerId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };

    const rows = db.prepare(
      `SELECT fli.product_service_id AS productId, fli.price_snapshot AS snapshotPrice,
              ps.name, ps.price, ps.active, ps.storefront_visible, ps.stock_control_enabled, ps.studio_image_url,
              (SELECT url FROM product_images pi WHERE pi.product_service_id = ps.id ORDER BY position ASC, created_at ASC LIMIT 1) AS cover,
              (SELECT COALESCE(SUM(quantity_available - quantity_reserved), 0) FROM inventory_items inv WHERE inv.product_service_id = ps.id) AS sellable
       FROM fashion_look_items fli JOIN products_services ps ON ps.id = fli.product_service_id
       WHERE fli.look_id = ? AND fli.organization_id = ?`
    ).all(lookId, orgId) as any[];
    if (!rows.length) return { ok: false, error: "Este look não tem peças." };

    const items = rows.map((r) => {
      let available = true;
      let reason: string | null = null;
      if (!r.active || (r.storefront_visible != null && r.storefront_visible === 0)) { available = false; reason = "Esta peça saiu de circulação."; }
      else if (!(r.price > 0)) { available = false; reason = "Esta peça está sem preço no momento."; }
      else if (r.stock_control_enabled && (r.sellable ?? 0) <= 0) { available = false; reason = "Esta peça esgotou."; }
      const price = r.price || 0;
      const snapshotPrice = r.snapshotPrice || 0;
      return {
        productId: r.productId, name: r.name, image: r.cover || r.studio_image_url || null,
        price, snapshotPrice,
        priceChanged: available && snapshotPrice > 0 && Math.abs(price - snapshotPrice) >= 0.01,
        available, reason,
      };
    });
    const availableTotal = Math.round(items.filter((i) => i.available).reduce((s, i) => s + i.price, 0) * 100) / 100;
    FashionStudioService.recordEvent(orgId, "FashionLookAddedToCart", {
      itemCount: items.length, availableCount: items.filter((i) => i.available).length, availableTotal,
    }, customerId, lookId);
    return { ok: true, lookId, items, availableTotal };
  }

  /** Atribuição pedido<->look (RF-027): valida que o look existe NA organização antes de gravar no pedido. */
  static lookIdForOrder(orgId: string, lookId: string | null | undefined): string | null {
    if (!lookId) return null;
    const row = db.prepare(`SELECT id FROM fashion_looks WHERE id = ? AND organization_id = ?`).get(String(lookId), orgId) as any;
    return row?.id || null;
  }

  // ---- link de compartilhamento (RF-028, com expiração; RF-029: sem avatar) ----

  private static shareSecret(): string {
    return crypto.createHash("sha256").update(`${JWT_SECRET}:fashion_look_share_v1`).digest("hex");
  }

  /** Token stateless HMAC (lookId + expiração de 7 dias) — nada gravado, nada a vazar. */
  static shareLook(orgId: string, customerId: string, lookId: string): { ok: true; token: string } | { ok: false; error: string } {
    const look = db.prepare(
      `SELECT fl.id FROM fashion_looks fl JOIN fashion_look_requests flr ON flr.id = fl.request_id
       WHERE fl.id = ? AND fl.organization_id = ? AND flr.customer_id = ?`
    ).get(lookId, orgId, customerId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };
    const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const payload = `${lookId}.${exp}`;
    const sig = crypto.createHmac("sha256", this.shareSecret()).update(payload).digest("hex").slice(0, 32);
    return { ok: true, token: Buffer.from(`${payload}.${sig}`).toString("base64url") };
  }

  /**
   * Resolve um token de compartilhamento (público, sem login). Devolve SÓ a
   * composição do look (peças/preços atuais/explicação) — nunca avatar, foto
   * gerada ou qualquer dado da cliente (RF-029, padrão conservador).
   */
  static resolveSharedLook(token: string): { lookId: string; explanation: string; storeSlug: string | null; items: { productId: string; name: string; image: string | null; price: number; available: boolean }[]; total: number } | null {
    let decoded = "";
    try { decoded = Buffer.from(String(token || ""), "base64url").toString("utf-8"); } catch { return null; }
    const parts = decoded.split(".");
    if (parts.length !== 3) return null;
    const [lookId, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return null;
    const expected = crypto.createHmac("sha256", this.shareSecret()).update(`${lookId}.${exp}`).digest("hex").slice(0, 32);
    const a = Buffer.from(sig, "utf-8"), b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const look = db.prepare(`SELECT id, organization_id, explanation FROM fashion_looks WHERE id = ?`).get(lookId) as any;
    if (!look) return null;
    if (!FashionStudioService.isEnabled(look.organization_id)) return null; // kill switch vale para links antigos
    const store = db.prepare(`SELECT slug FROM storefront_settings WHERE organization_id = ?`).get(look.organization_id) as any;
    const rows = db.prepare(
      `SELECT fli.product_service_id AS productId, ps.name, ps.price, ps.active, ps.storefront_visible, ps.stock_control_enabled, ps.studio_image_url,
              (SELECT url FROM product_images pi WHERE pi.product_service_id = ps.id ORDER BY position ASC, created_at ASC LIMIT 1) AS cover,
              (SELECT COALESCE(SUM(quantity_available - quantity_reserved), 0) FROM inventory_items inv WHERE inv.product_service_id = ps.id) AS sellable
       FROM fashion_look_items fli JOIN products_services ps ON ps.id = fli.product_service_id
       WHERE fli.look_id = ? AND fli.organization_id = ?`
    ).all(lookId, look.organization_id) as any[];
    const items = rows.map((r) => ({
      productId: r.productId, name: r.name, image: r.cover || r.studio_image_url || null, price: r.price || 0,
      available: !!r.active && (r.storefront_visible == null || r.storefront_visible === 1) && (r.price > 0) && (!r.stock_control_enabled || (r.sellable ?? 0) > 0),
    }));
    const total = Math.round(items.filter((i) => i.available).reduce((s, i) => s + i.price, 0) * 100) / 100;
    return { lookId: look.id, explanation: look.explanation || "", storeSlug: store?.slug || null, items, total };
  }

  /** Looks de um request (para reabrir a tela) — só da dona. */
  static getRequestLooks(orgId: string, customerId: string, requestId: string): any | null {
    const request = db.prepare(`SELECT * FROM fashion_look_requests WHERE id = ? AND organization_id = ? AND customer_id = ?`).get(requestId, orgId, customerId) as any;
    if (!request) return null;
    const looks = db.prepare(`SELECT id, explanation, status FROM fashion_looks WHERE request_id = ? AND organization_id = ? ORDER BY created_at ASC`).all(requestId, orgId) as any[];
    const itemsStmt = db.prepare(
      `SELECT fli.product_service_id AS productId, fli.role, fli.price_snapshot AS price, ps.name
       FROM fashion_look_items fli JOIN products_services ps ON ps.id = fli.product_service_id
       WHERE fli.look_id = ? AND fli.organization_id = ?`
    );
    return {
      id: request.id, occasion: request.occasion, status: request.status,
      looks: looks.map((l) => ({ ...l, items: itemsStmt.all(l.id, orgId) })),
    };
  }
}
