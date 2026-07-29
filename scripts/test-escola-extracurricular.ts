/**
 * TESTE — Módulo Escola Fatia 3: Extracurriculares (ADR-144)
 * ----------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - CRUD atividade com vagas (capacity);
 *   - matrícula atômica: preenche vagas, depois vira lista de espera com posição;
 *   - idempotência da matrícula (não duplica);
 *   - cancelar uma vaga PROMOVE o 1º da lista de espera;
 *   - roster (matriculados + espera ordenada);
 *   - presença por sessão idempotente; só p/ aluno matriculado;
 *   - aviso ao responsável determinístico (matrícula/espera/promoção/falta);
 *   - PORTA de consentimento (D3): sem digest_consent não avisa;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:escola-extracurricular
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escola-extra-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-escola-extra-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StudentService } = await import("../src/server/StudentService.js");
  const { ExtracurricularService } = await import("../src/server/ExtracurricularService.js");
  const { ExtracurricularNoticeService } = await import("../src/server/ExtracurricularNoticeService.js");

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

  // Alunos + responsável consentindo (só o do Lucas consente)
  const lucas = StudentService.createStudent(A.orgId, { fullName: "Lucas Andrade", turma: "3º ano B" }, A.actorId).student;
  const maria = StudentService.createStudent(A.orgId, { fullName: "Maria Silva", turma: "3º ano B" }, A.actorId).student;
  const bia = StudentService.createStudent(A.orgId, { fullName: "Bia Costa", turma: "2º ano A" }, A.actorId).student;
  const juliana = A.mkContact("Juliana Andrade", "5511988887777");
  StudentService.linkGuardian(A.orgId, lucas.id, { guardianContactId: juliana, isPrimary: true }, A.actorId);
  StudentService.setConsent(A.orgId, lucas.id, juliana, true, A.actorId);
  // Maria tem responsável SEM consentimento (porta fechada)
  const pedro = A.mkContact("Pedro Silva", "5511970001111");
  StudentService.linkGuardian(A.orgId, maria.id, { guardianContactId: pedro }, A.actorId);

  // ---- 1. Atividade com 2 vagas ----
  const futsal = ExtracurricularService.createActivity(A.orgId, { name: "Futsal", capacity: 2, dayLabel: "Terça e Quinta", timeLabel: "16h" }, A.actorId).activity;
  check("Atividade criada com capacidade", futsal.name === "Futsal" && futsal.capacity === 2);
  check("Atividade não é reserva/contato", !db.prepare("SELECT id FROM products_services WHERE id = ?").get(futsal.id) && !db.prepare("SELECT id FROM contacts WHERE id = ?").get(futsal.id));

  // ---- 2. Matrícula preenche vagas ----
  const e1 = ExtracurricularService.enroll(A.orgId, futsal.id, lucas.id, A.actorId);
  const e2 = ExtracurricularService.enroll(A.orgId, futsal.id, maria.id, A.actorId);
  check("1º e 2º matriculados ocupam as vagas", e1.status === "enrolled" && e2.status === "enrolled");
  const info2 = ExtracurricularService.getActivity(A.orgId, futsal.id);
  check("Sem vagas restantes após lotar", info2.seatsLeft === 0 && info2.enrolled === 2);

  // ---- 3. Cheio → lista de espera com posição ----
  const e3 = ExtracurricularService.enroll(A.orgId, futsal.id, bia.id, A.actorId);
  check("3º matriculado vai p/ lista de espera na posição 1", e3.status === "waitlisted" && e3.position === 1);

  // ---- 4. Idempotência ----
  const e1again = ExtracurricularService.enroll(A.orgId, futsal.id, lucas.id, A.actorId);
  check("Rematricular o mesmo aluno é idempotente", e1again.deduped === true && e1again.status === "enrolled");
  check("Idempotência não muda contagem", ExtracurricularService.getActivity(A.orgId, futsal.id).enrolled === 2);

  // ---- 5. roster ----
  const roster = ExtracurricularService.roster(A.orgId, futsal.id);
  check("Roster lista 2 matriculados e 1 na espera", roster.enrolled.length === 2 && roster.waitlist.length === 1 && roster.waitlist[0].student_name === "Bia Costa");

  // ---- 6. Cancelar vaga promove o 1º da espera ----
  const cancel = ExtracurricularService.cancelEnrollment(A.orgId, futsal.id, maria.id, A.actorId);
  check("Cancelar matrícula promove o 1º da espera", cancel.promotedStudentId === bia.id);
  const rosterAfter = ExtracurricularService.roster(A.orgId, futsal.id);
  check("Após promoção: 2 matriculados, 0 na espera", rosterAfter.enrolled.length === 2 && rosterAfter.waitlist.length === 0);
  check("Bia agora está matriculada", rosterAfter.enrolled.some((r: any) => r.student_id === bia.id));

  // ---- 7. Rematrícula após cancelar reabre pela regra de vaga ----
  const eMariaAgain = ExtracurricularService.enroll(A.orgId, futsal.id, maria.id, A.actorId);
  check("Rematrícula após cancelar respeita capacidade (volta p/ espera)", eMariaAgain.status === "waitlisted" && eMariaAgain.position === 1);

  // ---- 8. Textos determinísticos do aviso ----
  const tEnrolled = ExtracurricularNoticeService.enrollmentText("Lucas Andrade", futsal, "enrolled", null);
  check("Texto de matrícula confirmada", tEnrolled.includes("Matrícula confirmada") && tEnrolled.includes("*Futsal*") && tEnrolled.includes("SAIR"));
  const tWait = ExtracurricularNoticeService.enrollmentText("Bia Costa", futsal, "waitlisted", 1);
  check("Texto de lista de espera cita posição", tWait.includes("lista de espera") && tWait.includes("posição *1*"));
  const tPromo = ExtracurricularNoticeService.promotionText("Bia Costa", futsal);
  check("Texto de promoção (abriu vaga)", tPromo.includes("Abriu vaga") && tPromo.includes("matriculado"));
  const tAbs = ExtracurricularNoticeService.absenceText("Lucas Andrade", futsal, "2026-08-04");
  check("Texto de falta cita data", tAbs.includes("faltou hoje") && tAbs.includes("2026-08-04"));

  // ---- 9. Aviso ao responsável respeita a PORTA de consentimento ----
  const sent: Array<{ phone: string; text: string }> = [];
  const send = (phone: string, text: string) => { sent.push({ phone, text }); };
  const nLucas = await ExtracurricularNoticeService.notifyGuardians(A.orgId, lucas.id, tEnrolled, { send });
  check("Responsável consentindo recebe o aviso", nLucas.sent === 1 && sent.length === 1 && sent[0].phone === "5511988887777");
  const nMaria = await ExtracurricularNoticeService.notifyGuardians(A.orgId, maria.id, tWait, { send });
  check("Responsável SEM consentimento não recebe (porta fechada)", nMaria.sent === 0 && sent.length === 1);

  // ---- 10. Presença ----
  const att = ExtracurricularService.recordAttendance(A.orgId, { activityId: futsal.id, studentId: lucas.id, date: "2026-08-04", status: "absent" }, A.actorId);
  check("Falta registrada", att.status === "absent");
  const attAgain = ExtracurricularService.recordAttendance(A.orgId, { activityId: futsal.id, studentId: lucas.id, date: "2026-08-04", status: "present" }, A.actorId);
  const attCount = (db.prepare("SELECT COUNT(*) AS n FROM extracurricular_attendance WHERE organization_id = ? AND activity_id = ? AND student_id = ? AND date = ?").get(A.orgId, futsal.id, lucas.id, "2026-08-04") as any).n;
  check("Presença é idempotente por (atividade, aluno, data)", attCount === 1 && attAgain.status === "present");
  check("Presença só p/ aluno matriculado", (() => { try { ExtracurricularService.recordAttendance(A.orgId, { activityId: futsal.id, studentId: maria.id, date: "2026-08-04", status: "present" }, A.actorId); return false; } catch (e: any) { return e.message.includes("não está matriculado"); } })());
  check("Data/status inválidos são rejeitados", (() => { try { ExtracurricularService.recordAttendance(A.orgId, { activityId: futsal.id, studentId: lucas.id, date: "x", status: "present" }, A.actorId); return false; } catch { return true; } })());

  // ---- 11. Isolamento multi-tenant ----
  const bAct = ExtracurricularService.createActivity(B.orgId, { name: "Xadrez", capacity: 1 }, B.actorId).activity;
  check("Org B não vê atividades de A", ExtracurricularService.listActivities(B.orgId).length === 1 && ExtracurricularService.listActivities(B.orgId)[0].id === bAct.id);
  check("Matricular aluno de A em atividade de B falha", (() => { try { ExtracurricularService.enroll(B.orgId, bAct.id, lucas.id, B.actorId); return false; } catch (e: any) { return e.message.includes("não encontrado"); } })());

  console.log("\n=== Módulo Escola — Extracurriculares (ADR-144, Fatia 3) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
