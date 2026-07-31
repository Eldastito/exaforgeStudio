/**
 * TESTE — Módulo Clínica Fatia 29: Snapshot immutability + hash reforço
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *
 * ── canonicalize() ────────────────────────────────────────────────────
 *   - primitivos: value === canonicalize(value)
 *   - objetos: keys sorted alfabeticamente
 *   - objetos aninhados: sort recursivo (nível 1 + níveis internos)
 *   - arrays: ordem PRESERVADA (ordem semântica de items da receita)
 *   - array de objetos: cada elemento canonicalizado internamente
 *   - misto: shape completo recanoniza sem perder valores
 *
 * ── computeDocumentHash() ─────────────────────────────────────────────
 *   - determinístico: mesma entrada = mesmo hash
 *   - order-insensitive em nested: mudar ORDEM de keys em objeto aninhado
 *     NÃO afeta hash (o bug antigo da Fase 16 quebrava aqui)
 *   - order-sensitive em arrays: trocar ordem de items MUDA hash (correto)
 *   - inclusão de patientName/businessName: 2 payloads iguais exceto pelo
 *     patientName geram hashes diferentes (auditor detecta troca)
 *
 * ── Snapshot no doc emitido ──────────────────────────────────────────
 *   - issuePrescription grava patient_name_snapshot + business_name_snapshot
 *   - issueCertificate idem
 *   - Renomear contato APÓS issue: hash do doc não muda; snapshots
 *     preservados; PDF re-renderizado usa snapshot (não live lookup)
 *   - Renomear organization_settings.business_name APÓS issue: mesma coisa
 *   - Rascunho continua usando lookup live (dados podem mudar até emitir)
 *
 * ── Snapshot de plano no appointment ─────────────────────────────────
 *   - startCare grava patient_plan_snapshot_json com {plan, insurance,
 *     planNumber, planValidUntil, snapshotAt}
 *   - agendaForDay prefere snapshot vs plano atual (mudar plano
 *     APÓS startCare não afeta a exibição do appt em curso)
 *   - Appt SEM startCare: agendaForDay cai no plano ATUAL (fallback)
 *   - Paciente sem patient_profiles: snapshot fica NULL, hydrate cai em
 *     null (não crasha)
 *
 * ── Isolamento cross-tenant ──────────────────────────────────────────
 *   - snapshot de org A não vaza pra visão da org B
 *
 * Uso:  npm run test:clinic-immutability
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-immutability-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-immutability-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService, computeDocumentHash, canonicalize } = await import("../src/server/ClinicDocumentsService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string, businessName = `Clínica ${tag}`) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, businessName);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}${Math.floor(Math.random() * 1e8)}`);
    LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { actorId: `user_${tag}` });
    return { orgId, actorId: `user_${tag}`, contactId };
  }

  // ── 1. canonicalize() ──────────────────────────────────────────────────
  check("canonicalize null", canonicalize(null) === null);
  check("canonicalize string", canonicalize("abc") === "abc");
  check("canonicalize number", canonicalize(42) === 42);
  check("canonicalize boolean", canonicalize(false) === false);

  const obj1 = canonicalize({ b: 1, a: 2 });
  check("canonicalize object: keys sorted", JSON.stringify(obj1) === '{"a":2,"b":1}');

  const nested = canonicalize({ z: { b: 1, a: 2 }, a: 1 });
  check("canonicalize nested: outer sorted",
    JSON.stringify(nested).indexOf('"a":1') < JSON.stringify(nested).indexOf('"z"'));
  check("canonicalize nested: inner sorted",
    JSON.stringify(nested).includes('"z":{"a":2,"b":1}'));

  const arr = canonicalize([{ b: 1, a: 2 }, { c: 3 }]);
  check("canonicalize array: ordem preservada", JSON.stringify(arr) === '[{"a":2,"b":1},{"c":3}]');

  // ── 2. computeDocumentHash: determinismo e order-insensitivity ────────
  const h1 = computeDocumentHash({ a: 1, b: { x: 1, y: 2 } });
  const h2 = computeDocumentHash({ b: { y: 2, x: 1 }, a: 1 });
  check("hash determinístico com nested reorder", h1 === h2);
  check("hash é 64 hex", /^[a-f0-9]{64}$/.test(h1));

  const h3 = computeDocumentHash({ a: 1, b: { x: 1, y: 3 } });
  check("hash muda com valor diferente", h1 !== h3);

  const arr1 = computeDocumentHash({ items: [{ drug: "A" }, { drug: "B" }] });
  const arr2 = computeDocumentHash({ items: [{ drug: "B" }, { drug: "A" }] });
  check("hash muda com ordem de array trocada (order-sensitive em arrays)", arr1 !== arr2);

  const withPatient = computeDocumentHash({ id: "x", patientName: "João" });
  const withOtherPatient = computeDocumentHash({ id: "x", patientName: "Maria" });
  check("hash muda com patientName diferente (detecta troca de titular)", withPatient !== withOtherPatient);

  // ── 3. Snapshots em prescription/certificate ─────────────────────────
  const A = seedOrg("A", "Clínica ORIGINAL");
  const prof = ClinicAgendaService.createProfessional(A.orgId, {
    name: "Dra. Ana", registrationNumber: "12345", council: "CRM/SP",
  }, A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, prof.id, "4242", A.actorId);

  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T",
    scheduledStart: "2026-12-01T10:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { subjective: "s", plan: "p" });
  const signed = ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);

  const rx = ClinicDocumentsService.createPrescription(A.orgId, signed.id, {
    items: [{ drug: "Paracetamol 750mg" }],
  }, A.actorId);
  const rxIssued = ClinicDocumentsService.issuePrescription(A.orgId, rx.id, A.actorId, { pin: "4242" });
  check("prescription issued: patientNameSnapshot preenchido", rxIssued.patientNameSnapshot === "Paciente A");
  check("prescription issued: businessNameSnapshot preenchido", rxIssued.businessNameSnapshot === "Clínica ORIGINAL");
  check("prescription issued: hash 64 hex", /^[a-f0-9]{64}$/.test(String(rxIssued.signatureHash)));

  const cert = ClinicDocumentsService.createCertificate(A.orgId, signed.id, { days: 3, purpose: "rest" }, A.actorId);
  const certIssued = ClinicDocumentsService.issueCertificate(A.orgId, cert.id, A.actorId, { pin: "4242" });
  check("certificate issued: patientNameSnapshot preenchido", certIssued.patientNameSnapshot === "Paciente A");
  check("certificate issued: businessNameSnapshot preenchido", certIssued.businessNameSnapshot === "Clínica ORIGINAL");

  const hashBefore = rxIssued.signatureHash;
  const bizHashBefore = certIssued.signatureHash;

  // ── 4. Renomear contato + negócio APÓS issue → snapshot preservado ────
  db.prepare(`UPDATE contacts SET name = ? WHERE id = ? AND organization_id = ?`)
    .run("Paciente RENOMEADO", A.contactId, A.orgId);
  db.prepare(`UPDATE organization_settings SET business_name = ? WHERE organization_id = ?`)
    .run("Clínica RENOMEADA", A.orgId);

  const rxAfter = ClinicDocumentsService.getPrescription(A.orgId, rx.id);
  check("prescription após rename: patientNameSnapshot INALTERADO", rxAfter?.patientNameSnapshot === "Paciente A");
  check("prescription após rename: businessNameSnapshot INALTERADO", rxAfter?.businessNameSnapshot === "Clínica ORIGINAL");
  check("prescription após rename: signatureHash INALTERADO", rxAfter?.signatureHash === hashBefore);

  const certAfter = ClinicDocumentsService.getCertificate(A.orgId, cert.id);
  check("certificate após rename: snapshots preservados",
    certAfter?.patientNameSnapshot === "Paciente A" && certAfter?.businessNameSnapshot === "Clínica ORIGINAL");
  check("certificate após rename: hash preservado", certAfter?.signatureHash === bizHashBefore);

  // PDF re-renderiza usando snapshot (não live lookup)
  const pdfAfter = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rx.id);
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdfAfter) });
  const parsed = await parser.getText();
  const pdfText = String(parsed?.text || "");
  check("PDF re-renderizado usa snapshot do paciente (não live lookup)", pdfText.includes("Paciente A"));
  check("PDF re-renderizado NÃO tem nome renomeado", !pdfText.includes("RENOMEADO"));
  check("PDF re-renderizado usa business snapshot", pdfText.includes("Clínica ORIGINAL"));

  // Rascunho continua usando lookup live
  const rxDraft = ClinicDocumentsService.createPrescription(A.orgId, signed.id, {
    items: [{ drug: "Dipirona 500mg" }],
  }, A.actorId);
  const pdfDraft = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rxDraft.id);
  const parserDraft = new PDFParse({ data: new Uint8Array(pdfDraft) });
  const parsedDraft = await parserDraft.getText();
  const pdfDraftText = String(parsedDraft?.text || "");
  check("PDF rascunho usa lookup live (nome renomeado atual)", pdfDraftText.includes("Paciente RENOMEADO"));

  // Volta o nome pro original pros testes seguintes
  db.prepare(`UPDATE contacts SET name = ? WHERE id = ? AND organization_id = ?`)
    .run("Paciente A", A.contactId, A.orgId);
  db.prepare(`UPDATE organization_settings SET business_name = ? WHERE organization_id = ?`)
    .run("Clínica ORIGINAL", A.orgId);

  // ── 5. Snapshot de plano no startCare ─────────────────────────────────
  // Cria patient_profile com plano
  db.prepare(
    `INSERT INTO patient_profiles (id, organization_id, contact_id, insurance_name, current_plan_name, insurance_card_number, insurance_valid_until)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A.orgId, A.contactId, "Amil", "Amil 400", "12345678", "2027-12-31");

  const apt2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T2",
    scheduledStart: "2026-12-02T10:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);

  // ANTES do startCare — agendaForDay cai no plano atual (fallback)
  const dayBefore = ClinicAgendaService.agendaForDay(A.orgId, "2026-12-02");
  const apptBeforeStart = (dayBefore.appointments as any[]).find((x) => x.id === apt2.id);
  check("antes de startCare: agendaForDay usa plano ATUAL (fallback)", apptBeforeStart?.insurance_name === "Amil");
  check("antes de startCare: patient_plan_snapshot é null", apptBeforeStart?.patient_plan_snapshot == null);

  // startCare congela o snapshot
  await ClinicAgendaService.startCare(A.orgId, apt2.id, A.actorId);
  const rawApt2After = db.prepare(`SELECT patient_plan_snapshot_json FROM appointments WHERE id = ?`).get(apt2.id) as any;
  check("startCare gravou patient_plan_snapshot_json", !!rawApt2After?.patient_plan_snapshot_json);
  const snap = JSON.parse(rawApt2After.patient_plan_snapshot_json);
  check("snapshot.plan = 'Amil 400'", snap.plan === "Amil 400");
  check("snapshot.insurance = 'Amil'", snap.insurance === "Amil");
  check("snapshot.planNumber = '12345678'", snap.planNumber === "12345678");
  check("snapshot.snapshotAt ISO", typeof snap.snapshotAt === "string" && snap.snapshotAt.includes("T"));

  // Mudar plano APÓS startCare
  db.prepare(`UPDATE patient_profiles SET insurance_name = ?, current_plan_name = ? WHERE organization_id = ? AND contact_id = ?`)
    .run("Bradesco", "Bradesco PLUS", A.orgId, A.contactId);
  const dayAfter = ClinicAgendaService.agendaForDay(A.orgId, "2026-12-02");
  const apptAfterStart = (dayAfter.appointments as any[]).find((x) => x.id === apt2.id);
  check("após mudar plano: agendaForDay prefere SNAPSHOT (Amil 400)",
    apptAfterStart?.current_plan_name === "Amil 400" && apptAfterStart?.insurance_name === "Amil");
  check("após mudar plano: snapshot exposto em patient_plan_snapshot", apptAfterStart?.patient_plan_snapshot?.plan === "Amil 400");

  // Novo appt (SEM startCare ainda) — agendaForDay cai no plano ATUAL (Bradesco)
  const apt3 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T3",
    scheduledStart: "2026-12-03T10:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const day3 = ClinicAgendaService.agendaForDay(A.orgId, "2026-12-03");
  const appt3 = (day3.appointments as any[]).find((x) => x.id === apt3.id);
  check("novo appt sem startCare: fallback pro plano ATUAL (Bradesco PLUS)",
    appt3?.current_plan_name === "Bradesco PLUS");

  // startCare idempotente do lado do snapshot: COALESCE não sobrescreve.
  // Mudamos plano DE NOVO e forçamos re-startCare (o service já bloqueia com
  // "atendimento já iniciado" — quebra idempotência de startCare, mas o
  // snapshot já congelou; verificamos via SQL que fica igual mesmo se
  // hipoteticamente rodasse duas vezes).
  db.prepare(`UPDATE patient_profiles SET current_plan_name = ? WHERE organization_id = ? AND contact_id = ?`)
    .run("Bradesco GOLD", A.orgId, A.contactId);
  // Simulação: mesmo UPDATE do service, mas manual
  db.prepare(`UPDATE appointments SET patient_plan_snapshot_json = COALESCE(patient_plan_snapshot_json, ?) WHERE id = ? AND organization_id = ?`)
    .run(JSON.stringify({ plan: "Bradesco GOLD" }), apt2.id, A.orgId);
  const rawApt2Idem = db.prepare(`SELECT patient_plan_snapshot_json FROM appointments WHERE id = ?`).get(apt2.id) as any;
  const snap2 = JSON.parse(rawApt2Idem.patient_plan_snapshot_json);
  check("snapshot é idempotente (COALESCE preserva primeira captura)", snap2.plan === "Amil 400");

  // Paciente sem patient_profiles — snapshot fica null, agenda cai no fallback (que também vem null)
  const B = seedOrg("B");
  const profB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dr. B" }, B.actorId);
  const aptB = ClinicAgendaService.createAppointment(B.orgId, {
    contactId: B.contactId, title: "TB",
    scheduledStart: "2026-12-04T10:00:00-03:00",
    professionalId: profB.id, durationMinutes: 30, force: true,
  }, B.actorId);
  await ClinicAgendaService.startCare(B.orgId, aptB.id, B.actorId);
  const rawB = db.prepare(`SELECT patient_plan_snapshot_json FROM appointments WHERE id = ?`).get(aptB.id) as any;
  check("startCare sem patient_profiles: snapshot fica null (não crasha)", rawB?.patient_plan_snapshot_json === null);
  const dayB = ClinicAgendaService.agendaForDay(B.orgId, "2026-12-04");
  const apptBOut = (dayB.appointments as any[]).find((x) => x.id === aptB.id);
  check("agendaForDay: sem snapshot e sem patient_profiles → insurance null",
    apptBOut?.insurance_name == null);

  // ── 6. Isolamento cross-tenant ──────────────────────────────────────
  const dayA = ClinicAgendaService.agendaForDay(A.orgId, "2026-12-02");
  const aInB = (dayA.appointments as any[]).find((x) => x.id === apt2.id);
  check("cross-tenant: appt de A visível na agenda de A", !!aInB);
  const dayAsB = ClinicAgendaService.agendaForDay(B.orgId, "2026-12-02");
  const aFromB = (dayAsB.appointments as any[]).find((x) => x.id === apt2.id);
  check("cross-tenant: appt de A NÃO aparece na agenda de B", !aFromB);

  console.log("\n=== Snapshot immutability + hash reforço (ADR-080 Fase 29) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
