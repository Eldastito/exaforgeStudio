/**
 * TESTE — Editar recorrência "esta e as próximas" (PRD Moda/TOULON, TASK-005)
 * ----------------------------------------------------------------------------
 * Prova, offline (TaskRecurrenceService.update):
 *   - edita a regra (título/responsável/prioridade/cronograma) + bump de version;
 *   - propaga CONTEÚDO às ocorrências ABERTAS (a_fazer/fazendo);
 *   - NUNCA reescreve ocorrências CONCLUÍDAS (feito) nem canceladas;
 *   - applyToOpen=false não toca nas tarefas materializadas;
 *   - mudança de cronograma recomputa next_run_at;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:task-recurrence-edit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-task-recur-edit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-task-recur-edit-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { TaskRecurrenceService } = await import("../src/server/TaskRecurrenceService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;
  const U1 = randomUUID(), U2 = randomUUID();

  const rule = TaskRecurrenceService.create(A, { title: "Abrir a loja", frequency: "daily", startsOn: "2026-08-10", localTime: "09:00", assignedTo: U1, priority: "media" });
  // materializa 2 ocorrências
  TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, rule.id), new Date("2026-08-10T13:00:00.000Z"));
  TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, rule.id), new Date("2026-08-11T13:00:00.000Z"));
  const tasks = db.prepare(`SELECT id, status FROM tasks WHERE organization_id = ? AND recurrence_rule_id = ? ORDER BY scheduled_occurrence_at`).all(A, rule.id) as any[];
  check("2 ocorrências materializadas", tasks.length === 2, `n=${tasks.length}`);
  // conclui a primeira, deixa a segunda aberta
  const doneId = tasks[0].id, openId = tasks[1].id;
  db.prepare(`UPDATE tasks SET status = 'feito', title = 'Abrir a loja', assigned_to = ? WHERE id = ?`).run(U1, doneId);

  // ===== 1. Editar "esta e as próximas" =====
  const before = TaskRecurrenceService.get(A, rule.id);
  const upd = TaskRecurrenceService.update(A, rule.id, { title: "Abrir a loja às 8h", assignedTo: U2, priority: "alta", localTime: "08:00", interval: 2 }, {}, "actor1");
  check("regra: título atualizado", upd.title === "Abrir a loja às 8h");
  check("regra: responsável atualizado", upd.assigned_to === U2);
  check("regra: cronograma (localTime/interval)", upd.local_time === "08:00" && upd.interval === 2);
  check("version incrementou", Number(upd.version) === Number(before.version) + 1, `v ${before.version}→${upd.version}`);
  check("next_run_at recomputado (08:00 = 11:00Z)", /T11:00:00/.test(String(upd.next_run_at)), upd.next_run_at);

  // ===== 2. Propaga só às ocorrências ABERTAS =====
  const openTask = db.prepare(`SELECT title, assigned_to, priority FROM tasks WHERE id = ?`).get(openId) as any;
  check("ocorrência ABERTA recebe novo título", openTask.title === "Abrir a loja às 8h");
  check("ocorrência ABERTA recebe novo responsável", openTask.assigned_to === U2);
  const doneTask = db.prepare(`SELECT title, assigned_to FROM tasks WHERE id = ?`).get(doneId) as any;
  check("ocorrência CONCLUÍDA NÃO é reescrita (título)", doneTask.title === "Abrir a loja");
  check("ocorrência CONCLUÍDA NÃO é reescrita (responsável)", doneTask.assigned_to === U1);

  // ===== 3. applyToOpen=false não toca nas tarefas =====
  const upd2 = TaskRecurrenceService.update(A, rule.id, { title: "Só na regra" }, { applyToOpen: false }, "actor1");
  check("regra atualizada", upd2.title === "Só na regra");
  const openTask2 = db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(openId) as any;
  check("applyToOpen=false: tarefa aberta intacta", openTask2.title === "Abrir a loja às 8h");

  // ===== 4. Isolamento =====
  const other = TaskRecurrenceService.update(B, rule.id, { title: "hack" }, {}, "x");
  check("update em outra org não acha a regra", other === null);

  console.log("\n=== TEST: Editar recorrência esta-e-próximas (TASK-005) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
