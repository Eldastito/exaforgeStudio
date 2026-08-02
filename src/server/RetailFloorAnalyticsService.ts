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
      `SELECT a.id, a.seller_id, s.name AS seller_name, s.matricula, a.outcome, a.reconciliation_state, a.declared_value, a.declared_pieces,
              a.started_at, date(a.started_at) AS day,
              CASE WHEN a.ended_at IS NOT NULL THEN (strftime('%s', a.ended_at) - strftime('%s', a.started_at)) / 60.0 END AS minutes,
              CAST(strftime('%H', a.started_at) AS INTEGER) AS hour,
              EXISTS (SELECT 1 FROM retail_floor_attendance_scans sc
                       WHERE sc.organization_id = a.organization_id AND sc.attendance_id = a.id) AS has_scan
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

    // Atendimentos por hora de início (escala/pico) — walkout junto (Fatia 13):
    // "entrou e saiu" concentrado no pico é sinal de loja subdimensionada.
    const hourMap = new Map<number, { count: number; walkouts: number }>();
    for (const a of atts) {
      const h = hourMap.get(Number(a.hour)) || { count: 0, walkouts: 0 };
      h.count++; if (a.outcome === "walkout") h.walkouts++;
      hourMap.set(Number(a.hour), h);
    }
    const byHour = [...hourMap.entries()].map(([hour, v]) => ({ hour, count: v.count, walkouts: v.walkouts })).sort((a, b) => a.hour - b.hour);

    // ---- Fatia 13 (Analytics v2) — agregações novas sobre dados já gravados ----

    // Série por dia: tendência dentro do período (contagens honestas; a UI
    // calcula % se quiser — denominador sempre `decided`).
    const dayMap = new Map<string, { attendances: number; decided: number; declared: number; confirmed: number; walkouts: number; unknown: number }>();
    for (const a of atts) {
      const d = dayMap.get(a.day) || { attendances: 0, decided: 0, declared: 0, confirmed: 0, walkouts: 0, unknown: 0 };
      d.attendances++;
      if (a.outcome && a.outcome !== "unknown") d.decided++;
      if (a.outcome === "converted") { d.declared++; if (a.reconciliation_state === "confirmed") d.confirmed++; }
      if (a.outcome === "walkout") d.walkouts++;
      if (a.outcome === "unknown") d.unknown++;
      dayMap.set(a.day, d);
    }
    const byDay = [...dayMap.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));

    // Ticket médio e PA (peças por atendimento convertido) — sempre os DOIS
    // números rotulados (RN-150-004): declarado × confirmado. Média só sobre
    // linhas com o dado preenchido (valor/peças são opcionais no finish).
    const avgOf = (rows: any[], field: string) => {
      const known = rows.filter((r) => r[field] != null);
      return known.length ? round2(known.reduce((acc, r) => acc + Number(r[field]), 0) / known.length) : null;
    };
    const ticketDeclared = avgOf(declared, "declared_value");
    const ticketConfirmed = avgOf(confirmed, "declared_value");
    const piecesPerSaleDeclared = avgOf(declared, "declared_pieces");
    const piecesPerSaleConfirmed = avgOf(confirmed, "declared_pieces");

    // Conversão com × sem consulta de peça: mede o valor do próprio scan.
    // Denominador `decided` dos dois lados (unknown não entra em lugar nenhum).
    const scanSplitOf = (rows: any[]) => {
      const dec = rows.filter((a) => a.outcome && a.outcome !== "unknown");
      const decl = dec.filter((a) => a.outcome === "converted");
      const conf = decl.filter((a) => a.reconciliation_state === "confirmed");
      return { attendances: rows.length, decided: dec.length, declared: decl.length, confirmed: conf.length,
               conversionDeclaredPct: pct1(decl.length, dec.length), conversionConfirmedPct: pct1(conf.length, dec.length) };
    };
    const scanSplit = {
      withScan: scanSplitOf(atts.filter((a) => Number(a.has_scan) === 1)),
      withoutScan: scanSplitOf(atts.filter((a) => Number(a.has_scan) !== 1)),
    };

    // R$ deixado na mesa por ruptura: demanda não atendida × preço conhecido do
    // catálogo. Peça sem produto resolvido (EAN fora do catálogo) não tem preço —
    // conta separada pra não fingir precisão (unpricedCount).
    const unmetValueRow = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN p.price IS NOT NULL THEN p.price ELSE 0 END), 0) AS known_value,
              SUM(CASE WHEN p.price IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN p.price IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM retail_floor_unmet_demand u
         LEFT JOIN products_services p ON p.organization_id = u.organization_id AND p.id = u.product_id
        WHERE u.organization_id = ? AND u.store_id = ? AND date(u.created_at) >= ? AND date(u.created_at) <= ?`
    ).get(orgId, storeId, start, end) as any;
    const unmetLostValue = {
      knownValue: round2(Number(unmetValueRow?.known_value || 0)),
      pricedCount: Number(unmetValueRow?.priced || 0),
      unpricedCount: Number(unmetValueRow?.unpriced || 0),
    };

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
        // Fatia 13: ticket/PA (declarado × confirmado, RN-150-004) + higiene.
        ticketDeclared, ticketConfirmed, piecesPerSaleDeclared, piecesPerSaleConfirmed,
        unknownCount: byOutcome["unknown"] || 0,
        // % de auto-encerrados sobre o total: alto = cronômetro mal usado, e os
        // demais números perdem confiança (métrica de higiene operacional).
        unknownPct: pct1(byOutcome["unknown"] || 0, atts.length),
      },
      bySeller, lossPareto, topUnmet: topUnmet.map((r) => ({ item: r.item, reason: r.reason, count: Number(r.n) })), byHour,
      byDay, scanSplit, unmetLostValue,
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
        // Fatia 13: mesmos números honestos, agora comparáveis entre lojas.
        ticketConfirmed: r.totals.ticketConfirmed,
        unknownPct: r.totals.unknownPct,
        unmetLostValue: r.unmetLostValue.knownValue,
      };
    });
    return {
      start, end,
      inCalibration: RetailFloorSettingsService.inCalibration(orgId),
      stores: rows,
    };
  }
}

