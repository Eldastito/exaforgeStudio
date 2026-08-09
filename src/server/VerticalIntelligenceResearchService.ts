import db from "./db.js";
import { randomUUID } from "crypto";
import { researchFingerprint } from "./VerticalIntelligenceService.js";
import { ResearchCuratorService } from "./ResearchCuratorService.js";
import { ResearchBudgetService } from "./ResearchBudgetService.js";

/**
 * VerticalIntelligenceResearchService (ADR-157, DI-5.4) — a AGENDA de nichos
 * automatizados e o passe que roda a pesquisa SOZINHO (supersede localmente o
 * "scheduler nunca dispara pesquisa" da DI-4.5, RN-157 escopo automático).
 *
 * O admin master registra um nicho (vertical, topic, region?, timeframe?) com um
 * intervalo; o Scheduler (ADR-074) chama `maybeSweep()` e, para cada nicho
 * VENCIDO (now - last_run_at >= interval_days), COM consumidores opt-in e DENTRO
 * do orçamento, dispara o pipeline autônomo `ResearchCuratorService.curate`
 * (provider → gate → anonimização → publicação). Gasto de PLATAFORMA — sem
 * organization_id (RN-157-1). Best-effort (convenção nº 7).
 *
 * Mútua exclusão (RN-157-4): um nicho com agenda ENABLED não recebe o lembrete
 * manual da DI-4.5 (o `VerticalIntelligenceReminderService.dueNiches` exclui
 * fingerprints agendados) — automação e "re-colar" não convivem no mesmo nicho.
 */

const TOGGLE_KEY = "vertical_intel_research_enabled"; // '0' desliga; default ligado
const DEFAULT_INTERVAL_DAYS = 7;

export class VerticalIntelligenceResearchService {
  private static getSetting(key: string): string | null {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key) as any;
    return row ? String(row.value) : null;
  }
  private static setSetting(key: string, value: string): void {
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, value);
  }
  /** Ligado por padrão; só '0' desliga globalmente a automação. */
  static isEnabled(): boolean { return this.getSetting(TOGGLE_KEY) !== "0"; }
  static setEnabled(on: boolean): void { this.setSetting(TOGGLE_KEY, on ? "1" : "0"); }

  /** Registra (ou atualiza) um nicho na agenda. Só admin master (na rota). */
  static upsert(input: { vertical: string; topic: string; region?: string; timeframe?: string; intervalDays?: number; enabled?: boolean }): any {
    const vertical = String(input?.vertical || "").trim();
    const topic = String(input?.topic || "").trim();
    if (!vertical || !topic) throw new Error("vertical e topic são obrigatórios.");
    const region = input.region ? String(input.region).trim() : null;
    const timeframe = input.timeframe ? String(input.timeframe).trim() : null;
    const fingerprint = researchFingerprint(vertical, topic, region || undefined, timeframe || undefined);
    const intervalDays = Math.max(1, Math.min(365, Number(input.intervalDays) || DEFAULT_INTERVAL_DAYS));
    const enabled = input.enabled === false ? 0 : 1;
    const existing = db.prepare("SELECT id FROM vertical_intelligence_schedule WHERE fingerprint = ?").get(fingerprint) as any;
    const id = existing?.id || randomUUID();
    db.prepare(`
      INSERT INTO vertical_intelligence_schedule (id, fingerprint, vertical, topic, region, timeframe, interval_days, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(fingerprint) DO UPDATE SET
        vertical=excluded.vertical, topic=excluded.topic, region=excluded.region, timeframe=excluded.timeframe,
        interval_days=excluded.interval_days, enabled=excluded.enabled, updated_at=CURRENT_TIMESTAMP
    `).run(id, fingerprint, vertical, topic, region, timeframe, intervalDays, enabled);
    return this.get(fingerprint);
  }

  static get(fingerprint: string): any | null {
    return db.prepare("SELECT * FROM vertical_intelligence_schedule WHERE fingerprint = ?").get(fingerprint) as any || null;
  }
  static list(): any[] {
    return db.prepare("SELECT * FROM vertical_intelligence_schedule ORDER BY vertical, topic").all() as any[];
  }
  static setNicheEnabled(fingerprint: string, on: boolean): void {
    db.prepare("UPDATE vertical_intelligence_schedule SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE fingerprint = ?").run(on ? 1 : 0, fingerprint);
  }
  static remove(fingerprint: string): void {
    db.prepare("DELETE FROM vertical_intelligence_schedule WHERE fingerprint = ?").run(fingerprint);
  }
  private static markRan(fingerprint: string): void {
    db.prepare("UPDATE vertical_intelligence_schedule SET last_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE fingerprint = ?").run(fingerprint);
  }

  /** Verticais que TÊM contas consumindo (opt-in) — só essas valem pesquisar. */
  private static consumingVerticals(): Set<string> {
    const rows = db.prepare("SELECT DISTINCT vertical FROM organization_settings WHERE COALESCE(external_intelligence_enabled,0)=1 AND vertical IS NOT NULL AND vertical <> ''").all() as any[];
    return new Set(rows.map((r) => r.vertical));
  }

  /**
   * Nichos ENABLED, VENCIDOS pelo intervalo e COM consumidores. Nicho nunca
   * rodado (last_run_at NULL) conta como vencido. Só nicho com consumidor entra
   * (frugalidade — não pesquisa vertical sem quem leia).
   */
  static dueNiches(): any[] {
    const consuming = this.consumingVerticals();
    if (!consuming.size) return [];
    const rows = db.prepare(`
      SELECT * FROM vertical_intelligence_schedule
      WHERE enabled = 1
        AND (last_run_at IS NULL OR last_run_at <= datetime('now', '-' || interval_days || ' days'))
      ORDER BY (last_run_at IS NULL) DESC, last_run_at ASC
    `).all() as any[];
    return rows.filter((r) => consuming.has(r.vertical));
  }

  /**
   * Chamado pelo Scheduler: dispara a pesquisa autônoma dos nichos vencidos.
   * Respeita o toggle global, os dois tetos (orçamento de plataforma + o gate do
   * curador) e para quando o orçamento estoura. Marca `last_run_at` a cada
   * TENTATIVA (publicada OU reprovada) para não martelar a IA/orçamento; se o
   * orçamento já estourou, NÃO tenta (não marca). Best-effort por nicho.
   */
  static async maybeSweep(): Promise<{ due: number; attempted: number; published: number; skipped?: string }> {
    if (!this.isEnabled()) return { due: 0, attempted: 0, published: 0, skipped: "disabled" };
    const due = this.dueNiches();
    let attempted = 0, published = 0;
    for (const n of due) {
      if (!ResearchBudgetService.canSpend()) return { due: due.length, attempted, published, skipped: "budget_exceeded" };
      try {
        const r = await ResearchCuratorService.curate(
          { userId: "scheduler" },
          { vertical: n.vertical, topic: n.topic, region: n.region || undefined, timeframe: n.timeframe || undefined },
        );
        attempted++;
        if (r.published) published++;
        // budget_exceeded volta de curate SEM ter chamado o provider → não marca
        // (para re-tentar quando o orçamento renovar); qualquer outro resultado
        // (publicado ou reprovado) marca o disparo.
        if (r.reason !== "budget_exceeded") this.markRan(n.fingerprint);
      } catch { this.markRan(n.fingerprint); /* best-effort: erro de 1 não trava os demais */ }
    }
    return { due: due.length, attempted, published };
  }
}

export default VerticalIntelligenceResearchService;
