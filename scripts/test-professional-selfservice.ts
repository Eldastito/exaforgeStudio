/**
 * TEST — Auth passwordless + leitura por-profissional (ADR-180 F7.1). DB-backed, det.,
 * isolado. Prova: magic-link → sessão escopada (sem organizationId, nunca users); a leitura
 * agrega a agenda federada + o financeiro do profissional ACROSS clínicas; token revogado
 * não vira sessão; sessão inválida/staff-like é recusada.
 *
 * Uso: npm run test:professional-selfservice
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-selfsvc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-selfsvc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalAvailabilityService: AV } = await import("../src/server/ProfessionalAvailabilityService.js");
  const { ProfessionalAuthService: AUTH } = await import("../src/server/ProfessionalAuthService.js");
  const { ProfessionalSelfService: SELF } = await import("../src/server/ProfessionalSelfService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clínica Pet A', 'active', 'petshop', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Hospital Vet B', 'active', 'petshop', 1)`).run(randomUUID(), B);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES ('tA', ?, 'ch', 'Ana', 'ana')`).run(A);
  const svcA = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Consulta', 200, 60)`).run(svcA, A);

  // MESMO profissional em DUAS clínicas (identidade global).
  const pid = PRO.upsertIdentity({ name: "Dra. Vet", council: "CRMV-SP", registrationNumber: "12345", email: "vet@ex.com" }, A).id;
  const relA = REL.invite(A, { professionalId: pid, permissions: { services: [svcA], commissionPercent: 70 } }).id; REL.accept(A, relA);
  const relB = REL.invite(B, { professionalId: pid, permissions: { services: [] } }).id; REL.accept(B, relB);
  CFG.setOffering(A, relA, { serviceId: svcA, durationMin: 60 });
  CFG.setWindows(A, relA, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }]);

  // Um atendimento federado em A (09:00, atendido) e outro previsto em B (direto).
  const NOW = "2026-08-24T08:00:00.000Z";
  const hold = AV.hold(A, relA, { serviceId: svcA, startISO: "2026-08-24T09:00:00.000Z", nowISO: NOW });
  const appt = BOOK.confirmBooking(A, { holdId: hold.id, contactId: "tA", nowISO: NOW });
  db.prepare(`UPDATE appointments SET status = 'completed' WHERE id = ?`).run(appt.id); // atendido → realizado
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, network_relationship_id) VALUES (?, ?, 'tA', 'Cirurgia', '2026-08-25T10:00:00.000Z', '2026-08-25T11:00:00.000Z', 'confirmed', ?)`).run(randomUUID(), B, relB);

  // 1. Magic-link → sessão escopada.
  const { token } = AUTH.generateToken(pid, { issuerOrgId: A });
  const { session, professional } = AUTH.startSession(token);
  check("1.1 sessão emitida + identidade", !!session && professional.id === pid && professional.council === "CRMV-SP");
  const claims: any = jwt.verify(session, process.env.JWT_SECRET);
  check("1.2 JWT tem professionalId + escopo", claims.professionalId === pid && claims.scope === "professional_portal");
  check("1.3 JWT NÃO carrega organizationId (não é sessão de staff)", claims.organizationId === undefined);
  check("1.4 verifySession devolve o professionalId", AUTH.verifySession(session)?.professionalId === pid);

  // 2. Sessão de staff (com organizationId) é recusada.
  const staffish = jwt.sign({ professionalId: pid, scope: "professional_portal", organizationId: A }, process.env.JWT_SECRET!);
  check("2.1 token com organizationId recusado", AUTH.verifySession(staffish) === null);
  check("2.2 escopo errado recusado", AUTH.verifySession(jwt.sign({ professionalId: pid, scope: "other" }, process.env.JWT_SECRET!)) === null);
  check("2.3 lixo recusado", AUTH.verifySession("nope") === null);

  // 3. Overview: identidade + as 2 clínicas.
  const ov = SELF.overview(pid);
  check("3.1 overview lista as 2 clínicas aceitas", ov.clinics.length === 2);
  check("3.2 clínicas trazem o nome do negócio", ov.clinics.some((c: any) => c.clinicName === "Clínica Pet A") && ov.clinics.some((c: any) => c.clinicName === "Hospital Vet B"));

  // 4. Agenda federada cross-clínica.
  const ag = SELF.agenda(pid, { fromISO: "2026-08-01", toISO: "2026-09-01" });
  check("4.1 agenda junta atendimentos das 2 clínicas", ag.appointments.length === 2);
  check("4.2 cada atendimento tem a clínica", ag.appointments.every((a: any) => a.clinicName));
  check("4.3 ordenada por data asc", ag.appointments[0].start < ag.appointments[1].start);

  // 5. Financeiro agregado.
  const fin = SELF.finance(pid);
  check("5.1 financeiro por clínica (2)", fin.byClinic.length === 2);
  // A: 1 atendido (realizado), R$200 × 70% = 140 pro profissional.
  const cA = fin.byClinic.find((c: any) => c.clinicName === "Clínica Pet A");
  check("5.2 realizado em A reflete o split (prof=140)", cA.realized.count === 1 && cA.realized.professionalAmount === 140);
  check("5.3 total realizado agregado", fin.totals.realized.count === 1 && fin.totals.realized.professionalAmount === 140);

  // 6. Revogar o token → não vira mais sessão.
  AUTH.revoke(pid);
  let e6 = false; try { AUTH.startSession(token); } catch (e: any) { e6 = e.message === "token_invalid_or_expired"; }
  check("6.1 token revogado não abre sessão", e6);
  check("6.2 status reflete revogação", AUTH.status(pid).active === false);

  // 7. Isolamento: outro profissional não vê nada disto.
  const pid2 = PRO.upsertIdentity({ name: "Outro", council: "CRMV-SP", registrationNumber: "99999" }, A).id;
  check("7.1 outro profissional tem 0 clínicas", SELF.clinics(pid2).length === 0);
  check("7.2 outro profissional tem agenda vazia", SELF.agenda(pid2).appointments.length === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-selfservice: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
