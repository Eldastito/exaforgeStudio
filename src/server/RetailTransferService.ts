/**
 * Retail Ops — Transferência de estoque ENTRE LOJAS (ADR-083, Fase G).
 *
 * Move peças de uma loja para outra SEM perder o controle:
 *   - despachar → dá baixa na loja de ORIGEM e a transferência fica `in_transit`
 *     (as peças estão "na estrada", já saíram da origem mas não entraram no
 *     destino — não some do sistema);
 *   - receber → dá entrada na loja de DESTINO (a quantidade REALMENTE recebida,
 *     que pode diferir do enviado — a diferença fica registrada);
 *   - cancelar (em trânsito) → estorna a baixa da origem.
 *
 * Cada perna usa RetailInventoryService.applyMovement (estoque por loja, que
 * PODE ficar negativo e abre alerta) e roda numa transação única. Isolado por
 * organização, auditado. A sugestão da IA (Fase 2) só liga signal_id/
 * decision_action_id e chama `create` com source='ai_suggested'.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailInventoryService } from "./RetailInventoryService.js";
import { RetailStockPolicyService } from "./RetailStockPolicyService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { haversineKm } from "./geo.js";

type NewItem = { productId: string; variantId?: string | null; quantity: number };
type CreateInput = { originStoreId: string; destStoreId: string; note?: string; items: NewItem[]; source?: "manual" | "ai_suggested"; signalId?: string | null; decisionActionId?: string | null };

const int = (n: any) => Math.trunc(Number(n) || 0);

export class RetailTransferService {
  private static store(orgId: string, storeId: string): any {
    return db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, storeId);
  }

  /**
   * Cria e DESPACHA a transferência: valida, dá baixa na origem de cada item e
   * grava `in_transit`. Bloqueia enviar mais do que há na origem (não se
   * "transfere" peça que não existe — é aí que se perde o controle).
   */
  static create(orgId: string, input: CreateInput, actorId?: string): any {
    const origin = this.store(orgId, String(input.originStoreId || ""));
    const dest = this.store(orgId, String(input.destStoreId || ""));
    if (!origin) throw new Error("loja de origem inválida");
    if (!dest) throw new Error("loja de destino inválida");
    if (origin.id === dest.id) throw new Error("origem e destino não podem ser a mesma loja");

    const items = (Array.isArray(input.items) ? input.items : [])
      .map((it) => ({ productId: String(it.productId || ""), variantId: it.variantId ? String(it.variantId) : null, quantity: int(it.quantity) }))
      .filter((it) => it.productId && it.quantity > 0);
    if (!items.length) throw new Error("informe ao menos um item com quantidade > 0");

    // Valida disponibilidade na ORIGEM antes de mexer em qualquer estoque.
    for (const it of items) {
      const cur = RetailInventoryService.get(orgId, origin.id, it.productId, it.variantId);
      const avail = int(cur?.quantity_available);
      if (it.quantity > avail) throw new Error(`estoque insuficiente na origem para ${it.productId} (disponível ${avail}, pedido ${it.quantity})`);
    }

    const transferId = randomUUID();
    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO retail_stock_transfers (id, organization_id, origin_store_id, dest_store_id, status, source, signal_id, decision_action_id, note, created_by, dispatched_at)
         VALUES (?, ?, ?, ?, 'in_transit', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(transferId, orgId, origin.id, dest.id, input.source || "manual", input.signalId || null, input.decisionActionId || null, input.note || null, actorId || null);
      const insItem = db.prepare(
        `INSERT INTO retail_stock_transfer_items (id, organization_id, transfer_id, product_service_id, variant_id, quantity_sent) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const it of items) {
        insItem.run(randomUUID(), orgId, transferId, it.productId, it.variantId, it.quantity);
        // Baixa na ORIGEM (delta negativo).
        RetailInventoryService.applyMovement(orgId, origin.id, it.productId, it.variantId, -it.quantity, actorId);
      }
    });
    run();
    try { logAuthEvent(orgId, actorId || "system", transferId, "RETAIL_TRANSFER_DISPATCH", { origin: origin.id, dest: dest.id, items: items.length }); } catch { /* noop */ }
    return this.get(orgId, transferId);
  }

  /**
   * RECEBE a transferência no destino: dá entrada da quantidade recebida (por
   * padrão, o enviado; ou o informado por item na conferência) e fecha como
   * `received`. Idempotente por estado (só age em 'in_transit').
   */
  static receive(orgId: string, transferId: string, opts: { items?: Array<{ itemId: string; quantityReceived: number }> } = {}, actorId?: string): any {
    const t = db.prepare(`SELECT * FROM retail_stock_transfers WHERE organization_id = ? AND id = ?`).get(orgId, transferId) as any;
    if (!t) throw new Error("transferência não encontrada");
    if (t.status !== "in_transit") throw new Error(`transferência não está em trânsito (status: ${t.status})`);
    const rows = db.prepare(`SELECT * FROM retail_stock_transfer_items WHERE organization_id = ? AND transfer_id = ?`).all(orgId, transferId) as any[];
    const override = new Map((opts.items || []).map((i) => [String(i.itemId), int(i.quantityReceived)]));

    const run = db.transaction(() => {
      for (const it of rows) {
        const recv = override.has(it.id) ? Math.max(0, override.get(it.id)!) : int(it.quantity_sent);
        db.prepare(`UPDATE retail_stock_transfer_items SET quantity_received = ? WHERE id = ?`).run(recv, it.id);
        if (recv > 0) RetailInventoryService.applyMovement(orgId, t.dest_store_id, it.product_service_id, it.variant_id, recv, actorId);
      }
      db.prepare(`UPDATE retail_stock_transfers SET status = 'received', received_by = ?, received_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(actorId || null, transferId);
    });
    run();
    try { logAuthEvent(orgId, actorId || "system", transferId, "RETAIL_TRANSFER_RECEIVE", { dest: t.dest_store_id }); } catch { /* noop */ }
    return this.get(orgId, transferId);
  }

  /** Cancela uma transferência EM TRÂNSITO: estorna a baixa da origem. */
  static cancel(orgId: string, transferId: string, actorId?: string): any {
    const t = db.prepare(`SELECT * FROM retail_stock_transfers WHERE organization_id = ? AND id = ?`).get(orgId, transferId) as any;
    if (!t) throw new Error("transferência não encontrada");
    if (t.status !== "in_transit") throw new Error(`só é possível cancelar em trânsito (status: ${t.status})`);
    const rows = db.prepare(`SELECT * FROM retail_stock_transfer_items WHERE organization_id = ? AND transfer_id = ?`).all(orgId, transferId) as any[];
    const run = db.transaction(() => {
      for (const it of rows) {
        // Estorna a baixa na ORIGEM (as peças não saíram de fato).
        RetailInventoryService.applyMovement(orgId, t.origin_store_id, it.product_service_id, it.variant_id, int(it.quantity_sent), actorId);
      }
      db.prepare(`UPDATE retail_stock_transfers SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(transferId);
    });
    run();
    try { logAuthEvent(orgId, actorId || "system", transferId, "RETAIL_TRANSFER_CANCEL", {}); } catch { /* noop */ }
    return this.get(orgId, transferId);
  }

  /**
   * Cria a transferência a partir de um SINAL de sugestão da IA
   * (`retail_transfer_suggested`): lê origem/destino/produto/variante e a
   * quantidade sugerida da evidência, despacha (baixa na origem) marcando
   * source='ai_suggested' + o vínculo com o sinal/ação, e RESOLVE o sinal (a
   * oportunidade passou a ser tratada). Fase 2 do maestro de transferências.
   */
  static fromSignal(orgId: string, signalId: string, actorId?: string, decisionActionId?: string | null): any {
    const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND id = ?`).get(orgId, signalId) as any;
    if (!sig) throw new Error("sinal não encontrado");
    if (sig.signal_type !== "retail_transfer_suggested") throw new Error("o sinal não é uma sugestão de transferência");
    let ev: any = {};
    try { ev = JSON.parse(sig.evidence_json || "{}"); } catch { ev = {}; }
    const qty = Math.max(1, int(ev.quantitySuggested) || 1);
    const t = this.create(orgId, {
      originStoreId: ev.originStoreId, destStoreId: ev.destStoreId,
      items: [{ productId: ev.productId, variantId: ev.variantId, quantity: qty }],
      source: "ai_suggested", signalId, decisionActionId: decisionActionId || null,
      note: "Sugestão da IA — reposição da grade (loja com sobra → loja com falta)",
    }, actorId);
    try { BusinessSignalService.resolve(orgId, signalId); } catch { /* noop */ }
    return t;
  }

  static get(orgId: string, transferId: string): any | null {
    const t = db.prepare(
      `SELECT t.*, so.name AS origin_store, sd.name AS dest_store
         FROM retail_stock_transfers t
         LEFT JOIN retail_stores so ON so.id = t.origin_store_id
         LEFT JOIN retail_stores sd ON sd.id = t.dest_store_id
        WHERE t.organization_id = ? AND t.id = ?`
    ).get(orgId, transferId) as any;
    if (!t) return null;
    t.items = db.prepare(
      `SELECT i.*, p.name AS product_name, COALESCE(v.name, '—') AS variant_name, v.size, v.color
         FROM retail_stock_transfer_items i
         LEFT JOIN products_services p ON p.id = i.product_service_id
         LEFT JOIN product_variants v ON v.id = i.variant_id
        WHERE i.organization_id = ? AND i.transfer_id = ?`
    ).all(orgId, transferId) as any[];
    return t;
  }

  /**
   * Sugere o MELHOR HORÁRIO para separar/despachar a transferência: a hora mais
   * TRANQUILA da loja (menos vendas no PDV), dentro do horário em que ela opera.
   * Baseado em dados (retail_pdv_sales, casado pela `filial` = código da loja);
   * cai num padrão sensato quando não há histórico. Determinístico.
   */
  static suggestBestWindow(orgId: string, storeCode?: string | null): string {
    const fallback = "início da manhã, antes do movimento";
    const code = String(storeCode || "").trim();
    if (!code) return fallback;
    const rows = db.prepare(
      `SELECT CAST(substr(sale_time, 1, 2) AS INTEGER) AS h, COUNT(*) AS n
         FROM retail_pdv_sales
        WHERE organization_id = ? AND filial = ? AND sale_time IS NOT NULL AND sale_time <> ''
          AND sale_date >= date('now', '-60 days')
        GROUP BY h`
    ).all(orgId, code) as any[];
    let bestH: number | null = null, bestN = Infinity;
    for (const r of rows) {
      const h = Number(r.h);
      if (!Number.isFinite(h) || h < 6 || h > 22) continue; // só horas de operação plausíveis
      if (Number(r.n) < bestN) { bestN = Number(r.n); bestH = h; }
    }
    if (bestH == null) return fallback;
    return `por volta das ${String(bestH).padStart(2, "0")}h (horário mais tranquilo da loja)`;
  }

  /**
   * REPOSIÇÃO da grade (PRD Moda/TOULON, INV-005): loja que TRABALHA o produto
   * (tem outros tamanhos com saldo) mas está ZERADA numa variação que outra loja
   * tem sobrando → sugestão de transferência entre filiais. Enriquece cada
   * sugestão com:
   *  - identificação da peça (referência, EAN, unidade, cor, tamanho);
   *  - saldo da loja NECESSITADA + mínimo/meta/falta (política, se houver);
   *  - saldo da DOADORA + TRANSFERÍVEL = max(saldo doadora − mínimo da doadora, 0)
   *    (RN nº 4: a doadora não fica abaixo do mínimo dela). Sem política de
   *    doadora, todo o excedente é considerado transferível (min desconhecido).
   *  - distância (mais próximas primeiro) e melhor horário da doadora.
   * Determinístico, isolado por organização.
   */
  static replenishmentSuggestions(orgId: string, opts: { minDonor?: number; limit?: number } = {}): { count: number; suggestions: any[] } {
    const minDonor = Math.max(1, int(opts.minDonor) || 2);
    const limit = Math.min(500, Math.max(10, int(opts.limit) || 200));
    const rows = db.prepare(`
      WITH carrier AS (
        SELECT rsi.store_id, rsi.product_service_id,
               SUM(CASE WHEN rsi.quantity_available > 0 THEN rsi.quantity_available ELSE 0 END) AS tot
          FROM retail_store_inventory rsi
          JOIN retail_stores s ON s.id = rsi.store_id AND s.active = 1
         WHERE rsi.organization_id = ?
         GROUP BY rsi.store_id, rsi.product_service_id
        HAVING tot > 0
      )
      SELECT p.name AS product_name, p.external_ref AS product_external_ref, p.default_uom AS product_uom,
             COALESCE(v.name, '—') AS variant_name, v.size, v.color,
             v.external_ref AS variant_sku, COALESCE(v.sku, p.ean) AS variant_ean,
             sn.name AS needy_store, sd.name AS donor_store, sd.code AS donor_code, d.quantity_available AS donor_qty,
             c.store_id AS needy_store_id, d.store_id AS donor_store_id,
             d.product_service_id, d.variant_id,
             COALESCE(n.quantity_available, 0) AS needy_qty,
             sn.latitude AS needy_lat, sn.longitude AS needy_lng, sd.latitude AS donor_lat, sd.longitude AS donor_lng
        FROM retail_store_inventory d
        JOIN retail_stores sd ON sd.id = d.store_id AND sd.active = 1
        JOIN carrier c ON c.product_service_id = d.product_service_id AND c.store_id <> d.store_id
        JOIN retail_stores sn ON sn.id = c.store_id
        JOIN products_services p ON p.id = d.product_service_id
        LEFT JOIN product_variants v ON v.id = d.variant_id
        LEFT JOIN retail_store_inventory n ON n.store_id = c.store_id AND n.product_service_id = d.product_service_id AND COALESCE(n.variant_id, '') = COALESCE(d.variant_id, '')
       WHERE d.organization_id = ? AND d.quantity_available >= ? AND d.variant_id IS NOT NULL AND d.variant_id <> ''
         AND COALESCE(n.quantity_available, 0) <= 0
       ORDER BY d.quantity_available DESC, p.name ASC
       LIMIT ?
    `).all(orgId, orgId, minDonor, limit) as any[];

    const orgHasPolicies = RetailStockPolicyService.hasAny(orgId);
    const timeCache = new Map<string, string>();
    const suggestions = rows.map((r) => {
      const dist = haversineKm(r.needy_lat, r.needy_lng, r.donor_lat, r.donor_lng);
      const code = String(r.donor_code || "");
      if (!timeCache.has(code)) timeCache.set(code, this.suggestBestWindow(orgId, code));

      // Necessitada: meta/falta pela política dela.
      const needyPol = orgHasPolicies ? RetailStockPolicyService.resolve(orgId, r.needy_store_id, r.product_service_id, r.variant_id) : null;
      const needyQ = RetailStockPolicyService.computeQuantities(int(r.needy_qty), needyPol);
      // Doadora: transferível preservando o mínimo dela (sem política → excedente todo).
      const donorPol = orgHasPolicies ? RetailStockPolicyService.resolve(orgId, r.donor_store_id, r.product_service_id, r.variant_id) : null;
      const donorMin = donorPol ? donorPol.min_qty : 0;
      const transferable_qty = Math.max(int(r.donor_qty) - donorMin, 0);

      const { needy_lat, needy_lng, donor_lat, donor_lng, ...rest } = r;
      return {
        ...rest,
        needy_current_qty: int(r.needy_qty),
        needy_min_qty: needyQ.min_qty,
        needy_target_qty: needyQ.target_qty,
        shortage_qty: needyQ.shortage_qty,
        qty_to_zero: needyQ.qty_to_zero,
        donor_min_qty: donorPol ? donorMin : null,
        transferable_qty,
        distance_km: Number.isFinite(dist) ? dist : null,
        best_time: timeCache.get(code),
      };
    }).sort((a, b) => (a.distance_km == null ? Infinity : a.distance_km) - (b.distance_km == null ? Infinity : b.distance_km));
    return { count: suggestions.length, suggestions };
  }

  static list(orgId: string, opts: { status?: string; limit?: number; offset?: number } = {}): any[] {
    const where: string[] = ["t.organization_id = ?"];
    const args: any[] = [orgId];
    if (opts.status) { where.push("t.status = ?"); args.push(opts.status); }
    const limit = Math.min(500, Math.max(1, int(opts.limit) || 100));
    const offset = Math.max(0, int(opts.offset) || 0);
    return db.prepare(
      `SELECT t.*, so.name AS origin_store, sd.name AS dest_store,
              (SELECT COUNT(*) FROM retail_stock_transfer_items i WHERE i.transfer_id = t.id) AS item_count,
              (SELECT COALESCE(SUM(quantity_sent), 0) FROM retail_stock_transfer_items i WHERE i.transfer_id = t.id) AS total_sent
         FROM retail_stock_transfers t
         LEFT JOIN retail_stores so ON so.id = t.origin_store_id
         LEFT JOIN retail_stores sd ON sd.id = t.dest_store_id
        WHERE ${where.join(" AND ")}
        ORDER BY CASE t.status WHEN 'in_transit' THEN 0 ELSE 1 END, t.dispatched_at DESC
        LIMIT ${limit} OFFSET ${offset}`
    ).all(...args) as any[];
  }

  /** Total de transferências (para paginação), com o mesmo filtro de status. */
  static count(orgId: string, opts: { status?: string } = {}): number {
    const where: string[] = ["organization_id = ?"];
    const args: any[] = [orgId];
    if (opts.status) { where.push("status = ?"); args.push(opts.status); }
    return Number((db.prepare(`SELECT COUNT(*) c FROM retail_stock_transfers WHERE ${where.join(" AND ")}`).get(...args) as any)?.c || 0);
  }
}
