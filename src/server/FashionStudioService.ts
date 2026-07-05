import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { chat, isAIConfigured } from "./llm.js";
import { normalizeProductName } from "./productMatcher.js";

/**
 * Fashion AI Studio — FAS-0, fundação (ADR-034 / PRD-E-006).
 *
 * Este serviço é a única porta de entrada do módulo nesta fase:
 *  - flag por loja (desligada por padrão; o toggle é o kill switch, RF-035);
 *  - catálogo ELEGÍVEL para looks (seção 8.3 do PRD): o provador nunca
 *    monta look com item que a vitrine não venderia — mesmas regras de
 *    visibilidade/estoque que já valem para a loja (ADR-028/033), computadas
 *    a partir do catálogo real (products_services/inventory_items), nunca de
 *    uma cópia;
 *  - telemetria (fashion_events): todos os eventos da seção 17 do PRD passam
 *    por recordEvent, que por regra NUNCA aceita conteúdo visual/base64 no
 *    payload (RNF-004).
 *
 * O que este serviço deliberadamente NÃO faz ainda: foto, consentimento,
 * geração, carrinho — fases FAS-1 a FAS-4.
 */

// ---- Classificação VESTÍVEL (ADR-041) ----------------------------------
// O provador só pode conter roupa/calçado/acessório de moda — a loja pode
// vender qualquer outra coisa (caneca, eletrônico, decoração...). A checagem
// é em camadas: heurística por palavras (grátis, síncrona) → IA para o que a
// heurística não decide → override manual do lojista (fashion_wearable_source
// = 'manual' nunca é sobrescrito). Item ainda NÃO classificado fica FORA do
// provador (conservador: nunca arriscar vestir uma caneca).

// Palavras normalizadas (sem acento, minúsculas — ver normalizeProductName).
// Casadas por PREFIXO de palavra: " calca" pega "calça" e "calças".
const WEARABLE_WORDS = [
  // roupas
  "vestido", "saia", "calca", "blusa", "camisa", "camiseta", "regata", "top", "cropped",
  "short", "bermuda", "jaqueta", "casaco", "blazer", "cardiga", "sueter", "moletom",
  "macacao", "body", "legging", "jeans", "polo", "tricot", "trico", "malha", "sobretudo",
  "parka", "colete", "terno", "jardineira", "pantalona", "kimono", "camisola", "pijama",
  "lingerie", "sutia", "calcinha", "cueca", "biquini", "maio", "sunga", "uniforme", "look",
  // calçados
  "sapato", "tenis", "sandalia", "salto", "sapatilha", "bota", "chinelo", "rasteira",
  "mocassim", "scarpin", "papete", "slide", "alpargata", "sapatenis",
  // acessórios de moda (vestíveis no corpo)
  "bolsa", "cinto", "colar", "brinco", "pulseira", "anel", "oculos", "chapeu", "bone",
  "lenco", "echarpe", "cachecol", "gravata", "meia", "luva", "relogio", "tiara", "pochete",
  "mochila", "carteira", "gargantilha", "tornozeleira", "abada", "saida de praia", "visor", "viseira",
];
const NON_WEARABLE_WORDS = [
  "caneca", "copo", "garrafa", "squeeze", "taca", "quadro", "poster", "livro", "revista",
  "celular", "capinha", "fone", "carregador", "cabo", "mouse", "teclado", "notebook", "tablet",
  "perfume", "batom", "maquiagem", "shampoo", "condicionador", "hidratante", "sabonete", "esmalte",
  "vela", "decoracao", "almofada", "toalha", "lencol", "cortina", "tapete", "panela", "caneta",
  "caderno", "agenda", "chaveiro", "adesivo", "brinquedo", "pelucia", "jogo", "console",
  "alimento", "chocolate", "cafe", "cha", "suplemento", "racao", "vaso", "planta", "luminaria",
];

