/**
 * TEST — Inteligência de demanda da rede (ADR-180 F9.1). DB-backed, det., isolado.
 * Prova: waitlist (sem vaga) + recusa contam como demanda NÃO atendida por serviço/
 * profissional; atendimentos federados contam como atendida; a pressão é qualitativa;
 * sem sinal → insufficient_data (não inventa); isolado por org.
 *
 * Uso: npm run test:professional-demand
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-demand-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-demand-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalDemandService: DEM } = await import("../src/server/ProfessionalDemandService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'C', 'active', 'petshop', 1)`).run(randomUUID(), org);
  const svcCardio = randomUUID(), svcOrto = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svcCardio, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Ortopedia')`).run(svcOrto, A);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES ('c1', ?, 'ch', 'Ana', 'ana')`).run(A);
  const pid = PRO.upsertIdentity({ name: "Dra. Cardio", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: pid, permissions: { services: [svcCardio] } }).id; REL.accept(A, rel);

  // 0. Sem nada → insufficient_data.
  check("0.1 sem sinal → insufficient_data", DEM.demand(A).summary.insufficientData === true);

  // 1. 3 waitlist de cardiologia (sem vaga) → demanda não atendida.
  for (let i = 0; i < 3; i++) BOOK.waitlist(A, { relationshipId: rel, serviceId: svcCardio, contactId: `c${i}` });
  // 1 recusa: cria um appointment federado com serviço cardio + sinal booking_declined.
  const apDecl = randomUUID();
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, network_relationship_id, network_service_id) VALUES (?, ?, 'c1', 'Atd', '2026-08-24T10:00:00Z', 'cancelled', ?, ?)`).run(apDecl, A, rel, svcCardio);
  SIG.publish(A, { domain: "clinic", signalType: "professional_network/booking_declined", severity: "attention", basis: "fact", confidence: 1, sourceService: "test", sourceEntityType: "appointment", sourceEntityId: apDecl, dedupeKey: `clinic:prof_declined:${apDecl}` } as any);
  // 1 atendimento ATENDIDO de cardio (met).
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, network_relationship_id, network_service_id) VALUES (?, ?, 'c1', 'Atd', ?, 'completed', ?, ?)`).run(randomUUID(), A, new Date().toISOString(), rel, svcCardio);

  const d = DEM.demand(A);
  const cardio = d.byService.find((s) => s.serviceId === svcCardio)!;
  check("1.1 cardio: 3 waitlist contados como unmet", cardio.unmet === 3);
  check("1.2 cardio: 1 recusa contada como declined", cardio.declined === 1);
  check("1.3 cardio: 1 atendido contado como met", cardio.met === 1);
  check("1.4 cardio: pressão high (demanda ≥ atendida)", cardio.pressure === "high");
  check("1.5 summary agrega", d.summary.totalUnmet === 3 && d.summary.totalDeclined === 1 && d.summary.totalMet === 1 && d.summary.insufficientData === false);

  // 2. Por profissional.
  const p = d.byProfessional.find((x) => x.relationshipId === rel)!;
  check("2.1 profissional agrega a demanda dele", p && p.unmet === 3 && p.declined === 1 && p.professionalName === "Dra. Cardio");

  // 3. Serviço só atendido (sem waitlist/recusa) → pressão low.
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, network_relationship_id, network_service_id) VALUES (?, ?, 'c1', 'Orto', ?, 'confirmed', ?, ?)`).run(randomUUID(), A, new Date().toISOString(), rel, svcOrto);
  const orto = DEM.demand(A).byService.find((s) => s.serviceId === svcOrto)!;
  check("3.1 serviço só atendido → pressão low", orto.pressure === "low" && orto.unmet === 0 && orto.met === 1);

  // 4. Ordenação: cardio (demanda 4) antes de orto (demanda 0).
  const ordered = DEM.demand(A).byService;
  check("4.1 ordenado por demanda desc", ordered[0].serviceId === svcCardio);

  // 5. Isolamento: org B não vê a demanda de A.
  check("5.1 org B → insufficient_data", DEM.demand(B).summary.insufficientData === true);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-demand: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
