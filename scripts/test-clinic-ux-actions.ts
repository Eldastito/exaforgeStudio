/**
 * TESTE — Módulo Clínica Fatia 31: UX blockers (backend endpoints)
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Escopo backend-testável. A UI-front (modal PIN, dirty-guard do
 * EncounterModal, badges visuais no sidebar) fica documentada como
 * pendente pra sessão com Playwright.
 *
 * ── ClinicAgendaService.cancel (chamado pela nova rota) ────────────────
 *   - cancel(staff) marca status=cancelled + cancelled_by='staff' + reason
 *   - Idempotente: 2ª chamada devolve estado atual sem mudar timestamp
 *   - Audit CLINIC_APPOINTMENT_CANCELLED com {cancelledBy: 'staff', reason}
 *   - Cross-tenant: id de A na org B → not found
 *
 * ── ClinicVacancyService.tryOfferOnCancel grace window ─────────────────
 *   - graceMs:0 (default legado) executa imediatamente
 *   - graceMs>0 usa setTimeout; se appt for reativado nesse intervalo,
 *     NÃO dispara vaga (re-check antes)
 *   - graceMs>0 respeitado com timer real curto (100ms) — reativa antes do
 *     timer disparar; espera 200ms; confirma que nenhuma vaga foi criada
 *
 * ── Counts de badge ────────────────────────────────────────────────────
 *   - followUpQueue count = 0 quando não há encounter signed com follow_up
 *   - followUpQueue count = N quando há encounters com recomendação
 *   - Retorno já agendado (parent_appointment_id ativo) SAI do count
 *   - Cross-tenant: count de A não vaza pra B
 *   - Vacancy pending-count = SELECT direto por status='pending'
 *
 * Uso:  npm run test:clinic-ux-actions
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-ux-actions-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-ux-actions-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicVacancyService } = await import("../src/server/ClinicVacancyService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, `55${tag}${Math.floor(Math.random() * 1e8)}`);
      LgpdService.grantConsent(orgId, id, "dados_sensiveis", { actorId: `user_${tag}` });
      LgpdService.grantConsent(orgId, id, "comunicacoes", { actorId: `user_${tag}` });
      return id;
    };
    return { orgId, actorId: `user_${tag}`, mkContact };
  }

  const A = seedOrg("A");
  const contactA = A.mkContact("Paciente A");
  const prof = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);

  // ── 1. cancel(staff) ──────────────────────────────────────────────────
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: contactA, title: "T", scheduledStart: new Date(Date.now() + 24 * 3600_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);

  const c1 = ClinicAgendaService.cancel(A.orgId, apt.id, { reason: "paciente pediu no telefone", cancelledBy: "staff" }, A.actorId);
  check("cancel(staff) marca status=cancelled", c1.status === "cancelled");
  check("cancel(staff) grava cancelled_by='staff'", c1.cancelled_by === "staff");
  check("cancel(staff) grava reason", c1.cancellation_reason === "paciente pediu no telefone");
  check("cancel(staff) grava cancelled_at", !!c1.cancelled_at);

  const firstCancelledAt = c1.cancelled_at;
  const c2 = ClinicAgendaService.cancel(A.orgId, apt.id, { reason: "outra", cancelledBy: "staff" }, A.actorId);
  check("cancel idempotente: 2ª chamada devolve status=cancelled", c2.status === "cancelled");
  check("cancel idempotente: cancelled_at preservado (não mudou)", c2.cancelled_at === firstCancelledAt);

  // Cross-tenant
  const B = seedOrg("B");
  let threwCross: any = null;
  try { ClinicAgendaService.cancel(B.orgId, apt.id, { cancelledBy: "staff" }, B.actorId); } catch (e) { threwCross = e; }
  check("cross-tenant: cancel de A em B → 'não encontrado'",
    threwCross?.message?.includes("não encontrado") === true);

  // Auditoria
  const cancelAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_APPOINTMENT_CANCELLED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_APPOINTMENT_CANCELLED ≥ 1", Number(cancelAudit?.c) >= 1);

  const cancelMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_APPOINTMENT_CANCELLED' ORDER BY created_at ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(cancelMeta?.metadata_json || "{}");
  check("audit metadata: cancelledBy='staff'", meta.cancelledBy === "staff");
  check("audit metadata: reason preservada", meta.reason === "paciente pediu no telefone");

  // ── 2. Grace window na oferta de vaga ──────────────────────────────────
  // Setup: cria appt futuro (>6h) com prof + candidato (encounter signed com follow_up)
  const contactB = A.mkContact("Candidato Vaga");
  const aptOwner = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.mkContact("Owner Vaga"), title: "Owner",
    scheduledStart: new Date(Date.now() + 48 * 3600_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);

  // Cria encounter signed com follow_up pra ter candidato elegível
  const aptCand = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: contactB, title: "Consulta Cand",
    scheduledStart: new Date(Date.now() - 5 * 86400_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc = ClinicEncounterService.open(A.orgId, aptCand.id, A.actorId);
  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { subjective: "s", plan: "p" });
  const signed = ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, signed.id, A.actorId, 7);

  // Cancela o owner appt
  ClinicAgendaService.cancel(A.orgId, aptOwner.id, { cancelledBy: "staff" }, A.actorId);

  // graceMs:0 → executa imediato + oferta é criada
  const senderSends: any[] = [];
  const sender = async (channelId: string, to: string, message: string) => {
    senderSends.push({ channelId, to, message });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  const offer1 = await ClinicVacancyService.tryOfferOnCancel(A.orgId, aptOwner.id, { sender: sender as any, graceMs: 0 });
  check("graceMs:0 executa imediato + cria vaga", !!offer1?.id);

  // Setup 2: outro cenário com grace curto — reativa antes do timer
  const aptOwner2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.mkContact("Owner Vaga 2"), title: "Owner 2",
    scheduledStart: new Date(Date.now() + 72 * 3600_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, aptOwner2.id, { cancelledBy: "staff" }, A.actorId);

  // Dispara com graceMs=200ms; imediatamente reativa (status volta pra confirmed).
  // O re-check no timer vai ver status != 'cancelled' e retornar null.
  const pendingPromise = ClinicVacancyService.tryOfferOnCancel(A.orgId, aptOwner2.id, { sender: sender as any, graceMs: 200 });
  db.prepare(`UPDATE appointments SET status = 'confirmed', cancelled_at = NULL, cancelled_by = NULL WHERE id = ? AND organization_id = ?`)
    .run(aptOwner2.id, A.orgId);

  const beforeSends = senderSends.length;
  const resAfterReactivate = await pendingPromise;
  check("grace window: appt reativado dentro do grace → oferta NULL", resAfterReactivate === null);
  check("grace window: sender NÃO chamado pra vaga cancelada durante grace",
    senderSends.length === beforeSends);

  // Setup 3: outro candidato + outro owner. Primeiro candidato já tem
  // oferta pending (setup 1), então pickCandidate excluiria — cria novo.
  const contactB2 = A.mkContact("Candidato Vaga 2");
  const aptCand2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: contactB2, title: "Consulta Cand 2",
    scheduledStart: new Date(Date.now() - 4 * 86400_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc2 = ClinicEncounterService.open(A.orgId, aptCand2.id, A.actorId);
  ClinicEncounterService.update(A.orgId, enc2.id, A.actorId, { subjective: "s", plan: "p" });
  const signed2 = ClinicEncounterService.finalize(A.orgId, enc2.id, A.actorId);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, signed2.id, A.actorId, 7);

  const aptOwner3 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.mkContact("Owner Vaga 3"), title: "Owner 3",
    scheduledStart: new Date(Date.now() + 96 * 3600_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, aptOwner3.id, { cancelledBy: "staff" }, A.actorId);
  const beforeSends2 = senderSends.length;
  const offerAfterGrace = await ClinicVacancyService.tryOfferOnCancel(A.orgId, aptOwner3.id, { sender: sender as any, graceMs: 50 });
  check("grace window: appt permanece cancelled → oferta dispara após grace", !!offerAfterGrace?.id);
  check("grace window: sender chamado uma vez após grace expirar",
    senderSends.length === beforeSends2 + 1);

  // ── 3. Follow-up queue count ───────────────────────────────────────────
  // A tem 1 encounter signed com follow_up_days (do setup do grace test)
  const queueA = ClinicAgendaService.followUpQueue(A.orgId, 200);
  check("followUpQueue count > 0 quando há encounter signed com follow_up",
    Array.isArray(queueA) && queueA.length >= 1, String(queueA?.length));

  // Depois de agendar o retorno, o encounter SAI da fila
  const encsBefore = queueA.length;
  ClinicAgendaService.scheduleFollowUp(A.orgId, aptCand.id, { inDays: 7 }, A.actorId);
  const queueAAfter = ClinicAgendaService.followUpQueue(A.orgId, 200);
  check("followUpQueue diminui após agendar retorno", queueAAfter.length === encsBefore - 1);

  // Cross-tenant
  const queueB = ClinicAgendaService.followUpQueue(B.orgId, 200);
  check("cross-tenant: followUpQueue de A não vaza pra B", queueB.length === 0);

  // Org com 0 encounters
  const C = seedOrg("C");
  const queueC = ClinicAgendaService.followUpQueue(C.orgId, 200);
  check("followUpQueue count=0 pra org sem encounters", queueC.length === 0);

  // ── 4. Vacancy pending count (via SELECT direto — padrão da rota) ─────
  const pendingA = db.prepare(
    `SELECT COUNT(*) AS c FROM clinical_vacancy_offers WHERE organization_id = ? AND status = 'pending'`
  ).get(A.orgId) as any;
  check("vacancy pending count > 0 quando há ofertas pending",
    Number(pendingA?.c) >= 1, String(pendingA?.c));

  const pendingB = db.prepare(
    `SELECT COUNT(*) AS c FROM clinical_vacancy_offers WHERE organization_id = ? AND status = 'pending'`
  ).get(B.orgId) as any;
  check("cross-tenant: vacancy pending count de A não vaza pra B",
    Number(pendingB?.c) === 0);

  console.log("\n=== UX actions backend (ADR-080 Fase 31) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
