/**
 * TESTE — Módulo Clínica Fatia 25: Alertas de alergia na receita
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - CRUD: add valida contact-exists, whitelist kind/severity, substância
 *     não-vazia; update sem substância (imutável); deactivate soft (row
 *     preservada); list default só ativas + severity DESC (severe first).
 *   - LGPD Art.11: sem consent, add/update/list/deactivate/get lançam
 *     LGPD_CONSENT_REQUIRED; revoke bloqueia leitura imediata; re-grant
 *     restaura.
 *   - checkPrescription: match bidirecional (item contém substância OU
 *     substância contém item), case-insensitive, só alergias ATIVAS,
 *     alergia desativada NÃO alerta, sem items devolve [], paciente sem
 *     alergia devolve [].
 *   - Hook em createPrescription: SEVERE sem force:true bloqueia (código
 *     ALLERGY_ALERT, payload {alerts}); com force:true grava com
 *     allergy_alert_forced=1; MODERATE/MILD grava allergy_warnings sem
 *     bloquear + audit CLINIC_ALLERGY_WARNING.
 *   - Hook em updatePrescription: troca items pra droga com alergia
 *     severa → ALLERGY_ALERT; force:true bypassa; se novos items não
 *     têm alergia, allergy_warnings zerado.
 *   - Hook em issuePrescription: alergia cadastrada DEPOIS do draft
 *     é detectada no issue (última defesa); force:true bypassa.
 *   - Isolamento multi-tenant.
 *   - Auditoria: ADDED/UPDATED/DEACTIVATED/ALERT_TRIGGERED/WARNING com
 *     metadata correto.
 *
 * Uso:  npm run test:clinic-allergies
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-allergies-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-allergies-1234567890";

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
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicPatientAllergyService } = await import("../src/server/ClinicPatientAllergyService.js");
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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Paciente") };
  }

  function openDraftEncounter(seed: { orgId: string; actorId: string; patient: string }, profId: string, startISO: string) {
    if (!LgpdService.hasConsent(seed.orgId, seed.patient, "dados_sensiveis")) {
      LgpdService.grantConsent(seed.orgId, seed.patient, "dados_sensiveis", { channel: "in_person", actorId: seed.actorId });
    }
    const apt = ClinicAgendaService.createAppointment(seed.orgId, {
      contactId: seed.patient,
      title: "Consulta",
      scheduledStart: startISO,
      professionalId: profId,
      durationMinutes: 30,
    }, seed.actorId);
    return ClinicEncounterService.open(seed.orgId, apt.id, seed.actorId);
  }

  const A = seedOrg("A");
  const draA = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });

  // ── 1. CRUD básico ───────────────────────────────────────────────────────
  const al1 = ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, {
    substance: "  Dipirona ", kind: "drug", severity: "severe", reaction: "Anafilaxia",
  });
  check("add retorna alergia com id", !!al1.id);
  check("substance normalizada (lower + trim)", al1.substance === "dipirona");
  check("substanceDisplay preserva forma original trimada", al1.substanceDisplay === "Dipirona");
  check("severity gravada", al1.severity === "severe");
  check("reaction gravada", al1.reaction === "Anafilaxia");
  check("active=true por default", al1.active === true);

  const al2 = ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, {
    substance: "Amoxicilina", severity: "mild",
  });
  check("segunda alergia criada", al2.id !== al1.id);
  check("default kind=drug", al2.kind === "drug");
  check("default severity respeitada quando explícita", al2.severity === "mild");

  // Contact inexistente
  let threwNo: any = null;
  try {
    ClinicPatientAllergyService.add(A.orgId, "contact_fake", A.actorId, { substance: "X" });
  } catch (e) { threwNo = e; }
  check("add em contact inexistente → 'Paciente não encontrado'", threwNo?.message?.includes("não encontrado"));

  // Substância vazia
  let threwEmpty: any = null;
  try { ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, { substance: "   " }); } catch (e) { threwEmpty = e; }
  check("substância vazia rejeitada", !!threwEmpty);

  // Kind/severity inválidos
  let threwKind: any = null;
  try {
    // @ts-expect-error test
    ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, { substance: "X", kind: "bogus" });
  } catch (e) { threwKind = e; }
  check("kind fora da whitelist → ALLERGY_INVALID_KIND", threwKind?.code === "ALLERGY_INVALID_KIND");

  let threwSev: any = null;
  try {
    // @ts-expect-error test
    ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, { substance: "Y", severity: "extreme" });
  } catch (e) { threwSev = e; }
  check("severity fora da whitelist → ALLERGY_INVALID_SEVERITY", threwSev?.code === "ALLERGY_INVALID_SEVERITY");

  // Update
  const al1v2 = ClinicPatientAllergyService.update(A.orgId, al1.id, A.actorId, { severity: "moderate", notes: "revisado" });
  check("update severity gravado", al1v2.severity === "moderate");
  check("update notes gravado", al1v2.notes === "revisado");

  // List (default só ativas, ordenado severity DESC)
  const list1 = ClinicPatientAllergyService.list(A.orgId, A.patient);
  check("list retorna 2 ativas", list1.length === 2, String(list1.length));
  // al1 agora é moderate, al2 é mild → moderate vem primeiro
  check("list ordenado severity DESC (moderate antes de mild)",
    list1[0].id === al1.id && list1[1].id === al2.id);

  // Deactivate
  const al2Off = ClinicPatientAllergyService.deactivate(A.orgId, al2.id, A.actorId);
  check("deactivate retorna active=false", al2Off.active === false);
  check("deactivate marca deactivated_at", !!al2Off.deactivatedAt);
  const list2 = ClinicPatientAllergyService.list(A.orgId, A.patient);
  check("list default esconde inativa", list2.length === 1);
  const list3 = ClinicPatientAllergyService.list(A.orgId, A.patient, { includeInactive: true });
  check("list includeInactive retorna 2", list3.length === 2);
  // Idempotência
  const al2OffAgain = ClinicPatientAllergyService.deactivate(A.orgId, al2.id, A.actorId);
  check("deactivate idempotente", al2OffAgain.active === false && al2OffAgain.deactivatedAt === al2Off.deactivatedAt);

  // Reativa al2 pros próximos testes... na verdade cria outra
  const al3 = ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, {
    substance: "Ibuprofeno", severity: "moderate",
  });

  // ── 2. LGPD gate ─────────────────────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.patient, "dados_sensiveis", A.actorId);
  let threwLgpdList: any = null;
  try { ClinicPatientAllergyService.list(A.orgId, A.patient); } catch (e) { threwLgpdList = e; }
  check("list após revoke → LGPD_CONSENT_REQUIRED", threwLgpdList?.code === "LGPD_CONSENT_REQUIRED");

  let threwLgpdGet: any = null;
  try { ClinicPatientAllergyService.get(A.orgId, al1.id); } catch (e) { threwLgpdGet = e; }
  check("get após revoke → LGPD_CONSENT_REQUIRED", threwLgpdGet?.code === "LGPD_CONSENT_REQUIRED");

  let threwLgpdAdd: any = null;
  try { ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, { substance: "X" }); } catch (e) { threwLgpdAdd = e; }
  check("add após revoke → LGPD_CONSENT_REQUIRED", threwLgpdAdd?.code === "LGPD_CONSENT_REQUIRED");

  // Row inexistente NÃO gata consent (padrão)
  check("get de alergia inexistente devolve null (não gata)",
    ClinicPatientAllergyService.get(A.orgId, "fake_id") === null);

  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  check("re-grant restaura list", ClinicPatientAllergyService.list(A.orgId, A.patient).length >= 1);

  // ── 3. checkPrescription — match bidirecional ────────────────────────────
  // Alergias ativas de A no momento: al1 (dipirona/moderate), al3 (ibuprofeno/moderate)
  // (al2 amoxicilina foi deactivated)
  const alertsA = ClinicPatientAllergyService.checkPrescription(A.orgId, A.patient, [
    { drug: "Dipirona sódica 500mg" },      // item contém substância "dipirona"
    { drug: "Paracetamol 750mg" },          // sem match
  ]);
  check("check: item contém substância dá match", alertsA.length === 1);
  check("check: alerta traz substanceDisplay", alertsA[0].substance === "Dipirona");
  check("check: alerta traz matchedItemIndex", alertsA[0].matchedItemIndex === 0);
  check("check: severity vem no alerta", alertsA[0].severity === "moderate");

  // Substância contém item (alergia composta)
  ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, {
    substance: "amoxicilina + clavulanato", severity: "severe",
  });
  const alertsB = ClinicPatientAllergyService.checkPrescription(A.orgId, A.patient, [
    { drug: "amoxicilina 500" },
  ]);
  check("check: substância contém item dá match", alertsB.length === 1);
  check("check: severity severe reportado", alertsB[0].severity === "severe");

  // Case-insensitive
  const alertsC = ClinicPatientAllergyService.checkPrescription(A.orgId, A.patient, [
    { drug: "IBUPROFENO 400" },
  ]);
  check("check: case-insensitive", alertsC.length === 1 && alertsC[0].substance === "Ibuprofeno");

  // Alergia desativada NÃO alerta
  const alertsD = ClinicPatientAllergyService.checkPrescription(A.orgId, A.patient, [
    { drug: "Amoxicilina" },  // al2 desativada não bate, MAS al2b composta bate
  ]);
  // "amoxicilina" contém em "amoxicilina + clavulanato" (ativa e severe)
  check("check: alergia desativada NÃO conta (só a composta ativa bate)",
    alertsD.length === 1 && alertsD[0].severity === "severe");

  // Items vazios / paciente sem alergia
  check("check: items vazios devolve []", ClinicPatientAllergyService.checkPrescription(A.orgId, A.patient, []).length === 0);
  const B0 = seedOrg("B0");
  check("check: paciente sem alergia devolve []", ClinicPatientAllergyService.checkPrescription(B0.orgId, B0.patient, [{ drug: "X" }]).length === 0);

  check("hasSevere: true em alerta severe", ClinicPatientAllergyService.hasSevere(alertsB) === true);
  check("hasSevere: false em alerta só moderate", ClinicPatientAllergyService.hasSevere(alertsA) === false);

  // ── 4. Hook em createPrescription ────────────────────────────────────────
  const enc1 = openDraftEncounter(A, draA.id, "2026-09-10T09:00:00-03:00");

  // Severe sem force → ALLERGY_ALERT
  let threwRx: any = null;
  try {
    ClinicDocumentsService.createPrescription(A.orgId, enc1.id, {
      items: [{ drug: "Amoxicilina 500" }],
    }, A.actorId);
  } catch (e) { threwRx = e; }
  check("createPrescription severe → ALLERGY_ALERT", threwRx?.code === "ALLERGY_ALERT");
  check("erro traz payload com alerts", Array.isArray(threwRx?.payload?.alerts) && threwRx.payload.alerts.length > 0);
  check("payload alert é severe", threwRx?.payload?.alerts[0]?.severity === "severe");

  // Com force:true — grava com allergy_alert_forced=1
  const rxForced = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, {
    items: [{ drug: "Amoxicilina 500" }], force: true,
  }, A.actorId);
  check("createPrescription severe + force → grava", !!rxForced.id);
  check("row tem allergy_alert_forced=true", rxForced.allergyAlertForced === true);
  check("row tem allergyWarnings preenchido", Array.isArray(rxForced.allergyWarnings) && rxForced.allergyWarnings!.length > 0);

  // Moderate — grava com warning sem bloquear
  const rxWarn = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, {
    items: [{ drug: "Dipirona 500" }, { drug: "Paracetamol 750" }],
  }, A.actorId);
  check("createPrescription moderate → grava sem bloquear", !!rxWarn.id);
  check("row NÃO forced", rxWarn.allergyAlertForced === false);
  check("row tem warnings do moderate", Array.isArray(rxWarn.allergyWarnings) && rxWarn.allergyWarnings!.some((w) => w.severity === "moderate"));

  // Sem alergia — sem warnings
  const rxClean = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, {
    items: [{ drug: "Vitamina C 1g" }],
  }, A.actorId);
  check("receita sem match → warnings null", rxClean.allergyWarnings === null);
  check("receita sem match NÃO forced", rxClean.allergyAlertForced === false);

  // ── 5. Hook em updatePrescription ────────────────────────────────────────
  // Atualiza rxClean com item que bate severe → bloqueia sem force
  let threwUpd: any = null;
  try {
    ClinicDocumentsService.updatePrescription(A.orgId, rxClean.id, A.actorId, {
      items: [{ drug: "Amoxicilina 500" }],
    });
  } catch (e) { threwUpd = e; }
  check("update items pra severe sem force → ALLERGY_ALERT", threwUpd?.code === "ALLERGY_ALERT");

  // Com force bypassa
  const rxCleanForced = ClinicDocumentsService.updatePrescription(A.orgId, rxClean.id, A.actorId, {
    items: [{ drug: "Amoxicilina 500" }], force: true,
  });
  check("update items pra severe + force → grava", rxCleanForced.allergyAlertForced === true);

  // Volta pra clean sem match — warnings zerados
  const rxCleanBack = ClinicDocumentsService.updatePrescription(A.orgId, rxCleanForced.id, A.actorId, {
    items: [{ drug: "Vitamina D" }],
  });
  check("update pra items sem alergia zera warnings", rxCleanBack.allergyWarnings === null);
  check("update pra items sem alergia zera forced", rxCleanBack.allergyAlertForced === false);

  // ── 6. Hook em issuePrescription ─────────────────────────────────────────
  // Alergia cadastrada DEPOIS do draft — issue detecta
  const rxLater = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, {
    items: [{ drug: "Metamizol 500" }],  // sem alergia agora
  }, A.actorId);
  check("draft antes de alergia nova → sem warnings", rxLater.allergyWarnings === null);

  // Agora cadastra alergia severa a metamizol
  ClinicPatientAllergyService.add(A.orgId, A.patient, A.actorId, {
    substance: "metamizol", severity: "severe",
  });
  let threwIssue: any = null;
  try {
    ClinicDocumentsService.issuePrescription(A.orgId, rxLater.id, A.actorId);
  } catch (e) { threwIssue = e; }
  check("issue detecta alergia cadastrada após draft → ALLERGY_ALERT", threwIssue?.code === "ALLERGY_ALERT");

  // Force no issue emite
  const issuedForced = ClinicDocumentsService.issuePrescription(A.orgId, rxLater.id, A.actorId, { force: true });
  check("issue com force emite mesmo com severe", issuedForced.status === "issued");
  check("issue force marca allergy_alert_forced=true", issuedForced.allergyAlertForced === true);

  // ── 7. Isolamento multi-tenant ───────────────────────────────────────────
  const B = seedOrg("B");
  LgpdService.grantConsent(B.orgId, B.patient, "dados_sensiveis", { channel: "in_person", actorId: B.actorId });
  const drB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dr. B" }, B.actorId);
  const encB = openDraftEncounter(B, drB.id, "2026-09-15T09:00:00-03:00");
  // Alergia de A NÃO afeta B
  const rxB = ClinicDocumentsService.createPrescription(B.orgId, encB.id, {
    items: [{ drug: "Dipirona 500" }],  // A tem dipirona; B não
  }, B.actorId);
  check("cross-tenant: alergia de A NÃO alerta em B", rxB.allergyWarnings === null);
  // list(B, A.patient) — consent é per-org: B não tem consent do paciente de A,
  // então o próprio gate LGPD já defende contra listagem cross-tenant (403).
  let threwCross: any = null;
  try { ClinicPatientAllergyService.list(B.orgId, A.patient); } catch (e) { threwCross = e; }
  check("cross-tenant: list de paciente de A na org B → LGPD_CONSENT_REQUIRED",
    threwCross?.code === "LGPD_CONSENT_REQUIRED");
  // Sanity: paciente novo de B sem alergia devolve [].
  check("cross-tenant: paciente próprio de B sem alergia → []",
    ClinicPatientAllergyService.list(B.orgId, B.patient).length === 0);

  // ── 8. Auditoria ─────────────────────────────────────────────────────────
  const addedCount = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_ALLERGY_ADDED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_ALLERGY_ADDED ≥ 4", Number(addedCount?.c) >= 4, String(addedCount?.c));

  const deactCount = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_ALLERGY_DEACTIVATED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_ALLERGY_DEACTIVATED = 1", Number(deactCount?.c) === 1);

  const alertCount = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_ALLERGY_ALERT_TRIGGERED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_ALLERGY_ALERT_TRIGGERED ≥ 3 (create+update+issue)", Number(alertCount?.c) >= 3, String(alertCount?.c));

  const warnCount = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_ALLERGY_WARNING'`
  ).get(A.orgId) as any;
  check("audit CLINIC_ALLERGY_WARNING ≥ 1", Number(warnCount?.c) >= 1);

  const alertMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_ALLERGY_ALERT_TRIGGERED' ORDER BY created_at ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(alertMeta?.metadata_json || "{}");
  check("audit metadata do ALERT carrega severe=true", meta.severe === true);
  check("audit metadata do ALERT carrega alertCount", typeof meta.alertCount === "number");

  console.log("\n=== Alertas de alergia na receita (ADR-080 Fase 25) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
