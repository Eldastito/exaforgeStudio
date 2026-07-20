import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { NotificationService } from "./NotificationService.js";
import { chat } from "./llm.js";

/**
 * Reposição inteligente (Fase 1 do "ZappFlow Supply"). Varre o estoque, encontra
 * itens abaixo do mínimo crítico (inventory_items.low_stock_threshold), calcula
 * o consumo médio diário (saídas em stock_movements nos últimos 30 dias) e
 * propõe uma REQUISIÇÃO DE COMPRA (rascunho) para o gestor aprovar.
 *
 * Tudo intra-cliente — não depende de fornecedor estar no ZappFlow. As Fases 2/3
 * (cotação com fornecedores + rede ZappFlow) reusam essa requisição como ponto
 * de partida.
 */
export class PurchaseRequisitionService {
  /** Calcula a sugestão de compra para um item específico (sem persistir). */
  static suggestForItem(orgId: string, params: {
    productId: string; variantId: string | null;
    currentStock: number; threshold: number; targetDays: number;
  }) {
    // Consumo médio diário pelas saídas (vendas/baixas) dos últimos 30 dias.
    const r = db.prepare(`
      SELECT COALESCE(SUM(quantity),0) AS total
      FROM stock_movements
      WHERE organization_id = ? AND product_service_id = ? AND type = 'saida'
        AND created_at >= datetime('now','-30 days')
        AND (? IS NULL OR variant_id IS NULL OR variant_id = ?)
    `).get(orgId, params.productId, params.variantId, params.variantId) as any;
    const sold30 = Number(r?.total || 0);
    const avgDaily = sold30 / 30;
    const cover = avgDaily > 0 ? Math.round((params.currentStock / avgDaily) * 10) / 10 : null;
    // Sugere o maior entre repor até o mínimo e cobrir os próximos N dias.
    const byThreshold = Math.max(0, (params.threshold || 0) - params.currentStock);
    const byTarget = Math.ceil(avgDaily * (params.targetDays || 14));
    const suggested = Math.max(byThreshold, byTarget, 1);
    return { suggestedQty: suggested, avgDailyConsumption: Math.round(avgDaily * 100) / 100, daysOfCover: cover };
  }

  /** Lista os itens da org abaixo do mínimo crítico (com sugestão de QTD). */
  static itemsBelowThreshold(orgId: string, targetDays = 14) {
    const rows = db.prepare(`
      SELECT ii.id, ii.product_service_id, ii.variant_id,
             ii.quantity_available, ii.quantity_reserved, ii.low_stock_threshold,
             p.name AS product_name, pv.name AS variant_name
      FROM inventory_items ii
      JOIN products_services p ON p.id = ii.product_service_id
      LEFT JOIN product_variants pv ON pv.id = ii.variant_id
      WHERE ii.organization_id = ?
        AND p.active = 1 AND p.stock_control_enabled = 1
        AND COALESCE(ii.low_stock_threshold,0) > 0
        AND (ii.quantity_available - COALESCE(ii.quantity_reserved,0)) <= ii.low_stock_threshold
    `).all(orgId) as any[];

    return rows.map(r => {
      const stock = (r.quantity_available || 0) - (r.quantity_reserved || 0);
      const s = this.suggestForItem(orgId, {
        productId: r.product_service_id, variantId: r.variant_id,
        currentStock: stock, threshold: r.low_stock_threshold, targetDays,
      });
      return {
        productServiceId: r.product_service_id,
        variantId: r.variant_id || null,
        name: r.variant_name ? `${r.product_name} (${r.variant_name})` : r.product_name,
        currentStock: stock,
        threshold: r.low_stock_threshold,
        ...s,
      };
    });
  }

  /** Requisição em rascunho aberta (no máximo uma por org). */
  static currentDraft(orgId: string): any | null {
    return db.prepare(`SELECT * FROM purchase_requisitions WHERE organization_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`).get(orgId) as any || null;
  }

  /** Lista os itens de uma requisição. */
  static itemsOf(reqId: string): any[] {
    return db.prepare(`SELECT * FROM purchase_requisition_items WHERE requisition_id = ?`).all(reqId) as any[];
  }

