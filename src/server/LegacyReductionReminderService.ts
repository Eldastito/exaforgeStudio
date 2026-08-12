/**
 * LegacyReductionReminderService — PRD 6 / ADR-163 F16 (§107/§112): surfacer proativo
 * do gate de redução de legado (F12).
 *
 * PROBLEMA que fecha: a F12 (`LegacyReductionService`) é uma leitura ADVISÓRIA — útil,
 * mas ninguém abre `/api/ux/legacy-reduction` espontaneamente. Este reminder roda no
 * Scheduler e, quando a telemetria PROVA substituição (`ready_to_retire`), publica UM
 * `business_signal` (convenção nº 12 — nunca cria tabela de alerta própria) pra que o
 * gestor veja a recomendação na Smart Inbox. Quando não há mais candidato, RESOLVE o
 * sinal (dedupe) — sem ruído residual.
 *
 * Continua ADVISÓRIO (RN-UX-5/§112): o sinal só INFORMA "a tela X pode ser aposentada";
 * a retirada real é PR humano separado. `severity:info` (baixa urgência) — não compete
 * com risco/aprovação. Best-effort (nunca derruba o tick). Isolado por org.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { LegacyReductionService } from "./LegacyReductionService.js";

const TOGGLE_KEY = "legacy_reduction_reminder_enabled";  // '0' desliga; default ligado
const LAST_RUN_KEY = "legacy_reduction_reminder_last_run";
const DEDUPE_KEY = "ux:legacy_reduction_ready";

export class LegacyReductionReminderService {
  private static getSetting(key: string): string | null {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key) as any;
    return row ? row.value : null;
  }
  private static setSetting(key: string, value: string): void {
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, value);
  }
  static isEnabled(): boolean { return this.getSetting(TOGGLE_KEY) !== "0"; }
  static setEnabled(on: boolean): void { this.setSetting(TOGGLE_KEY, on ? "1" : "0"); }
  static lastRun(): string | null { return this.getSetting(LAST_RUN_KEY); }

  /**
   * Varre as orgs com telemetria ligada: publica o sinal quando há candidato
   * `ready_to_retire`; resolve quando não há. Retorna a contagem pra observabilidade.
   */
  static sweep(opts: { sinceDays?: number } = {}): { orgs: number; published: number; resolved: number } {
    let published = 0, resolved = 0;
    const orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(ux_telemetry_enabled,0) = 1`).all() as any[];
    for (const { organization_id: orgId } of orgs) {
      let ready: any[] = [];
      try { ready = LegacyReductionService.readyForOrg(orgId, opts); } catch { ready = []; }
      if (ready.length) {
        try {
          BusinessSignalService.publish(orgId, {
            domain: "operations",
            signalType: "legacy_ux_ready_to_retire",
            severity: "info",
            basis: "fact",
            confidence: 0.9,
            sourceService: "legacy_reduction_reminder",
            subjectType: "ux_surface",
            subjectId: ready.map((c) => c.legacy).sort().join(","),
            dedupeKey: DEDUPE_KEY,
            impactUnit: null,
            evidence: {
              count: ready.length,
              candidates: ready.map((c) => ({ label: c.label, legacy: c.legacy, replacement: c.replacement, evidence: c.evidence })),
              note: "Advisório: a retirada é decisão humana em PR separado (RN-UX-5/§112).",
            },
          } as any);
          published++;
        } catch { /* best-effort */ }
      } else {
        try { const r = BusinessSignalService.resolveByDedupe(orgId, DEDUPE_KEY); if (r?.ok) resolved++; } catch { /* best-effort */ }
      }
    }
    return { orgs: orgs.length, published, resolved };
  }

  /** Gate SEMANAL (mesmo molde do lembrete de nicho): enabled + intervalo de 7 dias. */
  static maybeWeeklySweep(): { skipped?: string; result?: { orgs: number; published: number; resolved: number } } {
    if (!this.isEnabled()) return { skipped: "disabled" };
    const last = this.lastRun();
    if (last) {
      const overdue = db.prepare("SELECT (? <= datetime('now','-7 days')) AS due").get(last) as any;
      if (!overdue?.due) return { skipped: "not_due" };
    }
    const result = this.sweep();
    this.setSetting(LAST_RUN_KEY, new Date().toISOString());
    return { result };
  }
}

export default LegacyReductionReminderService;
