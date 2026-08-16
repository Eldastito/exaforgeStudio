/**
 * Tarefas recorrentes — motor de recorrência (PRD Moda/TOULON, frente TASK; ADR-171).
 *
 * A REGRA (`task_recurrence_rules`) é um template. O Scheduler MATERIALIZA, a cada
 * passe, uma tarefa normal em `tasks` para cada ocorrência VENCIDA — preservando
 * o histórico de conclusão por ocorrência (TASK-002).
 *
 * Invariantes:
 *  - Timezone (TASK-004): `local_time` + `timezone` (IANA) definem a hora local;
 *    `next_run_at` é guardado em UTC. A conversão local→UTC usa Intl (correta
 *    inclusive fora do Brasil; São Paulo não tem DST desde 2019).
 *  - Idempotência (TASK-003): chave determinística `${ruleId}:${scheduledAtISO}`
 *    em `tasks.occurrence_dedupe_key` (índice único parcial) — reprocessar o
 *    passe NÃO duplica.
 *  - Catch-up limitado: ocorrências muito atrasadas (> GRACE) são PULADAS (o
 *    next_run_at avança), mas não geram enxurrada de tarefas velhas.
 *  - Isolamento por organização (RN nº 1).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { TaskService } from "./TaskService.js";

const DAY_MS = 86_400_000;
const GRACE_DAYS = 2;          // ocorrências mais velhas que isto são puladas
const MAX_CATCHUP = 60;        // teto de iterações de catch-up por regra/passe

type LocalDate = { y: number; mo: number; d: number };

// ---- utilidades de timezone (sem lib; via Intl) ----------------------------

/** Offset (min) em que o horário LOCAL da tz está à frente do UTC, no instante. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: any = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/** Instante UTC de um horário de PAREDE local (y,mo,d,h,mi) numa timezone IANA. */
function zonedWallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMinutes(new Date(guess), timeZone);
  let utc = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(utc), timeZone);
  if (off2 !== off1) utc = guess - off2 * 60000; // reajusta na virada de DST
  return new Date(utc);
}

/** Data LOCAL (calendário) de um instante numa timezone. */
function localDateOf(instant: Date, timeZone: string): LocalDate {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const p: any = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day };
}

// ---- calendário puro (índice de dia em UTC-meia-noite, sem tz) --------------
const dayIndex = (dt: LocalDate) => Math.floor(Date.UTC(dt.y, dt.mo - 1, dt.d) / DAY_MS);
const fromDayIndex = (idx: number): LocalDate => { const dt = new Date(idx * DAY_MS); return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; };
const weekdayOf = (dt: LocalDate) => new Date(Date.UTC(dt.y, dt.mo - 1, dt.d)).getUTCDay(); // 0=domingo
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const parseYmd = (s: string): LocalDate => { const [y, mo, d] = String(s).split("-").map(Number); return { y, mo, d }; };

export class TaskRecurrenceService {
  /** A data local candidata BATE com a regra? (frequência/intervalo/dia). */
  private static matches(rule: any, cand: LocalDate, start: LocalDate): boolean {
    if (dayIndex(cand) < dayIndex(start)) return false;
    const interval = Math.max(1, Number(rule.interval) || 1);
    if (rule.frequency === "daily") {
      return (dayIndex(cand) - dayIndex(start)) % interval === 0;
    }
    if (rule.frequency === "weekly") {
      let wds: number[] = [];
      try { wds = JSON.parse(rule.by_weekday || "[]"); } catch { wds = []; }
      if (!wds.length) wds = [weekdayOf(start)];
      if (!wds.includes(weekdayOf(cand))) return false;
      // semana (domingo-base) a cada `interval`.
      const wStart = dayIndex(start) - weekdayOf(start);
      const wCand = dayIndex(cand) - weekdayOf(cand);
      return (Math.round((wCand - wStart) / 7)) % interval === 0;
    }
    if (rule.frequency === "monthly") {
      const dom = Math.min(Math.max(1, Number(rule.day_of_month) || start.d), daysInMonth(cand.y, cand.mo));
      if (cand.d !== dom) return false;
      const months = (cand.y - start.y) * 12 + (cand.mo - start.mo);
      return months >= 0 && months % interval === 0;
    }
    return false;
  }

