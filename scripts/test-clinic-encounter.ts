/**
 * TESTE — Módulo Clínica Fase G: Prontuário/SOAP (ADR-080 extensão).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - LGPD Art.11: sem consentimento `dados_sensiveis`, open()/update() falham
 *     com LGPD_CONSENT_REQUIRED (o produto bloqueia, não é policy do cliente);
 *   - `startCare()` da agenda tenta abrir encounter BEST-EFFORT (silencioso
 *     se faltar consentimento) — não trava o início do atendimento;
 *   - open() é IDEMPOTENTE: chamar duas vezes devolve o mesmo encounter
 *     (protegido por UNIQUE(org, appointment_id));
 *   - SOAP editável (Subjetivo/Objetivo/Avaliação/Plano) + `form_data` JSON
 *     extensível (Fatia 1b vai definir schemas específicos por ficha);
 *   - update() bloqueia encounter `signed` com ENCOUNTER_SIGNED (bloqueio
 *     no service, não no DB — a próxima fatia libera addendum);
 *   - finalize() é IDEMPOTENTE: chamar num já assinado devolve o mesmo,
 *     sem mudar `signed_by`/`signed_at`;
 *   - versionamento em `clinical_encounter_history` diff campo-a-campo;
 *   - histórico consolidado do paciente (mais recente primeiro);
 *   - isolamento multi-tenant (org B não enxerga nem altera encounter de A);
 *   - auditoria em `auth_audit_logs` (OPENED/UPDATED/FINALIZED).
 *
 * Uso:  npm run test:clinic-encounter
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-encounter-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-encounter-1234567890";

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
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Paciente Alvo") };
  }
  const A = seedOrg("A");

  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Consulta inicial",
    scheduledStart: "2026-08-01T09:00:00-03:00",
    professionalId: dra.id,
    durationMinutes: 30,
  }, A.actorId);

  // ── 1. LGPD: sem consentimento, open() falha ─────────────────────────────
  let threw: any = null;
  try { ClinicEncounterService.open(A.orgId, apt.id, A.actorId); } catch (e) { threw = e; }
  check("open() sem consentimento LGPD → LGPD_CONSENT_REQUIRED", threw?.code === "LGPD_CONSENT_REQUIRED", String(threw?.code));

  // startCare tenta abrir mas é best-effort — não pode travar o atendimento.
  const started = ClinicAgendaService.startCare(A.orgId, apt.id, A.actorId);
  check("startCare NÃO trava quando falta consentimento", started.status === "in_care");
  check("encounter NÃO foi aberto ainda (sem consentimento)", ClinicEncounterService.getByAppointment(A.orgId, apt.id) === null);

  // ── 2. Concede consentimento e abre ──────────────────────────────────────
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
  check("open() com consentimento devolve encounter draft", enc.status === "draft" && enc.appointmentId === apt.id);
  check("professional_name_snapshot copiado do appointment", enc.professionalId === dra.id);

  // Idempotência
  const enc2 = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
  check("open() idempotente: mesmo id na 2ª chamada", enc2.id === enc.id);

  // ── 3. Atualiza SOAP + form_data ─────────────────────────────────────────
  const updated = ClinicEncounterService.update(A.orgId, enc.id, A.actorId, {
    subjective: "Dor lombar há 2 semanas.",
    objective: "PA 12/8. Flexão dolorosa.",
    assessment: "Lombalgia mecânica.",
    plan: "Fisioterapia 2×/sem por 4 semanas.",
    formData: { escala_dor: 7, sono: "ruim" },
  });
  check("SOAP gravado (S)", updated.subjective?.startsWith("Dor lombar"));
  check("SOAP gravado (O/A/P)", updated.objective?.includes("PA 12/8") && updated.assessment === "Lombalgia mecânica." && updated.plan?.includes("Fisioterapia"));
  check("form_data JSON gravado (extensível)", updated.formData?.escala_dor === 7 && updated.formData?.sono === "ruim");

  // Segunda edição parcial — só plano
  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { plan: "Fisioterapia 3×/sem por 4 semanas." });

  // Histórico versionado
  const hist = ClinicEncounterService.history(A.orgId, enc.id);
  check("clinical_encounter_history tem 2 entradas (2 UPDATEs)", hist.length === 2, String(hist.length));
  const planoChange = hist[0].changedFields.find((c: any) => c.field === "plan");
  check("último diff é do campo 'plan'", !!planoChange && planoChange.after?.includes("3×/sem"));

  // ── 4. Bloqueio: reabrir con com update NÃO cria diff quando nada muda ───
  const noChange = ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { subjective: updated.subjective });
  const histAfterNoop = ClinicEncounterService.history(A.orgId, enc.id);
  check("update com mesmo valor NÃO adiciona linha no history", histAfterNoop.length === 2 && noChange.id === enc.id);

  // ── 5. finalize() ─────────────────────────────────────────────────────────
  const signed = ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);
  check("finalize() vira signed", signed.status === "signed");
  check("signed_by preenchido", signed.signedBy === A.actorId);
  check("signed_at preenchido", !!signed.signedAt);
  // Idempotente
  const signed2 = ClinicEncounterService.finalize(A.orgId, enc.id, "outro-user");
  check("finalize() idempotente NÃO troca signed_by", signed2.signedBy === A.actorId);

  // ── 6. update() bloqueado depois de signed ───────────────────────────────
  let threwSigned: any = null;
  try { ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { plan: "novo plano" }); } catch (e) { threwSigned = e; }
  check("update em encounter signed → ENCOUNTER_SIGNED", threwSigned?.code === "ENCOUNTER_SIGNED");

  // ── 7. Histórico do paciente ─────────────────────────────────────────────
  // Segundo encounter em outra consulta
  const apt2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Retorno",
    scheduledStart: "2026-08-08T09:00:00-03:00",
    professionalId: dra.id,
    durationMinutes: 30,
  }, A.actorId);
  ClinicEncounterService.open(A.orgId, apt2.id, A.actorId);
  const historyPatient = ClinicEncounterService.listByPatient(A.orgId, A.patient);
  check("histórico do paciente lista 2 encounters", historyPatient.length === 2);
  check("histórico ordenado desc (mais recente primeiro)", historyPatient[0].appointmentId === apt2.id);

  // ── 8. Isolamento multi-tenant ───────────────────────────────────────────
  const B = seedOrg("B");
  check("org B não vê encounter da org A pela consulta", ClinicEncounterService.getByAppointment(B.orgId, apt.id) === null);
  check("org B não vê encounter pelo id", ClinicEncounterService.get(B.orgId, enc.id) === null);
  let threwCross: any = null;
  try { ClinicEncounterService.update(B.orgId, enc.id, B.actorId, { plan: "x" }); } catch (e) { threwCross = e; }
  check("org B tentando update em encounter da org A → 404 (Prontuário não encontrado)", threwCross?.message?.includes("não encontrado"));
  check("histórico do paciente da org A está intocado (2 encounters)", ClinicEncounterService.listByPatient(A.orgId, A.patient).length === 2);

  // ── 9. Auditoria (auth_audit_logs) ──────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type LIKE 'CLINIC_ENCOUNTER_%'
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const auditMap = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("auditoria CLINIC_ENCOUNTER_OPENED ≥ 2 (dois encounters)", (auditMap.CLINIC_ENCOUNTER_OPENED || 0) >= 2, String(auditMap.CLINIC_ENCOUNTER_OPENED));
  check("auditoria CLINIC_ENCOUNTER_UPDATED ≥ 2", (auditMap.CLINIC_ENCOUNTER_UPDATED || 0) >= 2, String(auditMap.CLINIC_ENCOUNTER_UPDATED));
  check("auditoria CLINIC_ENCOUNTER_FINALIZED = 1", (auditMap.CLINIC_ENCOUNTER_FINALIZED || 0) === 1, String(auditMap.CLINIC_ENCOUNTER_FINALIZED));

  console.log("\n=== Prontuário/SOAP (ADR-080 Fase G) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
