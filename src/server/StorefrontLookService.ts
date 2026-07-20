import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { chat, isAIConfigured } from "./llm.js";
import { FashionStudioService } from "./FashionStudioService.js";

/**
 * Vitrinista IA — motor de looks de MERCHANDISING da loja (ADR-104 Bloco 2).
 *
 * Quando um lote de peças novas chega, a IA se comporta como consultora de
 * vitrine: combina as peças (novas como BASE, podendo puxar peças antigas que
 * combinem) em looks; o lojista cura num Kanban (arrasta/solta, cria/edita).
 *
 * Distinto do FashionLookService (que é da CLIENTE, dirigido por quiz/ocasião
 * e com consentimento/memória): aqui não há cliente — é conteúdo da loja,
 * gravado em storefront_looks. A imagem do avatar vestindo o look aprovado é
 * gerada e publicada no Bloco 3; este bloco entrega só sugestão + curadoria.
 *
 * Segue a MESMA rede de segurança anti prompt-injection do look da cliente
 * (regra 19.3): a IA só pode devolver IDs do catálogo ELEGÍVEL; tudo é
 * revalidado server-side. Sem IA (ou saída inválida), um compositor
 * DETERMINÍSTICO monta looks simples — a vitrinista nunca quebra por falta de IA.
 */

interface CatalogItem { id: string; name: string; category: string | null; price: number; image: string | null; }
interface ComposedStoreLook { title: string; explanation: string; items: { productId: string; role: string }[]; }

const VALID_ROLES = new Set(["main", "bottom", "outerwear", "shoes", "accessory"]);
const MAX_ITEMS_PER_LOOK = 5;
const DEFAULT_MAX_LOOKS = 8;
const DEFAULT_WINDOW_DAYS = 14;
// 'published' só é definido pelo Bloco 3 (após gerar a imagem) — o Kanban move
// entre estas colunas.
const KANBAN_STATUSES = new Set(["suggested", "approved", "archived"]);

export class StorefrontLookService {
  // ---- catálogo e "peças novas do lote" ----

  private static catalog(orgId: string): CatalogItem[] {
    return (FashionStudioService.eligibleItems(orgId) as any[]).map((e) => ({
      id: e.id, name: e.name, category: e.category, price: e.price, image: e.image,
    }));
  }