  /** Próximo instante UTC estritamente APÓS `after`. null se acabou (ends_on). */
  static computeNextRun(rule: any, after: Date): Date | null {
    const tz = rule.timezone || "America/Sao_Paulo";
    const [hh, mi] = String(rule.local_time || "09:00").split(":").map((x: string) => parseInt(x, 10) || 0);
    const start = parseYmd(rule.starts_on);
    const endIdx = rule.ends_on ? dayIndex(parseYmd(rule.ends_on)) : null;
    // Varre a partir do MAIOR entre starts_on e a data local de `after`.
    const afterLocal = localDateOf(after, tz);
    let idx = Math.max(dayIndex(start), dayIndex(afterLocal));
    for (let i = 0; i < 800; i++, idx++) {
      if (endIdx != null && idx > endIdx) return null;
      const cand = fromDayIndex(idx);
      if (!this.matches(rule, cand, start)) continue;
      const instant = zonedWallTimeToUtc(cand.y, cand.mo, cand.d, hh, mi, tz);
      if (instant.getTime() > after.getTime()) return instant;
    }
    return null;
  }

  static create(orgId: string, input: any, actorId?: string): any {
    const title = String(input.title || "").trim();
    if (!title) throw new Error("Informe um título para a tarefa recorrente.");
    const frequency = ["daily", "weekly", "monthly"].includes(input.frequency) ? input.frequency : null;
    if (!frequency) throw new Error("frequency deve ser daily, weekly ou monthly.");
    const startsOn = String(input.startsOn || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw new Error("startsOn (YYYY-MM-DD) é obrigatório.");
    const localTime = /^\d{2}:\d{2}$/.test(String(input.localTime)) ? input.localTime : "09:00";
    const interval = Math.max(1, Math.trunc(Number(input.interval) || 1));
    const id = randomUUID();
    const rule = {
      id, organization_id: orgId, title,
      description: input.description || null,
      assigned_to: input.assignedTo || null,
      store_id: input.storeId || null,
      priority: input.priority || "media",
      frequency, interval,
      by_weekday: Array.isArray(input.byWeekday) ? JSON.stringify(input.byWeekday.filter((n: any) => Number.isInteger(n) && n >= 0 && n <= 6)) : null,
      day_of_month: input.dayOfMonth != null ? Math.min(31, Math.max(1, Math.trunc(Number(input.dayOfMonth)))) : null,
      local_time: localTime,
      timezone: input.timezone || "America/Sao_Paulo",
      starts_on: startsOn,
      ends_on: input.endsOn ? String(input.endsOn).slice(0, 10) : null,
      max_occurrences: input.maxOccurrences != null && input.maxOccurrences !== "" ? Math.max(1, Math.trunc(Number(input.maxOccurrences))) : null,
      notification_policy_json: input.notificationPolicy ? JSON.stringify(input.notificationPolicy) : null,
      created_by: actorId || null,
    };
    // Primeiro next_run_at: a partir de 1ms antes do início (inclui o próprio start).
    const startInstant = zonedWallTimeToUtc(parseYmd(startsOn).y, parseYmd(startsOn).mo, parseYmd(startsOn).d, 0, 0, rule.timezone);
    const first = this.computeNextRun(rule, new Date(startInstant.getTime() - 1));
    db.prepare(`
      INSERT INTO task_recurrence_rules (id, organization_id, title, description, assigned_to, store_id, priority, frequency, interval, by_weekday, day_of_month, local_time, timezone, starts_on, ends_on, max_occurrences, next_run_at, status, notification_policy_json, created_by, updated_by)
      VALUES (@id, @organization_id, @title, @description, @assigned_to, @store_id, @priority, @frequency, @interval, @by_weekday, @day_of_month, @local_time, @timezone, @starts_on, @ends_on, @max_occurrences, @next_run_at, 'active', @notification_policy_json, @created_by, @created_by)
    `).run({ ...rule, next_run_at: first ? first.toISOString() : null });
    try { logAuthEvent(orgId, actorId || "system", id, "TASK_RECURRENCE_CREATED", { title, frequency, interval }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any | null {
    return (db.prepare(`SELECT * FROM task_recurrence_rules WHERE organization_id = ? AND id = ?`).get(orgId, id) as any) || null;
  }

  static list(orgId: string, opts: { status?: string } = {}): any[] {
    const where = ["organization_id = ?"]; const args: any[] = [orgId];
    if (opts.status) { where.push("status = ?"); args.push(opts.status); }
    return db.prepare(`SELECT * FROM task_recurrence_rules WHERE ${where.join(" AND ")} ORDER BY created_at DESC`).all(...args) as any[];
  }

  static pause(orgId: string, id: string, actorId?: string): any | null {
    const r = this.get(orgId, id); if (!r) return null;
    db.prepare(`UPDATE task_recurrence_rules SET status = 'paused', updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(actorId || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "TASK_RECURRENCE_PAUSED", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static resume(orgId: string, id: string, actorId?: string): any | null {
    const r = this.get(orgId, id); if (!r) return null;
    if (r.status === "completed") throw new Error("regra já encerrada");
    // Reprograma o próximo disparo a partir de agora (não refaz o passado).
    const next = this.computeNextRun(r, new Date());
    db.prepare(`UPDATE task_recurrence_rules SET status = 'active', next_run_at = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
      .run(next ? next.toISOString() : null, actorId || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "TASK_RECURRENCE_RESUMED", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Encerra a regra (fim antecipado). Não mexe em ocorrências já materializadas. */
  static end(orgId: string, id: string, actorId?: string): any | null {
    const r = this.get(orgId, id); if (!r) return null;
    db.prepare(`UPDATE task_recurrence_rules SET status = 'completed', next_run_at = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(actorId || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "TASK_RECURRENCE_ENDED", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Quantas ocorrências já foram materializadas (derivado — RN-004). */
  private static materializedCount(orgId: string, ruleId: string): number {
    return Number((db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ? AND recurrence_rule_id = ?`).get(orgId, ruleId) as any)?.c || 0);
  }

  /**
   * Materializa as ocorrências VENCIDAS de UMA regra até `now`. Idempotente,
   * limitado por MAX_CATCHUP; ocorrências > GRACE dias são puladas (avança sem
   * criar). Retorna quantas tarefas criou.
   */
  static materializeRule(orgId: string, rule: any, now: Date, actorId?: string): number {
    if (rule.status !== "active" || !rule.next_run_at) return 0;
    let created = 0;
    let next: Date | null = new Date(rule.next_run_at);
    const graceFloor = now.getTime() - GRACE_DAYS * DAY_MS;

    // Fase 1: FAST-FORWARD sobre ocorrências velhas (fora da graça) — só avança o
    // relógio, NÃO materializa (evita enxurrada de tarefas atrasadas). Guardado
    // por um teto alto contra loop infinito.
    let guard = 0;
    while (next && next.getTime() < graceFloor && guard++ < 5000) next = this.computeNextRun(rule, next);

    // Fase 2: materializa as ocorrências dentro de [graça, agora], LIMITADO.
    while (next && next.getTime() <= now.getTime() && created < MAX_CATCHUP) {
      if (rule.max_occurrences != null && this.materializedCount(orgId, rule.id) >= rule.max_occurrences) {
        this.markCompleted(orgId, rule.id); return created;
      }
      const scheduledIso = next.toISOString();
      const dedupeKey = `${rule.id}:${scheduledIso}`;
      const exists = db.prepare(`SELECT 1 FROM tasks WHERE organization_id = ? AND occurrence_dedupe_key = ?`).get(orgId, dedupeKey);
      if (!exists) {
        try {
          TaskService.create(orgId, {
            title: rule.title, description: rule.description || "", assignedTo: rule.assigned_to,
            priority: rule.priority, source: "recurrence", dueAt: scheduledIso,
            recurrenceRuleId: rule.id, scheduledOccurrenceAt: scheduledIso, occurrenceDedupeKey: dedupeKey,
          }, actorId || "system");
          created++;
        } catch (e: any) {
          // Corrida: outro passe materializou (índice único) — segue em frente.
          if (!/UNIQUE|constraint/i.test(String(e?.message))) throw e;
        }
      }
      next = this.computeNextRun(rule, next);
    }

    // Persiste o próximo disparo (ou encerra se acabou).
    if (!next) this.markCompleted(orgId, rule.id);
    else db.prepare(`UPDATE task_recurrence_rules SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(next.toISOString(), orgId, rule.id);
    return created;
  }

  private static markCompleted(orgId: string, id: string): void {
    db.prepare(`UPDATE task_recurrence_rules SET status = 'completed', next_run_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, id);
  }

  /** Passe do Scheduler: materializa todas as regras ativas vencidas (todas as orgs). */
  static materializeDuePass(now: Date = new Date()): number {
    const rules = db.prepare(`SELECT * FROM task_recurrence_rules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?`).all(now.toISOString()) as any[];
    let total = 0;
    for (const rule of rules) {
      try { total += this.materializeRule(rule.organization_id, rule, now); } catch (e: any) { console.error("[TaskRecurrence] regra falhou", rule.id, e?.message); }
    }
    return total;
  }
}
