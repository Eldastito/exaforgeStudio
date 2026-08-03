import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { MASTER_ADMIN_EMAIL } from "./config/secret.js";

/**
 * FalaTu — BRIEFING DIÁRIO PROATIVO (ADR-151 Fatia 5).
 *
 * Sweep determinístico: pra cada usuário do FalaTu na org, deriva os fatos do
 * dia POR QUERY (RN-004: nada de contador/estado mutável) e publica UM sinal
 * por (usuário, dia) no `business_signals` (ADR-136, convenção nº 12 — nunca
 * tabela própria de alerta). Idempotente por dedupe_key
 * `falatu:daily_briefing:{userId}:{date}` — seguro pra rodar em cron
 * (Scheduler.falatuBriefingPass) quantas vezes for.
 *
 * O que conta como "dia com briefing" (actionable):
 *   - itens pendentes no inbox (aguardando o Confere humano);
 *   - compromissos COM data de hoje;
 *   - compromissos SEM data (RN-151 não inventou — o humano precisa completar).
 * Tarefas abertas entram só como contexto na evidência: sozinhas não geram
 * sinal (senão o sinal viraria ruído diário perpétuo).
 *
 * Severidade determinística: `attention` quando há pendência de ação humana
 * (inbox pendente ou compromisso sem data); `info` quando é só a agenda do dia.
 *
 * GUARDRAILS (RN-151 §Fatia 5) — este sweep NUNCA:
 *   - Cria/edita/confirma tarefa, compromisso, lista ou item (só sinaliza);
 *   - Envia mensagem a quem quer que seja (quem consome o sinal decide);
 *   - Inventa dado: a evidência é 100% derivada das tabelas falatu_*.
 * Sinais que deixaram de valer (dia virou, pendência resolvida) são fechados
 * por resolveByDedupe — mesmo desenho do ClinicRenewalTaskService (F47).
 */

const SIGNAL_TYPE = "falatu_daily_briefing";

function dedupeKeyFor(userId: string, date: string): string {
  return `falatu:daily_briefing:${userId}:${date}`;
}

export class FalaTuBriefingTaskService {
  /** A org tem o usuário-operador da plataforma? (mesmo bypass do falatuGate.) */
  static hasMasterAdminUser(orgId: string): boolean {
    try {
      return !!db.prepare(`SELECT 1 FROM users WHERE organization_id = ? AND email = ? LIMIT 1`).get(orgId, MASTER_ADMIN_EMAIL);
    } catch { return false; }
  }

  /** Fatos do dia de um usuário, derivados por query (RN-004). */
  static computeDay(orgId: string, userId: string, date: string) {
    const pendingInbox = (db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ? AND status = 'pending'`).get(orgId, userId) as any).c as number;
    const todayEvents = db.prepare(`SELECT id, title, event_time FROM falatu_events WHERE organization_id = ? AND user_id = ? AND event_date = ? ORDER BY event_time ASC LIMIT 50`).all(orgId, userId, date) as any[];
    const undatedEvents = db.prepare(`SELECT id, title FROM falatu_events WHERE organization_id = ? AND user_id = ? AND event_date IS NULL ORDER BY created_at DESC LIMIT 50`).all(orgId, userId) as any[];
    const openTasks = (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ? AND user_id = ? AND completed = 0`).get(orgId, userId) as any).c as number;
    return { pendingInbox, todayEvents, undatedEvents, openTasks };
  }

  /**
   * Executa o sweep da org. `date` (YYYY-MM-DD) é injetável pra teste
   * determinístico; default = hoje. Retorna resumo — rodar 2× não duplica.
   */
  static run(orgId: string, opts: { date?: string } = {}): { seen: number; published: number; deduped: number; resolved: number } {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(opts.date || "") ? opts.date! : new Date().toISOString().slice(0, 10);
    const users = db.prepare(`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM falatu_inbox_items WHERE organization_id = ?
        UNION SELECT user_id FROM falatu_events WHERE organization_id = ?
        UNION SELECT user_id FROM falatu_tasks WHERE organization_id = ?
      )
    `).all(orgId, orgId, orgId) as any[];

    let published = 0;
    let deduped = 0;
    const validKeys = new Set<string>();

    for (const u of users) {
      const userId = u.user_id as string;
      const facts = FalaTuBriefingTaskService.computeDay(orgId, userId, date);
      const actionable = facts.pendingInbox > 0 || facts.todayEvents.length > 0 || facts.undatedEvents.length > 0;
      if (!actionable) continue;

      const dedupeKey = dedupeKeyFor(userId, date);
      validKeys.add(dedupeKey);
      const severity = facts.pendingInbox > 0 || facts.undatedEvents.length > 0 ? "attention" : "info";
      const res = BusinessSignalService.publish(orgId, {
        domain: "falatu",
        signalType: SIGNAL_TYPE,
        severity,
        basis: "fact",
        confidence: 1,
        sourceService: "FalaTuBriefingTaskService",
        sourceEntityType: "user",
        sourceEntityId: userId,
        evidence: {
          userId,
          date,
          pendingInbox: facts.pendingInbox,
          openTasks: facts.openTasks,
          todayEvents: facts.todayEvents.slice(0, 10).map((e) => ({ id: e.id, title: e.title, time: e.event_time || null })),
          undatedEvents: facts.undatedEvents.slice(0, 10).map((e) => ({ id: e.id, title: e.title })),
        },
        dedupeKey,
      });
      if (res.deduped) deduped++;
      else published++;
    }

    // Fecha o que deixou de valer: dia anterior E sinal de hoje cujo conteúdo
    // esvaziou (tudo confirmado/datado) — o dashboard não fica ecoando briefing velho.
    let resolved = 0;
    let open: any[] = [];
    try {
      open = db.prepare(
        `SELECT dedupe_key FROM business_signals
          WHERE organization_id = ? AND domain = 'falatu' AND signal_type = ? AND status = 'open'`
      ).all(orgId, SIGNAL_TYPE) as any[];
    } catch { open = []; }
    for (const row of open) {
      if (!validKeys.has(row.dedupe_key)) {
        const r = BusinessSignalService.resolveByDedupe(orgId, row.dedupe_key);
        if (r.ok) resolved++;
      }
    }

    return { seen: users.length, published, deduped, resolved };
  }

  /**
   * Sinais abertos do PRÓPRIO usuário — os dados do FalaTu são pessoais
   * (org + user), então a rota não vaza o briefing de um colega pro outro.
   */
  static list(orgId: string, userId: string): any[] {
    return BusinessSignalService.list(orgId, { domain: "falatu", status: "open" })
      .filter((s: any) => s.signal_type === SIGNAL_TYPE && s.evidence?.userId === userId);
  }
}

export default FalaTuBriefingTaskService;
