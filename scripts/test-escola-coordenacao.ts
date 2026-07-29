/**
 * TESTE — Módulo Escola Fatia 4: Painel da coordenação (ADR-144)
 * -------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - turma_sem_professor: turma com alunos e sem grade/professor ativo;
 *     resolve quando a turma ganha grade;
 *   - falta_recorrente: aluno com N+ faltas NÃO justificadas (justificadas não contam);
 *   - aula_cancelada_recorrente: item de grade com N+ aulas não realizadas;
 *   - atividade_lista_espera: extracurricular com fila de espera; resolve ao abrir vaga;
 *   - idempotência do passe (recomputar não duplica);
 *   - painel traz sinais com ação recomendada e prioridades do domínio education;
 *   - education é first-class no Pareto (peso/ação/dono coordenacao);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:escola-coordenacao
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escola-coord-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-escola-coord-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StudentService } = await import("../src/server/StudentService.js");
  const { TeacherService } = await import("../src/server/TeacherService.js");
  const { ExtracurricularService } = await import("../src/server/ExtracurricularService.js");
  const { SchoolCoordinationService } = await import("../src/server/SchoolCoordinationService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, enabled_modules) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, `Escola ${tag}`, JSON.stringify(["escola"]));
    return { orgId, actorId: `user_${tag}` };
  }

  const A = seedOrg("A");
  const B = seedOrg("B");

  const openEdu = (orgId: string) => BusinessSignalService.list(orgId, { domain: "education", status: "open" });
  const byType = (orgId: string, t: string) => openEdu(orgId).filter((s: any) => s.signal_type === t);

  // Alunos em duas turmas
  const lucas = StudentService.createStudent(A.orgId, { fullName: "Lucas Andrade", turma: "3º ano B" }, A.actorId).student;
  const maria = StudentService.createStudent(A.orgId, { fullName: "Maria Silva", turma: "3º ano B" }, A.actorId).student;
  const bia = StudentService.createStudent(A.orgId, { fullName: "Bia Costa", turma: "2º ano A" }, A.actorId).student;

  // ---- 1. turma_sem_professor (nenhuma turma tem grade ainda) ----
  let pass = SchoolCoordinationService.runSignalsPass(A.orgId);
  check("Passe publica turma_sem_professor p/ as 2 turmas", byType(A.orgId, "turma_sem_professor").length === 2);
  check("Sinal de turma sem professor tem severidade risk", byType(A.orgId, "turma_sem_professor").every((s: any) => s.severity === "risk"));
  check("Evidência conta alunos da turma", byType(A.orgId, "turma_sem_professor").some((s: any) => s.evidence?.students === 2));

  // Dá grade/professor ao 3º ano B → esse sinal deve RESOLVER no próximo passe
  const ana = TeacherService.createTeacher(A.orgId, { fullName: "Ana Ribeiro", subject: "Matemática" }, A.actorId).teacher;
  TeacherService.addScheduleItem(A.orgId, ana.id, { turma: "3º ano B", weekday: 1, timeLabel: "7h30" }, A.actorId);
  pass = SchoolCoordinationService.runSignalsPass(A.orgId);
  check("Turma com grade resolve o sinal (fica só 2º ano A)", byType(A.orgId, "turma_sem_professor").length === 1 && byType(A.orgId, "turma_sem_professor")[0].evidence?.turma === "2º ano A");
  check("Passe reporta 1 resolvido", pass.resolved === 1);

  // ---- 2. idempotência ----
  const before = openEdu(A.orgId).length;
  SchoolCoordinationService.runSignalsPass(A.orgId);
  check("Recomputar o passe é idempotente (não duplica)", openEdu(A.orgId).length === before);

  // ---- 3. falta_recorrente (justificada não conta) ----
  StudentService.recordAbsence(A.orgId, lucas.id, "2026-08-03", "", A.actorId); // não justificada
  StudentService.recordAbsence(A.orgId, lucas.id, "2026-08-04", "", A.actorId);
  StudentService.recordAbsence(A.orgId, lucas.id, "2026-08-05", "atestado", A.actorId); // justificada
  SchoolCoordinationService.runSignalsPass(A.orgId);
  check("2 faltas ainda não disparam recorrência (limiar 3)", byType(A.orgId, "falta_recorrente").length === 0);
  StudentService.recordAbsence(A.orgId, lucas.id, "2026-08-06", "", A.actorId); // 3ª não justificada
  SchoolCoordinationService.runSignalsPass(A.orgId);
  const fr = byType(A.orgId, "falta_recorrente");
  check("3 faltas não justificadas disparam falta_recorrente", fr.length === 1 && fr[0].source_entity_id === lucas.id);
  check("Evidência conta só as faltas não justificadas", fr[0].evidence?.absences === 3);

  // ---- 4. aula_cancelada_recorrente ----
  const sched = TeacherService.addScheduleItem(A.orgId, ana.id, { turma: "3º ano B", weekday: 3, timeLabel: "9h20" }, A.actorId);
  TeacherService.confirmClass(A.orgId, { scheduleItemId: sched.id, date: "2026-08-05", status: "not_held" }, A.actorId);
  SchoolCoordinationService.runSignalsPass(A.orgId);
  check("1 aula não realizada não dispara recorrência (limiar 2)", byType(A.orgId, "aula_cancelada_recorrente").length === 0);
  TeacherService.confirmClass(A.orgId, { scheduleItemId: sched.id, date: "2026-08-12", status: "not_held" }, A.actorId);
  SchoolCoordinationService.runSignalsPass(A.orgId);
  check("2 aulas não realizadas disparam aula_cancelada_recorrente", byType(A.orgId, "aula_cancelada_recorrente").length === 1);

  // ---- 5. atividade_lista_espera (resolve ao abrir vaga) ----
  const futsal = ExtracurricularService.createActivity(A.orgId, { name: "Futsal", capacity: 1 }, A.actorId).activity;
  ExtracurricularService.enroll(A.orgId, futsal.id, lucas.id, A.actorId);   // vaga
  ExtracurricularService.enroll(A.orgId, futsal.id, maria.id, A.actorId);   // espera
  SchoolCoordinationService.runSignalsPass(A.orgId);
  const wl = byType(A.orgId, "atividade_lista_espera");
  check("Atividade com fila dispara atividade_lista_espera", wl.length === 1 && wl[0].evidence?.waitlist === 1);
  check("Sinal de lista de espera é attention", wl[0].severity === "attention");
  ExtracurricularService.cancelEnrollment(A.orgId, futsal.id, lucas.id, A.actorId); // promove maria → fila zera
  SchoolCoordinationService.runSignalsPass(A.orgId);
  check("Fila zerada resolve o sinal", byType(A.orgId, "atividade_lista_espera").length === 0);

  // ---- 6. Painel + education first-class no Pareto ----
  const panel = SchoolCoordinationService.panel(A.orgId);
  check("Painel traz sinais abertos do domínio education", panel.signals.length >= 3 && panel.signals.every((s: any) => s.domain === "education"));
  check("Cada sinal do painel traz ação recomendada", panel.signals.every((s: any) => s.action && s.action.label && s.action.actionType));
  const frInPanel = panel.signals.find((s: any) => s.signal_type === "falta_recorrente");
  check("Ação de falta_recorrente é específica", frInPanel?.action?.label?.includes("faltas recorrentes"));
  check("Painel traz prioridades do domínio education", Array.isArray(panel.priorities) && panel.priorities.length > 0);
  check("Prioridade education sugere dono coordenacao", panel.priorities.every((p: any) => p.suggestedOwner === "coordenacao"));
  const prio = ImpactPrioritizationService.prioritize(A.orgId);
  check("education entra também no Pareto global", (prio.global || []).some((p: any) => p.domain === "education"));

  // ---- 7. Isolamento multi-tenant ----
  StudentService.createStudent(B.orgId, { fullName: "Outro Aluno", turma: "1º ano" }, B.actorId);
  const passB = SchoolCoordinationService.runSignalsPass(B.orgId);
  check("Org B só vê a própria turma sem professor", byType(B.orgId, "turma_sem_professor").length === 1 && passB.byType["turma_sem_professor"] === 1);
  check("Passe de B não mexe nos sinais de A", byType(A.orgId, "falta_recorrente").length === 1);

  console.log("\n=== Módulo Escola — Painel da coordenação (ADR-144, Fatia 4) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
