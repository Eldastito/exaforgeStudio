/**
 * TEST — ADR-160 F6 (Onda A): porta I/O, 2ª fatia — EVENT vira agendamento CANÔNICO.
 *
 * Prova, determinístico (semeia o inbox pendente + um contato real direto no DB):
 *   - flag OFF (default): confirm(EVENT) materializa SÓ o silo falatu_events, sem
 *     appointment, bridged_appointment_id NULL (0 regressão);
 *   - flag ON + contato REAL + data + hora: cria o agendamento CANÔNICO via
 *     AppointmentService (contact_id certo, título fiel, scheduled_start com offset
 *     -03:00, scheduled_end calculado) + grava o vínculo silo→canônico + retorna
 *     bridgedAppointmentId; SÓ o registro (sem e-mail/Calendar — efeito de borda);
 *   - NUNCA inventa (RN-151): ON sem hora → silo-only; ON sem contato → silo-only;
 *     ON com contato de OUTRA org → silo-only;
 *   - AppointmentService.create valida contato (throw p/ inexistente/foreign) e
 *     calcula o fim pela duração do slot — a mesma porta que a rota usa;
 *   - isolamento multi-tenant; toggles bridgeState/setEventBridge.
 *
 * Uso: npm run test:falatu-porta-events
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-porta-ev-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-porta-ev-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService: FT } = await import("../src/server/FalaTuService.js");
  const { AppointmentService: APS } = await import("../src/server/AppointmentService.js");

  const mkOrg = (events: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_bridge_events_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, events ? 1 : 0);
    return id;
  };
  const mkContact = (orgId: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', ?, ?)`).run(id, orgId, name, `id_${id.slice(0, 6)}`);
    return id;
  };
  const seedInbox = (orgId: string, userId: string, intent: string, content: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, summary, intent, entities_json, confidence, status) VALUES (?, ?, ?, 'webapp', ?, ?, ?, '{}', 0.9, 'pending')`)
      .run(id, orgId, userId, content, content, intent);
    return id;
  };
  const appts = (orgId: string) => db.prepare(`SELECT * FROM appointments WHERE organization_id = ?`).all(orgId) as any[];
  const siloEvent = (refId: string) => db.prepare(`SELECT * FROM falatu_events WHERE id = ?`).get(refId) as any;

  // ===== 1. Flag OFF (default) → só silo, sem agendamento =====
  const orgOff = mkOrg(false);
  const cOff = mkContact(orgOff, "Dra. Ana");
  check("toggle: isEventBridgeEnabled false por padrão", FT.isEventBridgeEnabled(orgOff) === false);
  const inOff = seedInbox(orgOff, "u1", "EVENT", "consulta com a Dra. Ana");
  const rOff = FT.confirm(orgOff, "u1", inOff, { eventDate: "2026-09-01", eventTime: "14:00", contactId: cOff });
  check("OFF: confirmou como event (silo)", rOff.kind === "event" && !!rOff.refId);
  check("OFF: NÃO criou agendamento canônico", appts(orgOff).length === 0);
  check("OFF: bridged_appointment_id NULL no silo", siloEvent(rOff.refId!)?.bridged_appointment_id == null);
  check("OFF: retorno sem bridgedAppointmentId", rOff.bridgedAppointmentId == null);

  // ===== 2. Flag ON + contato + data + hora → cria canônico + vínculo =====
  const orgOn = mkOrg(true);
  const cOn = mkContact(orgOn, "Dr. Bruno");
  check("toggle: isEventBridgeEnabled true com flag", FT.isEventBridgeEnabled(orgOn) === true);
  const inOn = seedInbox(orgOn, "u1", "EVENT", "retorno com o Dr. Bruno");
  const rOn = FT.confirm(orgOn, "u1", inOn, { eventDate: "2026-09-10", eventTime: "09:30", contactId: cOn });
  const a = appts(orgOn);
  check("ON: criou exatamente 1 agendamento canônico", a.length === 1);
  check("ON: appointment com contact_id + título fiel", a[0]?.contact_id === cOn && a[0]?.title === "retorno com o Dr. Bruno");
  check("ON: scheduled_start com offset -03:00 (Brasília, não inventa fuso)", a[0]?.scheduled_start === "2026-09-10T09:30:00-03:00");
  check("ON: scheduled_end calculado (duração do slot)", !!a[0]?.scheduled_end);
  check("ON: retorno traz bridgedAppointmentId == id do appointment", rOn.bridgedAppointmentId === a[0]?.id);
  check("ON: vínculo silo→canônico gravado (bridged_appointment_id)", siloEvent(rOn.refId!)?.bridged_appointment_id === a[0]?.id);
  check("ON: silo falatu_events preservado (dual-write)", !!siloEvent(rOn.refId!));

  // ===== 3. RN-151: nunca inventa — falta hora / falta contato / contato foreign =====
  const inNoTime = seedInbox(orgOn, "u1", "EVENT", "reunião sem hora");
  const rNoTime = FT.confirm(orgOn, "u1", inNoTime, { eventDate: "2026-09-11", contactId: cOn });
  check("ON+sem hora: silo-only (agendamento sem início não faz sentido)", rNoTime.bridgedAppointmentId == null && appts(orgOn).length === 1);

  const inNoContact = seedInbox(orgOn, "u1", "EVENT", "evento sem contato");
  const rNoContact = FT.confirm(orgOn, "u1", inNoContact, { eventDate: "2026-09-12", eventTime: "10:00" });
  check("ON+sem contato: silo-only (contact_id é NOT NULL, nunca inventa)", rNoContact.bridgedAppointmentId == null && appts(orgOn).length === 1);

  const foreign = mkContact(mkOrg(true), "Contato de outra org");
  const inForeign = seedInbox(orgOn, "u1", "EVENT", "evento com contato de outra org");
  const rForeign = FT.confirm(orgOn, "u1", inForeign, { eventDate: "2026-09-13", eventTime: "11:00", contactId: foreign });
  check("ON+contato foreign: silo-only (contato não é desta org)", rForeign.bridgedAppointmentId == null && appts(orgOn).length === 1);

  // ===== 4. AppointmentService.create — porta canônica (validação + fim) =====
  const cDirect = mkContact(orgOn, "Contato direto");
  const direct = APS.create(orgOn, { contactId: cDirect, title: "manual", scheduledStart: "2026-09-20T15:00:00-03:00" }, "u1");
  check("APS.create: cria record + calcula scheduled_end", !!direct?.id && !!direct?.scheduled_end);
  let threwMissing = false;
  try { APS.create(orgOn, { contactId: "nao-existe", title: "x", scheduledStart: "2026-09-20T15:00:00-03:00" }, "u1"); } catch { threwMissing = true; }
  check("APS.create: throw p/ contato inexistente (contact_id NOT NULL honesto)", threwMissing);
  let threwNoTitle = false;
  try { APS.create(orgOn, { contactId: cDirect, title: "  ", scheduledStart: "2026-09-20T15:00:00-03:00" }, "u1"); } catch { threwNoTitle = true; }
  check("APS.create: throw p/ título vazio", threwNoTitle);

  // ===== 5. Bridges independentes: evento não cria tarefa =====
  check("ON: nenhum registro em tasks (event bridge não toca tasks)", (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE organization_id = ?`).get(orgOn) as any).n === 0);

  // ===== 6. Isolamento multi-tenant =====
  const orgA = mkOrg(true), orgB = mkOrg(true);
  const cA = mkContact(orgA, "A");
  const inA = seedInbox(orgA, "ua", "EVENT", "evento A");
  FT.confirm(orgA, "ua", inA, { eventDate: "2026-09-14", eventTime: "08:00", contactId: cA });
  check("isolamento: appointment de A não aparece em B", appts(orgB).length === 0 && appts(orgA).length === 1);

  // ===== 7. Toggles =====
  const orgTgl = mkOrg(false);
  check("setEventBridge(true) liga", FT.setEventBridge(orgTgl, true).events === true && FT.isEventBridgeEnabled(orgTgl) === true);
  check("bridgeState reporta tasks+events", (() => { const s = FT.bridgeState(orgTgl); return typeof s.tasks === "boolean" && s.events === true; })());
  check("setEventBridge(false) desliga", FT.setEventBridge(orgTgl, false).events === false);

  console.log("\n=== TEST: Fala Tu porta I/O — bridge de eventos (ADR-160 F6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu porta I/O — eventos (F6) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
