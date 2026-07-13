/**
 * Retail Ops — Impact Ledger (valor COMPROVADO), ADR-085 (fatia só-leitura).
 *
 * Primeira fatia do Impact Ledger: prova, em R$, o valor que o ZappFlow já gerou
 * na operação — usando SÓ o que já está nas tabelas retail_* (sem esquema novo,
 * sem baseline, sem estimativa). Segue a guarda de honestidade do ADR-085 D4:
 * separa VALOR COMPROVADO (R$ efetivamente apurados) de ATIVIDADE (trabalho
 * automatizado, em contagem) — os dois NUNCA são somados num número só.
 *
 * O "valor estimado" (capital parado, perdas evitadas, tempo devolvido) e o
 * baseline do dia 0 ficam para fatias futuras, pois dependem de premissas/decisão.
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
}
