/**
 * Retail Ops — Dashboard + acumulado mensal + export (ADR-083, Fase H).
 *
 * Amarra A–G numa visão só: os cards do dia (cota/realizado/desvio, pendências,
 * divergências, estoque negativo, premiação estimada) e o acumulado do mês
 * (por loja) com as linhas prontas para exportar (Google Sheets/CSV). Só
 * LEITURA agregada das tabelas retail_*; isolado por organização.
 */
import db from "./db.js";
import { RetailCommissionService } from "./RetailCommissionService.js";

function num(v: any): number { return Number(v || 0); }

export class RetailDashboardService {
  /** Painel do DIA. */
  static daily(orgId: string, date: string): any {
    const quotaTotal = num((db.prepare(`SELECT COALESCE(SUM(quota_amount),0) AS s FROM retail_store_quotas WHERE organization_id = ? AND quota_date = ?`).get(orgId, date) as any)?.s);
    const realized = num((db.prepare(`SELECT COALESCE(SUM(informed_total),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND closing_date = ? AND status != 'rejected'`).get(orgId, date) as any)?.s);

    // Lojas acima/abaixo da cota (compara o fechamento do dia com a cota do dia).
    const cmp = db.prepare(
      `SELECT c.store_id, c.informed_total, COALESCE(q.quota_amount,0) AS quota
         FROM retail_daily_closings c
    LEFT JOIN retail_store_quotas q ON q.organization_id = c.organization_id AND q.store_id = c.store_id AND q.quota_date = c.closing_date
        WHERE c.organization_id = ? AND c.closing_date = ? AND c.status != 'rejected'`
    ).all(orgId, date) as any[];
    let storesAbove = 0, storesBelow = 0;
    for (const r of cmp) { if (num(r.informed_total) >= num(r.quota)) storesAbove++; else storesBelow++; }

    const pend = db.prepare(
      `SELECT task_type, COUNT(*) AS c FROM retail_store_daily_tasks WHERE organization_id = ? AND task_date = ? AND status IN ('pending','late') GROUP BY task_type`
    ).all(orgId, date) as any[];
    const pendBy: Record<string, number> = { fechamento: 0, malote: 0, escala: 0 };
    for (const p of pend) pendBy[p.task_type] = p.c;

    const divergences = num((db.prepare(`SELECT COUNT(*) AS c FROM retail_daily_closings WHERE organization_id = ? AND closing_date = ? AND divergence_status = 'divergent'`).get(orgId, date) as any)?.c);
    const negativeStock = num((db.prepare(`SELECT COUNT(*) AS c FROM retail_store_inventory WHERE organization_id = ? AND quantity_available < 0`).get(orgId) as any)?.c);
    const activeStores = num((db.prepare(`SELECT COUNT(*) AS c FROM retail_stores WHERE organization_id = ? AND active = 1`).get(orgId) as any)?.c);

    return {
      date,
      quotaTotal, realized, variance: realized - quotaTotal,
      variancePercent: quotaTotal > 0 ? ((realized - quotaTotal) / quotaTotal) * 100 : 0,
      activeStores, storesAbove, storesBelow,
      pendingClosings: pendBy.fechamento, pendingMalote: pendBy.malote, pendingScale: pendBy.escala,
      divergences, negativeStock,
    };
  }

