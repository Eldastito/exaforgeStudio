/**
 * TESTE — Módulo Clínica Fase R: visibilidade das automações WhatsApp
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - overview.automations.reschedule conta offered/chosen/abandoned/expired;
 *   - overview.automations.vacancy conta offered/accepted/declined/expired;
 *   - vacancy.recoveredMinutes soma duração das aceitas (recuperação de receita);
 *   - VacancyService.recent devolve N mais recentes com nomes hidratados
 *     (candidato, profissional, paciente da consulta original);
 *   - Ordena desc por created_at;
 *   - Isolamento multi-tenant;
 *   - Respeita from/to (offer FORA da janela não conta).
 *
 * Uso:  npm run test:clinic-automation-visibility
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-autovis-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-autovis-1234567890";

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
  const { ClinicMetricsService } = await import("../src/server/ClinicMetricsService.js");
  const { ClinicVacancyService } = await import("../src/server/ClinicVacancyService.js");
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
    return { orgId, channelId, actorId: `user_${tag}`, mkContact };
  }
  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  const cancelPatient = A.mkContact("Cancela");
  const q1 = A.mkContact("Q1");
  const q2 = A.mkContact("Q2");
  [cancelPatient, q1, q2].forEach((c) => {
    LgpdService.grantConsent(A.orgId, c, "dados_sensiveis", { actorId: A.actorId });
    LgpdService.grantConsent(A.orgId, c, "comunicacoes", { actorId: A.actorId });
  });

  // Prepara 2 candidatos com signed encounter pendente
  async function seedCandidate(patient: string, offsetPast: number) {
    const apt = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patient, title: "Antiga",
      scheduledStart: new Date(Date.now() - offsetPast * 86400_000).toISOString(),
      professionalId: dra.id, durationMinutes: 30, force: true,
    }, A.actorId);
    const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
    ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc.id, A.actorId, 10);
    ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);
    db.prepare(`UPDATE clinical_encounters SET signed_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - offsetPast * 86400_000).toISOString(), enc.id);
    return apt;
  }
  await seedCandidate(q1, 20);
  await seedCandidate(q2, 10);

  // Cancela consulta 1 → vaga 1 → sender ok → oferta pro Q1
  const senderOk = async () => "wamid";
  const now = Date.now();
  const c1 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: cancelPatient, title: "vaga1", scheduledStart: new Date(now + 48 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 60, force: true,
  }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, c1.id, { cancelledBy: "patient" }, A.actorId);
  const o1 = await ClinicVacancyService.tryOfferOnCancel(A.orgId, c1.id, { sender: senderOk });
  check("oferta 1 criada", !!o1);
  // Q1 aceita
  ClinicVacancyService.handleReply(A.orgId, q1, true);

  // Cancela consulta 2 → vaga 2 → oferta pro Q2
  const c2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: cancelPatient, title: "vaga2", scheduledStart: new Date(now + 72 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, c2.id, { cancelledBy: "patient" }, A.actorId);
  const o2 = await ClinicVacancyService.tryOfferOnCancel(A.orgId, c2.id, { sender: senderOk });
  check("oferta 2 criada", !!o2);
  // Q2 declina
  ClinicVacancyService.handleReply(A.orgId, q2, false);

  // ── Metrics overview ────────────────────────────────────────────────
  const m = ClinicMetricsService.overview(A.orgId);
  check("automations.vacancy.offered >= 2", m.automations.vacancy.offered >= 2, String(m.automations.vacancy.offered));
  check("automations.vacancy.accepted = 1", m.automations.vacancy.accepted === 1);
  check("automations.vacancy.declined = 1", m.automations.vacancy.declined === 1);
  check("recoveredMinutes = 60 (duração da vaga 1 aceita)", m.automations.vacancy.recoveredMinutes === 60,
    String(m.automations.vacancy.recoveredMinutes));
  check("automations.reschedule.offered = 0 (nenhum criado)", m.automations.reschedule.offered === 0);

  // ── recent() ─────────────────────────────────────────────────────────
  const list = ClinicVacancyService.recent(A.orgId, 20);
  check("recent devolve 2 offers", list.length === 2);
  check("recent ordenado desc (mais nova primeiro)",
    new Date(list[0].createdAt).getTime() >= new Date(list[1].createdAt).getTime());
  check("recent hidrata candidateName", list.every((x) => !!x.candidateName));
  check("recent hidrata professionalName = 'Dra. Ana'", list.every((x) => x.professionalName === "Dra. Ana"));
  check("recent hidrata sourcePatientName = 'Cancela'", list.every((x) => x.sourcePatientName === "Cancela"));

  // ── Isolamento multi-tenant ─────────────────────────────────────────
  const B = seedOrg("B");
  check("org B: recent vazio", ClinicVacancyService.recent(B.orgId).length === 0);
  const mB = ClinicMetricsService.overview(B.orgId);
  check("org B: automations zeradas", mB.automations.vacancy.offered === 0 && mB.automations.reschedule.offered === 0);

  // ── Filtro from/to (fora da janela não conta) ────────────────────────
  const mNarrow = ClinicMetricsService.overview(A.orgId, {
    from: new Date(now + 100 * 86400_000).toISOString(),
    to: new Date(now + 200 * 86400_000).toISOString(),
  });
  check("window futuro distante: automations zeradas (fora da janela)",
    mNarrow.automations.vacancy.offered === 0);

  console.log("\n=== Visibilidade das automações (ADR-080 Fase R) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
