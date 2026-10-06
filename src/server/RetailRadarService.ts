import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { AnomalyDetectorRegistry } from "./AnomalyDetectorRegistry.js";
import { percentile } from "./anomalyPrimitives.js";

/**
 * RetailRadarService — RADAR CONTEXTUAL do varejo (ADR-204 F3.3, PRD Fase 3 §10/§11).
 *
 * Olha o que JÁ está no PDV/ERP e avisa só o que merece atenção, separando:
 *   · ANOMALIA TÉCNICA (dado/integração/cadastro errado): preço zerado/absurdo · venda duplicada · integração atrasada ·
 *     comissão estranha;
 *   · DESVIO DE NEGÓCIO: dia fechado da loja bem ABAIXO do normal;
 *   · OPORTUNIDADE: dia fechado da loja bem ACIMA do normal.
 * A classe vai em `evidence.signalClass` (`technical|business|opportunity`) — declarada no `AnomalyDetectorRegistry`.
 *
 * REGRAS (RN-F3-*):
 *  - RN-F3-5: a HORA da venda no PDV NÃO é confiável (dono, 2026-10) → NADA aqui usa `sale_time`. A normalidade é por
 *    LOJA × DIA DA SEMANA, só em dias FECHADOS (nunca o dia corrente, que está pela metade). Sem ≥6 mesmos-dias-da-semana
 *    de histórico → "histórico insuficiente": não inventa faixa.
 *  - Dado velho NUNCA vira "queda de venda": se a integração está atrasada, o radar só diz isso e se CALA sobre as lojas.
 *  - Dia sem nenhuma venda é ambíguo (loja fechada? dado faltando?) → nunca é lido como queda.
 *  - Sinais só em `business_signals` (convenção nº 12). Nunca inventa dinheiro: `impactAmount` sempre null; o texto usa
 *    percentuais; comissão sem R$ no sinal (dinheiro role-gated).
 *  - Decisão estatística pela primitiva `evaluateAnomaly` via `AnomalyDetectorRegistry.evaluate` (sem motor paralelo) +
 *    guarda de faixa: o dia só dispara se também estiver FORA de tudo o que já aconteceu naquele dia da semana (±10%).
 *  - Opt-in por empresa (`retail_radar_enabled`, default 0): sem a flag o `pass` não publica; `scan({publish:false})` é só leitura.
 *  - Isolado por organização. Determinístico, sem LLM.
 */
const DAY = 86400e3;
const HOUR = 3600e3;
const LOOKBACK_DAYS = 84;        // 12 semanas de mesmos-dias-da-semana
const MIN_SAME_WEEKDAY = 6;
const PRICE_HISTORY_DAYS = 90;
const PRICE_MIN_SAMPLE = 5;
const PRICE_ABSURD_FACTOR = 10;  // ≥10× ou ≤1/10 da mediana do próprio produto
const INTEGRATION_LATE_HOURS = 36;
const INTEGRATION_CRITICAL_HOURS = 72;
const FEED_STALE_DAYS = 3;       // prova mais fraca (sem cursor): nenhuma venda nova há 3 dias
const COMMISSION_MIN_ROWS = 10;
const COMMISSION_OUTLIER_FACTOR = 2.5;
const SIGNAL_DOMAIN = "retail_radar";
const MAX_EXAMPLES = 5;