export class FashionStudioService {
  static isEnabled(orgId: string): boolean {
    const row = db.prepare(`SELECT fashion_studio_enabled FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!row?.fashion_studio_enabled;
  }

  /** Limite diário de gerações da loja (RF-031). Clamp 1–20: config corrompida nunca vira ilimitado nem zero. */
  static dailyGenerationLimit(orgId: string): number {
    const row = db.prepare(`SELECT fashion_daily_generation_limit FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    const v = Number(row?.fashion_daily_generation_limit);
    if (!Number.isFinite(v) || v < 1) return 3;
    return Math.min(20, Math.round(v));
  }

  /**
   * Heurística vestível (ADR-041): 1 = roupa/acessório, 0 = não, null = a
   * heurística não decide (vai para a IA). Palavra casada por PREFIXO no nome
   * + categoria normalizados; se listas opostas colidem, não decide.
   */
  static classifyWearableHeuristic(name: string, category: string | null): 1 | 0 | null {
    const text = ` ${normalizeProductName(`${name || ""} ${category || ""}`)} `;
    const hit = (words: string[]) => words.some((w) => text.includes(` ${w}`));
    const wearable = hit(WEARABLE_WORDS);
    const non = hit(NON_WEARABLE_WORDS);
    if (wearable && !non) return 1;
    if (non && !wearable) return 0;
    return null;
  }

  /**
   * Completa a classificação vestível da loja (ADR-041): heurística para os
   * pendentes; IA (uma única chamada, barata) para o que sobrar. Best-effort e
   * idempotente — cada produto é classificado UMA vez (fica gravado); o
   * override manual do lojista ('manual') nunca é tocado. Chamada nos pontos
   * de entrada assíncronos do provador antes de montar o catálogo elegível.
   */
  static async ensureWearableClassified(orgId: string): Promise<void> {
    const pending = db.prepare(
      `SELECT id, name, category FROM products_services
       WHERE organization_id = ? AND type = 'product' AND active = 1 AND fashion_wearable IS NULL`
    ).all(orgId) as any[];
    if (!pending.length) return;
    const setStmt = db.prepare(`UPDATE products_services SET fashion_wearable = ?, fashion_wearable_source = ? WHERE id = ? AND COALESCE(fashion_wearable_source, '') != 'manual'`);
    const unknown: any[] = [];
    for (const p of pending) {
      const h = this.classifyWearableHeuristic(p.name, p.category);
      if (h !== null) setStmt.run(h, "heuristic", p.id);
      else unknown.push(p);
    }
    if (!unknown.length || !isAIConfigured()) return;
    try {
      const lines = unknown.slice(0, 200).map((p) => `${p.id} | ${p.name} | ${p.category || "sem categoria"}`).join("\n");
      const raw = await chat(
        `Produtos (id | nome | categoria):\n${lines}\n\nResponda: {"items":[{"id":"...","wearable":true}]} para TODOS os ids listados.`,
        {
          json: true, temperature: 0,
          system: "Você classifica produtos de uma loja para um provador virtual de moda. wearable=true SOMENTE para roupas, calçados e acessórios de moda que uma pessoa veste ou usa no corpo (vestido, calça, tênis, bolsa, colar, óculos, chapéu...). Qualquer outra coisa (caneca, eletrônico, decoração, cosmético, livro, alimento etc.) é wearable=false. Responda SOMENTE JSON.",
        }
      );
      let parsed: any = {};
      try { parsed = JSON.parse(raw || "{}"); } catch { /* fica {} */ }
      const known = new Set(unknown.map((p) => p.id));
      for (const it of Array.isArray(parsed?.items) ? parsed.items : []) {
        const id = String(it?.id || "");
        if (!known.has(id)) continue; // a IA só grava sobre os ids que perguntamos
        setStmt.run(it?.wearable === true ? 1 : 0, "ai", id);
      }
    } catch (e) {
      console.error("[FashionStudio] Classificação IA de vestíveis falhou (itens seguem pendentes/fora do provador):", e);
    }
  }

  /**
   * Catálogo elegível para looks (seção 8.3): publicado na vitrine, ativo,
   * com preço, com imagem comercial e com estoque vendável. Retorna o payload
   * mínimo que o Look Builder (FAS-2) e o motor de recomendação vão consumir —
   * sempre por IDs do catálogo real (regra 19.3: o motor só seleciona itens
   * por IDs daqui, nunca por texto livre).
   * ADR-041: e VESTÍVEL — item que não é roupa/acessório (ou ainda não
   * classificado) NUNCA entra no provador.
   */
  static eligibleItems(orgId: string): {
    id: string; name: string; slug: string | null; category: string | null;
    price: number; sale_mode: string; image: string | null;
    variants: { id: string; name: string; price: number | null }[];
  }[] {
    const rows = db.prepare(`
      SELECT ps.id, ps.name, ps.slug, ps.category, ps.price, ps.sale_mode, ps.stock_control_enabled, ps.has_variants, ps.studio_image_url, ps.fashion_wearable
      FROM products_services ps
      WHERE ps.organization_id = ? AND ps.type = 'product' AND ps.active = 1
        AND COALESCE(ps.storefront_visible, 1) = 1
        AND ps.price IS NOT NULL AND ps.price > 0
      ORDER BY COALESCE(ps.storefront_position, 999999) ASC, ps.name ASC
    `).all(orgId) as any[];
    const setWearStmt = db.prepare(`UPDATE products_services SET fashion_wearable = ?, fashion_wearable_source = 'heuristic' WHERE id = ? AND fashion_wearable IS NULL`);

    const coverStmt = db.prepare(`SELECT url FROM product_images WHERE product_service_id = ? ORDER BY position ASC, created_at ASC LIMIT 1`);
    const sellableStmt = db.prepare(`
      SELECT COALESCE(SUM(quantity_available - quantity_reserved), 0) AS sellable
      FROM inventory_items WHERE organization_id = ? AND product_service_id = ?
    `);
    const variantsStmt = db.prepare(`
      SELECT pv.id, pv.name, pv.price,
             COALESCE(inv.quantity_available, 0) - COALESCE(inv.quantity_reserved, 0) AS sellable
      FROM product_variants pv
      LEFT JOIN inventory_items inv ON inv.variant_id = pv.id
      WHERE pv.organization_id = ? AND pv.product_service_id = ? AND pv.active = 1
    `);

    const out: any[] = [];
    for (const p of rows) {
      // Vestível (ADR-041): 0 = fora; NULL tenta a heurística agora (síncrona,
      // grátis) e grava; se nem ela decidir, fica FORA até a IA classificar
      // (ensureWearableClassified) ou o lojista marcar manualmente.
      let wearable = p.fashion_wearable;
      if (wearable == null) {
        const h = this.classifyWearableHeuristic(p.name, p.category);
        if (h !== null) { setWearStmt.run(h, p.id); wearable = h; }
      }
      if (wearable !== 1) continue;

      // Imagem comercial obrigatória (8.3): a foto de estúdio (ADR-032) conta;
      // produto sem NENHUMA imagem não entra em look (o try-on precisa dela).
      const cover = (coverStmt.get(p.id) as any)?.url || p.studio_image_url || null;
      if (!cover) continue;

      // Estoque vendável (ADR-033): produto com controle e saldo zerado sai.
      if (p.stock_control_enabled) {
        const sellable = (sellableStmt.get(orgId, p.id) as any)?.sellable ?? 0;
        if (sellable <= 0) continue;
      }

      // Variações: só as com estoque (ou sem controle no nível da variação).
      let variants: { id: string; name: string; price: number | null }[] = [];
      if (p.has_variants) {
        variants = (variantsStmt.all(orgId, p.id) as any[])
          .filter((v) => v.sellable > 0)
          .map((v) => ({ id: v.id, name: v.name, price: v.price ?? null }));
        if (!variants.length) continue; // todas as variações esgotadas = inelegível
      }

      out.push({
        id: p.id, name: p.name, slug: p.slug || null, category: p.category || null,
        price: p.price, sale_mode: p.sale_mode || "unit", image: cover, variants,
      });
    }
    return out;
  }

  /**
   * Telemetria do módulo (seção 17/20 do PRD). Best-effort: nunca quebra o
   * fluxo que a gerou. Recusa payload com conteúdo visual (RNF-004) — checagem
   * barata por tamanho: nenhum evento legítimo do módulo carrega blobs.
   */
  static recordEvent(orgId: string, eventType: string, payload: Record<string, any> = {}, customerId?: string | null, correlationId?: string | null): void {
    try {
      const json = JSON.stringify(payload || {});
      if (json.length > 8_000) {
        console.warn(`[FashionStudio] Evento ${eventType} descartado: payload grande demais (provável blob — RNF-004).`);
        return;
      }
      db.prepare(
        `INSERT INTO fashion_events (id, organization_id, customer_id, event_type, payload_json, correlation_id) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), orgId, customerId || null, eventType, json, correlationId || null);
    } catch (e) { /* telemetria nunca derruba o caminho principal */ }
  }

  /** Contagem de eventos por tipo (métricas agregadas do admin — RF-036: sem dado privado, só agregado). */
  static eventCounts(orgId: string, sinceDays = 30): { event_type: string; count: number }[] {
    return db.prepare(`
      SELECT event_type, COUNT(*) AS count FROM fashion_events
      WHERE organization_id = ? AND created_at >= datetime('now', ?)
      GROUP BY event_type ORDER BY count DESC
    `).all(orgId, `-${Math.max(1, sinceDays)} days`) as any[];
  }
}
