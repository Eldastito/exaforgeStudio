/**
 * TESTE — Módulo Clínica Fatia 24: Notificação de addendum ao paciente
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Chamada direta notifyForAddendum envia WhatsApp e grava row 'sent'
 *     com provider_message_id, tokenId (portal curto 7d) e canal correto.
 *   - Mensagem tem nome do paciente, nome do negócio e link do portal.
 *   - Dedup: 2ª chamada mesma addendum sem force devolve a existente,
 *     sender NÃO é chamado 2×.
 *   - force:true bypassa dedup — nova row com nova tentativa.
 *   - LGPD sensível revogado → row 'skipped' com error LGPD_CONSENT_REQUIRED,
 *     sender NÃO é chamado.
 *   - LGPD comms revogado (mas sensível OK) → row 'skipped' com error
 *     LGPD_COMMS_CONSENT_REQUIRED, sender NÃO é chamado.
 *   - Paciente sem identifier → row 'failed', sender NÃO é chamado.
 *   - Sem canal ativo no org → row 'failed', sender NÃO é chamado.
 *   - Provider falha (sender lança) → row 'failed' com error preservado,
 *     addendum NÃO é afetado.
 *   - Toggle enabled=0 → row 'skipped' com reason "disabled".
 *   - Isolamento multi-tenant: notify em addendum de A a partir do org B
 *     devolve null (addendum não encontrado no org B).
 *   - Auditoria: eventos NOTIFIED / SKIPPED / FAILED gravados com metadata.
 *
 * Nota sobre o hook automático: `ClinicEncounterService.addAddendum`
 * dispara `notifyForAddendum` via microtask fire-and-forget. Pra manter o
 * teste determinístico, DESABILITAMOS o toggle no seedOrg por default —
 * cada teste habilita explicitamente antes de disparar sua chamada manual
 * de notify (com sender injetado).
 *
 * Uso:  npm run test:clinic-addendum-notice
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-addendum-notice-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-addendum-notice-1234567890";
process.env.APP_URL = "https://zappflow.test";

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
  const { ClinicAddendumNoticeService } = await import("../src/server/ClinicAddendumNoticeService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    // Desabilita o hook automático da Fase 24 por default — cada teste
    // habilita explicitamente antes de chamar notify manual (sender injetado).
    db.prepare(`UPDATE organization_settings SET clinic_addendum_notification_enabled = 0 WHERE organization_id = ?`).run(orgId);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string, phone?: string) => {
      const id = randomUUID();
      const ident = phone !== undefined ? phone : `55${tag.replace(/\W/g, "")}${Math.floor(Math.random() * 1e8)}`;
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, ident);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, channelId, mkContact };
  }

  function enableNotify(orgId: string, on = true) {
    db.prepare(`UPDATE organization_settings SET clinic_addendum_notification_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
  }

  async function openSignedEncounter(seed: { orgId: string; actorId: string; mkContact: (n: string, phone?: string) => string }, patientName: string, phone?: string) {
    const patient = seed.mkContact(patientName, phone);
    LgpdService.grantConsent(seed.orgId, patient, "dados_sensiveis", { channel: "in_person", actorId: seed.actorId });
    LgpdService.grantConsent(seed.orgId, patient, "comunicacoes", { actorId: seed.actorId });
    const prof = ClinicAgendaService.createProfessional(seed.orgId, { name: "Dra. Ana" }, seed.actorId);
    const apt = ClinicAgendaService.createAppointment(seed.orgId, {
      contactId: patient, title: "Consulta", scheduledStart: "2026-11-05T10:00:00-03:00",
      professionalId: prof.id, durationMinutes: 30,
    }, seed.actorId);
    const enc = ClinicEncounterService.open(seed.orgId, apt.id, seed.actorId);
    ClinicEncounterService.update(seed.orgId, enc.id, seed.actorId, { subjective: "queixa", plan: "conduta" });
    const signed = ClinicEncounterService.finalize(seed.orgId, enc.id, seed.actorId);
    return { patient, encounter: signed };
  }

  const sends: Array<{ channelId: string; to: string; message: string }> = [];
  const sender = async (channelId: string, to: string, message: string) => {
    sends.push({ channelId, to, message });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };

  // === Caso 1: envio OK (happy path) =======================================
  const A = seedOrg("A");
  const { patient: pA, encounter: encA } = await openSignedEncounter(A, "Maria Silva");
  const add1 = ClinicEncounterService.addAddendum(A.orgId, encA.id, A.actorId, { note: "Retorno normal", actorName: "Dra. Ana" });

  enableNotify(A.orgId, true);
  const n1 = await ClinicAddendumNoticeService.notifyForAddendum(A.orgId, add1.id, { actorId: A.actorId, sender });
  check("envio OK: status = sent", n1?.status === "sent", String(n1?.status));
  check("provider_message_id preservado", !!n1?.providerMessageId);
  check("portal_token_id gerado", !!n1?.portalTokenId);
  check("channel_id gravado", n1?.channelId === A.channelId);
  check("sender chamado 1×", sends.length === 1);
  check("mensagem contém nome do paciente", sends[0].message.includes("Maria"), sends[0].message);
  check("mensagem contém nome do negócio", sends[0].message.includes("Clínica A"));
  check("mensagem contém link do portal com APP_URL", sends[0].message.includes("https://zappflow.test/patient/"));

  // === Caso 2: dedup =======================================================
  const n2 = await ClinicAddendumNoticeService.notifyForAddendum(A.orgId, add1.id, { actorId: A.actorId, sender });
  check("2ª chamada devolve mesmo id (dedup)", n2?.id === n1?.id);
  check("sender NÃO foi chamado 2×", sends.length === 1);

  // === Caso 3: force bypass ================================================
  const n3 = await ClinicAddendumNoticeService.notifyForAddendum(A.orgId, add1.id, { actorId: A.actorId, sender, force: true });
  check("force:true gera row nova", !!n3 && n3.id !== n1?.id);
  check("force:true dispara sender", sends.length === 2);

  // === Caso 4: LGPD sensível revogado (nem tenta) =========================
  const add2 = ClinicEncounterService.addAddendum(A.orgId, encA.id, A.actorId, { note: "outra evolução" });
  LgpdService.revokeConsent(A.orgId, pA, "dados_sensiveis", A.actorId);
  const sendsPre4 = sends.length;
  const nSensRevoke = await ClinicAddendumNoticeService.notifyForAddendum(A.orgId, add2.id, { actorId: A.actorId, sender });
  check("LGPD sensível revoke → status skipped", nSensRevoke?.status === "skipped", String(nSensRevoke?.status));
  check("error identifica LGPD_CONSENT_REQUIRED", !!nSensRevoke?.error?.includes("LGPD_CONSENT_REQUIRED"), String(nSensRevoke?.error));
  check("sender NÃO chamado (sensível revoke)", sends.length === sendsPre4);
  LgpdService.grantConsent(A.orgId, pA, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });

  // === Caso 5: LGPD comms revogado (sensível OK) ==========================
  LgpdService.revokeConsent(A.orgId, pA, "comunicacoes", A.actorId);
  const sendsPre5 = sends.length;
  const add3 = ClinicEncounterService.addAddendum(A.orgId, encA.id, A.actorId, { note: "sem comms" });
  const nCommsRevoke = await ClinicAddendumNoticeService.notifyForAddendum(A.orgId, add3.id, { actorId: A.actorId, sender });
  check("LGPD comms revoke → status skipped", nCommsRevoke?.status === "skipped", String(nCommsRevoke?.status));
  check("error identifica LGPD_COMMS_CONSENT_REQUIRED", !!nCommsRevoke?.error?.includes("LGPD_COMMS_CONSENT_REQUIRED"));
  check("sender NÃO chamado (comms revoke)", sends.length === sendsPre5);
  LgpdService.grantConsent(A.orgId, pA, "comunicacoes", { actorId: A.actorId });

  // === Caso 6: sem identifier =============================================
  const noPhoneOrg = seedOrg("NP");
  enableNotify(noPhoneOrg.orgId, true);
  const noPhonePatient = noPhoneOrg.mkContact("Sem Telefone", "temp_will_be_cleared");
  db.prepare(`UPDATE contacts SET identifier = '' WHERE id = ?`).run(noPhonePatient);
  LgpdService.grantConsent(noPhoneOrg.orgId, noPhonePatient, "dados_sensiveis", { channel: "in_person", actorId: noPhoneOrg.actorId });
  LgpdService.grantConsent(noPhoneOrg.orgId, noPhonePatient, "comunicacoes", { actorId: noPhoneOrg.actorId });
  const profNP = ClinicAgendaService.createProfessional(noPhoneOrg.orgId, { name: "Dra. NP" }, noPhoneOrg.actorId);
  const aptNP = ClinicAgendaService.createAppointment(noPhoneOrg.orgId, {
    contactId: noPhonePatient, title: "C", scheduledStart: "2026-11-06T10:00:00-03:00",
    professionalId: profNP.id, durationMinutes: 30,
  }, noPhoneOrg.actorId);
  const encNP = ClinicEncounterService.open(noPhoneOrg.orgId, aptNP.id, noPhoneOrg.actorId);
  ClinicEncounterService.update(noPhoneOrg.orgId, encNP.id, noPhoneOrg.actorId, { plan: "p" });
  const encNPSigned = ClinicEncounterService.finalize(noPhoneOrg.orgId, encNP.id, noPhoneOrg.actorId);

  // Cria addendum COM auto-notify desabilitado por seedOrg, depois habilita
  enableNotify(noPhoneOrg.orgId, false);
  const addNP = ClinicEncounterService.addAddendum(noPhoneOrg.orgId, encNPSigned.id, noPhoneOrg.actorId, { note: "sem telefone" });
  enableNotify(noPhoneOrg.orgId, true);
  const sendsPre6 = sends.length;
  const nNoPhone = await ClinicAddendumNoticeService.notifyForAddendum(noPhoneOrg.orgId, addNP.id, { actorId: noPhoneOrg.actorId, sender });
  check("sem identifier → status failed", nNoPhone?.status === "failed", String(nNoPhone?.status));
  check("sem identifier → error legível", !!nNoPhone?.error?.includes("identificador"), String(nNoPhone?.error));
  check("sender NÃO chamado (sem identifier)", sends.length === sendsPre6);

  // === Caso 7: sem canal ativo ============================================
  const noChanOrg = seedOrg("NC");
  db.prepare(`UPDATE channels SET status = 'disconnected' WHERE organization_id = ?`).run(noChanOrg.orgId);
  enableNotify(noChanOrg.orgId, true);
  const pNC = noChanOrg.mkContact("Sem Canal");
  LgpdService.grantConsent(noChanOrg.orgId, pNC, "dados_sensiveis", { channel: "in_person", actorId: noChanOrg.actorId });
  LgpdService.grantConsent(noChanOrg.orgId, pNC, "comunicacoes", { actorId: noChanOrg.actorId });
  const profNC = ClinicAgendaService.createProfessional(noChanOrg.orgId, { name: "Dra. NC" }, noChanOrg.actorId);
  const aptNC = ClinicAgendaService.createAppointment(noChanOrg.orgId, {
    contactId: pNC, title: "C", scheduledStart: "2026-11-07T10:00:00-03:00",
    professionalId: profNC.id, durationMinutes: 30,
  }, noChanOrg.actorId);
  const encNC = ClinicEncounterService.open(noChanOrg.orgId, aptNC.id, noChanOrg.actorId);
  ClinicEncounterService.update(noChanOrg.orgId, encNC.id, noChanOrg.actorId, { plan: "p" });
  const encNCSigned = ClinicEncounterService.finalize(noChanOrg.orgId, encNC.id, noChanOrg.actorId);
  enableNotify(noChanOrg.orgId, false);
  const addNC = ClinicEncounterService.addAddendum(noChanOrg.orgId, encNCSigned.id, noChanOrg.actorId, { note: "sem canal" });
  enableNotify(noChanOrg.orgId, true);
  const sendsPre7 = sends.length;
  const nNoChan = await ClinicAddendumNoticeService.notifyForAddendum(noChanOrg.orgId, addNC.id, { actorId: noChanOrg.actorId, sender });
  check("sem canal → status failed", nNoChan?.status === "failed", String(nNoChan?.status));
  check("sem canal → error 'canal'", !!nNoChan?.error?.toLowerCase().includes("canal"), String(nNoChan?.error));
  check("sender NÃO chamado (sem canal)", sends.length === sendsPre7);

  // === Caso 8: provider falha =============================================
  const { encounter: encFail } = await openSignedEncounter(A, "Paciente Fail");
  const addFail = ClinicEncounterService.addAddendum(A.orgId, encFail.id, A.actorId, { note: "provider falha" });
  const failingSender = async () => { throw new Error("provider off"); };
  const nFail = await ClinicAddendumNoticeService.notifyForAddendum(A.orgId, addFail.id, { actorId: A.actorId, sender: failingSender });
  check("provider falha → status failed", nFail?.status === "failed", String(nFail?.status));
  check("error preservado do provider", !!nFail?.error?.includes("provider off"), String(nFail?.error));
  const stillThere = db.prepare(`SELECT id FROM clinical_encounter_addendums WHERE id = ?`).get(addFail.id) as any;
  check("addendum NÃO é afetado por falha de envio", stillThere?.id === addFail.id);

  // === Caso 9: toggle enabled=0 ===========================================
  const A2 = seedOrg("A2");
  const { encounter: encA2 } = await openSignedEncounter(A2, "Fulano");
  const addToggle = ClinicEncounterService.addAddendum(A2.orgId, encA2.id, A2.actorId, { note: "toggle off" });
  // toggle já é 0 por seedOrg default
  const sendsPre9 = sends.length;
  const nToggle = await ClinicAddendumNoticeService.notifyForAddendum(A2.orgId, addToggle.id, { actorId: A2.actorId, sender });
  check("toggle=0 → status skipped", nToggle?.status === "skipped", String(nToggle?.status));
  check("toggle=0 → error 'desabilitada'", !!nToggle?.error?.includes("desabilitada"), String(nToggle?.error));
  check("sender NÃO chamado (toggle off)", sends.length === sendsPre9);

  // === Caso 10: isolamento multi-tenant ===================================
  const B = seedOrg("B");
  enableNotify(B.orgId, true);
  const nCross = await ClinicAddendumNoticeService.notifyForAddendum(B.orgId, add1.id, { actorId: B.actorId, sender });
  check("org B tentando notificar addendum de A → null (não encontrado)", nCross === null);

  // === Caso 11: list() por addendum =======================================
  const list = ClinicAddendumNoticeService.list(A.orgId, add1.id);
  check("list retorna múltiplas rows (sent + forced)", list.length >= 2, String(list.length));
  check("list ordenado DESC por sent_at", list[0].sentAt >= list[list.length - 1].sentAt);

  // === Caso 12: Auditoria =================================================
  const audNotified = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ADDENDUM_NOTIFIED'`
  ).get(A.orgId) as any;
  check("CLINIC_ADDENDUM_NOTIFIED contado (>=2 happy + force)", Number(audNotified?.c) >= 2, String(audNotified?.c));

  const audSkipped = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ADDENDUM_NOTICE_SKIPPED'`
  ).get(A.orgId) as any;
  check("CLINIC_ADDENDUM_NOTICE_SKIPPED contado (LGPD sens + comms)", Number(audSkipped?.c) >= 2, String(audSkipped?.c));

  const audFailedA = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ADDENDUM_NOTICE_FAILED'`
  ).get(A.orgId) as any;
  check("CLINIC_ADDENDUM_NOTICE_FAILED contado (provider falha)", Number(audFailedA?.c) >= 1);

  // Aguarda microtasks do addAddendum hook terminarem antes de fechar
  await new Promise((r) => setTimeout(r, 100));

  console.log("\n=== Notificação de addendum ao paciente (ADR-080 Fase 24) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