  /**
   * INFORME DIÁRIO DA REDE (pedido do lojista — padrão do "Informe Diário" do
   * Brunno): por loja (dinheiro, venda, cota, bateu/faltou e a cota do DIA
   * SEGUINTE) MAIS o TOTAL da empresa, com o total ainda ABERTO por forma de
   * pagamento (dinheiro, PIX e cartão POR BANDEIRA) — pra facilitar a
   * conferência. Só leitura, isolado por org. Lista TODAS as lojas ativas
   * (loja sem fechamento aparece com venda 0).
   */
  static dailyInforme(orgId: string, date: string): any {
    const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
    const nextDate = new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const closings = db.prepare(
      `SELECT store_id, informed_total, quota_amount, details_json
         FROM retail_daily_closings WHERE organization_id = ? AND closing_date = ? AND status != 'rejected'`
    ).all(orgId, date) as any[];
    const byStore = new Map(closings.map((c) => [c.store_id, c]));
    const quotaToday = new Map((db.prepare(`SELECT store_id, quota_amount FROM retail_store_quotas WHERE organization_id = ? AND quota_date = ?`).all(orgId, date) as any[]).map((q) => [q.store_id, num(q.quota_amount)]));
    const quotaNext = new Map((db.prepare(`SELECT store_id, quota_amount FROM retail_store_quotas WHERE organization_id = ? AND quota_date = ?`).all(orgId, nextDate) as any[]).map((q) => [q.store_id, num(q.quota_amount)]));

    // Acumuladores da forma de pagamento (total da empresa).
    const credito: Record<string, number> = {}, debito: Record<string, number> = {};
    let tDinheiro = 0, tPix = 0, tVoucher = 0, tTroca = 0, tOutros = 0, tCredito = 0, tDebito = 0;

    const rows = stores.map((s) => {
      const c = byStore.get(s.id);
      const venda = c ? num(c.informed_total) : 0;
      // Cota do dia: snapshot do fechamento; senão a cota viva da loja.
      const cota = c && num(c.quota_amount) > 0 ? num(c.quota_amount) : (quotaToday.get(s.id) || 0);
      let dinheiro = 0;
      if (c?.details_json) {
        try {
          const d = JSON.parse(c.details_json) || {};
          dinheiro = num(d.dinheiro);
          tDinheiro += num(d.dinheiro); tPix += num(d.pix); tVoucher += num(d.voucher); tTroca += num(d.troca); tOutros += num(d.outros);
          for (const [k, v] of Object.entries(d.credito || {})) { credito[k] = r2((credito[k] || 0) + num(v)); tCredito += num(v); }
          for (const [k, v] of Object.entries(d.debito || {})) { debito[k] = r2((debito[k] || 0) + num(v)); tDebito += num(v); }
        } catch { /* fechamento sem detalhe: só o total (informed_total) entra */ }
      }
      return { storeId: s.id, storeName: s.name, dinheiro: r2(dinheiro), venda: r2(venda), cota: r2(cota), desvio: r2(venda - cota), cotaNext: r2(quotaNext.get(s.id) || 0), hasClosing: !!c };
    });

    const totalVenda = r2(rows.reduce((a, r) => a + r.venda, 0));
    const totalCota = r2(rows.reduce((a, r) => a + r.cota, 0));
    return {
      date, nextDate, stores: rows,
      total: {
        dinheiro: r2(tDinheiro), venda: totalVenda, cota: totalCota, desvio: r2(totalVenda - totalCota),
        cotaNext: r2(rows.reduce((a, r) => a + r.cotaNext, 0)),
        byMethod: { dinheiro: r2(tDinheiro), pix: r2(tPix), voucher: r2(tVoucher), troca: r2(tTroca), outros: r2(tOutros), credito, debito, totalCredito: r2(tCredito), totalDebito: r2(tDebito) },
      },
    };
  }

  /** Acumulado do MÊS ('YYYY-MM'). */
  static monthly(orgId: string, month: string): any {
    const start = `${month}-01`;
    const end = `${month}-31`; // datas são strings YYYY-MM-DD; BETWEEN cobre o mês
    const totalSales = num((db.prepare(`SELECT COALESCE(SUM(informed_total),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND closing_date BETWEEN ? AND ? AND status != 'rejected'`).get(orgId, start, end) as any)?.s);
    const perStore = db.prepare(
      `SELECT c.store_id, s.name AS store_name,
              COALESCE(SUM(c.informed_total),0) AS sales,
              COUNT(*) AS closings
         FROM retail_daily_closings c JOIN retail_stores s ON s.id = c.store_id
        WHERE c.organization_id = ? AND c.closing_date BETWEEN ? AND ? AND c.status != 'rejected'
        GROUP BY c.store_id ORDER BY sales DESC`
    ).all(orgId, start, end) as any[];
    const closingsCount = num((db.prepare(`SELECT COUNT(*) AS c FROM retail_daily_closings WHERE organization_id = ? AND closing_date BETWEEN ? AND ?`).get(orgId, start, end) as any)?.c);
    const commissionEstimate = RetailCommissionService.estimateTotal(orgId, start, end);
    return { month, totalSales, closingsCount, commissionEstimate, perStore };
  }

  /** Linhas do mês para EXPORT (Google Sheets/CSV): Data, Loja, Status, Cota, Informado, Desvio. */
  static monthlyClosingRows(orgId: string, month: string): any[][] {
    const start = `${month}-01`, end = `${month}-31`;
    const rows = db.prepare(
      `SELECT c.closing_date, s.name AS store_name, c.status, c.quota_amount, c.informed_total, c.variance_amount
         FROM retail_daily_closings c JOIN retail_stores s ON s.id = c.store_id
        WHERE c.organization_id = ? AND c.closing_date BETWEEN ? AND ?
        ORDER BY c.closing_date, s.name`
    ).all(orgId, start, end) as any[];
    const header = ["Data", "Loja", "Status", "Cota", "Informado", "Desvio"];
    return [header, ...rows.map((r) => [r.closing_date, r.store_name, r.status, num(r.quota_amount), num(r.informed_total), num(r.variance_amount)])];
  }
}
