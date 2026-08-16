/**
 * TESTE — Lembrete de tarefa por WhatsApp (PRD Moda/TOULON, TASK-007; ADR-172)
 * ----------------------------------------------------------------------------
 * Prova, offline (TaskReminderService, com `send` injetado):
 *   - regra opt-in (policy.whatsapp) + responsável com telefone → envia 1x;
 *   - DEDUPE: reprocessar não reenvia (already_sent);
 *   - sem telefone → não é candidato / no_phone;
 *   - policy sem whatsapp → não é candidato;
 *   - janela de silêncio (quiet hours) → não envia (sem log, re-tenta depois);
 *   - falha → log failed + retry; após 3 tentativas → DLQ (para de tentar);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:task-reminder
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-task-reminder-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-task-reminder-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { TaskRecurrenceService } = await import("../src/server/TaskRecurrenceService.js");
  const { TaskReminderService } = await import("../src/server/TaskReminderService.js");
  const { UxPreferencesService } = await import("../src/server/UxPreferencesService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;

  const mkUser = (org: string, phone: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, phone, global_status) VALUES (?, ?, 'Resp', ?, 'x', 'agent', ?, 'active')`)
      .run(id, org, id + "@t.com", phone);
    return id;
  };
  const userWithPhone = mkUser(A, "31988887777");
  const userNoPhone = mkUser(A, null);

  const mkRule = (org: string, assignee: string | null, whatsapp: boolean) => {
    const r = TaskRecurrenceService.create(org, {
      title: "Conferir malote", frequency: "daily", startsOn: "2026-08-10", localTime: "09:00",
      assignedTo: assignee, notificationPolicy: whatsapp ? { whatsapp: true } : {},
    });
    // materializa uma ocorrência vencida
    TaskRecurrenceService.materializeRule(org, TaskRecurrenceService.get(org, r.id), new Date("2026-08-10T13:00:00.000Z"));
    return r;
  };

  const ruleWA = mkRule(A, userWithPhone, true);
  const ruleNoPhone = mkRule(A, userNoPhone, true);
  const ruleNoWA = mkRule(A, userWithPhone, false);

  // ===== 1. Candidatos: só a regra opt-in com telefone =====
  const cands = TaskReminderService.pendingCandidates(A);
  check("1 candidato (opt-in + telefone)", cands.length === 1 && cands[0].assigned_to === userWithPhone, `n=${cands.length}`);

  // ===== 2. Envia 1x + dedupe =====
  const sent: { to: string; msg: string }[] = [];
  const send = async (to: string, msg: string) => { sent.push({ to, msg }); return "ok"; };
  const r1 = await TaskReminderService.remindForOrg(A, send, { hourSP: 12 });
  check("envia 1 lembrete", r1.sent === 1 && sent.length === 1, JSON.stringify(r1));
  check("envia para o telefone do responsável", sent[0]?.to === "31988887777");
  check("mensagem cita o título", /Conferir malote/.test(sent[0]?.msg || ""));
  const r2 = await TaskReminderService.remindForOrg(A, send, { hourSP: 12 });
  check("dedupe: não reenvia", r2.sent === 0 && sent.length === 1);

  // ===== 3. Quiet hours (define janela acordada 8..22; 3h = silêncio) =====
  const ruleWA2 = mkRule(A, userWithPhone, true); // nova ocorrência p/ testar
  // avança a ocorrência: materializa outro dia
  TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, ruleWA2.id), new Date("2026-08-11T13:00:00.000Z"));
  UxPreferencesService.set(A, undefined, { awakeStart: 8, awakeEnd: 22 });
  const sentQuiet: any[] = [];
  const rq = await TaskReminderService.remindForOrg(A, async (to, m) => { sentQuiet.push({ to, m }); }, { hourSP: 3 });
  check("quiet hours não envia", rq.sent === 0 && sentQuiet.length === 0, JSON.stringify(rq));
  // acordado agora envia
  const rqa = await TaskReminderService.remindForOrg(A, async (to, m) => { sentQuiet.push({ to, m }); }, { hourSP: 12 });
  check("fora do silêncio, envia (re-tenta)", rqa.sent >= 1 && sentQuiet.length >= 1);

  // ===== 4. Falha + retry + DLQ =====
  const ruleFail = mkRule(A, userWithPhone, true);
  TaskRecurrenceService.materializeRule(A, TaskRecurrenceService.get(A, ruleFail.id), new Date("2026-08-12T13:00:00.000Z"));
  const failTask = TaskReminderService.pendingCandidates(A).find((c: any) => c.assigned_to === userWithPhone);
  const boom = async () => { throw new Error("provedor fora do ar"); };
  const f1 = await TaskReminderService.remindTask(A, failTask, boom, { hourSP: 12 });
  check("falha vira status failed", f1.status === "failed");
  const logAfter1 = db.prepare(`SELECT status, attempts FROM task_reminder_log WHERE organization_id = ? AND task_id = ?`).get(A, failTask.id) as any;
  check("log failed attempts=1", logAfter1?.status === "failed" && logAfter1?.attempts === 1);
  await TaskReminderService.remindTask(A, failTask, boom, { hourSP: 12 }); // attempts 2
  const f3 = await TaskReminderService.remindTask(A, failTask, boom, { hourSP: 12 }); // attempts 3
  const logAfter3 = db.prepare(`SELECT attempts FROM task_reminder_log WHERE organization_id = ? AND task_id = ?`).get(A, failTask.id) as any;
  check("retry acumula tentativas (3)", logAfter3?.attempts === 3);
  const f4 = await TaskReminderService.remindTask(A, failTask, boom, { hourSP: 12 }); // DLQ
  check("após 3 tentativas → DLQ (skip)", f4.status === "skipped" && f4.reason === "dlq");
  // recuperação: se o provedor volta, um send OK ainda não acontece (DLQ) — precisa nova ocorrência
  check("DLQ não reenvia mesmo com send ok", (await TaskReminderService.remindTask(A, failTask, send, { hourSP: 12 })).status === "skipped");

  // ===== 5. Isolamento =====
  const uB = mkUser(B, "31955554444");
  mkRule(B, uB, true);
  const sentB: any[] = [];
  await TaskReminderService.remindForOrg(A, async () => { sentB.push(1); }, { hourSP: 12 });
  check("processar org A não toca candidatos da B", TaskReminderService.pendingCandidates(B).length === 1);

  console.log("\n=== TEST: Lembrete de tarefa por WhatsApp (TASK-007) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
