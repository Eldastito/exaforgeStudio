/**
 * Retail Floor — Indicadores da loja (ADR-150, Fatia 9 — a última).
 *
 * O painel do gerente com o que o módulo mediu no período. Regras duras:
 *  - Conversão SEMPRE em dois números rotulados: `declared` (o vendedor
 *    disse) e `confirmed` (o PDV sustentou, pós-Fatia 6) — nunca um número
 *    único ambíguo (RN-150-004). Denominador exclui `unknown` (atendimento
 *    auto-encerrado não é sucesso nem fracasso).
 *  - Quebra por vendedor traz CONTAGENS e tempos, com a conversão confirmada
 *    junto — mas a resposta carrega `inCalibration`: enquanto
 *    settings.calibration_until vigora, a UI avisa que NADA disso alimenta
 *    cobrança/comissão (RN-150-011, prioridade 7 do PRD). Não publicamos
 *    ranking — a ordem é alfabética de propósito (RN-150-006).
 *  - Todo tempo é derivado de timestamps server-side (RN-150-002).
 *  - Escopo: analytics da loja é de GESTOR da loja (RN-150-005).
 *  - RN-150-001: orgId 1º arg; tudo filtra organization_id.
 */
import db from "./db.js";
import { RetailFloorSettingsService } from "./RetailFloorService.js";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct1 = (num: number, den: number) => (den > 0 ? round1((num / den) * 100) : null);

export class RetailFloorAnalyticsService {
  /** Indicadores da loja no período [start..end] (YYYY-MM-DD, inclusivo). */
  static store(orgId: string, storeId: string, start: string, end: string): any {
    for (const d of [start, end]) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) throw new Error("start/end devem ser YYYY-MM-DD.");
    const store = db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");

    const atts = db.prepare(
      `SELECT a.seller_id, s.name AS seller_name, s.matricula, a.outcome, a.reconciliation_state, a.declared_value,
              a.started_at,
              CASE WHEN a.ended_at IS NOT NULL THEN (strftime('%s', a.ended_at) - strftime('%s', a.started_at)) / 60.0 END AS minutes,
              CAST(strftime('%H', a.started_at) AS INTEGER) AS hour
         FROM retail_floor_attendances a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND date(a.started_at) >= ? AND date(a.started_at) <= ?`
    ).all(orgId, storeId, start, end) as any[];

    // Denominador de conversão: desfecho conhecido (exclui unknown e ativos).
    const decided = atts.filter((a) => a.outcome && a.outcome !== "unknown");
    const declared = decided.filter((a) => a.outcome === "converted");
    const confirmed = declared.filter((a) => a.reconciliation_state === "confirmed");
    const unmatched = declared.filter((a) => a.reconciliation_state === "unmatched");
    const pending = declared.filter((a) => a.reconciliation_state === "pending");
    const ended = atts.filter((a) => a.minutes != null);

    const byOutcome: Record<string, number> = {};
    for (const a of atts) if (a.outcome) byOutcome[a.outcome] = (byOutcome[a.outcome] || 0) + 1;

    // Por vendedor — ordem ALFABÉTICA (não é ranking; RN-150-006).
    const sellerMap = new Map<string, any>();
    for (const a of atts) {
      if (!sellerMap.has(a.seller_id)) sellerMap.set(a.seller_id, { sellerId: a.seller_id, sellerName: a.seller_name || a.matricula, attendances: 0, declared: 0, confirmed: 0, minutesSum: 0, endedCount: 0 });
      const r = sellerMap.get(a.seller_id);
      r.attendances++;
      if (a.outcome === "converted") { r.declared++; if (a.reconciliation_state === "confirmed") r.confirmed++; }
      if (a.minutes != null) { r.minutesSum += Number(a.minutes); r.endedCount++; }
    }
    const bySeller = [...sellerMap.values()]
      .map((r) => ({
        sellerId: r.sellerId, sellerName: r.sellerName, attendances: r.attendances,
        declared: r.declared, confirmed: r.confirmed,
        avgMinutes: r.endedCount ? round1(r.minutesSum / r.endedCount) : null,
      }))
      .sort((a, b) => String(a.sellerName).localeCompare(String(b.sellerName)));