  /**
   * Detecta itens em falta e cria/atualiza a requisição rascunho da org.
   * - Retorna null se não há nada abaixo do mínimo.
   * - Idempotente: se já existe um rascunho, substitui os itens (sem duplicar).
   */
  static syncDraft(orgId: string, targetDays = 14): { id: string; items: number } | null {
    const items = this.itemsBelowThreshold(orgId, targetDays);
    const cur = this.currentDraft(orgId);
    // Itens ditados pelo gestor (source='manual') NÃO são tocados aqui — só os
    // 'auto' (reposição de estoque) são recalculados a cada passada (ADR-099).
    const manualCount = cur ? (db.prepare(`SELECT COUNT(*) c FROM purchase_requisition_items WHERE requisition_id = ? AND source = 'manual'`).get(cur.id) as any).c : 0;

    if (items.length === 0) {
      // Sem itens abaixo do mínimo: limpa só as linhas 'auto'.
      if (cur) {
        db.prepare(`DELETE FROM purchase_requisition_items WHERE requisition_id = ? AND source = 'auto'`).run(cur.id);
        // Se não sobrou nada (nem manual), descarta o rascunho vazio.
        if (manualCount === 0) {
          db.prepare(`DELETE FROM purchase_requisitions WHERE id = ? AND status = 'draft'`).run(cur.id);
          return null;
        }
        return { id: cur.id, items: 0 };
      }
      return null;
    }

    let req = cur;
    if (!req) {
      const id = uuidv4();
      db.prepare(`INSERT INTO purchase_requisitions (id, organization_id, status, created_by) VALUES (?, ?, 'draft', 'ai')`).run(id, orgId);
      req = { id };
    } else {
      // Substitui só as linhas 'auto' — fonte da verdade é o estoque atual.
      db.prepare(`DELETE FROM purchase_requisition_items WHERE requisition_id = ? AND source = 'auto'`).run(req.id);
    }

    // Produtos já ditados manualmente não são duplicados pela reposição automática.
    const manualProducts = new Set(
      (db.prepare(`SELECT product_service_id FROM purchase_requisition_items WHERE requisition_id = ? AND source = 'manual'`).all(req.id) as any[]).map(r => r.product_service_id)
    );

    const ins = db.prepare(`INSERT INTO purchase_requisition_items
      (id, requisition_id, organization_id, product_service_id, variant_id, current_stock, threshold, suggested_qty, avg_daily_consumption, days_of_cover, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`);
    let added = 0;
    for (const it of items) {
      if (manualProducts.has(it.productServiceId)) continue; // gestor já pediu esse
      ins.run(uuidv4(), req.id, orgId, it.productServiceId, it.variantId, it.currentStock, it.threshold, it.suggestedQty, it.avgDailyConsumption, it.daysOfCover);
      added++;
    }
    return { id: req.id, items: added };
  }

  /**
   * Extrai um pedido de compra da fala/mensagem do gestor (ex.: "compra 20
   * camisas polo brancas e 10 calças pretas"). Usa o LLM com JSON forçado.
   * Retorna { isOrder:false, items:[] } se não for um pedido ou se a IA falhar
   * (degradação graciosa — nunca cria nada sem itens).
   * Método estático para poder ser mockado nos testes (sem chave OpenAI).
   */
  static async extractOrderFromText(orgId: string, text: string): Promise<{ isOrder: boolean; items: { name: string; quantity: number; note?: string }[] }> {
    const catalog = (db.prepare(`SELECT name FROM products_services WHERE organization_id = ? AND active = 1 LIMIT 200`).all(orgId) as any[]).map(r => r.name);
    const system = [
      "Você extrai PEDIDOS DE COMPRA (reposição de estoque) que o gestor de uma loja dita por voz ou texto.",
      "Responda SEMPRE em JSON: { \"isOrder\": boolean, \"items\": [{ \"name\": string, \"quantity\": number, \"note\": string }] }.",
      "isOrder=true só se a mensagem claramente pede para COMPRAR/REPOR/ENCOMENDAR itens. Conversa fiada, dúvida ou venda ao cliente => isOrder=false, items=[].",
      "quantity é a quantidade a comprar (inteiro >=1; se não disser, use 1). name é o produto dito, o mais próximo possível do catálogo abaixo.",
      catalog.length ? `Catálogo (use estes nomes quando casar): ${catalog.slice(0, 120).join("; ")}` : "",
    ].filter(Boolean).join("\n");
    try {
      const raw = await chat(text, { json: true, temperature: 0, system });
      const parsed = JSON.parse(raw || "{}");
      const items = Array.isArray(parsed.items) ? parsed.items
        .map((it: any) => ({ name: String(it.name || "").trim(), quantity: Math.max(1, parseInt(String(it.quantity), 10) || 1), note: it.note ? String(it.note) : undefined }))
        .filter((it: any) => it.name) : [];
      return { isOrder: !!parsed.isOrder && items.length > 0, items };
    } catch (e) {
      console.warn("[Supply] Falha ao extrair pedido de compra do texto:", e);
      return { isOrder: false, items: [] };
    }
  }

