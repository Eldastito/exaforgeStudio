/**
 * SloDefinitionService — PRD 7 / ADR-164 F3.4 (§14/§99, §68): SLO por jornada crítica.
 *
 * A F5 (Operational Health) reporta a latência p95/p99 mas NÃO a usa pra classificar estado
 * — porque "rápido/lento" só tem sentido contra um ALVO, e o alvo é do operador, não do
 * código (§14). Este serviço é a porta de entrada desse alvo: o Admin Master define os SLOs
 * (p95 alvo + taxa de erro alvo, global e por rota crítica), GLOBAL em `platform_settings`.
 *
 * Com o SLO definido, `evaluate()` classifica a latência/erro correntes contra ele — e a F5
 * passa a poder rebaixar o estado por violação de SLO. Sem SLO → `defined:false` (honesto: a
 * latência segue só REPORTADA, comportamento pré-F3.4 — §59/RN-PRC-6). GLOBAL (RN-PRC-4),
 * determinístico, sem LLM.
 */
import db from "./db.js";

const KEY = "platform_slo_definitions";

export interface SloInput {
  defaultP95TargetMs?: number | null;   // orçamento de latência p95 (ms) padrão
  errorRatePctTarget?: number | null;    // teto de taxa de erro 5xx (%)
  routes?: Record<string, number> | null; // override de p95 por rota normalizada crítica
}

export class SloDefinitionService {
  static get(): any {
    const row = db.prepare("SELECT value, updated_at FROM platform_settings WHERE key = ?").get(KEY) as any;
    if (!row?.value) return { configured: false, reason: "not_configured" };
    let p: any; try { p = JSON.parse(row.value); } catch { return { configured: false, reason: "corrupt" }; }
    return { configured: true, updatedAt: row.updated_at, defaultP95TargetMs: null, errorRatePctTarget: null, routes: {}, ...p };
  }

  static set(input: SloInput = {}): any {
    const clean: any = { routes: {} };
    for (const f of ["defaultP95TargetMs", "errorRatePctTarget"] as const) {
      const v = (input as any)[f];
      if (v == null || v === "") { clean[f] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${f} deve ser número positivo.`);
      clean[f] = n;
    }
    if (input.routes && typeof input.routes === "object") {
      for (const [route, target] of Object.entries(input.routes)) {
        const n = Number(target);
        if (Number.isFinite(n) && n > 0) clean.routes[String(route).slice(0, 200)] = n;
      }
    }
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(KEY, JSON.stringify(clean));
    return this.get();
  }

  static clear(): void { db.prepare("DELETE FROM platform_settings WHERE key = ?").run(KEY); }

  /**
   * Classifica latência/erro correntes contra o SLO. Sem SLO → defined:false. Sem métrica
   * (p95/erro null) → o respectivo `*Met` é null (não inventa — RN-OA-2/RN-PRC-6). Violação
   * grave (>1.5× o alvo) → `degraded`; violação leve → `watch`; dentro → `ok`.
   */
  static evaluate(input: { p95Ms?: number | null; errorRatePct?: number | null; route?: string | null }, slo?: any): any {
    const def = slo ?? this.get();
    if (!def.configured) return { defined: false };
    const target = (input.route && def.routes && def.routes[input.route]) || def.defaultP95TargetMs || null;
    const errTarget = def.errorRatePctTarget ?? null;

    const p95 = input.p95Ms ?? null;
    const err = input.errorRatePct ?? null;
    const p95Met = (p95 == null || target == null) ? null : p95 <= target;
    const errMet = (err == null || errTarget == null) ? null : err <= errTarget;

    const p95Bad = p95Met === false && target != null ? p95! / target : 0;
    const errBad = errMet === false && errTarget ? err! / errTarget : 0;
    const worstRatio = Math.max(p95Bad, errBad);

    let state: "ok" | "watch" | "degraded" | "unknown";
    if (p95Met === null && errMet === null) state = "unknown";
    else if (p95Met === false || errMet === false) state = worstRatio >= 1.5 ? "degraded" : "watch";
    else state = "ok";

    return {
      defined: true, state,
      p95: { targetMs: target, currentMs: p95, met: p95Met },
      errorRate: { targetPct: errTarget, currentPct: err, met: errMet },
      breach: state === "watch" || state === "degraded",
      route: input.route ?? null,
    };
  }
}

export default SloDefinitionService;
