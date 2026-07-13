/**
 * Retail Ops — Impact Ledger (valor COMPROVADO), ADR-085 (fatia só-leitura).
 *
 * Primeira fatia do Impact Ledger: prova, em R$, o valor que o ZappFlow já gerou
 * na operação — usando SÓ o que já está nas tabelas retail_* (sem esquema novo,
 * sem baseline, sem estimativa). Segue a guarda de honestidade do ADR-085 D4:
 * separa VALOR COMPROVADO (R$ efetivamente apurados) de ATIVIDADE (trabalho
 * automatizado, em contagem) — os dois NUNCA são somados num número só.
 *
 * As perdas evitadas, o tempo devolvido e o baseline do dia 0 ficam para fatias
 * futuras (dependem de premissas/decisão). O CAPITAL PARADO já entra aqui como
 * FATO (não estimativa): é o custo médio × quantidade em estoque no núcleo.
 * Só leitura agregada; isolado por organização.
 */
import db from "./db.js";

function num(v: any): number { return Number(v || 0); }
function money(v: number): number { return Math.round(v * 100) / 100; }

export class RetailImpactService {
  /** Impacto do MÊS ('YYYY-MM'): valor comprovado (R$) + atividade (contagens). */
  static monthly(orgId: string, month: string): any {
    const start = `${month}-01`, end = `${month}-31`;

    // ── VALOR COMPROVADO (R$) — dinheiro efetivamente apurado ──────────────────
    // Divergências de comissão apuradas (prévia × informado) — o gestor comparou
    // e o sistema apontou diferença real que seria paga a mais/menos.
    const comm = db.prepare(
      `SELECT COALESCE(SUM(ABS(ci.divergence_amount)),0) AS amount, COUNT(*) AS c
         FROM retail_commission_items ci
         JOIN retail_commission_runs r ON r.id = ci.run_id
        WHERE r.organization_id = ? AND r.period_start BETWEEN ? AND ?
          AND ci.divergence_amount IS NOT NULL AND ci.divergence_amount != 0`
    ).get(orgId, start, end) as any;

    // Divergência do fechamento informado × sistema externo (só quando há
    // conciliação — Fase E). system_total tem default 0; até a conciliação
    // popular um total real (> 0), isto fica em zero (não confundir "não
    // conciliado" com "vendeu zero").
    const recon = db.prepare(
      `SELECT COALESCE(SUM(ABS(informed_total - system_total)),0) AS amount, COUNT(*) AS c
         FROM retail_daily_closings
        WHERE organization_id = ? AND closing_date BETWEEN ? AND ?
          AND system_total IS NOT NULL AND system_total > 0 AND status != 'rejected'`
    ).get(orgId, start, end) as any;

    const commissionDivergences = { amount: money(num(comm?.amount)), count: num(comm?.c) };
    const systemReconciliation = { amount: money(num(recon?.amount)), count: num(recon?.c) };
    const totalProvenBRL = money(commissionDivergences.amount + systemReconciliation.amount);

    // ── ATIVIDADE (contagens) — trabalho automatizado, NÃO é R$ ─────────────────
    const closingsChecked = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_daily_closings
        WHERE organization_id = ? AND closing_date BETWEEN ? AND ? AND status IN ('received','extracted','approved')`
    ).get(orgId, start, end) as any)?.c);

    const remindersSent = num((db.prepare(
      `SELECT COALESCE(SUM(reminder_count),0) AS c FROM retail_store_daily_tasks
        WHERE organization_id = ? AND task_date BETWEEN ? AND ?`
    ).get(orgId, start, end) as any)?.c);

    const stockCorrections = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_stock_alerts
        WHERE organization_id = ? AND status = 'resolved' AND date(resolved_at) BETWEEN ? AND ?`
    ).get(orgId, start, end) as any)?.c);

    const openStockAlerts = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_stock_alerts WHERE organization_id = ? AND status = 'open'`
    ).get(orgId) as any)?.c);

    const storesMonitored = num((db.prepare(
      `SELECT COUNT(*) AS c FROM retail_stores WHERE organization_id = ? AND active = 1`
    ).get(orgId) as any)?.c);

    return {
      month,
      proven: {
        commissionDivergences,
        systemReconciliation,
        totalProvenBRL,
      },
      activity: {
        closingsChecked,
        remindersSent,
        stockCorrections,
        openStockAlerts,
        storesMonitored,
      },
      note: "Valor comprovado = R$ efetivamente apurados. Atividade = trabalho automatizado (contagem) — não somar aos R$. Estimativas e baseline entram em fatia futura (ADR-085).",
    };
  }

  /**
   * Capital PARADO em estoque + produtos SEM GIRO (ADR-085, fatia factual).
   * Não é estimativa: capital = custo médio × quantidade em estoque no núcleo.
   * "Sem giro" = tem saldo mas sem SAÍDA (venda) há `slowMoverDays` dias (ou
   * nunca) — o dinheiro que está parado sem girar. Agregado no nível da org
   * (o núcleo não tem dimensão de loja; ver ADR-084 D4). Isolado por org.
   */
  static stockCapital(orgId: string, slowMoverDays = 60): any {
    const days = Math.max(1, Math.floor(Number(slowMoverDays) || 60));

    const totals = db.prepare(
      `SELECT COALESCE(SUM(quantity_available * COALESCE(avg_cost,0)),0) AS cap, COUNT(*) AS n
         FROM inventory_items WHERE organization_id = ? AND quantity_available > 0`
    ).get(orgId) as any;

    const rows = db.prepare(
      `SELECT pid, vid, qty, cost, name, last_out FROM (
         SELECT ii.product_service_id AS pid, ii.variant_id AS vid, ii.quantity_available AS qty,
                COALESCE(ii.avg_cost,0) AS cost, ps.name AS name,
                (SELECT MAX(sm.created_at) FROM stock_movements sm
                   WHERE sm.organization_id = ii.organization_id
                     AND sm.product_service_id = ii.product_service_id
                     AND sm.type = 'saida') AS last_out
           FROM inventory_items ii
           LEFT JOIN products_services ps ON ps.id = ii.product_service_id
          WHERE ii.organization_id = ? AND ii.quantity_available > 0
       ) WHERE last_out IS NULL OR last_out < datetime('now', ?)
       ORDER BY (qty * cost) DESC`
    ).all(orgId, `-${days} days`) as any[];

    const slow = rows.map((r) => ({
      productId: r.pid,
      variantId: r.vid || null,
      name: r.name || null,
      quantity: num(r.qty),
      avgCost: money(num(r.cost)),
      capital: money(num(r.qty) * num(r.cost)),
      lastSaleAt: r.last_out || null,
    }));
    const slowMoverCapital = money(slow.reduce((a, s) => a + s.capital, 0));

    const MAX_LIST = 50;
    return {
      totalCapital: money(num(totals?.cap)),
      itemsInStock: num(totals?.n),
      slowMoverDays: days,
      slowMoverCount: slow.length,
      slowMoverCapital,
      slowMovers: slow.slice(0, MAX_LIST),
      slowMoversTruncated: slow.length > MAX_LIST,
      note: "Capital parado = custo médio × quantidade em estoque (fato, não estimativa). Sem giro = com saldo e sem saída há N dias. Agregado por organização (núcleo sem dimensão de loja).",
    };
  }
}