  /**
   * Casa nomes ditados (ex.: "camisa polo branca") a produtos reais do catálogo.
   * Heurística simples (normaliza + contém) — suficiente para o piloto; itens sem
   * correspondência voltam em `unmatched` para o gestor cadastrar antes.
   */
  static matchItemsToProducts(orgId: string, items: { name: string; quantity?: number; note?: string }[]) {
    const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const products = db.prepare(`SELECT id, name FROM products_services WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const normProducts = products.map(p => ({ id: p.id, name: p.name, norm: norm(p.name) }));
    const matched: { productServiceId: string; name: string; quantity: number }[] = [];
    const unmatched: string[] = [];
    for (const it of items) {
      const q = norm(it.name);
      if (!q) continue;
      // Melhor correspondência: nome do produto contido na fala ou vice-versa;
      // senão, maior sobreposição de tokens.
      let best: { id: string; name: string; score: number } | null = null;
      const qTokens = q.split(" ").filter(Boolean);
      for (const p of normProducts) {
        let score = 0;
        if (p.norm === q) score = 100;
        else if (p.norm.includes(q) || q.includes(p.norm)) score = 60;
        else {
          const pTokens = new Set(p.norm.split(" ").filter(Boolean));
          const overlap = qTokens.filter(t => pTokens.has(t)).length;
          score = overlap > 0 ? (overlap / Math.max(qTokens.length, pTokens.size)) * 50 : 0;
        }
        if (score > 0 && (!best || score > best.score)) best = { id: p.id, name: p.name, score };
      }
      if (best && best.score >= 25) matched.push({ productServiceId: best.id, name: best.name, quantity: Math.max(1, Number(it.quantity) || 1) });
      else unmatched.push(it.name);
    }
    return { matched, unmatched };
  }

  /**
   * Adiciona itens ditados pelo gestor ao rascunho corrente (cria se não houver),
   * marcados source='manual'. Se o produto já está no rascunho, soma a quantidade.
   * Não mexe na reposição automática (linhas 'auto').
   */
  static addManualItems(orgId: string, matched: { productServiceId: string; quantity: number }[], createdBy = "manager"): { id: string; added: number } | null {
    if (!matched.length) return null;
    let req = this.currentDraft(orgId);
    if (!req) {
      const id = uuidv4();
      db.prepare(`INSERT INTO purchase_requisitions (id, organization_id, status, created_by) VALUES (?, ?, 'draft', ?)`).run(id, orgId, createdBy);
      req = { id };
    }
    let added = 0;
    for (const m of matched) {
      const existing = db.prepare(`SELECT id, suggested_qty FROM purchase_requisition_items WHERE requisition_id = ? AND product_service_id = ? AND source = 'manual' AND variant_id IS NULL`).get(req.id, m.productServiceId) as any;
      if (existing) {
        db.prepare(`UPDATE purchase_requisition_items SET suggested_qty = ? WHERE id = ?`).run((existing.suggested_qty || 0) + m.quantity, existing.id);
      } else {
        db.prepare(`INSERT INTO purchase_requisition_items
          (id, requisition_id, organization_id, product_service_id, variant_id, current_stock, threshold, suggested_qty, avg_daily_consumption, days_of_cover, source)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, 'manual')`).run(uuidv4(), req.id, orgId, m.productServiceId, m.quantity);
      }
      added++;
    }
    return { id: req.id, added };
  }

  /** Aprovação humana: marca a requisição como approved. (Fase 2 transforma em PO.) */
  static approve(orgId: string, reqId: string, userId: string): boolean {
    const r = db.prepare(`UPDATE purchase_requisitions SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status = 'draft'`).run(userId, reqId, orgId);
    return r.changes > 0;
  }

  /** Descarta a requisição (humano decidiu que não vai comprar agora). */
  static dismiss(orgId: string, reqId: string): boolean {
    const r = db.prepare(`UPDATE purchase_requisitions SET status = 'dismissed' WHERE id = ? AND organization_id = ? AND status = 'draft'`).run(reqId, orgId);
    return r.changes > 0;
  }

  /** Pass do Scheduler: roda em todas as orgs com procurement_enabled. */
  static async pass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT organization_id, COALESCE(procurement_target_days,14) AS target FROM organization_settings WHERE COALESCE(procurement_enabled,0) = 1`).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const before = this.currentDraft(org.organization_id);
        const beforeCount = before ? this.itemsOf(before.id).length : 0;
        const r = this.syncDraft(org.organization_id, Math.max(1, parseInt(String(org.target), 10) || 14));
        // Notifica só quando o rascunho cresce (novo item entrou em falta).
        if (r && r.items > beforeCount) {
          NotificationService.lowStock(org.organization_id, `${r.items} item(ns)`, 0);
        }
      } catch (e) { console.error('[Supply] Falha no pass de reposição', org.organization_id, e); }
    }
  }
}
