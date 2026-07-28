/**
 * TESTE — Módulo Escola Fatia 1: resumo diário ao responsável (ADR-144)
 * --------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - aluno como entidade própria (não é contato do CRM);
 *   - CONSENTIMENTO-DE-MENOR como PORTA: sem consentimento não envia e não marca dedupe;
 *   - texto determinístico do resumo (bom dia + nome do aluno + agenda do dia);
 *   - janela da manhã (SP) respeitada; fora da janela não envia;
 *   - dedupe: envia 1×/dia por relação responsável↔aluno;
 *   - múltiplos responsáveis do mesmo aluno recebem;
 *   - sinal de falta publicado no domínio `education`;
 *   - sendNow ignora janela/dedupe mas respeita o consentimento;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:escola-digest
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escola-digest-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-escola-digest-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// Datas SP determinísticas: 08:00 e 20:00 de São Paulo (UTC-3) em 2026-08-03.
const MORNING = new Date("2026-08-03T11:00:00Z"); // 08:00 SP → dentro da janela
const NIGHT = new Date("2026-08-03T23:00:00Z");   // 20:00 SP → fora da janela

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StudentService } = await import("../src/server/StudentService.js");
  const { SchoolDigestService } = await import("../src/server/SchoolDigestService.js");
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

  // ---- 1. Aluno é entidade própria (não vira contato) ----
  const lucas = StudentService.createStudent(A.orgId, { fullName: "Lucas Andrade", turma: "3º ano B", enrollmentCode: "2026-041" }, A.actorId).student;
  check("Aluno criado como entidade própria", !!lucas.id && lucas.full_name === "Lucas Andrade" && lucas.turma === "3º ano B");
  check("Aluno NÃO é um contato do CRM", !db.prepare("SELECT id FROM contacts WHERE id = ?").get(lucas.id));

  // Responsáveis (contatos com WhatsApp)
  const juliana = A.mkContact("Juliana Andrade", "5511988887777");
  const marcos = A.mkContact("Marcos Andrade", "5511977776666");
  StudentService.linkGuardian(A.orgId, lucas.id, { guardianContactId: juliana, relationship: "mãe", isPrimary: true }, A.actorId);
  StudentService.linkGuardian(A.orgId, lucas.id, { guardianContactId: marcos, relationship: "pai" }, A.actorId);

  // Agenda do dia
  StudentService.addAgendaItem(A.orgId, lucas.id, { date: "2026-08-03", kind: "class", title: "Aula", timeLabel: "7h30" }, A.actorId);
  StudentService.addAgendaItem(A.orgId, lucas.id, { date: "2026-08-03", kind: "class", title: "Aula" }, A.actorId);
  StudentService.addAgendaItem(A.orgId, lucas.id, { date: "2026-08-03", kind: "activity", title: "Futsal", timeLabel: "16h" }, A.actorId);
  StudentService.addAgendaItem(A.orgId, lucas.id, { date: "2026-08-03", kind: "notice", title: "Autorização do passeio de História", status: "pending" }, A.actorId);
  StudentService.addAgendaItem(A.orgId, lucas.id, { date: "2026-08-03", kind: "pickup", title: "Saída prevista", timeLabel: "17h30" }, A.actorId);

  // ---- 2. Consentimento como PORTA ----
  const sent: Array<{ phone: string; text: string }> = [];
  const send = (phone: string, text: string) => { sent.push({ phone, text }); };

  const r0 = await SchoolDigestService.runDigestPass(A.orgId, { now: MORNING, send });
  check("Sem consentimento não envia (porta fechada)", r0.sent === 0 && sent.length === 0);
  const link = db.prepare("SELECT last_digest_date FROM student_guardians WHERE organization_id = ? AND student_id = ? AND guardian_contact_id = ?").get(A.orgId, lucas.id, juliana) as any;
  check("Sem consentimento NÃO marca dedupe (pode consentir depois)", link?.last_digest_date == null);

  // Consentir para os dois responsáveis
  StudentService.setConsent(A.orgId, lucas.id, juliana, true, A.actorId);
  StudentService.setConsent(A.orgId, lucas.id, marcos, true, A.actorId);

  // ---- 3. Texto determinístico ----
  const preview = SchoolDigestService.dailyDigest(A.orgId, lucas.id, "2026-08-03", { guardianName: "Juliana Andrade" });
  check("Resumo cumprimenta o responsável pelo 1º nome", preview.text.includes("Bom dia, Juliana"));
  check("Resumo cita o aluno e a turma", preview.text.includes("*Lucas*") && preview.text.includes("(3º ano B)"));
  check("Resumo agrega as aulas com 1ª aula", preview.text.includes("2 aula(s)") && preview.text.includes("7h30"));
  check("Resumo lista extracurricular", preview.text.includes("Futsal às 16h"));
  check("Resumo marca aviso pendente", preview.text.includes("Autorização do passeio de História: *pendente*"));
  check("Resumo traz a saída", preview.text.includes("Saída prevista: 17h30"));
  check("Resumo tem opt-out (SAIR)", preview.text.includes("SAIR"));

  // ---- 4. Fora da janela não envia ----
  const rNight = await SchoolDigestService.runDigestPass(A.orgId, { now: NIGHT, send });
  check("Fora da janela da manhã não envia", rNight.sent === 0 && sent.length === 0);

  // ---- 5. Janela da manhã: os DOIS responsáveis recebem ----
  const r1 = await SchoolDigestService.runDigestPass(A.orgId, { now: MORNING, send });
  check("Na janela, ambos os responsáveis recebem", r1.sent === 2 && sent.length === 2);
  check("Enviou para os telefones certos", sent.some(s => s.phone === "5511988887777") && sent.some(s => s.phone === "5511977776666"));

  // ---- 6. Dedupe: não repete no mesmo dia ----
  const r2 = await SchoolDigestService.runDigestPass(A.orgId, { now: MORNING, send });
  check("Deduplica no mesmo dia (não reenvia)", r2.sent === 0 && sent.length === 2);

  // ---- 7. Sinal de falta no domínio education ----
  const abs = StudentService.recordAbsence(A.orgId, lucas.id, "2026-08-03", "", A.actorId);
  const sigs = BusinessSignalService.list(A.orgId, { domain: "education" });
  check("Falta publica sinal no domínio education", !!abs.signalId && sigs.length === 1 && sigs[0].signal_type === "student_absence");
  check("Falta sem justificativa é 'attention'", sigs[0].severity === "attention");
  const abs2 = StudentService.recordAbsence(A.orgId, lucas.id, "2026-08-03", "atestado médico", A.actorId);
  check("Falta do mesmo dia deduplica o sinal", abs2.deduped === true && BusinessSignalService.list(A.orgId, { domain: "education" }).length === 1);

  // ---- 8. sendNow ignora janela/dedupe, respeita consentimento ----
  const before = sent.length;
  const now = await SchoolDigestService.sendNow(A.orgId, lucas.id, { now: NIGHT, send });
  check("sendNow envia mesmo à noite e após dedupe", now.sent === 2 && sent.length === before + 2);
  // Revogar de um responsável → sendNow envia só ao que consente
  StudentService.setConsent(A.orgId, lucas.id, marcos, false, A.actorId);
  const before2 = sent.length;
  const now2 = await SchoolDigestService.sendNow(A.orgId, lucas.id, { now: NIGHT, send });
  check("sendNow respeita revogação de consentimento", now2.sent === 1 && sent.length === before2 + 1);

  // ---- 9. Isolamento multi-tenant ----
  const lucasB = StudentService.createStudent(B.orgId, { fullName: "Outro Aluno", turma: "1º ano" }, B.actorId).student;
  check("Org B não vê alunos de A", StudentService.listStudents(B.orgId).length === 1 && StudentService.listStudents(B.orgId)[0].id === lucasB.id);
  check("Vincular responsável de A a aluno de B falha (contato de outra org)", (() => {
    try { StudentService.linkGuardian(B.orgId, lucasB.id, { guardianContactId: juliana }, B.actorId); return false; }
    catch (e: any) { return e.message.includes("não encontrado"); }
  })());
  const rB = await SchoolDigestService.runDigestPass(B.orgId, { now: MORNING, send });
  check("Passe de B (sem consentimento) não envia", rB.sent === 0);

  console.log("\n=== Módulo Escola — Resumo diário ao responsável (ADR-144, Fatia 1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
