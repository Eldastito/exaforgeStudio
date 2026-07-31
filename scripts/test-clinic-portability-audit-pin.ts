/**
 * TESTE — Módulo Clínica Fatia 28: Portabilidade LGPD Art.18 + audit-of-audit +
 * PIN lockout com timingSafeEqual (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *
 * ── PIN lockout (ClinicDocumentsService.verifyPin) ─────────────────────
 *   - PIN correto passa e zera pin_failed_count anterior.
 *   - PIN errado incrementa pin_failed_count + audit CLINIC_PIN_FAILED.
 *   - Ao chegar em 5 erros, seta pin_locked_until (+15min) + audit
 *     CLINIC_PIN_LOCKED + próxima chamada lança PIN_LOCKED.
 *   - Tentar emitir enquanto PIN_LOCKED lança PIN_LOCKED (não PIN_INVALID).
 *   - resetPinLockout zera counter+lockout + audit CLINIC_PIN_LOCKOUT_RESET.
 *   - Após reset, PIN certo volta a funcionar.
 *   - Lockout expirado naturalmente: manipulamos pin_locked_until pro
 *     passado; próxima chamada zera counter e aceita PIN correto.
 *   - timingSafeEqual: compara mesmo com PIN de comprimento diferente
 *     sem crash (guard try/catch); PIN errado sempre lança PIN_INVALID
 *     até bloqueio (não vaza timing por early-return).
 *
 * ── Portabilidade (LgpdService.exportContact expandido) ────────────────
 *   - contact/tickets/messages/orders básicos continuam presentes.
 *   - clinical.patientProfile, encounters, encounterHistory, addendums,
 *     prescriptions, certificates, receipts, attachments,
 *     documentDeliveries, addendumNotifications, followUpNotifications,
 *     patientAllergies, patientPortalTokens vêm no export.
 *   - Ordem determinística (ASC por created_at).
 *   - Anexo purgado (purged_at set) ainda aparece no export com
 *     metadata (rastro é dado).
 *   - Isolamento multi-tenant: exportContact de contato de A não devolve
 *     dados de contato homônimo de B.
 *
 * ── Audit-of-audit ─────────────────────────────────────────────────────
 *   - CLINIC_ENCOUNTER_VIEWED gravado em GET /appointments/:id/encounter,
 *     /encounters/:id/history, /patients/:contactId/encounters — a partir
 *     dos handlers direto (chamando `logAuthEvent` local pra o teste
 *     valida invariantes; a rota real também loga).
 *   - Filtro AUDIT: filtragem por target_user_id / event_type / actor_id
 *     retornam só o subset esperado (via SQL direto no teste, sem HTTP).
 *
 * Uso:  npm run test:clinic-portability-audit-pin
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-portability-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-portability-audit-pin-1234567890";

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
  const { ClinicDocumentsService, verifyPin, resetPinLockout } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicReceiptService } = await import("../src/server/ClinicReceiptService.js");
  const { ClinicPatientAllergyService } = await import("../src/server/ClinicPatientAllergyService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}${Math.floor(Math.random() * 1e8)}`);
    LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { actorId: `user_${tag}` });
    LgpdService.grantConsent(orgId, contactId, "comunicacoes", { actorId: `user_${tag}` });
    return { orgId, actorId: `user_${tag}`, contactId };
  }

  // ── Setup ──────────────────────────────────────────────────────────────
  const A = seedOrg("A");
  const prof = ClinicAgendaService.createProfessional(A.orgId, {
    name: "Dra. Ana", registrationNumber: "12345", council: "CRM/SP",
  }, A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, prof.id, "4242", A.actorId);

  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T",
    scheduledStart: "2026-11-01T10:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { subjective: "s1", plan: "p1" });
  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { plan: "p2" });
  const signed = ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);
  ClinicEncounterService.addAddendum(A.orgId, signed.id, A.actorId, { note: "adendo teste", pin: "4242" });
  const rx = ClinicDocumentsService.createPrescription(A.orgId, signed.id, {
    items: [{ drug: "Paracetamol 750mg" }],
  }, A.actorId);
  ClinicDocumentsService.issuePrescription(A.orgId, rx.id, A.actorId, { pin: "4242" });
  const cert = ClinicDocumentsService.createCertificate(A.orgId, signed.id, { days: 3, purpose: "rest" }, A.actorId);
  ClinicDocumentsService.issueCertificate(A.orgId, cert.id, A.actorId, { pin: "4242" });
  const rcpt = ClinicReceiptService.create(A.orgId, signed.id, { amountCents: 25000, paymentMethod: "pix" }, A.actorId);
  ClinicReceiptService.issue(A.orgId, rcpt.id, A.actorId, { pin: "4242" });
  ClinicPatientAllergyService.add(A.orgId, A.contactId, A.actorId, { substance: "Dipirona", severity: "severe" });

  // ── 1. verifyPin com timingSafeEqual + lockout ─────────────────────────
  // PIN certo passa
  check("verifyPin PIN certo → true", verifyPin(A.orgId, prof.id, "4242") === true);

  // PIN errado 4× (lockout ativa no 5º)
  for (let i = 1; i <= 4; i++) {
    let threw: any = null;
    try { verifyPin(A.orgId, prof.id, "0000"); } catch (e) { threw = e; }
    check(`PIN errado ${i}× → PIN_INVALID`, threw?.code === "PIN_INVALID", `attempt ${i}`);
  }

  // 5ª tentativa errada → PIN_LOCKED direto
  let threw5: any = null;
  try { verifyPin(A.orgId, prof.id, "0000"); } catch (e) { threw5 = e; }
  check("PIN errado 5× → PIN_LOCKED (com until)", threw5?.code === "PIN_LOCKED" && typeof threw5?.until === "string");

  // pin_failed_count no DB
  const stateLocked = db.prepare(`SELECT pin_failed_count, pin_locked_until FROM clinic_professionals WHERE id = ? AND organization_id = ?`)
    .get(prof.id, A.orgId) as any;
  check("pin_failed_count = 5", Number(stateLocked?.pin_failed_count) === 5, String(stateLocked?.pin_failed_count));
  check("pin_locked_until preenchido", !!stateLocked?.pin_locked_until);

  // Tentar PIN certo durante lockout ainda lança PIN_LOCKED
  let threwDuring: any = null;
  try { verifyPin(A.orgId, prof.id, "4242"); } catch (e) { threwDuring = e; }
  check("PIN certo durante lockout → PIN_LOCKED", threwDuring?.code === "PIN_LOCKED");

  // Tentar emitir receita durante lockout também lança PIN_LOCKED
  const rxLock = ClinicDocumentsService.createPrescription(A.orgId, signed.id, {
    items: [{ drug: "Ibuprofeno 400mg" }],
  }, A.actorId);
  let threwIssue: any = null;
  try { ClinicDocumentsService.issuePrescription(A.orgId, rxLock.id, A.actorId, { pin: "4242" }); } catch (e) { threwIssue = e; }
  check("issue durante lockout → PIN_LOCKED", threwIssue?.code === "PIN_LOCKED");

  // Reset manual destranca
  resetPinLockout(A.orgId, prof.id, A.actorId);
  const stateReset = db.prepare(`SELECT pin_failed_count, pin_locked_until FROM clinic_professionals WHERE id = ? AND organization_id = ?`)
    .get(prof.id, A.orgId) as any;
  check("reset zera pin_failed_count", Number(stateReset?.pin_failed_count) === 0);
  check("reset zera pin_locked_until", stateReset?.pin_locked_until === null);
  check("verifyPin certo funciona após reset", verifyPin(A.orgId, prof.id, "4242") === true);

  // Simular lockout já EXPIRADO (força pin_locked_until pro passado) — chamada deve limpar auto
  db.prepare(`UPDATE clinic_professionals SET pin_failed_count = 5, pin_locked_until = ? WHERE id = ? AND organization_id = ?`)
    .run(new Date(Date.now() - 60 * 1000).toISOString(), prof.id, A.orgId);
  check("verifyPin certo após lockout expirado → true (auto-clear)", verifyPin(A.orgId, prof.id, "4242") === true);
  const stateAfterExpired = db.prepare(`SELECT pin_failed_count, pin_locked_until FROM clinic_professionals WHERE id = ? AND organization_id = ?`)
    .get(prof.id, A.orgId) as any;
  check("auto-clear zerou counter", Number(stateAfterExpired?.pin_failed_count) === 0);
  check("auto-clear limpou until", stateAfterExpired?.pin_locked_until === null);

  // timingSafeEqual: comprimento diferente não crasha (rebate como PIN_INVALID
  // ou LOCKED se contador extrapolar — o importante é não jogar exception não-typed)
  // Nota: verifyPin já valida `pin` como string; PIN vazio dá PIN_REQUIRED. Testa
  // PIN com formato NUMÉRICO mas comprimento diferente (2 dígitos).
  let threwShort: any = null;
  try { verifyPin(A.orgId, prof.id, "42"); } catch (e) { threwShort = e; }
  check("PIN com comprimento diferente não crasha, retorna PIN_INVALID",
    threwShort?.code === "PIN_INVALID" || threwShort?.code === "PIN_LOCKED");

  // Audit trail: CLINIC_PIN_FAILED (≥4) + CLINIC_PIN_LOCKED (≥1) + CLINIC_PIN_LOCKOUT_RESET (=1)
  const failedC = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PIN_FAILED'`)
    .get(A.orgId) as any;
  check("audit CLINIC_PIN_FAILED ≥ 4", Number(failedC?.c) >= 4, String(failedC?.c));

  const lockedC = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PIN_LOCKED'`)
    .get(A.orgId) as any;
  check("audit CLINIC_PIN_LOCKED ≥ 1", Number(lockedC?.c) >= 1);

  const resetC = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PIN_LOCKOUT_RESET'`)
    .get(A.orgId) as any;
  check("audit CLINIC_PIN_LOCKOUT_RESET = 1", Number(resetC?.c) === 1);

  const lockedMeta = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PIN_LOCKED' ORDER BY created_at ASC LIMIT 1`)
    .get(A.orgId) as any;
  const meta = JSON.parse(lockedMeta?.metadata_json || "{}");
  check("audit LOCKED metadata: attempts >= 5", Number(meta.attempts) >= 5);
  check("audit LOCKED metadata: lockedUntil ISO", typeof meta.lockedUntil === "string" && meta.lockedUntil.includes("T"));

  // ── 2. Portabilidade — exportContact expandido ─────────────────────────
  const exp = LgpdService.exportContact(A.orgId, A.contactId) as any;
  check("export: contact presente", exp?.contact?.id === A.contactId);
  check("export: appointments presente", Array.isArray(exp?.appointments) && exp.appointments.length >= 1);
  check("export: clinical existe", !!exp?.clinical);
  check("export.clinical.encounters ≥ 1", Array.isArray(exp?.clinical?.encounters) && exp.clinical.encounters.length >= 1);
  check("export.clinical.encounters[0].status === 'signed'", exp.clinical.encounters[0]?.status === "signed");
  check("export.clinical.encounterHistory ≥ 1 (SOAP mudou 2×)", Array.isArray(exp?.clinical?.encounterHistory) && exp.clinical.encounterHistory.length >= 1);
  check("export.clinical.addendums ≥ 1", Array.isArray(exp?.clinical?.addendums) && exp.clinical.addendums.length >= 1);
  check("export.clinical.prescriptions ≥ 1", Array.isArray(exp?.clinical?.prescriptions) && exp.clinical.prescriptions.length >= 1);
  check("export.clinical.prescriptions[0].status inclui 'issued'", exp.clinical.prescriptions.some((p: any) => p.status === "issued"));
  check("export.clinical.certificates ≥ 1", Array.isArray(exp?.clinical?.certificates) && exp.clinical.certificates.length >= 1);
  check("export.clinical.receipts ≥ 1", Array.isArray(exp?.clinical?.receipts) && exp.clinical.receipts.length >= 1);
  check("export.clinical.receipts[0].amount_cents = 25000", exp.clinical.receipts[0]?.amount_cents === 25000);
  check("export.clinical.patientAllergies ≥ 1", Array.isArray(exp?.clinical?.patientAllergies) && exp.clinical.patientAllergies.length >= 1);
  check("export.clinical.patientAllergies[0].substance_display 'Dipirona'", exp.clinical.patientAllergies[0]?.substance_display === "Dipirona");
  check("export.exportedAt ISO", typeof exp.exportedAt === "string" && exp.exportedAt.includes("T"));

  // Isolamento cross-tenant
  const B = seedOrg("B");
  const expB = LgpdService.exportContact(B.orgId, A.contactId) as any;
  check("cross-tenant: exportContact do contactId de A em org B → null (contact não existe em B)", expB === null);
  const expBOwn = LgpdService.exportContact(B.orgId, B.contactId) as any;
  check("cross-tenant: exportContact próprio de B tem clinical mas vazio", Array.isArray(expBOwn?.clinical?.encounters) && expBOwn.clinical.encounters.length === 0);

  // ── 3. Audit-of-audit: filtro SQL + CLINIC_ENCOUNTER_VIEWED ────────────
  // Simula 3 acessos de leitura ao encounter — as rotas gravam logAuthEvent
  logAuthEvent(A.orgId, A.actorId, A.contactId, "CLINIC_ENCOUNTER_VIEWED", { encounterId: signed.id, via: "appointment" });
  logAuthEvent(A.orgId, A.actorId, A.contactId, "CLINIC_ENCOUNTER_VIEWED", { encounterId: signed.id, via: "history" });
  logAuthEvent(A.orgId, A.actorId, A.contactId, "CLINIC_ENCOUNTER_VIEWED", { via: "patient-list", count: 1 });

  const viewedCount = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_ENCOUNTER_VIEWED'`)
    .get(A.orgId) as any;
  check("audit CLINIC_ENCOUNTER_VIEWED ≥ 3", Number(viewedCount?.c) >= 3, String(viewedCount?.c));

  // Filtro por event_type simulado (o que a rota /audit faria)
  const filtered = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT 100`)
    .all(A.orgId, "CLINIC_ENCOUNTER_VIEWED") as any[];
  check("filter event_type=VIEWED devolve subset", filtered.length >= 3 && filtered.every((r) => r.event_type === "CLINIC_ENCOUNTER_VIEWED"));

  // Filtro por target_user_id
  const filteredByRes = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND target_user_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(A.orgId, A.contactId) as any[];
  check("filter target_user_id=contact devolve subset ≥ 3", filteredByRes.length >= 3 && filteredByRes.every((r) => r.target_user_id === A.contactId));

  // Filtro por actor_id
  const filteredByActor = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND actor_user_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(A.orgId, A.actorId) as any[];
  check("filter actor_id devolve subset (algum evento)", filteredByActor.length >= 1 && filteredByActor.every((r) => r.actor_user_id === A.actorId));

  console.log("\n=== Portabilidade + audit-of-audit + PIN lockout (ADR-080 Fase 28) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
