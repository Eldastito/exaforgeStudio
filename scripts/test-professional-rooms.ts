/**
 * TEST — Recursos (sala) como restrição de disponibilidade (ADR-180 F5.1). DB-backed,
 * det., isolado. Prova: a oferta pode EXIGIR uma sala da clínica; a sala ocupada some das
 * vagas; o agendamento reserva a sala (`room_id`) e RECUSA quando a sala está tomada;
 * sala inexistente é rejeitada (não inventa recurso).
 *
 * Uso: npm run test:professional-rooms
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-profroom-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-profroom-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalAvailabilityService: AV } = await import("../src/server/ProfessionalAvailabilityService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clin', 'active', 'petshop', 1)`).run(randomUUID(), org);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run("tutorA", A);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Cirurgia', 300, 60)`).run(svc, A);
  const room = randomUUID();
  db.prepare(`INSERT INTO clinic_rooms (id, organization_id, name, active, capacity) VALUES (?, ?, 'Sala Cirúrgica', 1, 1)`).run(room, A);

  const pid = PRO.upsertIdentity({ name: "Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: pid, permissions: { services: [svc] } }).id;
  REL.accept(A, rel);
  CFG.setOffering(A, rel, { serviceId: svc, durationMin: 60, requiredRoomId: room });
  CFG.setWindows(A, rel, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }]);
  const NOW = "2026-08-24T08:00:00.000Z";
  const times = (slots: any[]) => slots.map((s) => s.start.slice(11, 16));

  // 1. Oferta carrega a sala exigida.
  const off = CFG.listOfferings(A, rel).find((o) => o.serviceId === svc)!;
  check("1.1 oferta exige a sala", off.requiredRoomId === room && off.requiredRoomName === "Sala Cirúrgica");

  // 2. Sem ocupação → 3 slots. Ocupa a sala 10:00–11:00 (outro atendimento) → 10:00 some.
  check("2.1 sala livre → 3 slots", times(AV.availableSlots(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW })).join(",") === "09:00,10:00,11:00");
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, room_id) VALUES (?, ?, 'tutorA', 'Outro', '2026-08-24T10:00:00.000Z', '2026-08-24T11:00:00.000Z', 'confirmed', ?)`).run(randomUUID(), A, room);
  const slots = AV.availableSlots(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW });
  check("2.2 sala ocupada remove o slot das 10:00", !times(slots).includes("10:00") && times(slots).includes("09:00"));

  // 3. Agendar num horário com a sala livre → reserva a sala (room_id no appointment).
  const h9 = BOOK.holdSlot(A, rel, { serviceId: svc, startISO: "2026-08-24T09:00:00.000Z", nowISO: NOW });
  const ap9 = BOOK.confirmBooking(A, { holdId: h9.id, contactId: "tutorA", nowISO: NOW });
  const rid = (db.prepare(`SELECT room_id FROM appointments WHERE id = ?`).get(ap9.id) as any)?.room_id;
  check("3.1 agendamento reservou a sala", rid === room);

  // 4. Agendar num horário com a sala TOMADA → recusa (room_taken). hold passa (não checa
  //    sala), o commit é que barra.
  const h10 = BOOK.holdSlot(A, rel, { serviceId: svc, startISO: "2026-08-24T10:00:00.000Z", nowISO: NOW });
  let taken = false; try { BOOK.confirmBooking(A, { holdId: h10.id, contactId: "tutorA", nowISO: NOW }); } catch (e: any) { taken = e.message === "room_taken"; }
  check("4.1 sala tomada → confirmBooking recusa (room_taken)", taken);

  // 5. Sala inexistente na oferta → rejeitada (não inventa recurso).
  let bad = false; try { CFG.setOffering(A, rel, { serviceId: svc, requiredRoomId: "sala-fantasma" }); } catch (e: any) { bad = e.message === "room_not_found"; }
  check("5.1 sala inexistente → room_not_found", bad);

  // 6. Limpar a sala exigida (requiredRoomId null) → volta a não exigir.
  CFG.setOffering(A, rel, { serviceId: svc, requiredRoomId: null });
  check("6.1 oferta sem sala após limpar", CFG.listOfferings(A, rel).find((o) => o.serviceId === svc)!.requiredRoomId === null);

  // 7. Isolamento: sala de A não é aceita numa oferta de B.
  const pidB = PRO.upsertIdentity({ name: "VetB", council: "CRMV-SP", registrationNumber: "999" }, B).id;
  const relB = REL.invite(B, { professionalId: pidB, permissions: { services: [] } }).id; REL.accept(B, relB);
  const svcB = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes) VALUES (?, ?, 'service', 'Consulta', 30)`).run(svcB, B);
  let iso = false; try { CFG.setOffering(B, relB, { serviceId: svcB, requiredRoomId: room }); } catch (e: any) { iso = e.message === "room_not_found"; }
  check("7.1 sala de A não vaza pra oferta de B", iso);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-rooms: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
