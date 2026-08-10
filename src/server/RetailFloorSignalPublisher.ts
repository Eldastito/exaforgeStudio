/**
 * RetailFloorSignalPublisher — sinais do Atendimento de Loja pro cérebro da
 * plataforma (ADR-150 Fatia 8, sobre o ledger da ADR-136).
 *
 * RN-150-006 dura: TUDO aqui é FATO CALCULADO (contagens, minutos, somas) com
 * a evidência junto — nenhum sinal atribui causa não medida e nenhum ranqueia
 * vendedor por conversão bruta. Quem transforma em narrativa/ação é o
 * Orquestrador/Diretor IA lendo o `business_signals`.
 *
 * Sinais por (loja, dia) — dedupe `retail_floor.{tipo}|{loja}|{dia}`,
 * republicar ATUALIZA a linha (idempotência do ledger):
 *  - `retail_floor_queue_delay`: minutos do dia com TODOS os vendedores do
 *    roster simultaneamente em atendimento (proxy honesto de cliente
 *    esperando — não rastreamos a fila de clientes) ≥ 15min.
 *  - `retail_floor_long_service`: atendimentos com duração ≥ 45min.
 *  - `retail_floor_unmet_demand`: demanda não atendida do dia agrupada por
 *    motivo/produto (ruptura de tamanho/cor/rede — insumo do Comprador IA).
 *  - `retail_floor_out_of_assortment`: EANs pedidos fora do mix
 *    (no_assortment), separados porque a ação é outra (mix, não reposição).
 *  - `retail_floor_declared_vs_pdv_gap`: conversões declaradas sem
 *    correspondência no PDV (unmatched ≥ 1) — gap conta APENAS o valor dos
 *    unmatched (o total do dia inclui pendentes e mentiria).
 *  - `retail_floor_network_recovery`: vendas recuperadas via rede — scan com
 *    reserva/transferência em peça SEM estoque local.
 *  - `retail_floor_conversion_drop` (janela 7d×7d, dedupe pela semana):
 *    conversão CONFIRMADA caiu ≥ 20% relativo vs a janela anterior, com
 *    amostra mínima de 20 atendimentos em cada janela — nunca conversão
 *    bruta declarada.
 *
 * Roda no tick horário do Scheduler (após a conciliação) e sob demanda
 * (`POST /signals/scan`, gestor). Isolado por organization_id (RN-150-001).
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { AnomalyDetectorRegistry } from "./AnomalyDetectorRegistry.js";

const ALL_BUSY_MIN = 15;        // min de "todo mundo atendendo" pra sinalizar
const LONG_SERVICE_MIN = 45;    // duração de atendimento considerada longa
const DROP_MIN_SAMPLE = 20;     // atendimentos mínimos por janela de 7d
// (queda relativa mínima agora vive no contrato do detector: F4.3 →
//  AnomalyDetectorRegistry "retail_floor_conversion_drop".threshold)

const day = (offset: number, from?: string) => {
  const d = from ? new Date(`${from}T00:00:00Z`) : new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

export class RetailFloorSignalPublisher {
  /** Varre uma org num dia: cada detector roda por loja com turno no dia. */
  static sweep(orgId: string, date?: string): { published: number } {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? date! : day(0);
    const stores = db.prepare(
      `SELECT DISTINCT s.id, s.name FROM retail_floor_shifts sh
         JOIN retail_stores s ON s.organization_id = sh.organization_id AND s.id = sh.store_id
        WHERE sh.organization_id = ? AND date(sh.opened_at) = ?`
    ).all(orgId, asOf) as any[];
    let published = 0;
    for (const store of stores) {
      published += this.queueDelay(orgId, store, asOf);
      published += this.longService(orgId, store, asOf);
      published += this.unmetDemand(orgId, store, asOf);
      published += this.outOfAssortment(orgId, store, asOf);
      published += this.declaredVsPdvGap(orgId, store, asOf);
      published += this.networkRecovery(orgId, store, asOf);
      published += this.conversionDrop(orgId, store, asOf);
    }
    return { published };
  }

  /** Minutos do dia com o roster INTEIRO em atendimento simultâneo. */
  private static queueDelay(orgId: string, store: any, date: string): number {
    const shifts = db.prepare(`SELECT id FROM retail_floor_shifts WHERE organization_id = ? AND store_id = ? AND date(opened_at) = ?`).all(orgId, store.id, date) as any[];
    let allBusyMinutes = 0, rosterSize = 0;
    for (const sh of shifts) {
      const roster = (db.prepare(`SELECT COUNT(*) AS n FROM retail_floor_queue_state WHERE organization_id = ? AND shift_id = ?`).get(orgId, sh.id) as any).n;
      if (!roster) continue;
      rosterSize = Math.max(rosterSize, Number(roster));
      const atts = db.prepare(
        `SELECT strftime('%s', started_at) AS s, strftime('%s', COALESCE(ended_at, datetime('now'))) AS e
           FROM retail_floor_attendances WHERE organization_id = ? AND shift_id = ?`
      ).all(orgId, sh.id) as any[];
      // Sweep line: soma os trechos em que a concorrência == tamanho do roster.
      const events: Array<[number, number]> = [];
      for (const a of atts) { events.push([Number(a.s), 1]); events.push([Number(a.e), -1]); }
      events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let conc = 0, lastTs = 0;
      for (const [ts, delta] of events) {
        if (conc >= Number(roster) && ts > lastTs) allBusyMinutes += (ts - lastTs) / 60;
        conc += delta; lastTs = ts;
      }
    }
    allBusyMinutes = Math.round(allBusyMinutes);
    if (allBusyMinutes < ALL_BUSY_MIN) return 0;
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_queue_delay",
      severity: allBusyMinutes >= 60 ? "risk" : "attention", basis: "fact", confidence: 0.9,
      impactAmount: allBusyMinutes, impactUnit: "min",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: { store: store.name, date, allBusyMinutes, rosterSize, note: "minutos com todos os vendedores do roster em atendimento simultâneo (proxy de espera)" },
      dedupeKey: `retail_floor.queue_delay|${store.id}|${date}`,
    });
    return 1;
  }

  /** Atendimentos longos do dia (≥ 45min), encerrados ou em curso. */
  private static longService(orgId: string, store: any, date: string): number {
    const rows = db.prepare(
      `SELECT a.id, s.name AS seller, ROUND((strftime('%s', COALESCE(a.ended_at, datetime('now'))) - strftime('%s', a.started_at)) / 60.0) AS minutes
         FROM retail_floor_attendances a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND date(a.started_at) = ?
          AND (strftime('%s', COALESCE(a.ended_at, datetime('now'))) - strftime('%s', a.started_at)) >= ?`
    ).all(orgId, store.id, date, LONG_SERVICE_MIN * 60) as any[];
    if (!rows.length) return 0;
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_long_service",
      severity: "attention", basis: "fact", confidence: 0.9,
      impactAmount: rows.length, impactUnit: "atendimentos",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: { store: store.name, date, thresholdMin: LONG_SERVICE_MIN, items: rows.slice(0, 10).map((r) => ({ seller: r.seller, minutes: Number(r.minutes) })) },
      dedupeKey: `retail_floor.long_service|${store.id}|${date}`,
    });
    return 1;
  }

  /** Ruptura evidenciada do dia (exceto fora-do-mix, que tem sinal próprio). */
  private static unmetDemand(orgId: string, store: any, date: string): number {
    const rows = db.prepare(
      `SELECT u.reason, u.detail_json, COALESCE(p.name, u.ean, '?') AS item, COUNT(*) AS n
         FROM retail_floor_unmet_demand u
         LEFT JOIN products_services p ON p.id = u.product_id AND p.organization_id = u.organization_id
        WHERE u.organization_id = ? AND u.store_id = ? AND date(u.created_at) = ? AND u.reason != 'no_assortment'
        GROUP BY u.reason, item ORDER BY n DESC`
    ).all(orgId, store.id, date) as any[];
    if (!rows.length) return 0;
    const total = rows.reduce((acc, r) => acc + Number(r.n), 0);
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_unmet_demand",
      severity: total >= 5 ? "risk" : "attention", basis: "fact", confidence: 0.9,
      impactAmount: total, impactUnit: "pedidos",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: { store: store.name, date, items: rows.slice(0, 10).map((r) => ({ item: r.item, reason: r.reason, count: Number(r.n), detail: safeParse(r.detail_json) })) },
      dedupeKey: `retail_floor.unmet_demand|${store.id}|${date}`,
    });
    return 1;
  }

  /** Pedidos fora do mix (ação é de sortimento, não de reposição). */
  private static outOfAssortment(orgId: string, store: any, date: string): number {
    const rows = db.prepare(
      `SELECT COALESCE(ean, '?') AS ean, COUNT(*) AS n FROM retail_floor_unmet_demand
        WHERE organization_id = ? AND store_id = ? AND date(created_at) = ? AND reason = 'no_assortment'
        GROUP BY ean ORDER BY n DESC`
    ).all(orgId, store.id, date) as any[];
    if (!rows.length) return 0;
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_out_of_assortment",
      severity: "info", basis: "fact", confidence: 0.85,
      impactAmount: rows.reduce((acc, r) => acc + Number(r.n), 0), impactUnit: "pedidos",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: { store: store.name, date, eans: rows.slice(0, 10).map((r) => ({ ean: r.ean, count: Number(r.n) })) },
      dedupeKey: `retail_floor.out_of_assortment|${store.id}|${date}`,
    });
    return 1;
  }

  /** Declarado sem correspondência no PDV (pós-conciliação da Fatia 6). */
  private static declaredVsPdvGap(orgId: string, store: any, date: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(declared_value), 0) AS v FROM retail_floor_attendances
        WHERE organization_id = ? AND store_id = ? AND date(started_at) = ?
          AND outcome = 'converted' AND reconciliation_state = 'unmatched'`
    ).get(orgId, store.id, date) as any;
    if (!Number(row?.n)) return 0;
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_declared_vs_pdv_gap",
      severity: Number(row.n) >= 3 ? "risk" : "attention", basis: "fact", confidence: 0.85,
      impactAmount: Math.round(Number(row.v) * 100) / 100, impactUnit: "BRL",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: { store: store.name, date, unmatchedCount: Number(row.n), unmatchedDeclaredValue: Number(row.v), note: "conversões declaradas sem venda compatível no PDV — conferir lançamento/CAI_USUARIO" },
      dedupeKey: `retail_floor.declared_vs_pdv_gap|${store.id}|${date}`,
    });
    return 1;
  }

  /** Venda recuperada via rede: reserva/transferência em peça sem estoque local. */
  private static networkRecovery(orgId: string, store: any, date: string): number {
    const rows = db.prepare(
      `SELECT sc.product_name, sc.action, COUNT(*) AS n
         FROM retail_floor_attendance_scans sc
         JOIN retail_floor_attendances a ON a.id = sc.attendance_id AND a.organization_id = sc.organization_id
        WHERE sc.organization_id = ? AND a.store_id = ? AND date(sc.created_at) = ?
          AND sc.action IN ('reserved','transfer_requested') AND COALESCE(sc.local_stock, 0) <= 0 AND COALESCE(sc.network_stock, 0) > 0
        GROUP BY sc.product_name, sc.action`
    ).all(orgId, store.id, date) as any[];
    if (!rows.length) return 0;
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_network_recovery",
      severity: "info", basis: "fact", confidence: 0.9,
      impactAmount: rows.reduce((acc, r) => acc + Number(r.n), 0), impactUnit: "vendas",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: { store: store.name, date, items: rows.slice(0, 10).map((r) => ({ product: r.product_name, action: r.action, count: Number(r.n) })) },
      dedupeKey: `retail_floor.network_recovery|${store.id}|${date}`,
    });
    return 1;
  }

  /** Conversão CONFIRMADA 7d vs 7d anteriores — nunca a bruta declarada. */
  private static conversionDrop(orgId: string, store: any, date: string): number {
    const rate = (start: string, end: string) => {
      const r = db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'converted' AND reconciliation_state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
           FROM retail_floor_attendances
          WHERE organization_id = ? AND store_id = ? AND date(started_at) >= ? AND date(started_at) <= ?
            AND outcome IS NOT NULL AND outcome != 'unknown'`
      ).get(orgId, store.id, start, end) as any;
      return { total: Number(r?.total || 0), confirmed: Number(r?.confirmed || 0) };
    };
    const cur = rate(day(-6, date), date);
    const prev = rate(day(-13, date), day(-7, date));
    if (cur.total < DROP_MIN_SAMPLE || prev.total < DROP_MIN_SAMPLE) return 0; // guarda de amostra (§25)
    const curRate = cur.confirmed / cur.total, prevRate = prev.confirmed / prev.total;
    if (prevRate <= 0) return 0;
    // PRD 2 F4.3 — a DECISÃO de anomalia agora roda pelo framework (registry →
    // primitiva F4.1): queda relativa ≥ threshold do contrato. Mesmo resultado do
    // `(prevRate-curRate)/prevRate < DROP_RATIO` inline; o sinal publicado abaixo
    // segue idêntico (contrato específico preservado).
    if (!AnomalyDetectorRegistry.evaluate("retail_floor_conversion_drop", { current: curRate, baseline: prevRate }).fires) return 0;
    BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_conversion_drop",
      severity: "risk", basis: "fact", confidence: 0.8,
      impactAmount: Math.round((prevRate - curRate) * 1000) / 10, impactUnit: "p.p.",
      occurredAt: date, sourceService: "RetailFloorSignalPublisher", sourceEntityType: "store", sourceEntityId: store.id,
      evidence: {
        store: store.name, windowEnd: date,
        current: { ...cur, rate: Math.round(curRate * 1000) / 10 },
        previous: { ...prev, rate: Math.round(prevRate * 1000) / 10 },
        note: "conversão CONFIRMADA (pós-PDV), janelas de 7 dias",
      },
      // Dedupe pela semana (fim da janela): 1 sinal por loja/semana, não por dia.
      dedupeKey: `retail_floor.conversion_drop|${store.id}|${day(-6, date)}`,
    });
    return 1;
  }
}

function safeParse(s: any): any { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

export default RetailFloorSignalPublisher;
