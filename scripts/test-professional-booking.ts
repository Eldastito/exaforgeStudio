/**
 * TEST — Booking federado + AutoBooking governado (ADR-180 F4). DB-backed, det.
 *
 * Fecha o MVP da Agenda Federada e prova o ANTI-ALUCINAÇÃO: a IA/AutoBooking só agenda
 * sobre vaga PROVADA pelo Availability Engine — nunca inventa (RN-PN-4). Cobre:
 *  - ferramentas de IA (getAvailability/holdSlot/confirmBooking) e o appointment amarrado
 *    ao vínculo da rede (`network_relationship_id`) + snapshot do nome do especialista;
 *  - idempotência durável do confirmBooking (1 appointment por hold);
 *  - recusa de hold inexistente/expirado/de outra org (não fabrica agendamento);
 *  - AutoBooking GOVERNADO: propõe `awaiting_approval` (RN-PN-6), não executa sem aprovar;
 *    aprovado → cria appointment + arma `booking_confirmation` (AGENDADO ≠ ATENDIDO);
 *  - sem vaga → waitlist em `business_signals`, ZERO appointment (não inventa).
 *
 * Uso: npm run test:professional-booking
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-profbook-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-profbook-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PROF } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalAvailabilityService: AV } = await import("../src/server/ProfessionalAvailabilityService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { ConfirmationEngine: CE } = await import("../src/server/ConfirmationEngine.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica B', 'active', 'petshop')`).run(randomUUID(), B);
  const svc = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, duration_minutes, active) VALUES (?, ?, 'service', 'Cirurgia', 60, 1)`).run(svc, A);
  const tutor = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run(tutor, A);
  const pet = (await import("../src/server/ClinicPetService.js")).ClinicPetService.create(A, { tutorContactId: tutor, name: "Louro" }).id;

  const prof = PROF.upsertIdentity({ council: "CRMV-SP", registrationNumber: "8001", name: "Dr. Aves" }, A);
  const rel = REL.invite(A, { professionalId: prof.id }, "userA");
  const DATE = "2026-08-24"; const NOW = "2026-08-20T00:00:00.000Z"; // seg 24/08 = dow 1
  CFG.setOffering(A, rel.id, { serviceId: svc }, "userA");
  CFG.setWindows(A, rel.id, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }], "userA");
  REL.accept(A, rel.id, "userA");

  // 1. Ferramentas de IA — grounding: getAvailability só devolve o que o motor prova.
  const slots = BOOK.getAvailability(A, rel.id, DATE, { serviceId: svc, nowISO: NOW });
  check("1.1 getAvailability devolve as vagas do motor (3)", slots.length === 3 && slots[0].start === `${DATE}T09:00:00.000Z`);
  check("1.2 nenhuma vaga fora da janela (09–12)", slots.every((s) => s.start >= `${DATE}T09:00:00.000Z` && s.end <= `${DATE}T12:00:00.000Z`));

  // 2. hold → confirmBooking cria o agendamento federado.
  const h = BOOK.holdSlot(A, rel.id, { serviceId: svc, startISO: `${DATE}T09:00:00.000Z`, ttlMinutes: 1440, nowISO: NOW }, "userA");
  const appt = BOOK.confirmBooking(A, { holdId: h.id, contactId: tutor, petId: pet, title: "Cirurgia no papagaio" }, "userA");
  check("2.1 confirmBooking cria appointment confirmado", appt.status === "confirmed" && appt.scheduledStart === `${DATE}T09:00:00.000Z`);
  check("2.2 appointment amarrado ao vínculo da rede", appt.networkRelationshipId === rel.id && appt.slotHoldId === h.id);
  check("2.3 snapshot do nome do especialista (não é clinic_professional local)", appt.professionalName === "Dr. Aves");
  check("2.4 carrega o pet (petshop)", appt.petId === pet);
  check("2.5 confirma o hold subjacente", AV.getHold(A, h.id)!.status === "confirmed");
  // a vaga agendada some da disponibilidade
  check("2.6 vaga agendada sai da disponibilidade", BOOK.getAvailability(A, rel.id, DATE, { serviceId: svc, nowISO: NOW }).every((s) => s.start !== `${DATE}T09:00:00.000Z`));

  // 3. Idempotência durável — 2ª confirmação do MESMO hold devolve o MESMO appointment.
  const appt2 = BOOK.confirmBooking(A, { holdId: h.id, contactId: tutor, petId: pet }, "userA");
  check("3.1 confirmBooking idempotente (mesmo appointment)", appt2.id === appt.id);
  const count = db.prepare(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ? AND slot_hold_id = ?`).get(A, h.id) as any;
  check("3.2 nunca 2 appointments para o mesmo hold", count.n === 1);

  // 4. ANTI-ALUCINAÇÃO — nunca fabrica agendamento.
  let t41 = false; try { BOOK.confirmBooking(A, { holdId: "nao-existe", contactId: tutor }, "userA"); } catch (e: any) { t41 = e.message === "hold_not_found"; }
  check("4.1 hold inexistente → hold_not_found (não inventa)", t41);
  const hRel = BOOK.holdSlot(A, rel.id, { serviceId: svc, startISO: `${DATE}T10:00:00.000Z`, nowISO: NOW }, "userA");
  AV.release(A, hRel.id, "userA");
  let t42 = false; try { BOOK.confirmBooking(A, { holdId: hRel.id, contactId: tutor }, "userA"); } catch (e: any) { t42 = e.message === "hold_not_active"; }
  check("4.2 hold liberado → hold_not_active (não agenda)", t42);
  let t43 = false; try { BOOK.confirmBooking(A, { holdId: h.id, contactId: "fantasma" }, "userA"); } catch (e: any) { t43 = e.message === "contact_not_found"; }
  // (h já confirmado/idempotente devolveria o appt; usa um hold novo p/ o contato inválido)
  const hC = BOOK.holdSlot(A, rel.id, { serviceId: svc, startISO: `${DATE}T11:00:00.000Z`, nowISO: NOW }, "userA");
  t43 = false; try { BOOK.confirmBooking(A, { holdId: hC.id, contactId: "fantasma" }, "userA"); } catch (e: any) { t43 = e.message === "contact_not_found"; }
  check("4.3 contato inexistente → contact_not_found (não inventa paciente)", t43);
  AV.release(A, hC.id, "userA");

  // 5. Isolamento cross-org (RN-PN-2).
  let t51 = false; try { BOOK.confirmBooking(B, { holdId: h.id, contactId: tutor }, "userB"); } catch (e: any) { t51 = e.message === "hold_not_found"; }
  check("5.1 org B não confirma hold de A (hold_not_found)", t51);

  // 6. AutoBooking GOVERNADO — propõe, não executa direto (RN-PN-6).
  const action = BOOK.autoBook(A, { relationshipId: rel.id, contactId: tutor, serviceId: svc, petId: pet, fromDate: DATE, days: 3, nowISO: NOW, title: "AutoBooking cirurgia" }, "userA");
  check("6.1 autoBook nasce awaiting_approval (não agenda direto)", action.status === "awaiting_approval" && action.command_type === "auto_booking");
  // executar sem aprovar → recusado
  let t62 = false; try { await BOOK.executeAutoBooking(A, action.id); } catch (e: any) { t62 = /não aprovada|not_approved|aprovada/i.test(e.message); }
  check("6.2 executar ação não aprovada → recusado", t62);
  const beforeCount = (db.prepare(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ?`).get(A) as any).n;
  // aprovar (RBAC é da rota; o service exige identidade) e executar
  DA.approve(A, action.id, "userA");
  const exec = await BOOK.executeAutoBooking(A, action.id);
  check("6.3 aprovado → executa e cria agendamento", exec.ok === true && exec.result?.effect === "booking_created");
  const afterCount = (db.prepare(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ?`).get(A) as any).n;
  check("6.4 +1 appointment federado criado", afterCount === beforeCount + 1);
  // 6.5 AGENDADO ≠ ATENDIDO: armou booking_confirmation pendente com SLA
  const conf = CE.getForAction(A, action.id);
  check("6.5 armou booking_confirmation pendente (AGENDADO ≠ ATENDIDO)", !!conf && conf.confirmation_method === "booking_confirmation" && conf.status === "pending");
  check("6.6 a vaga escolhida foi a 1ª livre (10:00, já que 09:00 estava agendada)", exec.result?.externalRef && (db.prepare(`SELECT scheduled_start s FROM appointments WHERE id = ?`).get(exec.result.externalRef) as any).s === `${DATE}T10:00:00.000Z`);

  // 7. AutoBooking SEM vaga → waitlist, ZERO appointment (não inventa).
  const prof2 = PROF.upsertIdentity({ council: "CRMV-SP", registrationNumber: "8002", name: "Dr. Sem Janela" }, A);
  const rel2 = REL.invite(A, { professionalId: prof2.id }, "userA"); REL.accept(A, rel2.id, "userA");
  CFG.setOffering(A, rel2.id, { serviceId: svc }, "userA"); // serviço ofertado, MAS sem janelas
  const action2 = BOOK.autoBook(A, { relationshipId: rel2.id, contactId: tutor, serviceId: svc, fromDate: DATE, days: 5, nowISO: NOW }, "userA");
  DA.approve(A, action2.id, "userA");
  const before2 = (db.prepare(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ?`).get(A) as any).n;
  let t71 = false; try { await BOOK.executeAutoBooking(A, action2.id); } catch (e: any) { t71 = /no_slot_available|Falha ao executar/i.test(e.message); }
  check("7.1 sem vaga → execução falha honesta (não fabrica)", t71);
  const after2 = (db.prepare(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ?`).get(A) as any).n;
  check("7.2 ZERO appointment criado sem vaga", after2 === before2);
  const wl = db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'professional_network/waitlist'`).get(A) as any;
  check("7.3 publicou waitlist em business_signals (demanda registrada)", wl.n >= 1);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-booking: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
