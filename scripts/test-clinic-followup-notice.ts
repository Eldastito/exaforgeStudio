/**
 * TESTE — Módulo Clínica Fatia 26: Notificação automática de retorno
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - notifyForEncounter feliz: encounter signed + follow_up_recommended_days
 *     → row 'sent' com provider_message_id, tokenId curto (7d) e mensagem
 *     contendo nome do paciente, negócio, data sugerida, link do portal.
 *   - Dedup por encounter: 2ª chamada sem force devolve existente, sender
 *     NÃO chamado 2×.
 *   - force:true bypassa dedup — nova row.
 *   - LGPD sensível revogado → 'skipped' reason LGPD_CONSENT_REQUIRED,
 *     sender NÃO chamado.
 *   - LGPD comms revogado → 'skipped' reason LGPD_COMMS_CONSENT_REQUIRED,
 *     sender NÃO chamado.
 *   - Paciente sem identifier → 'failed', sender NÃO chamado.
 *   - Sem canal ativo no org → 'failed', sender NÃO chamado.
 *   - Provider throw → 'failed' com error preservado.
 *   - Toggle enabled=0 → 'skipped' reason "disabled".
 *   - Encounter draft → null (nada a notificar sobre rascunho).
 *   - Encounter signed SEM follow_up_recommended_days → null.
 *   - Retorno já agendado (parent_appointment_id ativo) → 'skipped'
 *     reason "already_scheduled" (a Fase M cuida do lembrete de consulta
 *     marcada).
 *   - dispatchForOrg: candidatos DENTRO da janela (nowMs + leadDays)
 *     disparam; FORA (ainda muito cedo) NÃO disparam; retorno já agendado
 *     NÃO entra no candidates (SQL filtra); dedup no candidates (SQL
 *     filtra sent|queued anterior).
 *   - Isolamento multi-tenant.
 *   - Auditoria: NOTIFIED / SKIPPED / FAILED gravados com metadata.
 *
 * Uso:  npm run test:clinic-followup-notice
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-followup-notice-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-followup-notice-1234567890";
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
  const { ClinicFollowUpNoticeService } = await import("../src/server/ClinicFollowUpNoticeService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
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

  async function openSignedEncounterWithFollowUp(
    seed: { orgId: string; actorId: string; mkContact: (n: string, phone?: string) => string },
    patientName: string,
    apptStart: string,
    followUpDays: number,
    opts: { phone?: string; grantSensitive?: boolean; grantComms?: boolean } = {}
  ) {
    const patient = seed.mkContact(patientName, opts.phone);
    if (opts.grantSensitive !== false) LgpdService.grantConsent(seed.orgId, patient, "dados_sensiveis", { channel: "in_person", actorId: seed.actorId });
    if (opts.grantComms !== false) LgpdService.grantConsent(seed.orgId, patient, "comunicacoes", { actorId: seed.actorId });
    const prof = ClinicAgendaService.createProfessional(seed.orgId, { name: `Dr(a). ${patientName}` }, seed.actorId);
    const apt = ClinicAgendaService.createAppointment(seed.orgId, {
      contactId: patient, title: "Consulta", scheduledStart: apptStart,
      professionalId: prof.id, durationMinutes: 30,
    }, seed.actorId);
    const enc = ClinicEncounterService.open(seed.orgId, apt.id, seed.actorId);
    ClinicEncounterService.update(seed.orgId, enc.id, seed.actorId, { subjective: "s", plan: "p" });
    const signed = ClinicEncounterService.finalize(seed.orgId, enc.id, seed.actorId);
    if (followUpDays > 0) {
      ClinicEncounterService.setFollowUpRecommendation(seed.orgId, signed.id, seed.actorId, followUpDays);
    }
    return { patient, prof, apt, encounter: signed };
  }

  const sends: Array<{ channelId: string; to: string; message: string }> = [];
  const sender = async (channelId: string, to: string, message: string) => {
    sends.push({ channelId, to, message });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  const failingSender = async () => { throw new Error("provider off"); };

  const A = seedOrg("A");

  // ── 1. Happy path (notifyForEncounter direto) ─────────────────────────────
  const { patient: pat1, encounter: enc1 } = await openSignedEncounterWithFollowUp(
    A, "Maria Silva", "2026-10-01T10:00:00-03:00", 30
  );
  const before = sends.length;
  const n1 = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, enc1.id, {
    actorId: A.actorId, sender,
  });
  check("notify feliz: retornou row", !!n1);
  check("notify feliz: status=sent", n1?.status === "sent");
  check("notify feliz: provider_message_id gravado", !!n1?.providerMessageId);
  check("notify feliz: portalTokenId gravado", !!n1?.portalTokenId);
  check("notify feliz: sender chamado 1×", sends.length === before + 1);
  check("notify feliz: recommendedDays gravado", n1?.recommendedDays === 30);
  check("notify feliz: suggestedAt calculado (30d após consulta)",
    n1?.suggestedAt?.startsWith("2026-10-31") === true, String(n1?.suggestedAt));

  const msg1 = sends[sends.length - 1];
  check("mensagem contém primeiro nome do paciente", msg1.message.includes("Maria"));
  check("mensagem contém nome do negócio", msg1.message.includes("Clínica A"));
  check("mensagem contém data sugerida formatada BR", msg1.message.includes("31/10/2026"));
  check("mensagem contém link do portal absoluto", msg1.message.includes("https://zappflow.test/patient/"));
  check("mensagem menciona 7 dias de validade", msg1.message.includes("7 dias"));

  // ── 2. Dedup ─────────────────────────────────────────────────────────────
  const beforeDedup = sends.length;
  const n1b = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, enc1.id, {
    actorId: A.actorId, sender,
  });
  check("dedup: 2ª chamada devolve row existente", n1b?.id === n1?.id);
  check("dedup: sender NÃO chamado 2×", sends.length === beforeDedup);

  const n1c = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, enc1.id, {
    actorId: A.actorId, sender, force: true,
  });
  check("force:true: cria row nova", n1c?.id !== n1?.id);
  check("force:true: sender chamado de novo", sends.length === beforeDedup + 1);

  // ── 3. LGPD sensível revogado ────────────────────────────────────────────
  const { patient: patNoSens, encounter: encNoSens } = await openSignedEncounterWithFollowUp(
    A, "João sem sensível", "2026-10-02T10:00:00-03:00", 15
  );
  LgpdService.revokeConsent(A.orgId, patNoSens, "dados_sensiveis", A.actorId);
  const beforeSens = sends.length;
  const nSens = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, encNoSens.id, {
    actorId: A.actorId, sender,
  });
  check("LGPD sensível revogado: status=skipped", nSens?.status === "skipped");
  check("LGPD sensível revogado: error correto", nSens?.error === "LGPD_CONSENT_REQUIRED");
  check("LGPD sensível revogado: sender NÃO chamado", sends.length === beforeSens);

  // ── 4. LGPD comms revogado (sensível OK) ─────────────────────────────────
  const { patient: patNoComms, encounter: encNoComms } = await openSignedEncounterWithFollowUp(
    A, "Ana sem comms", "2026-10-03T10:00:00-03:00", 20
  );
  LgpdService.revokeConsent(A.orgId, patNoComms, "comunicacoes", A.actorId);
  const beforeComms = sends.length;
  const nComms = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, encNoComms.id, {
    actorId: A.actorId, sender,
  });
  check("LGPD comms revogado: status=skipped", nComms?.status === "skipped");
  check("LGPD comms revogado: error correto", nComms?.error === "LGPD_COMMS_CONSENT_REQUIRED");
  check("LGPD comms revogado: sender NÃO chamado", sends.length === beforeComms);

  // ── 5. Paciente sem identifier ───────────────────────────────────────────
  const { encounter: encNoId } = await openSignedEncounterWithFollowUp(
    A, "Ze sem numero", "2026-10-04T10:00:00-03:00", 10, { phone: "" }
  );
  const beforeNoId = sends.length;
  const nNoId = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, encNoId.id, {
    actorId: A.actorId, sender,
  });
  check("sem identifier: status=failed", nNoId?.status === "failed");
  check("sem identifier: sender NÃO chamado", sends.length === beforeNoId);

  // ── 6. Sem canal ativo ───────────────────────────────────────────────────
  const NoCh = seedOrg("NoCh");
  db.prepare(`UPDATE channels SET status = 'disconnected' WHERE organization_id = ?`).run(NoCh.orgId);
  const { encounter: encNoCh } = await openSignedEncounterWithFollowUp(
    NoCh, "Cliente NoCh", "2026-10-05T10:00:00-03:00", 30
  );
  const beforeNoCh = sends.length;
  const nNoCh = await ClinicFollowUpNoticeService.notifyForEncounter(NoCh.orgId, encNoCh.id, {
    actorId: NoCh.actorId, sender,
  });
  check("sem canal: status=failed", nNoCh?.status === "failed");
  check("sem canal: sender NÃO chamado", sends.length === beforeNoCh);

  // ── 7. Provider falha ────────────────────────────────────────────────────
  const { encounter: encFail } = await openSignedEncounterWithFollowUp(
    A, "Paciente Fail", "2026-10-06T10:00:00-03:00", 12
  );
  const nFail = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, encFail.id, {
    actorId: A.actorId, sender: failingSender,
  });
  check("provider throw: status=failed", nFail?.status === "failed");
  check("provider throw: error preservado", nFail?.error?.includes("provider off"));

  // ── 8. Toggle disabled ───────────────────────────────────────────────────
  const Off = seedOrg("Off");
  db.prepare(`UPDATE organization_settings SET clinic_followup_notification_enabled = 0 WHERE organization_id = ?`).run(Off.orgId);
  const { encounter: encOff } = await openSignedEncounterWithFollowUp(
    Off, "Cliente Off", "2026-10-07T10:00:00-03:00", 30
  );
  const beforeOff = sends.length;
  const nOff = await ClinicFollowUpNoticeService.notifyForEncounter(Off.orgId, encOff.id, {
    actorId: Off.actorId, sender,
  });
  check("toggle disabled: status=skipped", nOff?.status === "skipped");
  check("toggle disabled: error 'notificação desabilitada'", nOff?.error?.includes("desabilitada") === true);
  check("toggle disabled: sender NÃO chamado", sends.length === beforeOff);

  // ── 9. Encounter draft / sem follow_up_recommended_days ──────────────────
  const draftApt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: pat1, title: "Draft", scheduledStart: "2026-10-08T10:00:00-03:00",
    professionalId: (ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Y" }, A.actorId)).id,
    durationMinutes: 30,
  }, A.actorId);
  const draftEnc = ClinicEncounterService.open(A.orgId, draftApt.id, A.actorId);
  const nDraft = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, draftEnc.id, {
    actorId: A.actorId, sender,
  });
  check("encounter draft: retorna null", nDraft === null);

  // signed sem follow_up_recommended_days
  const { encounter: encNoFu } = await openSignedEncounterWithFollowUp(
    A, "Sem FollowUp", "2026-10-09T10:00:00-03:00", 0
  );
  const nNoFu = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, encNoFu.id, {
    actorId: A.actorId, sender,
  });
  check("signed sem follow_up_recommended_days: retorna null", nNoFu === null);

  // ── 10. Retorno já agendado → skipped already_scheduled ──────────────────
  const { patient: patSched, apt: aptSched, prof: profSched, encounter: encSched } = await openSignedEncounterWithFollowUp(
    A, "Já agendado", "2026-10-10T10:00:00-03:00", 30
  );
  // Cria o retorno (filho do apt) — usa scheduleFollowUp que preenche parent_appointment_id
  ClinicAgendaService.scheduleFollowUp(A.orgId, aptSched.id, { inDays: 30 }, A.actorId);
  const nSched = await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, encSched.id, {
    actorId: A.actorId, sender,
  });
  check("retorno já agendado: status=skipped", nSched?.status === "skipped");
  check("retorno já agendado: reason 'already_scheduled' no error", nSched?.error?.includes("já agendado") === true);

  // ── 11. dispatchForOrg — janela ──────────────────────────────────────────
  // Criamos 2 encounters: um cujo suggestedAt está DENTRO da janela (leadDays
  // default = 3), outro FORA (muito no futuro).
  const D = seedOrg("D");
  db.prepare(`UPDATE organization_settings SET clinic_followup_notification_lead_days = 3, clinic_followup_notification_enabled = 1 WHERE organization_id = ?`).run(D.orgId);

  // Base de tempo do teste
  const nowMs = Date.parse("2026-10-15T09:00:00Z");
  // Encounter cuja consulta foi 2026-10-13 e recomendação 3 dias → suggestedAt 2026-10-16 (DENTRO da janela: now+3d = 2026-10-18)
  const { encounter: encInWin } = await openSignedEncounterWithFollowUp(
    D, "Dentro Janela", "2026-10-13T10:00:00Z", 3
  );
  // Encounter cuja consulta foi 2026-10-13 e recomendação 30 dias → suggestedAt 2026-11-12 (FORA da janela)
  const { encounter: encOutWin } = await openSignedEncounterWithFollowUp(
    D, "Fora Janela", "2026-10-13T10:00:00Z", 30
  );

  const beforeDispatch = sends.length;
  const summary = await ClinicFollowUpNoticeService.dispatchForOrg(D.orgId, { nowMs, sender });
  check("dispatch: scanned = 2 candidatos", summary.scanned === 2, String(summary.scanned));
  check("dispatch: notified = 1 (só o dentro da janela)", summary.notified === 1, JSON.stringify(summary));
  check("dispatch: sender chamado 1×", sends.length === beforeDispatch + 1);

  const inWinRows = ClinicFollowUpNoticeService.list(D.orgId, encInWin.id);
  check("dispatch: encounter dentro da janela tem row sent", inWinRows[0]?.status === "sent");
  const outWinRows = ClinicFollowUpNoticeService.list(D.orgId, encOutWin.id);
  check("dispatch: encounter fora da janela NÃO tem row", outWinRows.length === 0);

  // 2ª chamada de dispatch — dedup (SQL filtra encounter que já tem sent)
  const beforeDispatch2 = sends.length;
  const summary2 = await ClinicFollowUpNoticeService.dispatchForOrg(D.orgId, { nowMs, sender });
  check("dispatch 2×: scanned pula quem já foi notified", summary2.scanned === 1, String(summary2.scanned));
  check("dispatch 2×: notified = 0", summary2.notified === 0);
  check("dispatch 2×: sender NÃO chamado", sends.length === beforeDispatch2);

  // dispatch com toggle off → retorna zerado
  db.prepare(`UPDATE organization_settings SET clinic_followup_notification_enabled = 0 WHERE organization_id = ?`).run(D.orgId);
  const summaryOff = await ClinicFollowUpNoticeService.dispatchForOrg(D.orgId, { nowMs, sender });
  check("dispatch com toggle off: zero atividade", summaryOff.scanned === 0 && summaryOff.notified === 0);

  // ── 12. Isolamento multi-tenant ──────────────────────────────────────────
  const B = seedOrg("B");
  const beforeCross = sends.length;
  const nCross = await ClinicFollowUpNoticeService.notifyForEncounter(B.orgId, enc1.id, {
    actorId: B.actorId, sender,
  });
  check("cross-tenant: notify em encounter de A a partir de B → null", nCross === null);
  check("cross-tenant: sender NÃO chamado", sends.length === beforeCross);
  check("cross-tenant: list de encounter de A na org B → []",
    ClinicFollowUpNoticeService.list(B.orgId, enc1.id).length === 0);

  // ── 13. Auditoria ────────────────────────────────────────────────────────
  const sentAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_FOLLOWUP_NOTIFIED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_FOLLOWUP_NOTIFIED ≥ 2 (feliz + force)", Number(sentAudit?.c) >= 2, String(sentAudit?.c));

  const skipAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_FOLLOWUP_NOTICE_SKIPPED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_FOLLOWUP_NOTICE_SKIPPED ≥ 3 (sens+comms+already_scheduled)", Number(skipAudit?.c) >= 3, String(skipAudit?.c));

  const failAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_FOLLOWUP_NOTICE_FAILED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_FOLLOWUP_NOTICE_FAILED ≥ 2 (no_identifier + provider throw)", Number(failAudit?.c) >= 2, String(failAudit?.c));

  const sentMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_FOLLOWUP_NOTIFIED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(sentMeta?.metadata_json || "{}");
  check("audit NOTIFIED metadata carrega encounterId", meta.encounterId === enc1.id);
  check("audit NOTIFIED metadata carrega recommendedDays", meta.recommendedDays === 30);
  check("audit NOTIFIED metadata carrega suggestedAt", typeof meta.suggestedAt === "string" && meta.suggestedAt.startsWith("2026-10-31"));

  console.log("\n=== Notificação automática de retorno (ADR-080 Fase 26) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