/**
 * Métricas OPERACIONAIS da loja derivadas do audit log (Fatia 13, Grupo 2).
 *
 * O audit (`auth_audit_logs`) já registra cada evento da fila com metadados —
 * aqui viram medida de governança, sem tabela nova:
 *  - Fila furada AUTORIZADA: starts com `override=true` (RN-150-012 — todo
 *    furo passou por PIN da gerência). Muitos furos = ou a fila não reflete a
 *    operação real, ou o PIN está banalizado. Por vendedor = quem FOI
 *    beneficiado (fato operacional, não ranking — RN-150-006).
 *  - Pausas por vendedor: transições waiting→break/unavailable pareadas com a
 *    saída do status (status novo ou rejoin). Duração SÓ de pares fechados no
 *    período — pausa em aberto conta na frequência, não nos minutos (não
 *    inventamos fim).
 *  - Destino pós-atendimento: distribuição do returnTo do finish (fila ×
 *    pausa direto).
 *
 * Métrica derivada de evento, nunca gravada (mesmo espírito da RN-150-003).
 * Escopo de gestor (RN-150-005, na rota). RN-150-001: tudo filtra org.
 */
export class RetailFloorOpsMetricsService {
  static store(orgId: string, storeId: string, start: string, end: string): any {
    for (const d of [start, end]) if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) throw new Error("start/end devem ser YYYY-MM-DD.");

    // Escopo por loja: eventos carregam shiftId, não storeId — resolve via turnos.
    const shiftIds = new Set(
      (db.prepare(`SELECT id FROM retail_floor_shifts WHERE organization_id = ? AND store_id = ?`).all(orgId, storeId) as any[]).map((r) => r.id)
    );
    const sellers = new Map<string, string>(
      (db.prepare(`SELECT id, COALESCE(name, matricula) AS name FROM retail_sellers WHERE organization_id = ?`).all(orgId) as any[]).map((r) => [r.id, r.name])
    );

    const rows = db.prepare(
      `SELECT event_type, metadata_json, created_at FROM auth_audit_logs
        WHERE organization_id = ?
          AND event_type IN ('RETAIL_FLOOR_ATTENDANCE_START', 'RETAIL_FLOOR_ATTENDANCE_FINISH', 'RETAIL_FLOOR_QUEUE_STATUS', 'RETAIL_FLOOR_QUEUE_JOIN')
          AND date(created_at) >= ? AND date(created_at) <= ?
        ORDER BY created_at, rowid`
    ).all(orgId, start, end) as any[];