  /** IDs elegíveis cadastrados DEPOIS da última curadoria (ou nos últimos N dias). */
  private static newPieceIds(orgId: string, eligibleIds: Set<string>, windowDays: number): Set<string> {
    const s = db.prepare(`SELECT vitrine_curated_at FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    // Estritamente DEPOIS da última curadoria (peças criadas no mesmo instante
    // ou antes já foram curadas). Na primeira vez, cai na janela de N dias.
    const since = s?.vitrine_curated_at
      ? `'${String(s.vitrine_curated_at).replace(/'/g, "")}'`
      : `datetime('now', '-${Math.max(1, Math.floor(windowDays))} days')`;
    const rows = db.prepare(
      `SELECT id FROM products_services WHERE organization_id = ? AND type = 'product' AND active = 1 AND created_at > ${since}`
    ).all(orgId) as any[];
    return new Set(rows.map((r) => r.id).filter((id) => eligibleIds.has(id)));
  }

  private static markCurated(orgId: string): void {
    db.prepare(`UPDATE storefront_settings SET vitrine_curated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgId);
  }

  // ---- validação da saída da IA (rede de segurança 19.3) ----

  static validateStoreLooks(parsed: any, byId: Map<string, CatalogItem>, newIds: Set<string>, maxLooks: number): ComposedStoreLook[] {
    const rawLooks: any[] = Array.isArray(parsed?.looks) ? parsed.looks : [];
    const out: ComposedStoreLook[] = [];
    for (const raw of rawLooks) {
      const seen = new Set<string>();
      const items: { productId: string; role: string }[] = [];
      for (const it of Array.isArray(raw?.items) ? raw.items : []) {
        const id = String(it?.id || "");
        if (!byId.has(id) || seen.has(id)) continue;               // fora do catálogo elegível ou repetido: descartado
        seen.add(id);
        items.push({ productId: id, role: VALID_ROLES.has(it?.role) ? it.role : (items.length === 0 ? "main" : "bottom") });
        if (items.length >= MAX_ITEMS_PER_LOOK) break;
      }
      // Cada look de vitrine PRECISA conter ao menos uma peça nova do lote —
      // é o ponto do fluxo (curar o que acabou de chegar).
      if (items.length < 2 || !items.some((i) => newIds.has(i.productId))) continue;
      const title = String(raw?.title || "").trim().slice(0, 80) || "Look da vitrine";
      const explanation = String(raw?.explanation || "").trim().slice(0, 400);
      out.push({ title, explanation, items });
      if (out.length >= maxLooks) break;
    }
    return out;
  }

  /** Compositor determinístico (sem IA): cada peça nova vira a base de um look, com 1 peça complementar de outra categoria. */
  static fallbackCompose(newPieces: CatalogItem[], eligible: CatalogItem[], maxLooks: number): ComposedStoreLook[] {
    const looks: ComposedStoreLook[] = [];
    for (const base of newPieces) {
      if (looks.length >= maxLooks) break;
      const complement = eligible.find((e) => e.id !== base.id && (e.category || "") !== (base.category || ""));
      const items = [{ productId: base.id, role: "main" }];
      if (complement) items.push({ productId: complement.id, role: "bottom" });
      if (items.length < 2) continue; // sem par não é "look"
      looks.push({
        title: `Look com ${base.name}`.slice(0, 80),
        explanation: complement ? `${base.name} combinado com ${complement.name}.` : `Look em destaque com ${base.name}.`,
        items,
      });
    }
    return looks;
  }

  // ---- fluxo principal: sugerir looks do lote ----

  static async suggest(orgId: string, opts: { windowDays?: number; maxLooks?: number } = {}):
    Promise<{ ok: true; created: number; newPieceCount: number; looks: any[] } | { ok: false; error: string }> {
    const maxLooks = Math.min(20, Math.max(1, opts.maxLooks || DEFAULT_MAX_LOOKS));
    const windowDays = opts.windowDays || DEFAULT_WINDOW_DAYS;

    try { await FashionStudioService.ensureWearableClassified(orgId); } catch { /* best-effort */ }
    const eligible = this.catalog(orgId);
    if (!eligible.length) return { ok: false, error: "A loja ainda não tem peças publicadas para montar looks." };

    const byId = new Map(eligible.map((e) => [e.id, e]));
    const eligibleIds = new Set(eligible.map((e) => e.id));
    const newIds = this.newPieceIds(orgId, eligibleIds, windowDays);
    if (!newIds.size) return { ok: false, error: "Nenhuma peça nova desde a última curadoria. Cadastre as peças que chegaram e tente de novo." };
    const newPieces = eligible.filter((e) => newIds.has(e.id));

    let looks: ComposedStoreLook[] = [];
    if (isAIConfigured()) {
      try {
        // Novas peças em destaque; catálogo completo como contexto (pode puxar
        // antigas que combinem). Cap para não estourar o prompt.
        const catalogLines = eligible.slice(0, 120)
          .map((e) => `${e.id} | ${e.name} | ${e.category || "sem categoria"} | R$ ${e.price.toFixed(2)}${newIds.has(e.id) ? " | NOVA" : ""}`)
          .join("\n");
        const system = `Você é uma vitrinista e consultora de moda de uma loja brasileira. Monte looks de VITRINE combinando as peças da lista, referenciando-as pelo ID exato. Regras rígidas: use SÓ itens da lista; nunca invente peças, cores, tecidos ou benefícios; cada look deve ter de 2 a 5 peças que combinem entre si (cores/estilo/ocasião); cada look DEVE incluir ao menos uma peça marcada como NOVA (é o lote que acabou de chegar); pode complementar com peças antigas que combinem. A explicação cita só dados reais das peças (nome, categoria) e o porquê da combinação. Responda SOMENTE JSON.`;
        const prompt = `Peças disponíveis (id | nome | categoria | preço | NOVA?):\n${catalogLines}\n\nMonte até ${maxLooks} looks de vitrine, priorizando destacar as peças NOVAS. Papéis possíveis: main, bottom, outerwear, shoes, accessory. Responda: {"looks":[{"title":"nome curto do look","explanation":"1-2 frases sobre a combinação","items":[{"id":"...","role":"main"}]}]}`;
        const raw = await chat(prompt, { json: true, temperature: 0.5, system });
        let parsed: any = {};
        try { parsed = JSON.parse(raw || "{}"); } catch { /* fica {} */ }
        looks = this.validateStoreLooks(parsed, byId, newIds, maxLooks);
      } catch (e) {
        console.error("[StorefrontLook] IA falhou ao compor looks de vitrine; usando fallback:", e);
      }
    }
    if (!looks.length) looks = this.fallbackCompose(newPieces, eligible, maxLooks);
    if (!looks.length) return { ok: false, error: "Não consegui montar combinações com as peças novas. Tente cadastrar peças de categorias diferentes." };

    // Persiste como 'suggested' (coluna inicial do Kanban) e avança a curadoria.
    const insLook = db.prepare(`INSERT INTO storefront_looks (id, organization_id, title, explanation, origin, status, position) VALUES (?, ?, ?, ?, 'ai', 'suggested', ?)`);
    const insItem = db.prepare(`INSERT INTO storefront_look_items (id, organization_id, look_id, product_service_id, role, position) VALUES (?, ?, ?, ?, ?, ?)`);
    const createdIds: string[] = [];
    let basePos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM storefront_looks WHERE organization_id = ? AND status = 'suggested'`).get(orgId) as any).p;
    for (const look of looks) {
      const lookId = uuidv4();
      insLook.run(lookId, orgId, look.title, look.explanation, basePos++);
      look.items.forEach((it, i) => insItem.run(uuidv4(), orgId, lookId, it.productId, it.role, i));
      createdIds.push(lookId);
    }
    this.markCurated(orgId);

    return { ok: true, created: createdIds.length, newPieceCount: newIds.size, looks: this.list(orgId).filter((l) => createdIds.includes(l.id)) };
  }

  // ---- leitura (para o Kanban) ----

  private static enrichItems(orgId: string, lookId: string): any[] {
    return (db.prepare(
      `SELECT sli.product_service_id AS productId, sli.role, ps.name, ps.price,
              (SELECT url FROM product_images pi WHERE pi.product_service_id = ps.id ORDER BY position ASC, created_at ASC LIMIT 1) AS cover,
              ps.studio_image_url
       FROM storefront_look_items sli JOIN products_services ps ON ps.id = sli.product_service_id
       WHERE sli.look_id = ? AND sli.organization_id = ? ORDER BY sli.position ASC`
    ).all(lookId, orgId) as any[]).map((r) => ({
      productId: r.productId, role: r.role, name: r.name, price: r.price, image: r.cover || r.studio_image_url || null,
    }));
  }

  /** Todos os looks de vitrine (não arquivados) enriquecidos — a fonte do Kanban. */
  static list(orgId: string): any[] {
    const looks = db.prepare(
      `SELECT id, title, explanation, origin, status, preset_avatar_id, published_image_url, position, created_at
       FROM storefront_looks WHERE organization_id = ? AND status != 'archived' ORDER BY status ASC, position ASC, created_at ASC`
    ).all(orgId) as any[];
    return looks.map((l) => ({
      id: l.id, title: l.title, explanation: l.explanation, origin: l.origin, status: l.status,
      presetAvatarId: l.preset_avatar_id || null, publishedImageUrl: l.published_image_url || null,
      position: l.position, createdAt: l.created_at, items: this.enrichItems(orgId, l.id),
      total: Math.round(this.enrichItems(orgId, l.id).reduce((s, i) => s + (i.price || 0), 0) * 100) / 100,
    }));
  }

  static get(orgId: string, id: string): any | null {
    const l = db.prepare(`SELECT * FROM storefront_looks WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!l) return null;
    return { ...l, items: this.enrichItems(orgId, id) };
  }

  // ---- curadoria (o lojista no Kanban) ----

  /** Cria um look manual a partir de IDs escolhidos pelo lojista. Só IDs do catálogo elegível entram. */
  static createManual(orgId: string, productIds: string[], input: { title?: string; status?: string } = {}):
    { ok: true; id: string } | { ok: false; error: string } {
    const eligibleIds = new Set(this.catalog(orgId).map((e) => e.id));
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of Array.isArray(productIds) ? productIds : []) {
      const id = String(raw || "");
      if (!eligibleIds.has(id) || seen.has(id)) continue;
      seen.add(id); items.push(id);
      if (items.length >= MAX_ITEMS_PER_LOOK) break;
    }
    if (!items.length) return { ok: false, error: "Selecione ao menos uma peça disponível para o look." };
    const status = input.status && KANBAN_STATUSES.has(input.status) ? input.status : "suggested";
    const id = uuidv4();
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM storefront_looks WHERE organization_id = ? AND status = ?`).get(orgId, status) as any).p;
    db.prepare(`INSERT INTO storefront_looks (id, organization_id, title, origin, status, position) VALUES (?, ?, ?, 'manual', ?, ?)`)
      .run(id, orgId, String(input.title || "Look manual").slice(0, 80), status, pos);
    const insItem = db.prepare(`INSERT INTO storefront_look_items (id, organization_id, look_id, product_service_id, role, position) VALUES (?, ?, ?, ?, ?, ?)`);
    items.forEach((pid, i) => insItem.run(uuidv4(), orgId, id, pid, i === 0 ? "main" : "bottom", i));
    return { ok: true, id };
  }

  /** Substitui as peças de um look (edição no Kanban). Só IDs elegíveis. */
  static setItems(orgId: string, id: string, productIds: string[]): { ok: true } | { ok: false; error: string } {
    const look = db.prepare(`SELECT id FROM storefront_looks WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };
    const eligibleIds = new Set(this.catalog(orgId).map((e) => e.id));
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of Array.isArray(productIds) ? productIds : []) {
      const pid = String(raw || "");
      if (!eligibleIds.has(pid) || seen.has(pid)) continue;
      seen.add(pid); items.push(pid);
      if (items.length >= MAX_ITEMS_PER_LOOK) break;
    }
    if (!items.length) return { ok: false, error: "O look precisa de ao menos uma peça disponível." };
    db.prepare(`DELETE FROM storefront_look_items WHERE look_id = ? AND organization_id = ?`).run(id, orgId);
    const insItem = db.prepare(`INSERT INTO storefront_look_items (id, organization_id, look_id, product_service_id, role, position) VALUES (?, ?, ?, ?, ?, ?)`);
    items.forEach((pid, i) => insItem.run(uuidv4(), orgId, id, pid, i === 0 ? "main" : "bottom", i));
    db.prepare(`UPDATE storefront_looks SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(id, orgId);
    return { ok: true };
  }

  /** Move o look entre colunas do Kanban (suggested/approved/archived) e/ou reordena. 'published' é do Bloco 3. */
  static update(orgId: string, id: string, patch: { status?: string; position?: number; title?: string }): { ok: true } | { ok: false; error: string } {
    const look = db.prepare(`SELECT status FROM storefront_looks WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };
    if (patch.status !== undefined && !KANBAN_STATUSES.has(patch.status)) {
      return { ok: false, error: "Status inválido." };
    }
    const sets: string[] = []; const vals: any[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
    if (patch.position !== undefined) { sets.push("position = ?"); vals.push(Math.max(0, Number(patch.position) || 0)); }
    if (patch.title !== undefined) { sets.push("title = ?"); vals.push(String(patch.title).slice(0, 80)); }
    if (!sets.length) return { ok: true };
    sets.push("updated_at = CURRENT_TIMESTAMP");
    vals.push(id, orgId);
    db.prepare(`UPDATE storefront_looks SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...vals);
    return { ok: true };
  }

  static remove(orgId: string, id: string): boolean {
    const r = db.prepare(`DELETE FROM storefront_looks WHERE id = ? AND organization_id = ?`).run(id, orgId);
    if (r.changes) db.prepare(`DELETE FROM storefront_look_items WHERE look_id = ? AND organization_id = ?`).run(id, orgId);
    return (r.changes || 0) > 0;
  }
}
