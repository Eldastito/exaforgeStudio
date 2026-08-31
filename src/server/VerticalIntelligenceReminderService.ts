import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { MASTER_ADMIN_EMAIL } from "./config/secret.js";
import { AccountIdentityService } from "./AccountIdentityService.js";

/**
 * VerticalIntelligenceReminderService (ADR-156, DI-4.5) — agendamento SEMANAL
 * do lembrete de atualização das pesquisas de nicho.
 *
 * Coerente com o provider MANUAL (DI-4.4): NÃO roda pesquisa sozinho (isso
 * exigiria rede externa, adiada) e NÃO sobrescreve o que o admin colou. Em vez
 * disso, uma vez por semana o Scheduler (ADR-074) detecta os nichos que TÊM
 * contas consumindo e cuja inteligência está vencendo/vencida, e publica um
 * LEMBRETE no ledger existente `business_signals` (domain 'platform') para o
 * admin master re-colar — reusa a infra de alertas (convenção nº 12), sem
 * scheduler/alerta novo. Quando o admin atualiza, o lembrete se auto-resolve.
 *
 * Gasto de plataforma; sem `organization_id` no dado compartilhado. O lembrete
 * é publicado na org do admin master (onde ele opera). Best-effort (convenção nº 7).
 */

const GRACE_DAYS = 3;               // avisa quando falta ≤ 3 dias p/ vencer
const TOGGLE_KEY = "vertical_intel_reminder_enabled"; // '0' desliga; default ligado
const LAST_RUN_KEY = "vertical_intel_reminder_last_run";
const DEDUPE_PREFIX = "platform:vi_stale:";

export class VerticalIntelligenceReminderService {
  private static getSetting(key: string): string | null {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key) as any;
    return row ? String(row.value) : null;
  }
  private static setSetting(key: string, value: string): void {
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, value);
  }

  /** Ligado por padrão (o dono pediu "ligar"); só '0' desliga. */
  static isEnabled(): boolean { return this.getSetting(TOGGLE_KEY) !== "0"; }
  static setEnabled(on: boolean): void { this.setSetting(TOGGLE_KEY, on ? "1" : "0"); }
  static lastRun(): string | null { return this.getSetting(LAST_RUN_KEY); }

  /** Org do admin master (onde o lembrete é publicado). Null se não houver. */
  static masterOrgId(): string | null {
    const row = AccountIdentityService.usersByEmail(MASTER_ADMIN_EMAIL)[0]; // RN-GRP-02
    return row?.organization_id || null;
  }

  /** Verticais que TÊM contas consumindo (opt-in) — só essas importam lembrar. */
  private static consumingVerticals(): Set<string> {
    const rows = db.prepare("SELECT DISTINCT vertical FROM organization_settings WHERE COALESCE(external_intelligence_enabled,0)=1 AND vertical IS NOT NULL AND vertical <> ''").all() as any[];
    return new Set(rows.map((r) => r.vertical));
  }

  /** Nichos vencendo/vencidos que têm consumidores. */
  static dueNiches(graceDays: number = GRACE_DAYS): any[] {
    const consuming = this.consumingVerticals();
    if (!consuming.size) return [];
    // Mútua exclusão (RN-157-4): nicho com AGENDA de automação ativa (DI-5.4) é
    // pesquisado sozinho pelo Scheduler — não faz sentido lembrar o admin de
    // "re-colar". Exclui esses fingerprints do lembrete manual.
    const rows = db.prepare(`SELECT id, fingerprint, vertical, topic, region, timeframe, valid_until,
        (valid_until <= CURRENT_TIMESTAMP) AS expired
      FROM vertical_intelligence
      WHERE valid_until <= datetime('now', ?)
        AND fingerprint NOT IN (SELECT fingerprint FROM vertical_intelligence_schedule WHERE enabled = 1)
      ORDER BY valid_until ASC`).all(`+${Math.max(0, graceDays)} days`) as any[];
    return rows.filter((r) => consuming.has(r.vertical)).map((r) => ({ ...r, expired: !!r.expired }));
  }

  /**
   * Publica os lembretes dos nichos vencidos/vencendo e resolve os que já não
   * estão mais devidos (admin re-colou). Retorna { due, published, resolved, org }.
   */
  static sweep(opts: { graceDays?: number } = {}): { due: number; published: number; resolved: number; org: string | null } {
    const due = this.dueNiches(opts.graceDays ?? GRACE_DAYS);
    const org = this.masterOrgId();
    let published = 0, resolved = 0;
    if (!org) return { due: due.length, published, resolved, org: null };

    // Chave por EPISÓDIO de vencimento (inclui valid_until): o ledger não reabre
    // um sinal já resolvido, então cada novo ciclo de staleness precisa de chave
    // própria — senão um nicho que vence de novo depois de re-colado não avisaria.
    const keyOf = (d: any) => `${DEDUPE_PREFIX}${d.fingerprint}:${d.valid_until}`;
    for (const d of due) {
      try {
        BusinessSignalService.publish(org, {
          domain: "platform", signalType: "vertical_intelligence_stale",
          severity: d.expired ? "risk" : "attention", basis: "fact", confidence: 1,
          sourceService: "VerticalIntelligenceReminder",
          evidence: { vertical: d.vertical, topic: d.topic, region: d.region, timeframe: d.timeframe, fingerprint: d.fingerprint, expired: d.expired, validUntil: d.valid_until },
          dedupeKey: keyOf(d),
        });
        published++;
      } catch { /* best-effort */ }
    }

    // Auto-resolve: lembretes abertos que já não correspondem a um nicho devido
    // (o admin re-colou → o valid_until mudou → a chave antiga sai da lista).
    const dueKeys = new Set(due.map(keyOf));
    try {
      const open = BusinessSignalService.list(org, { status: "open", domain: "platform" }).filter((s: any) => s.signal_type === "vertical_intelligence_stale");
      for (const s of open) {
        if (s.dedupe_key && !dueKeys.has(s.dedupe_key)) { BusinessSignalService.resolveByDedupe(org, s.dedupe_key); resolved++; }
      }
    } catch { /* best-effort */ }

    return { due: due.length, published, resolved, org };
  }

  /**
   * Chamada pelo Scheduler: roda o sweep no MÁXIMO 1×/semana (dedupe via
   * platform_settings). Respeita o toggle. Best-effort.
   */
  static maybeWeeklySweep(): { skipped?: string; result?: any } {
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

export default VerticalIntelligenceReminderService;