    // Pareto de perdas: motivos de não conversão (nível 1 + detalhe de produto).
    const lossRows = db.prepare(
      `SELECT outcome_reason_json FROM retail_floor_attendances
        WHERE organization_id = ? AND store_id = ? AND date(started_at) >= ? AND date(started_at) <= ?
          AND outcome = 'not_converted' AND outcome_reason_json IS NOT NULL`
    ).all(orgId, storeId, start, end) as any[];
    const lossCount = new Map<string, number>();
    for (const r of lossRows) {
      try {
        const j = JSON.parse(r.outcome_reason_json);
        const key = j.category === "product" && j.productDetail?.reason ? `product:${j.productDetail.reason}` : j.category;
        lossCount.set(key, (lossCount.get(key) || 0) + 1);
      } catch { /* linha malformada não derruba o painel */ }
    }
    const lossPareto = [...lossCount.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

    // Top rupturas evidenciadas (unmet_demand da Fatia 5).
    const topUnmet = db.prepare(
      `SELECT COALESCE(p.name, u.ean, '?') AS item, u.reason, COUNT(*) AS n
         FROM retail_floor_unmet_demand u
         LEFT JOIN products_services p ON p.id = u.product_id AND p.organization_id = u.organization_id
        WHERE u.organization_id = ? AND u.store_id = ? AND date(u.created_at) >= ? AND date(u.created_at) <= ?
        GROUP BY item, u.reason ORDER BY n DESC LIMIT 10`
    ).all(orgId, storeId, start, end) as any[];

    // Atendimentos por hora de início (escala/pico).
    const hourMap = new Map<number, number>();
    for (const a of atts) hourMap.set(Number(a.hour), (hourMap.get(Number(a.hour)) || 0) + 1);
    const byHour = [...hourMap.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour);

    const settings = RetailFloorSettingsService.get(orgId);
    return {
      storeId, storeName: store.name, start, end,
      inCalibration: RetailFloorSettingsService.inCalibration(orgId),
      calibrationUntil: settings.calibrationUntil,
      totals: {
        attendances: atts.length,
        decided: decided.length,
        byOutcome,
        declaredCount: declared.length,
        confirmedCount: confirmed.length,
        unmatchedCount: unmatched.length,
        pendingCount: pending.length,
        // Dois números, sempre rotulados (RN-150-004).
        conversionDeclaredPct: pct1(declared.length, decided.length),
        conversionConfirmedPct: pct1(confirmed.length, decided.length),
        avgServiceMinutes: ended.length ? round1(ended.reduce((acc, a) => acc + Number(a.minutes), 0) / ended.length) : null,
        confirmedValue: round2(confirmed.reduce((acc, a) => acc + Number(a.declared_value || 0), 0)),
      },
      bySeller, lossPareto, topUnmet: topUnmet.map((r) => ({ item: r.item, reason: r.reason, count: Number(r.n) })), byHour,
    };
  }
}

export class RetailFloorNetworkAnalytics {
  /**
   * Comparativo da REDE no período (Fatia 10, pós-piloto): uma linha por loja
   * ativa com os mesmos números honestos do painel da loja (declarada ×
   * confirmada, TMA, rupturas). Escopo: owner/admin (visão regional) — o
   * gerente de loja vê só a dele no /analytics/store. Ordem alfabética; a
   * comparação é do humano, não ranking do sistema (RN-150-006).
   */
  static network(orgId: string, start: string, end: string): any {
    for (const d of [start, end]) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) throw new Error("start/end devem ser YYYY-MM-DD.");
    const stores = db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const rows = stores.map((s) => {
      const r = RetailFloorAnalyticsService.store(orgId, s.id, start, end);
      return {
        storeId: s.id, storeName: s.name, code: s.code || null,
        attendances: r.totals.attendances, decided: r.totals.decided,
        conversionDeclaredPct: r.totals.conversionDeclaredPct,
        conversionConfirmedPct: r.totals.conversionConfirmedPct,
        pendingCount: r.totals.pendingCount, unmatchedCount: r.totals.unmatchedCount,
        avgServiceMinutes: r.totals.avgServiceMinutes,
        confirmedValue: r.totals.confirmedValue,
        unmetCount: r.topUnmet.reduce((acc: number, u: any) => acc + u.count, 0),
      };
    });
    return {
      start, end,
      inCalibration: RetailFloorSettingsService.inCalibration(orgId),
      stores: rows,
    };
  }
}

export default RetailFloorAnalyticsService;