export type RadarClass = "technical" | "business" | "opportunity";
export interface RadarFinding {
  kind: string; signalClass: RadarClass; severity: string; basis: "fact" | "hypothesis";
  filial: string | null; summary: string; evidence: any; dedupeKey: string;
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => isoDay(dayMs(d) + n * DAY);
const dow = (d: string) => new Date(dayMs(d)).getUTCDay();
const DOW_PT = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const median = (v: number[]) => (v.length ? percentile(v, 50) : 0);
const todaySP = (now = Date.now()) => new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const NORMAL = "COALESCE(status,'N') = 'N'";

export class RetailRadarService {
  static isEnabled(orgId: string): boolean {
    try { return !!Number((db.prepare("SELECT retail_radar_enabled e FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.e); } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare("UPDATE organization_settings SET retail_radar_enabled = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  private static storeLabel(orgId: string, filial: string): string {
    try { const r = db.prepare("SELECT name FROM retail_stores WHERE organization_id = ? AND code = ? LIMIT 1").get(orgId, filial) as any; return r?.name || `filial ${filial}`; } catch { return `filial ${filial}`; }
  }

  /** O dado de venda está em dia? Atrasado → o radar não fala de queda de loja (RN-F3-7: dado desatualizado). */
  static freshness(orgId: string, asOf: string, now = Date.now()): { hasSales: boolean; lastSaleDate: string | null; lastSyncAt: string | null; stale: boolean; hoursLate: number | null; source: "cursor" | "last_sale_date" | null } {
    const last = (db.prepare(`SELECT MAX(sale_date) d FROM retail_pdv_sales WHERE organization_id = ?`).get(orgId) as any)?.d || null;
    let lastSync: string | null = null;
    try { lastSync = (db.prepare(`SELECT MAX(last_synced_at) t FROM alterdata_sync_cursors WHERE organization_id = ? AND module = 'sales'`).get(orgId) as any)?.t || null; } catch { /* sem integração */ }
    if (!last) return { hasSales: false, lastSaleDate: null, lastSyncAt: lastSync, stale: false, hoursLate: null, source: null };
    if (lastSync) {
      const t = Date.parse(lastSync.includes("T") ? lastSync : lastSync.replace(" ", "T") + "Z");
      const hrs = Number.isFinite(t) ? (now - t) / HOUR : null;
      return { hasSales: true, lastSaleDate: last, lastSyncAt: lastSync, stale: hrs != null && hrs > INTEGRATION_LATE_HOURS, hoursLate: hrs != null ? Math.round(hrs) : null, source: "cursor" };
    }
    // Sem cursor, a prova é mais fraca: nenhuma venda nova há vários dias.
    const gapDays = (dayMs(todaySP(now)) - dayMs(last)) / DAY;
    return { hasSales: true, lastSaleDate: last, lastSyncAt: null, stale: gapDays > FEED_STALE_DAYS, hoursLate: gapDays > FEED_STALE_DAYS ? Math.round(gapDays * 24) : null, source: "last_sale_date" };
  }

  /**
   * Normalidade da LOJA num dia fechado: compara o total do dia com os MESMOS dias da semana das últimas 12 semanas
   * (só dias com venda). `insufficient_history` quando há < 6 amostras — sem faixa inventada. Nunca usa hora.
   */
  static storeDayNormality(orgId: string, filial: string, date: string): any {
    const total = (db.prepare(`SELECT SUM(valor) v, COUNT(*) n FROM retail_pdv_sales WHERE organization_id = ? AND filial = ? AND sale_date = ? AND ${NORMAL}`).get(orgId, filial, date) as any) || {};
    const actual = Number(total.v) || 0;
    if (!(Number(total.n) > 0) || !(actual > 0)) return { status: "no_sales_that_day", date, filial, actual: null, samples: 0 };
    const rows = db.prepare(`SELECT sale_date d, SUM(valor) v FROM retail_pdv_sales WHERE organization_id = ? AND filial = ? AND sale_date >= ? AND sale_date < ? AND ${NORMAL} GROUP BY sale_date HAVING SUM(valor) > 0`).all(orgId, filial, addDays(date, -LOOKBACK_DAYS), date) as any[];
    const sample = rows.filter((r) => dow(r.d) === dow(date)).map((r) => Number(r.v));
    if (sample.length < MIN_SAME_WEEKDAY) return { status: "insufficient_history", date, filial, actual, weekday: DOW_PT[dow(date)], samples: sample.length, minSamples: MIN_SAME_WEEKDAY };
    const base = median(sample);
    return { status: "ok", date, filial, actual, weekday: DOW_PT[dow(date)], samples: sample.length, median: base, min: Math.min(...sample), max: Math.max(...sample), sample };
  }

  /** Roda todos os detectores sobre o dia FECHADO `asOf` (default: ontem em SP). Publica só com `publish:true` + radar ligado. */
  static scan(orgId: string, opts: { asOf?: string; publish?: boolean; now?: number } = {}): any {
    const now = opts.now || Date.now();
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : addDays(todaySP(now), -1);
    const findings: RadarFinding[] = [];
    const fresh = this.freshness(orgId, asOf, now);
    const filiais = (db.prepare(`SELECT DISTINCT filial FROM retail_pdv_sales WHERE organization_id = ? AND sale_date >= ?`).all(orgId, addDays(asOf, -LOOKBACK_DAYS)) as any[]).map((r) => String(r.filial));
    const skipped: string[] = [];

    // ── integração atrasada (técnica) ──
    if (fresh.hasSales && fresh.stale) {
      const hrs = fresh.hoursLate ?? 0;
      findings.push({
        kind: "retail_integration_late", signalClass: "technical", severity: hrs > INTEGRATION_CRITICAL_HOURS ? "risk" : "attention", basis: fresh.source === "cursor" ? "fact" : "hypothesis",
        filial: null, dedupeKey: `${SIGNAL_DOMAIN}:integration_late`,
        summary: `A integração de vendas parece parada${hrs ? ` há cerca de ${hrs} horas` : ""}. Os números de venda podem estar incompletos até ela voltar.`,
        evidence: { source: fresh.source, lastSyncAt: fresh.lastSyncAt, lastSaleDate: fresh.lastSaleDate, hoursLate: fresh.hoursLate },
      });
    }

    // ── desvio por loja × dia da semana (negócio / oportunidade) — só com dado em dia ──
    const normality: any[] = [];
    if (!fresh.hasSales) skipped.push("sem_vendas");
    else if (fresh.stale) skipped.push("dado_desatualizado");
    else {
      for (const filial of filiais) {
        const n = this.storeDayNormality(orgId, filial, asOf);
        normality.push({ filial, status: n.status, samples: n.samples, weekday: n.weekday });
        if (n.status !== "ok") continue;
        const label = this.storeLabel(orgId, filial);
        for (const [name, kind] of [["retail_store_day_below_normal", "drop"], ["retail_store_day_above_normal", "spike"]] as const) {
          const ev = AnomalyDetectorRegistry.evaluate(name, { current: n.actual, sample: n.sample, baseline: n.median, subjectId: filial, now, evidence: { filial, storeLabel: label, date: asOf, weekday: n.weekday, samples: n.samples } });
          if (!ev.fires) continue;
          // Guarda de faixa: só dispara fora de TUDO o que já aconteceu naquele dia da semana (±10%).
          const outside = kind === "drop" ? n.actual < n.min * 0.9 : n.actual > n.max * 1.1;
          if (!outside) continue;
          const def = AnomalyDetectorRegistry.get(name)!;
          const pct = Math.round(Math.abs(n.actual - n.median) / n.median * 100);
          findings.push({
            kind: name, signalClass: def.signalClass as RadarClass, severity: def.severity, basis: "fact", filial, dedupeKey: `${name}:${filial}`,
            summary: kind === "drop"
              ? `${label}: as vendas de ${DOW_PT[dow(asOf)]} (${asOf.slice(8, 10)}/${asOf.slice(5, 7)}) ficaram cerca de ${pct}% abaixo do normal e abaixo de tudo o que a loja fez nesse dia da semana nas últimas semanas.`
              : `${label}: as vendas de ${DOW_PT[dow(asOf)]} (${asOf.slice(8, 10)}/${asOf.slice(5, 7)}) ficaram cerca de ${pct}% acima do normal — vale entender o que funcionou.`,
            evidence: { ...(ev.signal?.evidence || {}), deviationPct: pct, historyWeeks: n.samples, normalRange: "mesmos dias da semana das últimas 12 semanas" },
          });
        }
      }
    }

    // ── qualidade de dado do dia fechado (técnica) ──
    for (const f of this.priceFindings(orgId, asOf)) findings.push(f);
    for (const f of this.duplicateFindings(orgId, asOf)) findings.push(f);
    const comm = this.commissionFinding(orgId, asOf);
    if (comm) findings.push(comm);

    const out: any = { asOf, freshness: fresh, skipped, normality, findings: findings.map((f) => ({ kind: f.kind, signalClass: f.signalClass, severity: f.severity, basis: f.basis, filial: f.filial, summary: f.summary })), published: 0, resolved: 0 };
    if (!opts.publish) return out;
    if (!this.isEnabled(orgId)) return { ...out, published: 0, reason: "radar_disabled" };
    this.publish(orgId, asOf, findings, filiais, out, now);
    return out;
  }

  private static priceFindings(orgId: string, asOf: string): RadarFinding[] {
    const items = db.prepare(`SELECT filial, boleta, produto, quantidade q, valor v FROM retail_pdv_sale_items WHERE organization_id = ? AND sale_date = ? AND produto IS NOT NULL`).all(orgId, asOf) as any[];
    if (!items.length) return [];
    const hist = db.prepare(`SELECT valor, quantidade FROM retail_pdv_sale_items WHERE organization_id = ? AND produto = ? AND sale_date >= ? AND sale_date < ? AND quantidade > 0 AND valor > 0`);
    const medCache = new Map<string, number | null>();
    const medianFor = (produto: string): number | null => {
      if (medCache.has(produto)) return medCache.get(produto)!;
      const rows = hist.all(orgId, produto, addDays(asOf, -PRICE_HISTORY_DAYS), asOf) as any[];
      const m = rows.length >= PRICE_MIN_SAMPLE ? median(rows.map((r) => Number(r.valor) / Number(r.quantidade))) : null;
      medCache.set(produto, m); return m;
    };
    const byFilial = new Map<string, { zero: any[]; absurd: any[] }>();
    for (const it of items) {
      const q = Number(it.q) || 0, v = Number(it.v) || 0;
      if (!(q > 0)) continue;
      const g = byFilial.get(it.filial) || { zero: [], absurd: [] }; byFilial.set(it.filial, g);
      if (v <= 0) { g.zero.push({ boleta: it.boleta, produto: it.produto }); continue; }
      const med = medianFor(String(it.produto));
      if (med && med > 0) { const ratio = (v / q) / med; if (ratio >= PRICE_ABSURD_FACTOR || ratio <= 1 / PRICE_ABSURD_FACTOR) g.absurd.push({ boleta: it.boleta, produto: it.produto, vezesAMediana: Math.round(ratio * 100) / 100 }); }
    }
    const out: RadarFinding[] = [];
    for (const [filial, g] of byFilial) {
      if (!g.zero.length && !g.absurd.length) continue;
      const label = this.storeLabel(orgId, filial);
      out.push({
        kind: "retail_price_anomaly", signalClass: "technical", severity: g.absurd.length ? "attention" : "info", basis: "fact", filial,
        dedupeKey: `${SIGNAL_DOMAIN}:price:${filial}:${asOf}`,
        summary: `${label}: ${g.zero.length ? `${g.zero.length} item(ns) vendido(s) com preço zerado` : ""}${g.zero.length && g.absurd.length ? " e " : ""}${g.absurd.length ? `${g.absurd.length} com preço muito fora do histórico do produto` : ""} em ${asOf.slice(8, 10)}/${asOf.slice(5, 7)}. Confirme se é brinde/troca ou erro de cadastro.`,
        evidence: { date: asOf, filial, zeroPriceCount: g.zero.length, absurdPriceCount: g.absurd.length, examples: [...g.absurd, ...g.zero].slice(0, MAX_EXAMPLES), rule: `preço unitário ≥${PRICE_ABSURD_FACTOR}× ou ≤1/${PRICE_ABSURD_FACTOR} da mediana do produto (≥${PRICE_MIN_SAMPLE} vendas em ${PRICE_HISTORY_DAYS} dias); zerado = valor 0 com quantidade > 0` },
      });
    }
    return out;
  }

  private static duplicateFindings(orgId: string, asOf: string): RadarFinding[] {
    const rows = db.prepare(
      `SELECT filial, COUNT(*) c, GROUP_CONCAT(boleta) boletas FROM retail_pdv_sales
        WHERE organization_id = ? AND sale_date = ? AND valor > 0 AND ${NORMAL}
        GROUP BY filial, valor, pecas, COALESCE(usuario,''), COALESCE(payments_json,'') HAVING COUNT(*) > 1`
    ).all(orgId, asOf) as any[];
    const byFilial = new Map<string, { groups: number; boletas: string[] }>();
    for (const r of rows) { const g = byFilial.get(r.filial) || { groups: 0, boletas: [] }; g.groups++; g.boletas.push(...String(r.boletas).split(",")); byFilial.set(r.filial, g); }
    return [...byFilial].map(([filial, g]) => ({
      kind: "retail_duplicate_sale", signalClass: "technical" as RadarClass, severity: "attention", basis: "hypothesis" as const, filial,
      dedupeKey: `${SIGNAL_DOMAIN}:duplicate:${filial}:${asOf}`,
      summary: `${this.storeLabel(orgId, filial)}: ${g.groups} conjunto(s) de boletas idênticas (mesmo valor, peças, operador e pagamento) em ${asOf.slice(8, 10)}/${asOf.slice(5, 7)}. Pode ser lançamento duplicado — ou duas vendas iguais de verdade; confira.`,
      evidence: { date: asOf, filial, groups: g.groups, boletas: g.boletas.slice(0, MAX_EXAMPLES * 2), note: "hipótese: a hora do PDV não é confiável, então só a igualdade dos dados sustenta a suspeita" },
    }));
  }

  /** Comissão do ERP fora do padrão da PRÓPRIA rede (30 dias). Sem R$ no sinal (dinheiro role-gated). */
  private static commissionFinding(orgId: string, asOf: string): RadarFinding | null {
    let rows: any[] = [];
    try { rows = db.prepare(`SELECT matricula, sale_date d, valor v, comissao_erp c FROM retail_erp_seller_sales WHERE organization_id = ? AND sale_date >= ? AND sale_date <= ?`).all(orgId, addDays(asOf, -30), asOf) as any[]; } catch { return null; }
    const ratios = rows.filter((r) => Number(r.v) > 0 && Number(r.c) > 0).map((r) => Number(r.c) / Number(r.v));
    if (ratios.length < COMMISSION_MIN_ROWS) return null;       // sem base da própria rede, não se julga
    const med = median(ratios);
    const strange = rows.filter((r) => {
      const v = Number(r.v) || 0, c = Number(r.c) || 0;
      if (c <= 0) return false;
      return v <= 0 || c > v || c / v > med * COMMISSION_OUTLIER_FACTOR;
    });
    if (!strange.length) return null;
    return {
      kind: "retail_commission_strange", signalClass: "technical", severity: "attention", basis: "fact", filial: null,
      dedupeKey: `${SIGNAL_DOMAIN}:commission`,
      summary: `${strange.length} lançamento(s) de comissão do ERP fora do padrão da rede nos últimos 30 dias (sem venda, acima da venda ou muito acima do normal). Vale conferir antes de fechar a comissão.`,
      evidence: { count: strange.length, windowDays: 30, normalRatioPct: Math.round(med * 1000) / 10, examples: strange.slice(0, MAX_EXAMPLES).map((r) => ({ matricula: r.matricula, data: r.d, razaoPct: Number(r.v) > 0 ? Math.round((Number(r.c) / Number(r.v)) * 1000) / 10 : null })), rule: `comissão > venda, sem venda, ou razão > ${COMMISSION_OUTLIER_FACTOR}× a mediana da rede (≥${COMMISSION_MIN_ROWS} lançamentos de base)` },
    };
  }

  private static publish(orgId: string, asOf: string, findings: RadarFinding[], filiais: string[], out: any, now: number): void {
    const ttl: Record<string, number> = { retail_price_anomaly: 7 * DAY, retail_duplicate_sale: 7 * DAY, retail_commission_strange: 7 * DAY };
    for (const f of findings) {
      try {
        BusinessSignalService.publish(orgId, {
          domain: SIGNAL_DOMAIN, signalType: f.kind, severity: f.severity, basis: f.basis, confidence: f.basis === "fact" ? 0.8 : 0.5,
          impactAmount: null, impactUnit: null, sourceService: "RetailRadarService", sourceEntityType: f.filial ? "retail_filial" : null, sourceEntityId: f.filial,
          evidence: { ...f.evidence, signalClass: f.signalClass, summary: f.summary }, dedupeKey: f.dedupeKey, subjectType: f.filial ? "filial" : "org", subjectId: f.filial,
          expiresAt: new Date(now + (ttl[f.kind] || 3 * DAY)).toISOString(),
        } as any);
        out.published++;
      } catch { /* best-effort */ }
    }
    // Auto-cura: o que não dispara mais sai do radar (só os sinais de ESTADO — os de dia fechado expiram pelo TTL).
    const live = new Set(findings.map((f) => f.dedupeKey));
    const stateKeys = [`${SIGNAL_DOMAIN}:integration_late`, `${SIGNAL_DOMAIN}:commission`, ...filiais.flatMap((f) => [`retail_store_day_below_normal:${f}`, `retail_store_day_above_normal:${f}`])];
    for (const k of stateKeys) if (!live.has(k)) { try { if (BusinessSignalService.resolveByDedupe(orgId, k).ok) out.resolved++; } catch { /* noop */ } }
  }

  /** Scheduler: só orgs com o radar LIGADO (opt-in) e com vendas no PDV. */
  static pass(): void {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT os.organization_id FROM organization_settings os WHERE os.retail_radar_enabled = 1 AND EXISTS (SELECT 1 FROM retail_pdv_sales p WHERE p.organization_id = os.organization_id)`).all() as any[]; } catch { return; }
    for (const o of orgs) {
      try { this.scan(o.organization_id, { publish: true }); }
      catch (e: any) { console.error(`[RetailRadar] pass falhou (org ${o.organization_id})`, e?.message || e); }
    }
  }
}

export default RetailRadarService;
