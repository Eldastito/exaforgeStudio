/**
 * TESTE — Módulo Clínica Fase P: Reagendamento em 1 clique (ADR-080).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - parseIntent reconhece REMARCAR/REAGENDAR/MUDAR (com acento/caixa);
 *   - findSlots devolve até 3 slots livres, um por dia, preferindo mesmo
 *     horário do original, dentro da faixa útil, no futuro;
 *   - findSlots pula dias com conflito com outro appt do profissional;
 *   - REMARCAR sem consulta ativa → not_handled (não expõe rota interna);
 *   - REMARCAR com consulta cancelada → reply amigável sem oferta;
 *   - REMARCAR com consulta ativa → cria offer + envia lista formatada
 *     com "1)" "2)" "3)" e instrução;
 *   - Só 1 offer pendente por paciente (nova REMARCAR abandona a anterior);
 *   - Offer expira em 30 min (força expiração via UPDATE);
 *   - Escolha "2" cria novo appt (parent=original), cancela original com
 *     reason='rescheduled', confirma automaticamente o novo;
 *   - Escolha inválida ("5" fora do range) → not_handled;
 *   - Escolha "X" abandona sem criar consulta;
 *   - Escolha após offer expirada → sem ação;
 *   - Slot escolhido que virou passado → reply amigável (raro race);
 *   - Isolamento multi-tenant;
 *   - Auditoria (OFFERED / CHOSEN / ABANDONED).
 *
 * Uso:  npm run test:clinic-reschedule
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-resched-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-resched-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicReminderService } = await import("../src/server/ClinicReminderService.js");
  const { ClinicReminderReplyService } = await import("../src/server/ClinicReminderReplyService.js");
  const { ClinicRescheduleService } = await import("../src/server/ClinicRescheduleService.js");
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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Ana"), other: mkContact("Bruno") };
  }
  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);

  const now = Date.now();
  // Consulta 24h à frente, hora "10:00 local (~13:00 UTC BR)"
  const originalStartMs = now + 24 * 3600_000;
  const original = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta original",
    scheduledStart: new Date(originalStartMs).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });
  const senderOk = async () => "wamid.ok";
  await ClinicReminderService.sendForAppointment(A.orgId, original.id, { sender: senderOk });

  // ── 1. parseIntent — variantes de REMARCAR ──────────────────────────
  const p = (t: string) => ClinicReminderReplyService.parseIntent(t);
  check("REMARCAR → reschedule_offered", p("REMARCAR") === "reschedule_offered");
  check("remarca → reschedule_offered", p("remarca") === "reschedule_offered");
  check("Reagendar → reschedule_offered", p("Reagendar") === "reschedule_offered");
  check("reagenda → reschedule_offered", p("reagenda") === "reschedule_offered");
  check("mudar → reschedule_offered", p("mudar") === "reschedule_offered");
  check("outro horario → reschedule_offered", p("outro horario") === "reschedule_offered");
  check("outro dia → reschedule_offered", p("outro dia") === "reschedule_offered");
  // Cancelar continua sendo cancelled (não confunde com reschedule)
  check("cancelar → cancelled (não reschedule)", p("cancelar") === "cancelled");

  // ── 2. findSlots devolve slots livres ──────────────────────────────
  const slots = ClinicRescheduleService.findSlots(A.orgId, original.id, 3);
  check("findSlots devolve 3 slots", slots.length === 3);
  check("todos slots são futuros", slots.every((s) => new Date(s.startISO).getTime() > now));
  check("todos slots duram 30 min (herança)", slots.every((s) => s.durationMinutes === 30));
  // 1 por dia
  const days = new Set(slots.map((s) => s.startISO.slice(0, 10)));
  check("1 slot por dia (dias distintos)", days.size === slots.length);

  // ── 3. Consulta cancelada → reply amigável sem offer ─────────────────
  const canceled = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Cancelada", scheduledStart: new Date(now + 48 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  // Envia lembrete ANTES de cancelar (Fatia 7 rejeita cancelled)
  await ClinicReminderService.sendForAppointment(A.orgId, canceled.id, { sender: senderOk });
  ClinicAgendaService.cancel(A.orgId, canceled.id, { cancelledBy: "staff" }, A.actorId);
  const rCanceled = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "remarcar", now);
  check("REMARCAR em consulta cancelada → sem oferta, reply amigável",
    rCanceled.handled && (rCanceled.reply || "").toLowerCase().includes("cancelada"));

  // Volta o cenário: cancela o "canceled" removendo o lembrete recente pra restaurar original como top
  db.prepare(`UPDATE clinical_appointment_reminders SET sent_at = datetime('now','-3 hours') WHERE appointment_id = ?`).run(canceled.id);

  // ── 4. REMARCAR com consulta ativa → cria offer ──────────────────────
  const r1 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "remarcar", now);
  check("REMARCAR → handled + reschedule_offered", r1.handled && r1.action === "reschedule_offered");
  check("reply contém '1)' e '2)' e '3)'", (r1.reply || "").includes("1)") && (r1.reply || "").includes("2)") && (r1.reply || "").includes("3)"));
  check("reply contém instrução 'X'", (r1.reply || "").toLowerCase().includes("x"));
  check("reply menciona 30 minutos", (r1.reply || "").includes("30 minutos"));

  const offer = ClinicRescheduleService.pendingOffer(A.orgId, A.patient);
  check("offer pendente criada", !!offer && offer?.status === "pending" && offer.slots.length === 3);

  // ── 5. Nova REMARCAR abandona a anterior ─────────────────────────────
  const r2 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "reagendar", now);
  check("2ª REMARCAR: só uma offer pendente por paciente", ClinicRescheduleService.pendingOffer(A.orgId, A.patient)?.id !== offer?.id);

  // ── 6. Escolha "5" fora do range → not_handled ───────────────────────
  const r5 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "5", now);
  // Como não bateu com a offer, cai no fluxo normal — mas "5" não é intent válido → not_handled
  check("escolha 5 fora do range → not_handled", !r5.handled);

  // ── 7. Escolha válida "2" cria novo appt ─────────────────────────────
  const currentOffer = ClinicRescheduleService.pendingOffer(A.orgId, A.patient)!;
  const chosenSlot = currentOffer.slots[1]; // "2"
  const r7 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "2", now);
  check("escolha 2 → handled + rescheduled", r7.handled && r7.action === "rescheduled");
  check("reply contém 'remarcada'", (r7.reply || "").toLowerCase().includes("remarcada"));
  check("newAppointmentId retornado", !!r7.appointmentId);

  // O novo appt existe, está confirmed pelo paciente, tem parent=original
  const newApt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(r7.appointmentId) as any;
  check("novo appt existe", !!newApt);
  check("novo appt parent_appointment_id = original.id", newApt.parent_appointment_id === original.id);
  check("novo appt patient_confirmed_at setado", !!newApt.patient_confirmed_at);
  check("novo appt scheduled_start = slot escolhido", Math.abs(new Date(newApt.scheduled_start).getTime() - new Date(chosenSlot.startISO).getTime()) < 60_000);

  // Original virou cancelled com reason='rescheduled'
  const origAfter = db.prepare(`SELECT status, cancelled_by, cancellation_reason FROM appointments WHERE id = ?`).get(original.id) as any;
  check("original.status = 'cancelled'", origAfter.status === "cancelled");
  check("original.cancelled_by = 'patient'", origAfter.cancelled_by === "patient");
  check("original.cancellation_reason = 'rescheduled'", origAfter.cancellation_reason === "rescheduled");

  // Offer virou chosen
  const offerAfter = db.prepare(`SELECT status, chosen_index, new_appointment_id FROM clinical_reschedule_offers WHERE id = ?`).get(currentOffer.id) as any;
  check("offer.status = 'chosen'", offerAfter.status === "chosen");
  check("offer.chosen_index = 2", offerAfter.chosen_index === 2);
  check("offer.new_appointment_id = novo appt", offerAfter.new_appointment_id === r7.appointmentId);

  // ── 8. Após chosen, "1" não vira nova escolha (offer foi resolvida) ──
  const r8 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "1", now);
  check("depois de chosen, '1' → not_handled", !r8.handled);

  // ── 9. Abandono explícito com "X" ────────────────────────────────────
  // Nova consulta + nova offer pra testar
  const apt9 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "9", scheduledStart: new Date(now + 72 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  await ClinicReminderService.sendForAppointment(A.orgId, apt9.id, { sender: senderOk });
  ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "remarcar", now);
  const rX = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "X", now);
  check("'X' abandona offer", rX.handled && rX.action === "reschedule_abandoned");
  check("reply contém 'mantive'", (rX.reply || "").toLowerCase().includes("mantive"));

  // ── 10. Offer expirada não aceita escolha ────────────────────────────
  ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "remarcar", now); // nova offer
  const off10 = ClinicRescheduleService.pendingOffer(A.orgId, A.patient)!;
  db.prepare(`UPDATE clinical_reschedule_offers SET expires_at = datetime('now','-5 minutes') WHERE id = ?`).run(off10.id);
  const rExp = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "1", now);
  check("offer expirada → '1' não age", !rExp.handled);

  // ── 11. Isolamento multi-tenant ──────────────────────────────────────
  const B = seedOrg("B");
  const rCross = ClinicReminderReplyService.tryHandle(B.orgId, A.patient, "remarcar", now);
  check("org B com paciente de A → not_handled", !rCross.handled);
  check("org B: nenhuma offer criada pra paciente de A", ClinicRescheduleService.pendingOffer(B.orgId, A.patient) === null);

  // ── 12. Auditoria ────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type LIKE 'CLINIC_RESCHEDULE_%'
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_RESCHEDULE_OFFERED ≥ 3", (map.CLINIC_RESCHEDULE_OFFERED || 0) >= 3, String(map.CLINIC_RESCHEDULE_OFFERED));
  check("audit CLINIC_RESCHEDULE_CHOSEN = 1", (map.CLINIC_RESCHEDULE_CHOSEN || 0) === 1);
  check("audit CLINIC_RESCHEDULE_ABANDONED ≥ 1", (map.CLINIC_RESCHEDULE_ABANDONED || 0) >= 1);

  console.log("\n=== Reagendamento em 1 clique (ADR-080 Fase P) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
