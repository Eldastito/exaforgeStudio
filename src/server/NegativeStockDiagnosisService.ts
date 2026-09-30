/**
 * NegativeStockDiagnosisService — "por que está negativo?" por OCORRÊNCIA, agrupado (PRD Fase 1, F1.3).
 *
 * Antes: a tela listava 231 itens negativos e 4 causas genéricas em texto fixo. Agora: cada saldo negativo é
 * classificado pela causa que os DADOS provam e o resultado vem agrupado ("231 ocorrências em 4 lojas, 3 causas").
 * READ-ONLY, derivado por query (RN-004), sem tabela. Só classifica o que prova; o resto é `unknown` (resposta válida —
 * nunca chuta a causa). Precedência (a primeira que se prova vence):
 *  1. `transfer_in_transit` — há transferência A CAMINHO pra esta loja com o produto (mercadoria ainda não recebida);
 *  2. `no_entry_registered` — o produto não tem NENHUMA entrada/transferência registrada no estoque central (venda
 *     sem entrada lançada). Atenção: é por produto na organização (o histórico de movimento não é por loja);
 *  3. `stale_balance` — saldo negativo sem atualização há ≥ 30 dias (divergência de contagem/inventário parada);
 *  4. `unknown` — sem evidência.
 * Isola por organization_id.
 */
import db from "./db.js";

export type NegativeCause = "transfer_in_transit" | "no_entry_registered" | "stale_balance" | "unknown";
const STALE_DAYS = 30;

export const CAUSE_LABEL: Record<NegativeCause, string> = {
  transfer_in_transit: "Transferência a caminho ainda não recebida",
  no_entry_registered: "Produto sem nenhuma entrada lançada no estoque",
  stale_balance: `Saldo parado há mais de ${STALE_DAYS} dias (provável divergência de contagem)`,
  unknown: "Causa não identificada pelos dados",
};

export type NegativeDiagnosis = {
  total: number; storeCount: number; causeCount: number;          // causeCount = causas IDENTIFICADAS (sem contar unknown)
  byCause: Array<{ cause: NegativeCause; label: string; count: number; stores: Array<{ storeId: string; storeName: string; count: number }> }>;
  headline: string | null;
};

export class NegativeStockDiagnosisService {
  static diagnose(orgId: string, opts: { storeId?: string | null; restrictStoreIds?: string[]; now?: Date } = {}): NegativeDiagnosis {
    const nowMs = (opts.now || new Date()).getTime();
    let rows = db.prepare(
      `SELECT i.store_id, s.name AS store_name, i.product_service_id AS pid, i.variant_id, i.updated_at
         FROM retail_store_inventory i
         JOIN retail_stores s ON s.organization_id = i.organization_id AND s.id = i.store_id
        WHERE i.organization_id = ? AND i.quantity_available < 0${opts.storeId ? " AND i.store_id = ?" : ""}`,
    ).all(...(opts.storeId ? [orgId, opts.storeId] : [orgId])) as any[];
    if (opts.restrictStoreIds) { const ok = new Set(opts.restrictStoreIds); rows = rows.filter((r) => ok.has(r.store_id)); }   // trava de loja por usuário (ADR-173)
    if (!rows.length) return { total: 0, storeCount: 0, causeCount: 0, byCause: [], headline: null };

    const inTransit = new Set((db.prepare(
      `SELECT t.dest_store_id AS store_id, it.product_service_id AS pid FROM retail_stock_transfers t
         JOIN retail_stock_transfer_items it ON it.organization_id = t.organization_id AND it.transfer_id = t.id
        WHERE t.organization_id = ? AND t.status = 'in_transit'`,
    ).all(orgId) as any[]).map((r) => `${r.store_id}|${r.pid}`));
    const withEntry = new Set((db.prepare(
      `SELECT DISTINCT product_service_id AS pid FROM stock_movements WHERE organization_id = ? AND type IN ('entrada', 'transferencia')`,
    ).all(orgId) as any[]).map((r) => r.pid));

    const groups = new Map<NegativeCause, Map<string, { name: string; n: number }>>();
    const stores = new Set<string>();
    for (const r of rows) {
      stores.add(r.store_id);
      let cause: NegativeCause = "unknown";
      if (inTransit.has(`${r.store_id}|${r.pid}`)) cause = "transfer_in_transit";
      else if (!withEntry.has(r.pid)) cause = "no_entry_registered";
      else {
        const t = Date.parse(String(r.updated_at || "").replace(" ", "T") + (String(r.updated_at || "").includes("Z") ? "" : "Z"));
        if (Number.isFinite(t) && nowMs - t >= STALE_DAYS * 86400000) cause = "stale_balance";
      }
      if (!groups.has(cause)) groups.set(cause, new Map());
      const g = groups.get(cause)!;
      const cur = g.get(r.store_id) || { name: r.store_name, n: 0 };
      cur.n += 1; g.set(r.store_id, cur);
    }
    const byCause = Array.from(groups.entries()).map(([cause, m]) => {
      const st = Array.from(m.entries()).map(([storeId, v]) => ({ storeId, storeName: v.name, count: v.n })).sort((a, b) => b.count - a.count);
      return { cause, label: CAUSE_LABEL[cause], count: st.reduce((a, x) => a + x.count, 0), stores: st };
    }).sort((a, b) => (a.cause === "unknown" ? 1 : b.cause === "unknown" ? -1 : b.count - a.count));
    const causeCount = byCause.filter((c) => c.cause !== "unknown").length;
    const total = rows.length;
    const unknown = byCause.find((c) => c.cause === "unknown")?.count || 0;
    const headline = `${total} ocorrência${total === 1 ? "" : "s"} em ${stores.size} loja${stores.size === 1 ? "" : "s"}` +
      (causeCount ? ` · ${causeCount} causa${causeCount === 1 ? "" : "s"} identificada${causeCount === 1 ? "" : "s"}` : " · nenhuma causa identificada") +
      (unknown ? ` · ${unknown} sem causa provada` : "");
    return { total, storeCount: stores.size, causeCount, byCause, headline };
  }
}

export default NegativeStockDiagnosisService;
