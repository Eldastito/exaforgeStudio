/**
 * TESTE — Módulo Clínica Fase M: Lembrete automático de consulta (ADR-080).
 * ------------------------------------------------------------------------
 * Prova, offline e em banco temporário (sender injetado, ZERO rede real):
 *   - LGPD comunicações ausente → LGPD_COMMS_CONSENT_REQUIRED em
 *     sendForAppointment direto (chamada manual);
 *   - Consulta em status inativo (cancelled/no_show/completed) →
 *     APPT_NOT_ACTIVE em chamada manual; pass do dispatch ignora
 *     silenciosamente (não gera row);
 *   - Paciente sem identifier → erro claro na chamada manual;
 *   - Dedup: 2 chamadas seguidas de sendForAppointment devolvem o mesmo
 *     row (não duplica); dispatch() rodando 2× também não duplica;
 *   - `force: true` bypassa dedup e gera novo row;
 *   - Sem canal ativo: chamada manual devolve null (skip silencioso),
 *     pass conta como 'skipped';
 *   - Envio OK: row 'sent' + provider_message_id;
 *   - Sender falha: row 'failed' + error (não relança); próxima passada
 *     PODE reenviar (uma failed NÃO conta como dedup);
 *   - dispatch() encontra consulta na janela (agora + 24h ± 1h);
 *   - dispatch() ignora consulta FORA da janela (48h à frente);
 *   - Config clinic_reminder_hours é respeitada por org;
 *   - Isolamento multi-tenant;
 *   - Auditoria CLINIC_REMINDER_SENT / _FAILED.
 *
 * Uso:  npm run test:clinic-reminder
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-reminder-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-reminder-1234567890";

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
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string, opts: { hoursBefore?: number; channelStatus?: string } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_reminder_hours) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`, opts.hoursBefore ?? 24);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, ?)`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`, opts.channelStatus || "connected");
    const mkContact = (n: string, phone?: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, phone ?? `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, channelId, actorId: `user_${tag}`, patient: mkContact("Ana Silva"), other: mkContact("Bruno"), mkContact };
  }

  const A = seedOrg("A", { hoursBefore: 24 });
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Beatriz" }, A.actorId);

  // Consulta na janela (agora + 24h)
  const now = Date.now();
  const nowDate = new Date(now);
  const withinISO = new Date(now + 24 * 3600_000 + 5 * 60_000).toISOString(); // 24h05
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta", scheduledStart: withinISO,
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);

  // Consulta FORA da janela (agora + 48h)
  const farISO = new Date(now + 48 * 3600_000).toISOString();
  const aptFar = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta longe", scheduledStart: farISO,
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);

  // Mocks de sender
  const calls: any[] = [];
  const senderOk = async (channelId: string, to: string, content: string) => {
    calls.push({ channelId, to, content });
    return `wamid.${randomUUID()}`;
  };
  const senderFail = async () => { throw new Error("Provider offline (503)"); };

  // ── 1. LGPD comunicações ausente ─────────────────────────────────────
  let threwLgpd: any = null;
  try { await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { sender: senderOk }); } catch (e) { threwLgpd = e; }
  check("sem consentimento comunicações → LGPD_COMMS_CONSENT_REQUIRED", threwLgpd?.code === "LGPD_COMMS_CONSENT_REQUIRED");

  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });

  // ── 2. Consulta inativa (cancelled) → APPT_NOT_ACTIVE ─────────────────
  const canc = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "X", scheduledStart: withinISO,
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(canc.id);
  let threwCanc: any = null;
  try { await ClinicReminderService.sendForAppointment(A.orgId, canc.id, { sender: senderOk }); } catch (e) { threwCanc = e; }
  check("cancelled → APPT_NOT_ACTIVE", threwCanc?.code === "APPT_NOT_ACTIVE");

  // ── 3. Envio OK ──────────────────────────────────────────────────────
  calls.length = 0;
  const r1 = await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { sender: senderOk });
  check("envio OK grava row 'sent'", r1?.status === "sent");
  check("provider_message_id gravado", !!r1?.providerMessageId && r1.providerMessageId.startsWith("wamid."));
  check("sender chamado 1×", calls.length === 1);
  check("mensagem contém nome do paciente", calls[0].content.includes("Ana"));
  check("mensagem contém nome do profissional", calls[0].content.includes("Dra. Beatriz"));
  check("mensagem tem instrução SIM/NÃO", calls[0].content.includes("SIM") && calls[0].content.includes("NÃO"));

  // ── 4. Dedup: 2ª chamada devolve mesmo id (não duplica) ───────────────
  const r2 = await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { sender: senderOk });
  check("dedup: 2ª chamada devolve MESMO id", r2?.id === r1?.id);
  check("sender NÃO foi chamado de novo", calls.length === 1);

  // ── 5. force: true bypass dedup ──────────────────────────────────────
  const r3 = await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { sender: senderOk, force: true });
  check("force=true cria row NOVO", r3?.id !== r1?.id && r3?.status === "sent");
  check("sender foi chamado de novo (agora 2×)", calls.length === 2);

  // ── 6. Sender falha → row 'failed' sem relançar ──────────────────────
  const aptFail = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta fail", scheduledStart: withinISO,
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const rFail = await ClinicReminderService.sendForAppointment(A.orgId, aptFail.id, { sender: senderFail });
  check("provider falha → row 'failed'", rFail?.status === "failed");
  check("provider falha → error registrado", rFail?.error?.includes("Provider offline"));

  // Uma failed NÃO conta como dedup — próxima chamada tenta de novo
  const rRetry = await ClinicReminderService.sendForAppointment(A.orgId, aptFail.id, { sender: senderOk });
  check("failed NÃO bloqueia reenvio automático", rRetry?.status === "sent" && rRetry.id !== rFail?.id);

  // ── 7. Sem identifier ────────────────────────────────────────────────
  const noPhone = A.mkContact("Sem Fone", "");
  LgpdService.grantConsent(A.orgId, noPhone, "comunicacoes", { actorId: A.actorId });
  const aptNoPhone = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: noPhone, title: "X", scheduledStart: withinISO,
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  let threwNoPhone: any = null;
  try { await ClinicReminderService.sendForAppointment(A.orgId, aptNoPhone.id, { sender: senderOk }); } catch (e) { threwNoPhone = e; }
  check("paciente sem identifier → erro claro", threwNoPhone?.message?.includes("identificador"));

  // ── 8. Sem canal ativo → null (skip silencioso) ──────────────────────
  const NC = seedOrg("NC", { channelStatus: "disconnected" });
  LgpdService.grantConsent(NC.orgId, NC.patient, "comunicacoes", { actorId: NC.actorId });
  const draNC = ClinicAgendaService.createProfessional(NC.orgId, { name: "Dr. NC" }, NC.actorId);
  const aptNC = ClinicAgendaService.createAppointment(NC.orgId, {
    contactId: NC.patient, title: "X", scheduledStart: withinISO,
    professionalId: draNC.id, durationMinutes: 30,
  }, NC.actorId);
  const rNC = await ClinicReminderService.sendForAppointment(NC.orgId, aptNC.id, { sender: senderOk });
  check("sem canal ativo → devolve null (skip)", rNC === null);

  // ── 9. dispatch(): janela ────────────────────────────────────────────
  // Consulta longe (48h) NÃO deve entrar. Consulta perto (24h) já entrou —
  // rebuild org limpa pra ter cenário controlado.
  const D = seedOrg("D", { hoursBefore: 24 });
  const draD = ClinicAgendaService.createProfessional(D.orgId, { name: "Dr. D" }, D.actorId);
  const patD = D.patient;
  LgpdService.grantConsent(D.orgId, patD, "comunicacoes", { actorId: D.actorId });
  const aptInWindow = ClinicAgendaService.createAppointment(D.orgId, {
    contactId: patD, title: "In window", scheduledStart: new Date(now + 24 * 3600_000).toISOString(),
    professionalId: draD.id, durationMinutes: 30,
  }, D.actorId);
  const aptOutWindow = ClinicAgendaService.createAppointment(D.orgId, {
    contactId: patD, title: "Out window", scheduledStart: new Date(now + 48 * 3600_000).toISOString(),
    professionalId: draD.id, durationMinutes: 30,
  }, D.actorId);

  calls.length = 0;
  const stats1 = await ClinicReminderService.dispatch({ orgId: D.orgId, now: nowDate, sender: senderOk });
  check("dispatch() envia 1 (só o na janela)", stats1.sent === 1);
  check("dispatch() ignora consulta em 48h", ClinicReminderService.list(D.orgId, aptOutWindow.id).length === 0);
  check("dispatch() enviou pro apt na janela", ClinicReminderService.list(D.orgId, aptInWindow.id).length === 1);

  // 2ª rodada de dispatch NÃO duplica (dedup retorna o row existente,
  // então dispatch conta como 'sent' de novo — mas a garantia real é o
  // list count seguir em 1). E o sender NÃO deve ter sido chamado.
  const callsBefore = calls.length;
  await ClinicReminderService.dispatch({ orgId: D.orgId, now: nowDate, sender: senderOk });
  check("dedup: sender NÃO é chamado de novo na 2ª rodada", calls.length === callsBefore);
  check("apt na janela continua com 1 reminder", ClinicReminderService.list(D.orgId, aptInWindow.id).length === 1);

  // ── 10. Config hoursBefore por org ───────────────────────────────────
  const H2 = seedOrg("H2", { hoursBefore: 2 });
  const draH2 = ClinicAgendaService.createProfessional(H2.orgId, { name: "Dr. H2" }, H2.actorId);
  LgpdService.grantConsent(H2.orgId, H2.patient, "comunicacoes", { actorId: H2.actorId });
  const apt2h = ClinicAgendaService.createAppointment(H2.orgId, {
    contactId: H2.patient, title: "2h ahead", scheduledStart: new Date(now + 2 * 3600_000).toISOString(),
    professionalId: draH2.id, durationMinutes: 30,
  }, H2.actorId);
  // Consulta a 24h NÃO deve entrar (a org é 2h)
  const apt24h = ClinicAgendaService.createAppointment(H2.orgId, {
    contactId: H2.patient, title: "24h ahead", scheduledStart: new Date(now + 24 * 3600_000).toISOString(),
    professionalId: draH2.id, durationMinutes: 30,
  }, H2.actorId);
  const statsH2 = await ClinicReminderService.dispatch({ orgId: H2.orgId, now: nowDate, sender: senderOk });
  check("org com hoursBefore=2 respeita janela (envia só a de 2h)", statsH2.sent === 1);
  check("consulta 24h NÃO entra na janela de 2h", ClinicReminderService.list(H2.orgId, apt24h.id).length === 0);

  // ── 11. Isolamento multi-tenant ──────────────────────────────────────
  const B = seedOrg("B");
  const listB = ClinicReminderService.list(B.orgId, apt.id);
  check("org B não vê reminders de A", listB.length === 0);

  // ── 12. Auditoria ────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type LIKE 'CLINIC_REMINDER_%'
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_REMINDER_SENT ≥ 3 (envios OK)", (map.CLINIC_REMINDER_SENT || 0) >= 3, String(map.CLINIC_REMINDER_SENT));
  check("audit CLINIC_REMINDER_FAILED = 1", (map.CLINIC_REMINDER_FAILED || 0) === 1, String(map.CLINIC_REMINDER_FAILED));

  console.log("\n=== Lembrete automático de consulta (ADR-080 Fase M) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
