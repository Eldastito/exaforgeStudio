/**
 * TESTE — Tarefas recorrentes: motor (PRD Moda/TOULON, frente TASK; ADR-171)
 * ----------------------------------------------------------------------------
 * Prova, offline (TaskRecurrenceService):
 *   - computeNextRun para daily/weekly/monthly com hora local (America/Sao_Paulo);
 *   - primeiro next_run_at cai no start; intervalo respeitado;
 *   - materializeRule cria UMA tarefa por ocorrência vencida (idempotente:
 *     reprocessar NÃO duplica — chave de dedupe);
 *   - catch-up limitado (ocorrências > GRACE puladas, sem enxurrada);
 *   - pausa não materializa; resume reprograma a partir de agora;
 *   - fim por contagem (max_occurrences) encerra a regra;
 *   - timezone: a tarefa materializada tem due_at às 09:00 locais (12:00Z);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:task-recurrence
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-task-recur-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-task-recurrence-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { TaskRecurrenceService } = await import("../src/server/TaskRecurrenceService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const countTasks = (org: string, ruleId: string) =>
    Number((db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ? AND recurrence_rule_id = ?`).get(org, ruleId) as any)?.c || 0);

  // ===== 1. Diária: next_run_at no start (09:00 local = 12:00Z, sem DST no BR) =====
  const daily = TaskRecurrenceService.create(A, { title: "Abrir a loja", frequency: "daily", startsOn: "2026-08-10", localTime: "09:00", timezone: "America/Sao_Paulo" });
  check("regra criada com next_run_at", !!daily.next_run_at);
  check("primeiro disparo no start às 12:00Z (09:00 -03)", daily.next_run_at === "2026-08-10T12:00:00.000Z", daily.next_run_at);

  // computeNextRun avança 1 dia
  const n2 = TaskRecurrenceService.computeNextRun(daily, new Date("2026-08-10T12:00:00.000Z"));
  check("próxima diária = +1 dia", n2?.toISOString() === "2026-08-11T12:00:00.000Z", n2?.toISOString());

  // ===== 2. Semanal seg/qua (1,3), intervalo 1 =====
  const weekly = TaskRecurrenceService.create(A, { title: "Repor vitrine", frequency: "weekly", byWeekday: [1, 3], startsOn: "2026-08-10", localTime: "08:00", timezone: "America/Sao_Paulo" });
  // 2026-08-10 é segunda. Primeiro disparo = seg 10 às 11:00Z.
  check("semanal: 1º disparo segunda 11:00Z", weekly.next_run_at === "2026-08-10T11:00:00.000Z", weekly.next_run_at);
  const wNext = TaskRecurrenceService.computeNextRun(weekly, new Date(weekly.next_run_at));
  check("semanal: próxima = quarta 12", wNext?.toISOString() === "2026-08-12T11:00:00.000Z", wNext?.toISOString());

  // ===== 3. Mensal dia 15 =====
  const monthly = TaskRecurrenceService.create(A, { title: "Contagem de estoque", frequency: "monthly", dayOfMonth: 15, startsOn: "2026-08-01", localTime: "18:00", timezone: "America/Sao_Paulo" });
  check("mensal: 1º disparo dia 15 21:00Z", monthly.next_run_at === "2026-08-15T21:00:00.000Z", monthly.next_run_at);
  const mNext = TaskRecurrenceService.computeNextRun(monthly, new Date(monthly.next_run_at));
  check("mensal: próxima = 15 do mês seguinte", mNext?.toISOString() === "2026-09-15T21:00:00.000Z", mNext?.toISOString());

  // ===== 4. Materialização idempotente =====
  const rule = TaskRecurrenceService.get(A, daily.id);
  const created1 = TaskRecurrenceService.materializeRule(A, rule, new Date("2026-08-10T13:00:00.000Z"));
  check("materializa 1 ocorrência vencida", created1 === 1 && countTasks(A, daily.id) === 1);
  // reprocessa o MESMO instante (regra recarregada) — não duplica
  const created2 = TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, daily.id), new Date("2026-08-10T13:00:00.000Z"));
  check("reprocessar não duplica (idempotente)", created2 === 0 && countTasks(A, daily.id) === 1);
  // a tarefa materializada tem due_at no horário da ocorrência
  const t = db.prepare(`SELECT due_at, source, occurrence_dedupe_key FROM tasks WHERE organization_id = ? AND recurrence_rule_id = ?`).get(A, daily.id) as any;
  check("tarefa tem due_at 12:00Z e source=recurrence", t?.due_at === "2026-08-10T12:00:00.000Z" && t?.source === "recurrence");

  // ===== 5. Catch-up limitado: regra antiga não gera enxurrada =====
  const old = TaskRecurrenceService.create(A, { title: "Antiga", frequency: "daily", startsOn: "2026-01-01", localTime: "09:00" });
  const createdOld = TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, old.id), new Date("2026-08-16T13:00:00.000Z"));
  check("catch-up pula ocorrências velhas (poucas criadas)", createdOld <= 3, `criadas=${createdOld}`);
  const oldRule = TaskRecurrenceService.get(A, old.id);
  check("regra antiga avançou next_run_at pra perto de agora", new Date(oldRule.next_run_at).getTime() > new Date("2026-08-14T00:00:00Z").getTime());

  // ===== 6. Pausa não materializa =====
  TaskRecurrenceService.pause(A, daily.id);
  const paused = TaskRecurrenceService.get(A, daily.id);
  const beforePause = countTasks(A, daily.id);
  const createdPaused = TaskRecurrenceService.materializeRule(A, paused, new Date("2026-08-20T13:00:00.000Z"));
  check("pausada não materializa", createdPaused === 0 && countTasks(A, daily.id) === beforePause);
  const resumed = TaskRecurrenceService.resume(A, daily.id);
  check("resume reativa e reprograma", resumed.status === "active" && !!resumed.next_run_at);

  // ===== 7. Fim por contagem =====
  const limited = TaskRecurrenceService.create(A, { title: "3x só", frequency: "daily", startsOn: "2026-08-10", localTime: "09:00", maxOccurrences: 3 });
  // materializa muito além — deve parar em 3 e encerrar
  TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, limited.id), new Date("2026-08-10T13:00:00.000Z"));
  // avança dia a dia até bater o limite
  for (let i = 0; i < 5; i++) {
    const r = TaskRecurrenceService.get(A, limited.id);
    if (r.status !== "active") break;
    TaskRecurrenceService.materializeRule(A, r, new Date(`2026-08-${String(11 + i).padStart(2, "0")}T13:00:00.000Z`));
  }
  check("fim por contagem: exatamente 3 tarefas", countTasks(A, limited.id) === 3, `n=${countTasks(A, limited.id)}`);
  check("regra encerrada (completed)", TaskRecurrenceService.get(A, limited.id).status === "completed");

  // ===== 8. materializeDuePass + isolamento =====
  const rb = TaskRecurrenceService.create(B, { title: "B", frequency: "daily", startsOn: "2026-08-10", localTime: "09:00" });
  const totalCreated = TaskRecurrenceService.materializeDuePass(new Date("2026-08-16T13:00:00.000Z"));
  check("materializeDuePass cria algo", totalCreated >= 1);
  check("org B isolada (tarefa só na B)", countTasks(B, rb.id) >= 1);
  const crossA = Number((db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ? AND recurrence_rule_id = ?`).get(A, rb.id) as any)?.c || 0);
  check("regra da B não materializa na A", crossA === 0);

  console.log("\n=== TEST: Tarefas recorrentes — motor (TASK Fase 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
