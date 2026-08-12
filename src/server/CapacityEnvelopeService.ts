/**
 * CapacityEnvelopeService — PRD 7 / ADR-164 F13 (§104-§108, CA21, §59): Capacity Envelope.
 *
 * O Capacity Envelope é o LIMITE SEGURO de operação (ex.: "aguenta ~X req/s antes do p95
 * furar o SLO"), DERIVADO de teste de carga rodado FORA de produção (§107). Este serviço:
 *   - `deriveEnvelope(samples, slo)` — função PURA que acha o "joelho" (maior rps sustentável
 *     com p95 ≤ SLO e erro ≤ limite) a partir das amostras do harness;
 *   - `store/current` — persiste/lê o envelope VERSIONADO (CA21) em `platform_settings`
 *     (GLOBAL, Admin Master).
 *
 * GUARDRAIL CENTRAL (§59/§103): enquanto NÃO houver teste de carga real, `current()`
 * responde `established:false / awaiting_load_test` — **não inventa um limite**. O GitHub
 * prova o motor; o número real vem do ambiente (harness `loadtest:capacity`).
 * Determinístico, GLOBAL (RN-PRC-4), sem raw no SQLite (RN-PRC-3 — guarda só o envelope).
 */
import db from "./db.js";

const ENVELOPE_KEY = "platform_capacity_envelope"; // JSON versionado (global)

export interface LoadSample { rps: number; p95Ms: number; errorRatePct?: number }

export class CapacityEnvelopeService {
  /**
   * Deriva o envelope a partir das amostras do teste de carga. Acha o maior rps ainda
   * dentro do SLO (p95 ≤ sloP95Ms e erro ≤ maxErrorRatePct). Sem amostra → not_established.
   */
  static deriveEnvelope(samples: LoadSample[], opts: { sloP95Ms?: number; maxErrorRatePct?: number; version?: string; at?: number } = {}): any {
    const sloP95Ms = opts.sloP95Ms ?? 500;
    const maxErrorRatePct = opts.maxErrorRatePct ?? 1;
    const atIso = new Date(opts.at ?? 0).toISOString(); // `at` injetável (Date.now proibido em CI det.)
    if (!Array.isArray(samples) || samples.length === 0) {
      return { established: false, reason: "awaiting_load_test", sloP95Ms, maxErrorRatePct };
    }
    const sorted = samples.slice().filter((s) => Number.isFinite(s.rps) && Number.isFinite(s.p95Ms)).sort((a, b) => a.rps - b.rps);
    const ok = (s: LoadSample) => s.p95Ms <= sloP95Ms && (s.errorRatePct ?? 0) <= maxErrorRatePct;

    // Se o menor rps já fura o SLO → envelope 0 (não aguenta nem o piso testado).
    if (!ok(sorted[0])) {
      return { established: true, basis: "load_test", version: opts.version ?? "v1", derivedAt: atIso,
        sloP95Ms, maxErrorRatePct, safeRps: 0, knee: { rps: sorted[0].rps, p95Ms: sorted[0].p95Ms },
        testedMaxRps: sorted[sorted.length - 1].rps, note: "over_slo_at_min_load" };
    }
    // Caminha ascendendo enquanto dentro do SLO; para na 1ª violação = joelho.
    let lastGoodRps = sorted[0].rps; let knee: any = null;
    for (let i = 1; i < sorted.length; i++) {
      if (ok(sorted[i])) { lastGoodRps = sorted[i].rps; }
      else { knee = { rps: sorted[i].rps, p95Ms: sorted[i].p95Ms }; break; }
    }
    const testedMaxRps = sorted[sorted.length - 1].rps;
    return {
      established: true, basis: "load_test", version: opts.version ?? "v1", derivedAt: atIso,
      sloP95Ms, maxErrorRatePct, safeRps: lastGoodRps, knee,
      testedMaxRps,
      note: knee ? "knee_found" : "no_knee_within_tested_range", // sem joelho → aguenta AO MENOS o testado
    };
  }

  /** Persiste o envelope versionado (após teste de carga fora de produção). GLOBAL. */
  static store(envelope: any): void {
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(ENVELOPE_KEY, JSON.stringify(envelope));
  }

  /** Lê o envelope corrente. Sem teste de carga ainda → honesto (awaiting_load_test, §59). */
  static current(): any {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(ENVELOPE_KEY) as any;
    if (!row?.value) return { established: false, reason: "awaiting_load_test", note: "Rode o harness fora de produção (loadtest:capacity) e store o envelope." };
    try { return JSON.parse(row.value); } catch { return { established: false, reason: "corrupt_envelope" }; }
  }

  /** Compara a carga atual com o envelope: quanto de folga até o limite seguro. */
  static headroomVs(currentRps: number): any {
    const env = this.current();
    if (!env.established) return { available: false, reason: env.reason };
    const safeRps = env.safeRps ?? 0;
    return {
      available: true, currentRps, safeRps, sloP95Ms: env.sloP95Ms,
      utilizationPct: safeRps > 0 ? Math.round((currentRps / safeRps) * 1000) / 10 : null,
      headroomRps: Math.max(0, safeRps - currentRps),
    };
  }
}

export default CapacityEnvelopeService;
