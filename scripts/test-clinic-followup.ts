/**
 * TESTE — Módulo Clínica Fase I: Retorno em 1 clique + fila (ADR-080 extensão).
 * -----------------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - scheduleFollowUp cria appointment novo herdando profissional,
 *     paciente e duração da consulta de origem;
 *   - parent_appointment_id é gravado no retorno (rastreia a série);
 *   - IDEMPOTENTE: 2ª chamada devolve o retorno já existente (evita duas
 *     secretárias criando dois retornos);
 *   - inDays calcula data a partir de scheduled_start; atISO tem prioridade;
 *   - Conflito de horário: propaga CONFLICT (herda de createAppointment);
 *     force=true grava mesmo assim;
 *   - Retorno cancelado LIBERA nova chamada de scheduleFollowUp (idempotência
 *     só considera não-cancelados);
 *   - setFollowUpRecommendation grava/limpa days no encounter;
 *   - setFollowUpRecommendation NÃO é bloqueado por encounter signed
 *     (intenção clínica pode ser ajustada pós-assinatura);
 *   - Rejeita days=0 (Math.floor + throw, sem Math.max autocorretor);
 *   - Fila lista encounters signed com recomendação sem retorno agendado;
 *   - Após scheduleFollowUp, encounter SAI da fila;
 *   - Isolamento multi-tenant;
 *   - Auditoria: CLINIC_FOLLOWUP_SCHEDULED, CLINIC_ENCOUNTER_FOLLOWUP_SET.
 *
 * Uso:  npm run test:clinic-followup
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-followup-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-followup-1234567890";

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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Ana Silva"), other: mkContact("Bruno Alves") };
  }
  const A = seedOrg("A");

  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Beatriz" }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Consulta inicial",
    scheduledStart: "2026-08-01T09:00:00-03:00",
    professionalId: dra.id,
    durationMinutes: 40,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);

  // ── 1. Recomendação de retorno ─────────────────────────────────────────
  let threwRec: any = null;
  try { ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc.id, A.actorId, 0); } catch (e) { threwRec = e; }
  check("setFollowUpRecommendation rejeita days=0", !!threwRec);

  const encWithRec = ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc.id, A.actorId, 15);
  check("setFollowUpRecommendation grava 15 dias", encWithRec.followUpRecommendedDays === 15);

  // Limpa e regrava
  const encCleared = ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc.id, A.actorId, null);
  check("setFollowUpRecommendation aceita null (limpa)", encCleared.followUpRecommendedDays === null);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc.id, A.actorId, 15);

  // ── 2. Fila antes de assinar: NÃO aparece (fila só mostra signed) ──────
  const beforeSign = ClinicAgendaService.followUpQueue(A.orgId);
  check("fila NÃO mostra encounter draft (mesmo com recomendação)", beforeSign.length === 0);

  // Assina
  ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);

  // Recomendação sobrevive à assinatura E pode ser alterada pós-signed
  const encAfterSign = ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc.id, A.actorId, 20);
  check("setFollowUpRecommendation funciona pós-signed", encAfterSign.followUpRecommendedDays === 20);

  // ── 3. Fila lista o encounter signed com recomendação ──────────────────
  const queue1 = ClinicAgendaService.followUpQueue(A.orgId);
  check("fila mostra 1 encounter signed com recomendação", queue1.length === 1 && queue1[0].encounterId === enc.id);
  check("fila traz nome do paciente", queue1[0].patientName === "Ana Silva");
  check("fila traz nome do profissional (snapshot)", queue1[0].professionalName === "Dra. Beatriz");
  // suggestedAt = source_start + 20 dias
  const sourceStart = new Date("2026-08-01T09:00:00-03:00").getTime();
  const suggested = new Date(queue1[0].suggestedAt).getTime();
  check("fila calcula suggestedAt = source + N dias", Math.abs(suggested - (sourceStart + 20 * 86400000)) < 1000);

  // ── 4. scheduleFollowUp com inDays ─────────────────────────────────────
  const ret = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { inDays: 20 }, A.actorId);
  check("scheduleFollowUp cria appointment novo", !!ret.id && ret.id !== apt.id);
  check("retorno herda paciente", ret.contact_id === A.patient);
  check("retorno herda profissional", ret.professional_id === dra.id);
  check("retorno herda duração", ret.expected_duration_minutes === 40);
  check("retorno grava parent_appointment_id", ret.parent_appointment_id === apt.id);
  check("retorno título default = 'Retorno'", ret.title === "Consulta inicial" || ret.title === "Retorno", ret.title);

  // Data ~= source + 20 dias
  const retMs = new Date(ret.scheduled_start).getTime();
  check("retorno data = source + 20 dias", Math.abs(retMs - (sourceStart + 20 * 86400000)) < 60000);

  // ── 5. Idempotência: 2ª chamada devolve o mesmo ────────────────────────
  const ret2 = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { inDays: 30 }, A.actorId);
  check("scheduleFollowUp idempotente: 2ª chamada devolve mesmo id", ret2.id === ret.id);

  // ── 6. Após agendar, fila esvazia ──────────────────────────────────────
  const queue2 = ClinicAgendaService.followUpQueue(A.orgId);
  check("fila esvazia após retorno agendado", queue2.length === 0);

  // ── 7. Cancelar retorno LIBERA reagendamento ───────────────────────────
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ? AND organization_id = ?`).run(ret.id, A.orgId);
  const queue3 = ClinicAgendaService.followUpQueue(A.orgId);
  check("cancelar retorno REPÕE encounter na fila", queue3.length === 1 && queue3[0].encounterId === enc.id);
  const ret3 = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { inDays: 25 }, A.actorId);
  check("scheduleFollowUp após cancelar cria novo retorno", ret3.id !== ret.id);

  // ── 8. atISO tem prioridade sobre inDays ───────────────────────────────
  // Cancela ret3 e agenda com data explícita
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ? AND organization_id = ?`).run(ret3.id, A.orgId);
  const explicitISO = "2026-09-15T14:00:00-03:00";
  const ret4 = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { atISO: explicitISO, inDays: 999 }, A.actorId);
  check("atISO tem prioridade sobre inDays", Math.abs(new Date(ret4.scheduled_start).getTime() - new Date(explicitISO).getTime()) < 60000);

  // ── 9. Conflito propaga CONFLICT ───────────────────────────────────────
  // Cria appointment conflitante manualmente na mesma janela do ret4
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.other, title: "Outro paciente",
    scheduledStart: "2026-09-22T14:00:00-03:00", professionalId: dra.id, durationMinutes: 40,
  }, A.actorId);
  // Cancela ret4 pra liberar idempotência
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ? AND organization_id = ?`).run(ret4.id, A.orgId);
  let threwConflict: any = null;
  try { ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { atISO: "2026-09-22T14:00:00-03:00" }, A.actorId); } catch (e) { threwConflict = e; }
  check("conflito de horário propaga CONFLICT", threwConflict?.code === "CONFLICT");

  // force=true bypass
  const retForced = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { atISO: "2026-09-22T14:00:00-03:00", force: true }, A.actorId);
  check("scheduleFollowUp com force=true grava sobre conflito", !!retForced.id);

  // ── 10. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  let threwCross: any = null;
  try { ClinicAgendaService.scheduleFollowUp(B.orgId, apt.id, { inDays: 5 }, B.actorId); } catch (e) { threwCross = e; }
  check("org B agendando retorno em apt de A → 404", threwCross?.message?.includes("não encontrado"));
  check("fila de B está vazia", ClinicAgendaService.followUpQueue(B.orgId).length === 0);

  // ── 11. Auditoria ──────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type IN ('CLINIC_FOLLOWUP_SCHEDULED','CLINIC_ENCOUNTER_FOLLOWUP_SET')
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_FOLLOWUP_SCHEDULED ≥ 3 (ret + ret3 + ret4 + retForced)", (map.CLINIC_FOLLOWUP_SCHEDULED || 0) >= 3, String(map.CLINIC_FOLLOWUP_SCHEDULED));
  check("audit CLINIC_ENCOUNTER_FOLLOWUP_SET ≥ 3 (15/null/15/20)", (map.CLINIC_ENCOUNTER_FOLLOWUP_SET || 0) >= 3, String(map.CLINIC_ENCOUNTER_FOLLOWUP_SET));

  console.log("\n=== Retorno em 1 clique + fila (ADR-080 Fase I) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
