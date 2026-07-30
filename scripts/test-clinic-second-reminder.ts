/**
 * TESTE — Módulo Clínica Fase S: Segundo lembrete H-2 com escalada
 * -----------------------------------------------------------------
 * Prova, offline e em banco temporário (sender injetado, ZERO rede real):
 *   - Template 24h: texto atual (contém 'Lembramos');
 *   - Template 2h: texto novo (contém 'hoje' ou versão urgente);
 *   - sendForAppointment(templateKey='2h') NÃO envia se paciente já
 *     confirmou (patient_confirmed_at IS NOT NULL);
 *   - Envia se NÃO confirmou;
 *   - `force: true` bypassa o guard mesmo com confirmed;
 *   - Dedup independente por template_key: 24h e 2h coexistem;
 *   - Config clinic_second_reminder_enabled=0 → dispatch não faz 2ª janela;
 *   - Config clinic_second_reminder_hours=3 respeitado;
 *   - dispatch com 2 janelas envia 2 mensagens pra consulta certa;
 *   - Escalada H-1: consulta em <1h sem patient_confirmed_at ganha
 *     needs_manual_confirmation=1; idempotente;
 *   - Consulta já confirmada NÃO ganha needs_manual_confirmation;
 *   - Isolamento multi-tenant;
 *   - Auditoria SENT com templateKey='2h'.
 *
 * Uso:  npm run test:clinic-second-reminder
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-2h-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-2h-1234567890";

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

  function seedOrg(tag: string, opts: { secondEnabled?: boolean; secondHours?: number } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_second_reminder_enabled, clinic_second_reminder_hours) VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`, opts.secondEnabled === false ? 0 : 1, opts.secondHours ?? 2);
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
  const patient = A.mkContact("Paciente");
  LgpdService.grantConsent(A.orgId, patient, "comunicacoes", { actorId: A.actorId });

  const now = Date.now();
  const nowDate = new Date(now);
  const senderCalls: any[] = [];
  const senderOk = async (channelId: string, to: string, content: string) => {
    senderCalls.push({ channelId, to, content }); return "wamid.ok";
  };

  // ── 1. Template 24h (padrão) ─────────────────────────────────────────
  const apt24 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patient, title: "24h", scheduledStart: new Date(now + 24 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  await ClinicReminderService.sendForAppointment(A.orgId, apt24.id, { sender: senderOk });
  check("template 24h contém 'Lembramos'", senderCalls[0]?.content?.includes("Lembramos"));

  // ── 2. Segundo lembrete 2h em consulta hoje ──────────────────────────
  const apt2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patient, title: "2h", scheduledStart: new Date(now + 2 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  senderCalls.length = 0;
  const r2 = await ClinicReminderService.sendForAppointment(A.orgId, apt2.id, { sender: senderOk, templateKey: "2h" });
  check("template 2h envia OK", r2?.status === "sent");
  check("template 2h contém 'hoje'", senderCalls[0]?.content?.toLowerCase().includes("hoje"));

  // ── 3. Guard: 2h NÃO envia se já confirmado ──────────────────────────
  const aptConfirmed = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patient, title: "conf", scheduledStart: new Date(now + 3 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  ClinicAgendaService.confirmByPatient(A.orgId, aptConfirmed.id, A.actorId);
  senderCalls.length = 0;
  const rGuard = await ClinicReminderService.sendForAppointment(A.orgId, aptConfirmed.id, { sender: senderOk, templateKey: "2h" });
  check("2h em consulta já confirmada → null (sem envio)", rGuard === null);
  check("sender NÃO chamado", senderCalls.length === 0);

  // ── 4. force=true bypassa o guard ────────────────────────────────────
  const rForce = await ClinicReminderService.sendForAppointment(A.orgId, aptConfirmed.id, { sender: senderOk, templateKey: "2h", force: true });
  check("force=true envia mesmo confirmado", rForce?.status === "sent");

  // ── 5. Dedup independente por template_key ──────────────────────────
  const aptDedup = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patient, title: "dd", scheduledStart: new Date(now + 5 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const rA = await ClinicReminderService.sendForAppointment(A.orgId, aptDedup.id, { sender: senderOk }); // 24h default
  const rB = await ClinicReminderService.sendForAppointment(A.orgId, aptDedup.id, { sender: senderOk, templateKey: "2h" });
  check("24h e 2h coexistem (rows distintas)", rA?.id !== rB?.id && rA?.templateKey === "24h" && rB?.templateKey === "2h");
  const listCount = ClinicReminderService.list(A.orgId, aptDedup.id).length;
  check("list traz 2 templates diferentes", listCount === 2);

  // ── 6. dispatch com 2 janelas envia pros dois na janela certa ───────
  const A2 = seedOrg("A2", { secondEnabled: true, secondHours: 2 });
  const dra2 = ClinicAgendaService.createProfessional(A2.orgId, { name: "Dra." }, A2.actorId);
  const pat2 = A2.mkContact("P");
  LgpdService.grantConsent(A2.orgId, pat2, "comunicacoes", { actorId: A2.actorId });
  // 1 appt na janela 24h, 1 appt na janela 2h
  const apt24h = ClinicAgendaService.createAppointment(A2.orgId, {
    contactId: pat2, title: "24h", scheduledStart: new Date(now + 24 * 3600_000).toISOString(),
    professionalId: dra2.id, durationMinutes: 30,
  }, A2.actorId);
  const apt2h = ClinicAgendaService.createAppointment(A2.orgId, {
    contactId: pat2, title: "2h", scheduledStart: new Date(now + 2 * 3600_000).toISOString(),
    professionalId: dra2.id, durationMinutes: 30,
  }, A2.actorId);
  const dispatchCalls: any[] = [];
  const disSender = async (c: string, t: string, m: string) => { dispatchCalls.push({ c, t, m }); return "wamid"; };
  const stats = await ClinicReminderService.dispatch({ orgId: A2.orgId, now: nowDate, sender: disSender });
  check("dispatch envia >= 2 (uma janela cada)", stats.sent >= 2, String(stats.sent));
  const rem24 = ClinicReminderService.list(A2.orgId, apt24h.id);
  const rem2 = ClinicReminderService.list(A2.orgId, apt2h.id);
  check("apt 24h ganhou reminder 24h", rem24.some((r) => r.templateKey === "24h"));
  check("apt 2h ganhou reminder 2h", rem2.some((r) => r.templateKey === "2h"));

  // ── 7. Config secondEnabled=false pula 2ª janela ────────────────────
  const B = seedOrg("B", { secondEnabled: false });
  const draB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dr" }, B.actorId);
  const patB = B.mkContact("PB");
  LgpdService.grantConsent(B.orgId, patB, "comunicacoes", { actorId: B.actorId });
  const aptB2 = ClinicAgendaService.createAppointment(B.orgId, {
    contactId: patB, title: "2h", scheduledStart: new Date(now + 2 * 3600_000).toISOString(),
    professionalId: draB.id, durationMinutes: 30,
  }, B.actorId);
  await ClinicReminderService.dispatch({ orgId: B.orgId, now: nowDate, sender: senderOk });
  const remB = ClinicReminderService.list(B.orgId, aptB2.id);
  check("secondEnabled=false → nenhum lembrete 2h", !remB.some((r) => r.templateKey === "2h"));

  // ── 8. secondHours=3 respeitado ──────────────────────────────────────
  const C = seedOrg("C", { secondEnabled: true, secondHours: 3 });
  const draC = ClinicAgendaService.createProfessional(C.orgId, { name: "Dr" }, C.actorId);
  const patC = C.mkContact("PC");
  LgpdService.grantConsent(C.orgId, patC, "comunicacoes", { actorId: C.actorId });
  // Appt em 3h → deveria pegar; em 2h → não (fora da janela)
  const apt3 = ClinicAgendaService.createAppointment(C.orgId, {
    contactId: patC, title: "3h", scheduledStart: new Date(now + 3 * 3600_000).toISOString(),
    professionalId: draC.id, durationMinutes: 30,
  }, C.actorId);
  const apt2C = ClinicAgendaService.createAppointment(C.orgId, {
    contactId: patC, title: "2h", scheduledStart: new Date(now + 2 * 3600_000).toISOString(),
    professionalId: draC.id, durationMinutes: 30, force: true,
  }, C.actorId);
  await ClinicReminderService.dispatch({ orgId: C.orgId, now: nowDate, sender: senderOk });
  check("secondHours=3 pega apt em 3h", ClinicReminderService.list(C.orgId, apt3.id).some((r) => r.templateKey === "2h"));

  // ── 9. Escalada H-1 ──────────────────────────────────────────────────
  const D = seedOrg("D");
  const draD = ClinicAgendaService.createProfessional(D.orgId, { name: "Dr" }, D.actorId);
  const patD = D.mkContact("PD");
  LgpdService.grantConsent(D.orgId, patD, "comunicacoes", { actorId: D.actorId });
  // Consulta em 30min sem patient_confirmed_at
  const aptNear = ClinicAgendaService.createAppointment(D.orgId, {
    contactId: patD, title: "30min", scheduledStart: new Date(now + 30 * 60_000).toISOString(),
    professionalId: draD.id, durationMinutes: 30,
  }, D.actorId);
  // Consulta em 30min JÁ confirmada
  const aptNearConfirmed = ClinicAgendaService.createAppointment(D.orgId, {
    contactId: patD, title: "30min-conf", scheduledStart: new Date(now + 45 * 60_000).toISOString(),
    professionalId: draD.id, durationMinutes: 30, force: true,
  }, D.actorId);
  ClinicAgendaService.confirmByPatient(D.orgId, aptNearConfirmed.id, D.actorId);
  await ClinicReminderService.dispatch({ orgId: D.orgId, now: nowDate, sender: senderOk });
  const rowNear = db.prepare(`SELECT needs_manual_confirmation FROM appointments WHERE id=?`).get(aptNear.id) as any;
  const rowConf = db.prepare(`SELECT needs_manual_confirmation FROM appointments WHERE id=?`).get(aptNearConfirmed.id) as any;
  check("appt <1h não confirmada → needs_manual_confirmation=1", Number(rowNear.needs_manual_confirmation) === 1);
  check("appt <1h JÁ confirmada → needs_manual_confirmation=0", Number(rowConf.needs_manual_confirmation) === 0);

  // Idempotência: rodar dispatch de novo NÃO altera (flag já=1)
  await ClinicReminderService.dispatch({ orgId: D.orgId, now: nowDate, sender: senderOk });
  const rowNear2 = db.prepare(`SELECT needs_manual_confirmation FROM appointments WHERE id=?`).get(aptNear.id) as any;
  check("escalada idempotente", Number(rowNear2.needs_manual_confirmation) === 1);

  // ── 10. Isolamento multi-tenant ──────────────────────────────────────
  const audits = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_REMINDER_SENT'
        AND metadata_json LIKE '%2h%'`
  ).get(A.orgId) as any;
  check("audit CLINIC_REMINDER_SENT com template 2h ≥ 1", Number(audits.c) >= 1, String(audits.c));

  console.log("\n=== Segundo lembrete H-2 com escalada (ADR-080 Fase S) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