    const events: Array<{ type: string; at: string; meta: any }> = [];
    for (const r of rows) {
      try {
        const meta = JSON.parse(r.metadata_json || "{}");
        // FINISH antigos (pré-Fatia 13) não carregavam shiftId — ficam de fora
        // e a métrica passa a contar do deploy em diante (honesto).
        if ((meta.shiftId && shiftIds.has(meta.shiftId)) || meta.storeId === storeId) events.push({ type: r.event_type, at: r.created_at, meta });
      } catch { /* metadado malformado não derruba o painel */ }
    }

    // ---- Fila furada autorizada (override=true) ----
    const skips = events.filter((e) => e.type === "RETAIL_FLOOR_ATTENDANCE_START" && e.meta.override === true);
    const skipsByDay = new Map<string, number>();
    const skipsBySeller = new Map<string, number>();
    for (const e of skips) {
      const day = String(e.at).slice(0, 10);
      skipsByDay.set(day, (skipsByDay.get(day) || 0) + 1);
      skipsBySeller.set(e.meta.sellerId, (skipsBySeller.get(e.meta.sellerId) || 0) + 1);
    }

    // ---- Pausas por vendedor (pareamento entrada→saída do status) ----
    const PAUSE_STATUSES = ["break", "unavailable"] as const;
    type PauseAgg = { count: number; minutes: number };
    const pauseMap = new Map<string, { break: PauseAgg; unavailable: PauseAgg }>();
    const open = new Map<string, { status: string; at: string }>(); // sellerId → pausa aberta
    const aggOf = (sellerId: string) => {
      if (!pauseMap.has(sellerId)) pauseMap.set(sellerId, { break: { count: 0, minutes: 0 }, unavailable: { count: 0, minutes: 0 } });
      return pauseMap.get(sellerId)!;
    };
    const minutesBetween = (a: string, b: string) => Math.max(0, (Date.parse(`${String(b).replace(" ", "T")}Z`) - Date.parse(`${String(a).replace(" ", "T")}Z`)) / 60000);
    for (const e of events) {
      const sellerId = e.meta.sellerId;
      if (!sellerId) continue;
      if (e.type === "RETAIL_FLOOR_QUEUE_STATUS") {
        const to = String(e.meta.to || "");
        const cur = open.get(sellerId);
        if (cur && to !== cur.status) {
          (aggOf(sellerId) as any)[cur.status].minutes += minutesBetween(cur.at, e.at);
          open.delete(sellerId);
        }
        if ((PAUSE_STATUSES as readonly string[]).includes(to) && (!cur || cur.status !== to)) {
          (aggOf(sellerId) as any)[to].count++;
          open.set(sellerId, { status: to, at: e.at });
        }
      } else if (e.type === "RETAIL_FLOOR_QUEUE_JOIN") {
        const cur = open.get(sellerId);
        if (cur) {
          (aggOf(sellerId) as any)[cur.status].minutes += minutesBetween(cur.at, e.at);
          open.delete(sellerId);
        }
      }
    }
    const pauses = [...pauseMap.entries()]
      .map(([sellerId, agg]) => ({
        sellerId, sellerName: sellers.get(sellerId) || "?",
        breaks: agg.break.count, breakMinutes: round1(agg.break.minutes),
        unavailable: agg.unavailable.count, unavailableMinutes: round1(agg.unavailable.minutes),
      }))
      .sort((a, b) => a.sellerName.localeCompare(b.sellerName)); // alfabético, não ranking

    // ---- Destino pós-atendimento ----
    const returnTo = { waiting: 0, break: 0 };
    for (const e of events) {
      if (e.type !== "RETAIL_FLOOR_ATTENDANCE_FINISH") continue;
      if (e.meta.returnTo === "break") returnTo.break++; else if (e.meta.returnTo === "waiting") returnTo.waiting++;
    }

    return {
      storeId, start, end,
      queueSkips: {
        total: skips.length,
        byDay: [...skipsByDay.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
        bySeller: [...skipsBySeller.entries()]
          .map(([sellerId, count]) => ({ sellerId, sellerName: sellers.get(sellerId) || "?", count }))
          .sort((a, b) => a.sellerName.localeCompare(b.sellerName)),
      },
      pauses, returnTo,
    };
  }
}

export default RetailFloorAnalyticsService;
