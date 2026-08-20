/**
 * TEST — Finanças da Agenda Federada (ADR-180 F8.1). DB-backed, det., isolado.
 * Prova o split clínica×profissional DERIVADO (RN-004): preço acordado no agendamento
 * (snapshot), comissão do vínculo, realizado(atendido/fact) × previsto(agendado/estimate),
 * e a HONESTIDADE (sem preço → gross null; sem comissão → split null; nunca inventa).
 *
 * Uso: npm run test:professional-finance
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-proffin-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-proffin-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalFinanceService: FIN } = await import("../src/server/ProfessionalFinanceService.js");
  const { ClinicAgendaService: AG } = await import("../src/server/ClinicAgendaService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const org of [A, B]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clin', 'active', 'petshop', 1)`).run(randomUUID(), org);
  }
  const tutor = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run(tutor, A);

  // Serviço no catálogo com preço R$ 200.
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Cirurgia de ave', 200, 60)`).run(svc, A);
  // Serviço SEM preço (honestidade).
  const svcNoPrice = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Retorno', NULL, 30)`).run(svcNoPrice, A);

  // Profissional + vínculo aceito com comissão 30%.
  const prof = PRO.upsertIdentity({ name: "Dra. Ave", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: prof, permissions: { services: [svc, svcNoPrice], commissionPercent: 30 } }).id;
  REL.accept(A, rel);
  CFG.setOffering(A, rel, { serviceId: svc, durationMin: 60 });
  CFG.setOffering(A, rel, { serviceId: svcNoPrice, durationMin: 30 });
  // Janela seg-sex 09:00-12:00 (dow 1..5).
  CFG.setWindows(A, rel, [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, start: "09:00", end: "12:00", bufferMin: 0 })));

  // Uma segunda-feira futura fixa (2026-08-24 é segunda).
  const NOW = "2026-08-21T08:00:00.000Z";
  const hold = BOOK.holdSlot(A, rel, { serviceId: svc, startISO: "2026-08-24T09:00:00.000Z", nowISO: NOW });
  const appt = BOOK.confirmBooking(A, { holdId: hold.id, contactId: tutor, nowISO: NOW });

  // 1. Split derivado no atendimento AGENDADO (previsto/estimate).
  const s1 = FIN.settlement(A, appt.id);
  check("1.1 gross = preço acordado (200)", s1.gross === 200);
  check("1.2 comissão do vínculo (30%)", s1.commissionPercent === 30);
  check("1.3 parte do profissional = 60", s1.professionalAmount === 60);
  check("1.4 parte da clínica = 140", s1.clinicAmount === 140);
  check("1.5 agendado ≠ atendido → estimate", s1.basis === "estimate" && s1.realized === false);
  check("1.6 nome do serviço resolvido", s1.serviceName === "Cirurgia de ave");

  // 2. Ao ATENDER (completar), vira realizado (fact).
  AG.complete(A, appt.id);
  const s2 = FIN.settlement(A, appt.id);
  check("2.1 atendido → fact", s2.basis === "fact" && s2.realized === true);
  check("2.2 valores preservados após atendimento", s2.gross === 200 && s2.professionalAmount === 60);

  // 3. Snapshot: repreçar o catálogo NÃO muda o já agendado (valor acordado congelado).
  db.prepare(`UPDATE products_services SET price = 999 WHERE id = ?`).run(svc);
  const s3 = FIN.settlement(A, appt.id);
  check("3.1 preço congelado no agendamento (não segue catálogo)", s3.gross === 200);

  // 4. Honestidade: serviço sem preço → gross null, basis unknown (não inventa dinheiro).
  const hold2 = BOOK.holdSlot(A, rel, { serviceId: svcNoPrice, startISO: "2026-08-24T10:00:00.000Z", nowISO: NOW });
  const appt2 = BOOK.confirmBooking(A, { holdId: hold2.id, contactId: tutor, nowISO: NOW });
  const s4 = FIN.settlement(A, appt2.id);
  check("4.1 sem preço → gross null", s4.gross === null);
  check("4.2 sem preço → split null (não inventa)", s4.professionalAmount === null && s4.clinicAmount === null);
  check("4.3 sem preço → basis unknown", s4.basis === "unknown");

  // 5. Extrato do profissional: realizado × previsto separados.
  const st = FIN.statement(A, rel);
  check("5.1 lista os 2 atendimentos", st.events.length === 2);
  check("5.2 realizado = 1 (o atendido)", st.realized.count === 1 && st.realized.gross === 200);
  check("5.3 realizado: profissional 60 / clínica 140", st.realized.professionalAmount === 60 && st.realized.clinicAmount === 140);
  check("5.4 previsto = 1 (o sem preço, ainda agendado)", st.expected.count === 1);
  check("5.5 previsto sem preço → gross null + missingPrice contado", st.expected.gross === null && st.expected.missingPrice === 1);
  check("5.6 comissão do vínculo no cabeçalho", st.commissionPercent === 30);

  // 6. Sem comissão configurada → split null (nunca assume 0 nem 100%).
  const prof2 = PRO.upsertIdentity({ name: "Dr. Sem Comissão", council: "CRMV-SP", registrationNumber: "77777" }, A).id;
  const rel2 = REL.invite(A, { professionalId: prof2, permissions: { services: [svc] } }).id; // sem commissionPercent
  REL.accept(A, rel2);
  CFG.setOffering(A, rel2, { serviceId: svc, durationMin: 60 });
  CFG.setWindows(A, rel2, [{ dayOfWeek: 1, start: "14:00", end: "16:00", bufferMin: 0 }]);
  const hold3 = BOOK.holdSlot(A, rel2, { serviceId: svc, startISO: "2026-08-24T14:00:00.000Z", nowISO: NOW });
  const appt3 = BOOK.confirmBooking(A, { holdId: hold3.id, contactId: tutor, nowISO: NOW });
  const s6 = FIN.settlement(A, appt3.id);
  check("6.1 sem comissão → gross presente (999 agora)", s6.gross === 999);
  check("6.2 sem comissão → split null (não inventa)", s6.professionalAmount === null && s6.commissionPercent === null);

  // 7. Isolamento cross-org (RN-PN-2): B não vê o extrato/acerto de A.
  let iso1 = false; try { FIN.settlement(B, appt.id); } catch { iso1 = true; }
  check("7.1 acerto de A não vaza em B", iso1);
  let iso2 = false; try { FIN.statement(B, rel); } catch { iso2 = true; }
  check("7.2 extrato do vínculo de A não vaza em B", iso2);

  // 8. Cancelado fica fora do dinheiro (não entra no extrato).
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(appt2.id);
  const stAfter = FIN.statement(A, rel);
  check("8.1 cancelado sai do extrato", stAfter.events.every((e: any) => e.appointmentId !== appt2.id));
  check("8.2 extrato só conta confirmed/completed", stAfter.events.every((e: any) => e.status === "confirmed" || e.status === "completed"));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-finance: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
