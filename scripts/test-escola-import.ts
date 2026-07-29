/**
 * TESTE — Módulo Escola Fatia 5: Conectores reais / import (ADR-144)
 * -----------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - import de alunos casa por matrícula (enrollment_code) e por nome+turma;
 *   - reimportar é idempotente (atualiza, não duplica);
 *   - import de responsável cria/reusa contato por telefone, vincula e consente;
 *   - import de grade cria professor e deduplica a grade;
 *   - import de agenda alimenta a fonte do resumo diário e deduplica;
 *   - o payload importado é consumível de ponta a ponta (resumo diário sai);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:escola-import
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escola-import-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-escola-import-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SchoolImportService } = await import("../src/server/SchoolImportService.js");
  const { StudentService } = await import("../src/server/StudentService.js");
  const { TeacherService } = await import("../src/server/TeacherService.js");
  const { SchoolDigestService } = await import("../src/server/SchoolDigestService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, enabled_modules) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, `Escola ${tag}`, JSON.stringify(["escola"]));
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(`ch_${tag}`, orgId, `Canal ${tag}`, `wa_${tag}`);
    return { orgId, actorId: `user_${tag}` };
  }

  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 1. Import inicial (todas as seções) ----
  const payload = {
    students: [
      { fullName: "Lucas Andrade", enrollmentCode: "2026-041", turma: "3º ano B" },
      { fullName: "Maria Silva", enrollmentCode: "2026-042", turma: "2º ano A" },
    ],
    guardians: [
      { student: "2026-041", name: "Juliana Andrade", phone: "+55 (11) 98888-7777", relationship: "mãe", isPrimary: true, consent: true },
    ],
    schedule: [
      { teacher: "Ana Ribeiro", teacherPhone: "5511970001111", turma: "3º ano B", weekday: 1, timeLabel: "7h30", subject: "Matemática" },
    ],
    agenda: [
      { student: "2026-041", date: "2026-08-03", kind: "class", title: "Aula", timeLabel: "7h30" },
      { student: "2026-041", date: "2026-08-03", kind: "activity", title: "Futsal", timeLabel: "16h" },
    ],
  };
  const r1 = SchoolImportService.importData(A.orgId, payload, { source: "planilha", actorId: A.actorId });
  check("Alunos criados", r1.students.created === 2 && r1.students.updated === 0);
  check("Responsável vinculado", r1.guardians.created === 1);
  check("Grade criada", r1.schedule.created === 1);
  check("Agenda criada", r1.agenda.created === 2);

  // Aluno casou por matrícula; responsável virou contato com consentimento
  const lucas = StudentService.listStudents(A.orgId, { q: "Lucas" })[0];
  const detail = StudentService.getStudent(A.orgId, lucas.id);
  check("Responsável tem consentimento (porta aberta)", detail.guardians.length === 1 && detail.guardians[0].digest_consent === 1);
  check("Contato do responsável guarda o telefone em dígitos", detail.guardians[0].guardian_identifier === "5511988887777");

  // ---- 2. Reimport idempotente (mesma planilha) ----
  const r2 = SchoolImportService.importData(A.orgId, payload, { source: "planilha", actorId: A.actorId });
  check("Reimport não duplica alunos (atualiza)", r2.students.updated === 2 && r2.students.created === 0);
  check("Reimport não duplica responsável", r2.guardians.updated === 1 && r2.guardians.created === 0);
  check("Reimport deduplica a grade", r2.schedule.updated === 1 && r2.schedule.created === 0);
  check("Reimport deduplica a agenda", r2.agenda.updated === 2 && r2.agenda.created === 0);
  check("Total de alunos permanece 2", StudentService.listStudents(A.orgId).length === 2);
  check("Contato do responsável não duplicou", (db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ?").get(A.orgId) as any).n === 1);
  check("Grade permanece com 1 item", TeacherService.getTeacher(A.orgId, TeacherService.listTeachers(A.orgId)[0].id).schedule.length === 1);

  // ---- 3. Update por matrícula (troca de turma não duplica) ----
  const r3 = SchoolImportService.importData(A.orgId, { students: [{ fullName: "Lucas Andrade", enrollmentCode: "2026-041", turma: "4º ano A" }] }, { source: "planilha" });
  check("Update por matrícula atualiza a turma", r3.students.updated === 1 && StudentService.getStudent(A.orgId, lucas.id).student.turma === "4º ano A");

  // ---- 4. Casamento por nome+turma quando não há matrícula ----
  const r4 = SchoolImportService.importData(A.orgId, { students: [{ fullName: "Bia Costa", turma: "1º ano" }] }, { source: "planilha" });
  const r4b = SchoolImportService.importData(A.orgId, { students: [{ fullName: "Bia Costa", turma: "1º ano" }] }, { source: "planilha" });
  check("Sem matrícula casa por nome+turma (não duplica)", r4.students.created === 1 && r4b.students.updated === 1 && StudentService.listStudents(A.orgId, { q: "Bia" }).length === 1);

  // ---- 5. Linhas inválidas são puladas ----
  const r5 = SchoolImportService.importData(A.orgId, {
    students: [{ fullName: "" }],
    guardians: [{ student: "inexistente", name: "X", phone: "5511900000000" }, { student: "2026-041", phone: "" }],
    schedule: [{ teacher: "Z", turma: "9º", weekday: 9 }],
    agenda: [{ student: "2026-041", date: "03/08/2026", title: "x" }],
  }, { source: "planilha" });
  check("Aluno sem nome é pulado", r5.students.skipped === 1);
  check("Responsável de aluno inexistente/sem telefone é pulado", r5.guardians.skipped === 2);
  check("Grade com weekday inválido é pulada", r5.schedule.skipped === 1);
  check("Agenda com data inválida é pulada", r5.agenda.skipped === 1);

  // ---- 6. Ponta a ponta: o resumo diário sai do que foi importado ----
  const digest = SchoolDigestService.dailyDigest(A.orgId, lucas.id, "2026-08-03", { guardianName: "Juliana Andrade" });
  check("Resumo diário consome a agenda importada", digest.text.includes("1 aula(s)") && digest.text.includes("Futsal às 16h"));

  // ---- 7. Isolamento multi-tenant ----
  SchoolImportService.importData(B.orgId, { students: [{ fullName: "Aluno B", enrollmentCode: "2026-041", turma: "1º" }] }, { source: "webhook" });
  check("Org B não enxerga alunos de A (matrícula igual, orgs distintas)", StudentService.listStudents(B.orgId).length === 1);
  check("Org A mantém seus alunos", StudentService.listStudents(A.orgId).length === 3);

  console.log("\n=== Módulo Escola — Conectores reais / import (ADR-144, Fatia 5) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
