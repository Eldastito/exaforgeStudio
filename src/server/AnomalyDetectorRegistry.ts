/**
 * AnomalyDetectorRegistry — PRD 2 F4.2 (§26, §67, §88-90): o REGISTRY de
 * detectores + o CONTRATO do detector. Hoje cada detector é hardcoded e importado
 * no Scheduler; aqui eles se DECLARAM num lugar único, e a decisão de anomalia
 * roda pela primitiva pura da F4.1 (`evaluateAnomaly`) — não reimplementada.
 *
 * Contrato (§67): name, domain, metric, method, threshold, minSample, cooldown,
 * TTL, severity, basis, dedupe, recommendedProcess. `verticals` expressa os
 * defaults por vertical (§88-90 — zero-config: ativar a vertical já traz os
 * detectores certos).
 *
 * IMPORTANTE (§68): um detector só existe se muda uma decisão. Este módulo é a
 * ESTRUTURA + o runner (`evaluate` → SignalInput pronto pra publish, mas NÃO
 * publica — o caller/Scheduler decide). A migração de detectores reais é a F4.3.
 */
import { evaluateAnomaly, cooldownActive, ttlIso, AnomalyMethod, AnomalyDirection, AnomalyResult } from "./anomalyPrimitives.js";
import { SignalInput } from "./BusinessSignalService.js";

const SEVERITIES = new Set(["info", "attention", "risk", "critical"]);
const BASES = new Set(["fact", "estimate", "hypothesis"]);

export interface AnomalyDetectorDef {
  name: string;                 // ex.: sales_conversion_drop (= signalType)
  domain: string;               // ex.: sales
  purpose: string;
  metric: string;               // ex.: conversionRate
  method: AnomalyMethod;        // relative | absolute | zscore
  direction: AnomalyDirection;  // drop | spike | both
  threshold: number;            // relative: fração; absolute: unidades; zscore: sigmas
  minSample: number;            // §25
  cooldownMs: number;           // §56
  ttlMs: number;                // §25 — TTL do sinal emitido
  severity: string;             // info|attention|risk|critical
  basis: string;                // fact|estimate|hypothesis
  confidence?: number;          // 0..1 (default 0.75)
  subjectType?: string | null;
  recommendedProcessType?: string | null; // §40 — molde; router continua map-driven
  verticals?: string[];         // §88-90 — vazio/omitido = universal
}

export interface DetectorMeasurement {
  current: number;
  sample?: number[];
  baseline?: number;
  subjectId?: string | null;
  lastFiredAt?: string | null;  // pro cooldown
  evidence?: any;
  impactAmount?: number | null;
  impactUnit?: string | null;
  now?: number;
}

export interface DetectorEvaluation {
  detector: string;
  fires: boolean;
  reason: string;
  anomaly: AnomalyResult | null;
  signal: SignalInput | null;   // pronto pra BusinessSignalService.publish (o caller publica)
}

function validate(def: AnomalyDetectorDef): void {
  if (!def?.name || !def?.domain || !def?.metric) throw new Error("Detector exige name, domain e metric.");
  if (!SEVERITIES.has(def.severity)) throw new Error(`severity inválida: ${def.severity}`);
  if (!BASES.has(def.basis)) throw new Error(`basis inválido: ${def.basis}`);
  if (!Number.isFinite(def.threshold)) throw new Error("threshold deve ser número.");
  if (!(def.minSample >= 1)) throw new Error("minSample deve ser ≥ 1.");
  if (!(def.ttlMs > 0)) throw new Error("ttlMs deve ser > 0.");
}

export class AnomalyDetectorRegistry {
  private static defs = new Map<string, AnomalyDetectorDef>();

  static register(def: AnomalyDetectorDef): void { validate(def); this.defs.set(def.name, def); }
  static registerPack(_pack: string, defs: AnomalyDetectorDef[]): void { for (const d of defs) this.register(d); }
  static get(name: string): AnomalyDetectorDef | null { return this.defs.get(name) || null; }
  static list(): AnomalyDetectorDef[] { return [...this.defs.values()]; }
  static byDomain(domain: string): AnomalyDetectorDef[] { return this.list().filter((d) => d.domain === domain); }
  /** §88-90 — detectores default pra uma vertical (universais entram sempre). */
  static byVertical(vertical: string): AnomalyDetectorDef[] {
    return this.list().filter((d) => !d.verticals || d.verticals.length === 0 || d.verticals.includes(vertical));
  }

  /**
   * Roda o detector sobre uma medição: cooldown (§56) → anomalia (F4.1) → monta
   * o SignalInput pronto pra publish (sem publicar). NÃO é anomalia / em cooldown
   * → fires:false, signal null (fail-safe).
   */
  static evaluate(name: string, m: DetectorMeasurement): DetectorEvaluation {
    const def = this.get(name);
    if (!def) throw new Error(`Detector não registrado: ${name}`);
    const now = m.now || Date.now();

    if (cooldownActive(m.lastFiredAt, def.cooldownMs, now)) {
      return { detector: name, fires: false, reason: "cooldown ativo", anomaly: null, signal: null };
    }
    const anomaly = evaluateAnomaly({ current: m.current, sample: m.sample, baseline: m.baseline, minSample: def.minSample, method: def.method, threshold: def.threshold, direction: def.direction });
    if (!anomaly.isAnomaly) {
      return { detector: name, fires: false, reason: anomaly.reason, anomaly, signal: null };
    }
    const subjectId = m.subjectId ?? null;
    const signal: SignalInput = {
      domain: def.domain, signalType: def.name, severity: def.severity, basis: def.basis,
      confidence: def.confidence ?? 0.75, sourceService: `detector:${def.name}`,
      impactAmount: m.impactAmount ?? null, impactUnit: m.impactUnit ?? null,
      evidence: { ...(m.evidence || {}), metric: def.metric, current: m.current, baseline: anomaly.baseline, deviation: anomaly.reason, recommendedProcessType: def.recommendedProcessType ?? null },
      dedupeKey: `${def.name}:${subjectId || "org"}`,
      subjectType: def.subjectType ?? null, subjectId,
      expiresAt: ttlIso(def.ttlMs, now),
    };
    return { detector: name, fires: true, reason: anomaly.reason, anomaly, signal };
  }
}

// ── Pack default (§26/§90) — declarações, sem wiring de scheduler (F4.3 conecta a
// dados reais). Prova que o contrato é expressável; começa pelo exemplo do §26. ──
const HOUR = 3600e3;
AnomalyDetectorRegistry.registerPack("radar_core", [
  {
    name: "sales_conversion_drop", domain: "sales", purpose: "Queda incomum na conversão comercial vs baseline recente.",
    metric: "conversionRate", method: "relative", direction: "drop", threshold: 0.2, minSample: 30,
    cooldownMs: 6 * HOUR, ttlMs: 24 * HOUR, severity: "risk", basis: "fact", confidence: 0.8,
    subjectType: "funnel", recommendedProcessType: "sales_recovery_v1", verticals: ["retail", "moda", "servicos"],
  },
]);
