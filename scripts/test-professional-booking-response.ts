/**
 * TEST — O profissional aceita/recusa o atendimento federado (ADR-180 F7.4). DB-backed,
 * det., isolado. Prova: aceitar marca ACK sem mudar o status; recusar cancela (preserva
 * histórico) e publica sinal pra clínica; só atendimento de vínculo DELE; isolamento.
 *
 * Uso: npm run test:professional-booking-response
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bookresp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-bookresp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalSelfService: SELF } = await import("../src/server/ProfessionalSelfService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'A', 'active', 'petshop', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES ('tA', ?, 'ch', 'Ana', 'ana')`).run(A);
  const pid = PRO.upsertIdentity({ name: "Dra. Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const other = PRO.upsertIdentity({ name: "Outro", council: "CRMV-SP", registrationNumber: "99999" }, A).id;
  const relA = REL.invite(A, { professionalId: pid }).id; REL.accept(A, relA);
  const relO = REL.invite(A, { professionalId: other }).id; REL.accept(A, relO);

  const mkAppt = (rel: string) => { const id = randomUUID(); db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, network_relationship_id) VALUES (?, ?, 'tA', 'Consulta', '2026-08-24T10:00:00.000Z', '2026-08-24T11:00:00.000Z', 'confirmed', ?)`).run(id, A, rel); return id; };
  const ap1 = mkAppt(relA), ap2 = mkAppt(relA), apOther = mkAppt(relO);

  // 1. Aceitar → ACK sem mudar o status.
  const acc = SELF.acceptAppointment(pid, ap1);
  check("1.1 aceitar marca ackAt", !!acc.ackAt);
  check("1.2 status segue confirmed (ACK não muda FSM)", acc.status === "confirmed");
  const acc2 = SELF.acceptAppointment(pid, ap1);
  check("1.3 aceitar é idempotente (mesmo ack)", acc2.ackAt === acc.ackAt);
  check("1.4 agenda expõe o ackAt", (SELF.agenda(pid).appointments.find((a: any) => a.id === ap1) || {}).ackAt === acc.ackAt);

  // 2. Recusar → cancela + sinal pra clínica.
  const dec = await SELF.declineAppointment(pid, ap2, "conflito de agenda");
  check("2.1 recusar cancela (preserva histórico)", dec.status === "cancelled");
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'professional_network/booking_declined'`).get(A) as any;
  check("2.2 publica sinal pra clínica reagir", !!sig && sig.source_entity_id === ap2);
  check("2.3 recusado sai da agenda do profissional", !SELF.agenda(pid).appointments.some((a: any) => a.id === ap2));

  // 3. Isolamento: não aceita/recusa atendimento de OUTRO profissional.
  let e3 = false; try { SELF.acceptAppointment(pid, apOther); } catch (e: any) { e3 = e.message === "appointment_not_found"; }
  check("3.1 não aceita atendimento de outro profissional", e3);
  let e3b = false; try { await SELF.declineAppointment(pid, apOther); } catch (e: any) { e3b = e.message === "appointment_not_found"; }
  check("3.2 não recusa atendimento de outro profissional", e3b);

  // 4. Aceitar um já cancelado é recusado.
  let e4 = false; try { SELF.acceptAppointment(pid, ap2); } catch (e: any) { e4 = e.message === "appointment_not_active"; }
  check("4.1 não confirma presença em atendimento cancelado", e4);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-booking-response: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
