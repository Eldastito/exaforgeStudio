/**
 * TEST — Disponibilidade + agendamento federado (ADR-191 OAB-F3). DB-backed, det.
 * Prova a COMPOSIÇÃO sobre a ADR-180: exige federação; vagas ATERRADAS (nunca inventa);
 * hold atômico; confirmar cria o agendamento federado (network_relationship_id) AMARRADO
 * ao PROCESSO (legal_case_id) com cliente derivado do processo; idempotência.
 *
 * Uso: npm run test:legal-professional-booking
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalbook-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalbook-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalProfessionalBookingService: BOOK } = await import("../src/server/LegalProfessionalBookingService.js");
  const { LegalProfessionalScheduleService: SCHED } = await import("../src/server/LegalProfessionalScheduleService.js");
  const { LegalProfessionalFederationService: FED } = await import("../src/server/LegalProfessionalFederationService.js");
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia', 1)`).run(randomUUID(), A);
  const oab = String(300000 + Math.floor(Math.random() * 600000));
  const lawyer = P.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber: oab }, "u1");
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const proc = C.open(A, { contactId: clientId, title: "Ação X", responsibleLawyerId: lawyer.id }, "u1");

  const DATE = "2027-06-14";                                   // data futura fixa
  const dow = new Date(`${DATE}T00:00:00Z`).getUTCDay();
  const NOW = `${DATE}T00:00:00.000Z`;                          // relógio injetado (antes das janelas)

  // ── 1. Sem federação → não há disponibilidade ──
  let e1 = false; try { await BOOK.availability(A, lawyer.id, DATE, { slotMinutes: 60, nowISO: NOW } as any); } catch { e1 = true; }
  check("1.1 advogado não federado → disponibilidade rejeitada", e1);

  // federa + configura janela pro dia
  FED.federate(A, lawyer.id, "u1");
  SCHED.setWindows(A, lawyer.id, [{ dayOfWeek: dow, start: "09:00", end: "12:00", bufferMin: 0 }], "u1");

  // ── 2. Vagas aterradas (nunca inventa — RN-PN-4) ──
  const slots = await BOOK.availability(A, lawyer.id, DATE, { slotMinutes: 60, nowISO: NOW } as any);
  check("2.1 janela gera vagas provadas", Array.isArray(slots) && slots.length > 0 && slots[0].start.startsWith(DATE));
  // dia sem janela → zero vagas
  const emptyDay = new Date(`${DATE}T00:00:00Z`); emptyDay.setUTCDate(emptyDay.getUTCDate() + 1);
  const otherDate = emptyDay.toISOString().slice(0, 10);
  const slots2 = await BOOK.availability(A, lawyer.id, otherDate, { slotMinutes: 60, nowISO: NOW } as any);
  check("2.2 dia sem janela → zero vagas (não inventa)", slots2.length === 0);

  // ── 3. Hold atômico + confirmar cria agendamento federado amarrado ao processo ──
  const hold = BOOK.hold(A, lawyer.id, { startISO: slots[0].start, slotMinutes: 60, nowISO: NOW } as any, "u1");
  check("3.1 hold criado", !!hold?.id && hold.status === "active");
  const appt = BOOK.confirm(A, { holdId: hold.id, caseId: proc.id, nowISO: NOW } as any, "u1");
  check("3.2 agendamento federado (network_relationship_id) criado", !!appt?.id && !!appt.networkRelationshipId);
  check("3.3 amarrado ao PROCESSO + cliente derivado do processo", appt.legal_case_id === proc.id && appt.contactId === clientId);
  const row = db.prepare(`SELECT professional_name_snapshot, network_relationship_id, legal_case_id FROM appointments WHERE organization_id = ? AND id = ?`).get(A, appt.id) as any;
  check("3.4 persistido: snapshot do advogado + vínculo + processo", row?.professional_name_snapshot === "Dra. Ana" && !!row.network_relationship_id && row.legal_case_id === proc.id);

  // ── 4. Idempotência: confirmar o mesmo hold devolve o mesmo appointment ──
  const appt2 = BOOK.confirm(A, { holdId: hold.id, caseId: proc.id, nowISO: NOW } as any, "u1");
  check("4.1 re-confirmar mesmo hold → mesmo appointment (idempotente)", appt2.id === appt.id);

  // ── 5. A vaga tomada some da disponibilidade (aterrado, não oferece em cima) ──
  const after = await BOOK.availability(A, lawyer.id, DATE, { slotMinutes: 60, nowISO: NOW } as any);
  check("5.1 vaga confirmada não é mais oferecida", !after.some((s: any) => s.start === slots[0].start));

  // ── 6. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Outro', 'active', 'advocacia', 1)`).run(randomUUID(), B);
  const lawyerB = P.createLawyer(B, { name: "Dra. Ana", oabUf: "SP", oabNumber: oab }, "u2");
  FED.federate(B, lawyerB.id, "u2");
  const slotsB = await BOOK.availability(B, lawyerB.id, DATE, { slotMinutes: 60, nowISO: NOW } as any);
  check("6.1 org B sem janelas próprias → sem vagas (config isolada)", slotsB.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-professional-booking: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
