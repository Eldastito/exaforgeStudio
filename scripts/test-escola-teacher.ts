/**
 * TESTE — Módulo Escola Fatia 2: Agenda do professor (ADR-144)
 * ------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - professor como entidade própria (não é contato do CRM);
 *   - grade recorrente por turma resolvida por dia (weekday determinístico);
 *   - grade da TURMA agregando professores;
 *   - OPT-IN como PORTA: sem opt-in não envia e não marca dedupe;
 *   - texto determinístico do "resumo antes da aula";
 *   - janela da manhã (SP) respeitada; fora da janela não envia;
 *   - sem aulas no dia não envia (e não marca dedupe);
 *   - dedupe: envia 1×/dia por professor;
 *   - confirmação pós-aula: not_held publica sinal education class_not_held;
 *     reconfirmar como held resolve o sinal;
 *   - sendNow ignora janela/dedupe mas respeita opt-in e existência de aulas;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:escola-teacher
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escola-teacher-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-escola-teacher-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// 2026-08-03 é uma SEGUNDA-FEIRA (weekday 1). Datas SP determinísticas:
const MORNING = new Date("2026-08-03T11:00:00Z"); // 08:00 SP (segunda) → dentro da janela
const NIGHT = new Date("2026-08-03T23:00:00Z");   // 20:00 SP → fora da janela
const SUNDAY_MORNING = new Date("2026-08-02T11:00:00Z"); // 08:00 SP (domingo, sem aulas)

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { TeacherService } = await import("../src/server/TeacherService.js");
  const { TeacherDigestService } = await import("../src/server/TeacherDigestService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, enabled_modules) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, `Escola ${tag}`, JSON.stringify(["escola"]));
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string, phone: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, channelId, n, phone);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, mkContact };
  }

  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 1. Professor é entidade própria ----
  const ana = TeacherService.createTeacher(A.orgId, { fullName: "Ana Ribeiro", subject: "Matemática", phone: "5511988887777" }, A.actorId).teacher;
  check("Professor criado como entidade própria", !!ana.id && ana.full_name === "Ana Ribeiro" && ana.subject === "Matemática");
  check("Professor NÃO é um contato do CRM", !db.prepare("SELECT id FROM contacts WHERE id = ?").get(ana.id));
  check("weekdayOf calcula segunda como 1", TeacherService.weekdayOf("2026-08-03") === 1 && TeacherService.weekdayOf("2026-08-02") === 0);

  // ---- 2. Grade recorrente por turma (segunda = weekday 1) ----
  const s1 = TeacherService.addScheduleItem(A.orgId, ana.id, { turma: "3º ano B", weekday: 1, timeLabel: "7h30", subject: "Matemática" }, A.actorId);
  TeacherService.addScheduleItem(A.orgId, ana.id, { turma: "2º ano A", weekday: 1, timeLabel: "9h20", subject: "Matemática" }, A.actorId);
  TeacherService.addScheduleItem(A.orgId, ana.id, { turma: "3º ano B", weekday: 3, timeLabel: "7h30", subject: "Matemática" }, A.actorId); // quarta
  const monday = TeacherService.scheduleForDay(A.orgId, ana.id, "2026-08-03");
  check("Grade do dia resolve só as aulas de segunda", monday.length === 2 && monday.every((c: any) => c.weekday === 1));
  check("Grade do dia ordena por horário", monday[0].time_label === "7h30" && monday[1].time_label === "9h20");
  const wednesday = TeacherService.scheduleForDay(A.orgId, ana.id, "2026-08-05");
  check("Grade de quarta traz só a aula de quarta", wednesday.length === 1 && wednesday[0].time_label === "7h30");
  check("Dia inválido na grade lança erro", (() => { try { TeacherService.scheduleForDay(A.orgId, ana.id, "03/08/2026"); return false; } catch { return true; } })());

  // Segundo professor na mesma turma/dia (grade da turma agrega)
  const bruno = TeacherService.createTeacher(A.orgId, { fullName: "Bruno Souza", subject: "História", phone: "5511977776666" }, A.actorId).teacher;
  TeacherService.addScheduleItem(A.orgId, bruno.id, { turma: "3º ano B", weekday: 1, timeLabel: "10h10", subject: "História" }, A.actorId);
  const turma = TeacherService.turmaScheduleForDay(A.orgId, "3º ano B", "2026-08-03");
  check("Grade da turma agrega professores", turma.length === 2 && turma.some((c: any) => c.teacher_name === "Ana Ribeiro") && turma.some((c: any) => c.teacher_name === "Bruno Souza"));

  // ---- 3. Opt-in como PORTA ----
  const sent: Array<{ phone: string; text: string }> = [];
  const send = (phone: string, text: string) => { sent.push({ phone, text }); };

  const r0 = await TeacherDigestService.runAgendaPass(A.orgId, { now: MORNING, send });
  check("Sem opt-in não envia (porta fechada)", r0.sent === 0 && sent.length === 0);
  const t0 = db.prepare("SELECT last_agenda_date FROM teacher_profiles WHERE id = ?").get(ana.id) as any;
  check("Sem opt-in NÃO marca dedupe", t0?.last_agenda_date == null);

  TeacherService.setNotifyOptIn(A.orgId, ana.id, true, A.actorId);
  TeacherService.setNotifyOptIn(A.orgId, bruno.id, true, A.actorId);

  // ---- 4. Texto determinístico ----
  const preview = TeacherDigestService.dailyAgenda(A.orgId, ana.id, "2026-08-03");
  check("Resumo cumprimenta o professor pelo 1º nome", preview.text.includes("Bom dia, professor(a) Ana"));
  check("Resumo lista as aulas com horário/turma", preview.text.includes("7h30 — Matemática · 3º ano B") && preview.text.includes("9h20 — Matemática · 2º ano A"));
  check("Resumo conta as aulas do dia", preview.classCount === 2);
  const previewSun = TeacherDigestService.dailyAgenda(A.orgId, ana.id, "2026-08-02");
  check("Sem aulas o resumo avisa que não há", previewSun.classCount === 0 && previewSun.text.includes("Sem aulas"));

  // ---- 5. Fora da janela não envia ----
  const rNight = await TeacherDigestService.runAgendaPass(A.orgId, { now: NIGHT, send });
  check("Fora da janela da manhã não envia", rNight.sent === 0 && sent.length === 0);

  // ---- 6. Domingo (sem aulas) não envia nem marca dedupe ----
  const rSun = await TeacherDigestService.runAgendaPass(A.orgId, { now: SUNDAY_MORNING, send });
  check("Sem aulas no dia não envia", rSun.sent === 0 && rSun.results.every(r => r.reason === "no_classes"));
  const tSun = db.prepare("SELECT last_agenda_date FROM teacher_profiles WHERE id = ?").get(ana.id) as any;
  check("Sem aulas NÃO marca dedupe", tSun?.last_agenda_date == null);

  // ---- 7. Janela da manhã: os dois professores com aula recebem ----
  const r1 = await TeacherDigestService.runAgendaPass(A.orgId, { now: MORNING, send });
  check("Na janela, ambos os professores recebem", r1.sent === 2 && sent.length === 2);
  check("Enviou para os telefones certos", sent.some(s => s.phone === "5511988887777") && sent.some(s => s.phone === "5511977776666"));

  // ---- 8. Dedupe: não repete no mesmo dia ----
  const r2 = await TeacherDigestService.runAgendaPass(A.orgId, { now: MORNING, send });
  check("Deduplica no mesmo dia (não reenvia)", r2.sent === 0 && sent.length === 2);

  // ---- 9. Confirmação pós-aula → sinal de coordenação ----
  const conf = TeacherService.confirmClass(A.orgId, { scheduleItemId: s1.id, date: "2026-08-03", status: "not_held", note: "professora ausente" }, A.actorId);
  const sigs = BusinessSignalService.list(A.orgId, { domain: "education" });
  check("Aula não realizada publica sinal education class_not_held", !!conf.signalId && sigs.length === 1 && sigs[0].signal_type === "class_not_held");
  check("Sinal de aula não realizada é 'attention'", sigs[0].severity === "attention");
  const confHeld = TeacherService.confirmClass(A.orgId, { scheduleItemId: s1.id, date: "2026-08-03", status: "held" }, A.actorId);
  check("Reconfirmar como realizada resolve o sinal", confHeld.status === "held" && BusinessSignalService.list(A.orgId, { domain: "education", status: "open" }).length === 0);
  check("Confirmação é idempotente por (aula, data)", TeacherService.confirmationsForDay(A.orgId, "2026-08-03").length === 1);
  check("Status inválido de confirmação lança erro", (() => { try { TeacherService.confirmClass(A.orgId, { scheduleItemId: s1.id, date: "2026-08-03", status: "maybe" }, A.actorId); return false; } catch { return true; } })());

  // ---- 10. sendNow ignora janela/dedupe, respeita opt-in e aulas ----
  const before = sent.length;
  const now1 = await TeacherDigestService.sendNow(A.orgId, ana.id, { now: NIGHT, send });
  check("sendNow envia mesmo à noite e após dedupe", now1.sent === 1 && sent.length === before + 1);
  const nowSun = await TeacherDigestService.sendNow(A.orgId, ana.id, { now: SUNDAY_MORNING, send });
  check("sendNow sem aulas no dia não envia", nowSun.sent === 0 && nowSun.reason === "no_classes");
  TeacherService.setNotifyOptIn(A.orgId, ana.id, false, A.actorId);
  const nowOff = await TeacherDigestService.sendNow(A.orgId, ana.id, { now: MORNING, send });
  check("sendNow respeita revogação do opt-in", nowOff.sent === 0 && nowOff.reason === "no_opt_in");

  // ---- 11. Isolamento multi-tenant ----
  const carla = TeacherService.createTeacher(B.orgId, { fullName: "Carla Dias", subject: "Ciências", phone: "5511911112222" }, B.actorId).teacher;
  check("Org B não vê professores de A", TeacherService.listTeachers(B.orgId).length === 1 && TeacherService.listTeachers(B.orgId)[0].id === carla.id);
  check("Grade da turma de B não enxerga aulas de A", TeacherService.turmaScheduleForDay(B.orgId, "3º ano B", "2026-08-03").length === 0);
  check("Confirmar aula de A por B falha", (() => { try { TeacherService.confirmClass(B.orgId, { scheduleItemId: s1.id, date: "2026-08-03", status: "held" }, B.actorId); return false; } catch (e: any) { return e.message.includes("não encontrada"); } })());
  TeacherService.setNotifyOptIn(B.orgId, carla.id, true, B.actorId);
  const rB = await TeacherDigestService.runAgendaPass(B.orgId, { now: MORNING, send });
  check("Passe de B (professora sem aulas hoje) não envia", rB.sent === 0);

  console.log("\n=== Módulo Escola — Agenda do professor (ADR-144, Fatia 2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
