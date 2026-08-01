/**
 * TESTE — Módulo Clínica Fatia 48: IA rascunho de guia (FECHA ADR-145)
 * (ADR-145 Fase 5 §F48 / RN-014).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - draft() preenche patientName + cpf do contact/patient_profiles.
 *   - draft(TISS) sem plano/autorização → operator/card/tuss/authorization
 *     marcados missing=true com reason específica.
 *   - draft(TISS) com patient_profiles + authorization aprovada →
 *     insuranceName/insuranceCardNumber/operatorId/tussCode preenchidos.
 *   - draft(TISS) puxa procedureId + totalSessions de guia issued anterior
 *     do MESMO episódio quando não há autorização recente.
 *   - Guardrail: draft() NUNCA preenche authorizationNumber a partir de
 *     guia anterior (só de autorização aprovada); NUNCA gera validUntil.
 *   - draft(referral) sugere referralSpecialty da guia anterior mas
 *     NUNCA copia referralReason (motivo é sempre novo).
 *   - draft(medical_order) devolve items missing (jamais fabricar lista);
 *     cidCode vem de último atestado emitido do paciente.
 *   - Validações: guideType inválido, contact inexistente, professional
 *     cross-tenant, ciclo de outro episódio.
 *   - Isolamento multi-tenant (dados de A não vazam pra B).
 *   - draft() NÃO persiste — nenhuma linha em clinical_guides após chamar.
 *
 * Uso:  npm run test:clinic-ai-guide-draft
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-ai-draft-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-ai-draft";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicCareEpisodeService } = await import("../src/server/ClinicCareEpisodeService.js");
  const { ClinicGuideService } = await import("../src/server/ClinicGuideService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const actorId = `user_${tag}`;
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkProf = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, orgId, name);
      return id;
    };
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    return { orgId, actorId, channelId, mkProf, mkContact };
  }

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);

  // ── PACIENTE SEM PLANO (todo missing esperado no TISS) ────────────────
  const patCarla = A.mkContact("Carla");

  const d1 = ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: patCarla, professionalId: drAna,
  });
  check("draft TISS sem plano: patientName vem do contact",
    d1.fields.patientName?.value === "Carla" && d1.fields.patientName?.missing === false);
  check("draft TISS sem plano: cpf missing",
    d1.fields.cpf?.missing === true);
  check("draft TISS sem plano: operatorId missing",
    d1.fields.operatorId?.missing === true);
  check("draft TISS sem plano: insuranceCardNumber missing",
    d1.fields.insuranceCardNumber?.missing === true);
  check("draft TISS sem plano: tussCode missing (guardrail — IA não inventa)",
    d1.fields.tussCode?.missing === true);
  check("draft TISS sem plano: authorizationNumber missing (guardrail — IA não gera)",
    d1.fields.authorizationNumber?.missing === true);
  check("draft TISS sem plano: validUntil missing (guardrail — não chutar validade)",
    d1.fields.validUntil?.missing === true);
  check("draft TISS sem plano: warnings mencionam dados incompletos",
    Array.isArray(d1.warnings) && d1.warnings.length >= 1);
  check("draft TISS sem plano: reason da carteirinha é específica",
    /não cadastrada/.test(d1.fields.insuranceCardNumber?.reason || ""));

  // ── PACIENTE COM PLANO + AUTORIZAÇÃO APROVADA ────────────────────────
  const patMaria = A.mkContact("Maria");
  db.prepare(
    `INSERT INTO patient_profiles (id, organization_id, contact_id, cpf, insurance_card_number, insurance_name, current_plan_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A.orgId, patMaria, "111.222.333-44", "MARIA-CARD-9", "SulAmérica", "Executivo");

  const operatorId = randomUUID();
  db.prepare(
    `INSERT INTO health_plan_operators (id, organization_id, name, active)
     VALUES (?, ?, ?, 1)`
  ).run(operatorId, A.orgId, "SulAmérica");

  db.prepare(
    `INSERT INTO procedure_authorization_requests
       (id, organization_id, contact_id, operator_id, procedure_id, tuss_code,
        status, authorization_number, approved_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'approved', 'AUTH-2026-001', CURRENT_TIMESTAMP, '2026-12-31T23:59:59Z')`
  ).run(randomUUID(), A.orgId, patMaria, operatorId, "PROC-PSICOTERAPIA", "50000470");

  const d2 = ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria, professionalId: drAna,
  });
  check("draft TISS c/ plano+auth: cpf preenchido do patient_profiles",
    d2.fields.cpf?.value === "111.222.333-44" && d2.fields.cpf?.source === "patient_profiles");
  check("draft TISS c/ plano+auth: insuranceCardNumber preenchido",
    d2.fields.insuranceCardNumber?.value === "MARIA-CARD-9" && d2.fields.insuranceCardNumber?.missing === false);
  check("draft TISS c/ plano+auth: insuranceName preenchido",
    d2.fields.insuranceName?.value === "SulAmérica");
  check("draft TISS c/ plano+auth: operatorId puxado da authorization",
    d2.fields.operatorId?.value === operatorId
    && /procedure_authorization_requests/.test(d2.fields.operatorId?.source || ""));
  check("draft TISS c/ plano+auth: tussCode puxado da authorization",
    d2.fields.tussCode?.value === "50000470");
  check("draft TISS c/ plano+auth: authorizationNumber puxado (única fonte permitida)",
    d2.fields.authorizationNumber?.value === "AUTH-2026-001");
  check("draft TISS c/ plano+auth: validUntil puxado da authorization",
    d2.fields.validUntil?.value === "2026-12-31T23:59:59Z");
  check("draft TISS c/ plano+auth: warnings vazio",
    d2.warnings.length === 0);

  // ── GUARDRAIL: TotalSessions vem de guia anterior, jamais de autorização ─
  // Cria episódio + guia issued anterior com totalSessions=10
  const ep = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const gPrev = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria,
    operatorId, procedureId: "PROC-PSICOTERAPIA", totalSessions: 8,
    professionalId: drAna, episodeId: ep.id,
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gPrev.id, A.actorId);

  const d3 = ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria, professionalId: drAna,
    episodeId: ep.id,
  });
  check("draft TISS c/ guia anterior: totalSessions=8 (puxa da guia anterior do episódio)",
    d3.fields.totalSessions?.value === 8);
  check("draft TISS c/ guia anterior: procedureId vem da authorization (mais recente que a guia)",
    d3.fields.procedureId?.value === "PROC-PSICOTERAPIA");

  // ── GUARDRAIL: authorizationNumber NUNCA vem de guia anterior ────────
  // Cria paciente sem autorização mas com guia anterior — authorizationNumber
  // deve continuar missing (jamais copiar de guia).
  const patZe = A.mkContact("Zé");
  db.prepare(
    `INSERT INTO patient_profiles (id, organization_id, contact_id, cpf, insurance_card_number, insurance_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), A.orgId, patZe, "999.888.777-66", "ZE-CARD", "Amil");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const gZePrev = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patZe,
    operatorId, procedureId: "PROC-ZE", totalSessions: 5,
    professionalId: drAna, episodeId: epZe.id,
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gZePrev.id, A.actorId);

  const d4 = ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: patZe, professionalId: drAna, episodeId: epZe.id,
  });
  check("draft TISS: authorizationNumber missing mesmo com guia anterior (guardrail)",
    d4.fields.authorizationNumber?.missing === true);
  check("draft TISS: validUntil missing mesmo com guia anterior (guardrail)",
    d4.fields.validUntil?.missing === true);
  check("draft TISS: tussCode missing quando nem authorization nem guia anterior têm TUSS",
    d4.fields.tussCode?.missing === true);

  // ── REFERRAL: puxa specialty da anterior mas NUNCA copia reason ──────
  const gRefPrev = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: drAna, episodeId: ep.id,
    fields: { referralSpecialty: "Cardiologia", referralReason: "avaliação de sopro sistólico" },
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gRefPrev.id, A.actorId);

  const d5 = ClinicGuideService.draft(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: drAna, episodeId: ep.id,
  });
  check("draft referral: referralSpecialty sugere Cardiologia (herda da anterior)",
    d5.fields.referralSpecialty?.value === "Cardiologia" && d5.fields.referralSpecialty?.missing === false);
  check("draft referral: referralReason SEMPRE missing (guardrail — motivo é novo)",
    d5.fields.referralReason?.missing === true);
  check("draft referral: reason explica por que motivo não herda",
    /não é herdado/.test(d5.fields.referralReason?.reason || ""));

  // ── MEDICAL ORDER: items sempre missing (nunca fabricar) ─────────────
  // Semeia atestado com CID pra ver a sugestão do CID
  const apptForCert = randomUUID();
  db.prepare(
    `INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status)
     VALUES (?, ?, ?, ?, ?, ?, 'completed')`
  ).run(apptForCert, A.orgId, patMaria, "Consulta", "2026-06-01T10:00:00Z", "2026-06-01T10:30:00Z");
  const encounterForCert = randomUUID();
  db.prepare(
    `INSERT INTO clinical_encounters (id, organization_id, appointment_id, contact_id, status)
     VALUES (?, ?, ?, ?, 'signed')`
  ).run(encounterForCert, A.orgId, apptForCert, patMaria);
  db.prepare(
    `INSERT INTO clinical_medical_certificates
       (id, organization_id, encounter_id, appointment_id, contact_id, cid, days, purpose, status)
     VALUES (?, ?, ?, ?, ?, 'F41.1', 3, 'rest', 'issued')`
  ).run(randomUUID(), A.orgId, encounterForCert, apptForCert, patMaria);

  const d6 = ClinicGuideService.draft(A.orgId, {
    guideType: "medical_order", contactId: patMaria, professionalId: drAna,
  });
  check("draft medical_order: items missing (guardrail — jamais fabricar lista)",
    d6.fields.items?.missing === true);
  check("draft medical_order: cidCode sugere F41.1 do último atestado",
    d6.fields.cidCode?.value === "F41.1" && d6.fields.cidCode?.missing === false);

  const d7 = ClinicGuideService.draft(A.orgId, {
    guideType: "medical_order", contactId: patCarla, professionalId: drAna,
  });
  check("draft medical_order sem histórico: cidCode missing",
    d7.fields.cidCode?.missing === true);

  // ── Validações ───────────────────────────────────────────────────────
  let e1: any = null;
  try { ClinicGuideService.draft(A.orgId, { guideType: "invalid" as any, contactId: patMaria }); }
  catch (e: any) { e1 = e; }
  check("validação: guideType inválido", /guideType inválido/.test(e1?.message || ""));

  let e2: any = null;
  try { ClinicGuideService.draft(A.orgId, { guideType: "tiss_authorization", contactId: "no_such" }); }
  catch (e: any) { e2 = e; }
  check("validação: contact inexistente", /não encontrado/.test(e2?.message || ""));

  let e3: any = null;
  try { ClinicGuideService.draft(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: "no_such_prof",
  }); } catch (e: any) { e3 = e; }
  check("validação: professional inexistente", /não encontrado/.test(e3?.message || ""));

  // Ciclo de outro episódio → falha
  const patX = A.mkContact("PatX");
  const epX = ClinicCareEpisodeService.open(A.orgId, patX, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const { ClinicTreatmentCycleService } = await import("../src/server/ClinicTreatmentCycleService.js");
  const cX = ClinicTreatmentCycleService.create(A.orgId, epX.id, {}, A.actorId);
  let e4: any = null;
  try { ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria, episodeId: ep.id, cycleId: cX.id,
  }); } catch (e: any) { e4 = e; }
  check("validação: ciclo de outro episódio → falha", /outro episódio/.test(e4?.message || ""));

  // ── Cross-tenant ─────────────────────────────────────────────────────
  const B = seedOrg("B");
  const bSpec = ClinicSpecialtyService.create(B.orgId, { name: "PsiB" }, B.actorId);
  const bProf = B.mkProf("Dr B");
  ClinicSpecialtyService.setProfessionalSpecialties(B.orgId, bProf, [{ specialtyId: bSpec.id }], B.actorId);
  const bPat = B.mkContact("BP");

  let e5: any = null;
  try { ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: bPat, // paciente de B na org A
  }); } catch (e: any) { e5 = e; }
  check("cross-tenant: paciente de B invisível pra A", /não encontrado/.test(e5?.message || ""));

  let e6: any = null;
  try { ClinicGuideService.draft(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: bProf, // prof de B
  }); } catch (e: any) { e6 = e; }
  check("cross-tenant: professional de B invisível pra A", /não encontrado/.test(e6?.message || ""));

  // ── draft() NÃO persiste — nenhuma linha nova em clinical_guides ─────
  const beforeCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM clinical_guides WHERE organization_id = ?`
  ).get(A.orgId) as any)?.c;
  ClinicGuideService.draft(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria, professionalId: drAna, episodeId: ep.id,
  });
  ClinicGuideService.draft(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: drAna,
  });
  const afterCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM clinical_guides WHERE organization_id = ?`
  ).get(A.orgId) as any)?.c;
  check("guardrail: draft() não persiste — count inalterado", afterCount === beforeCount);

  console.log("\n=== IA rascunho de guia (ADR-145 Fatia 48) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
