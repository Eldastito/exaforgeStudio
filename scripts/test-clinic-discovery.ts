/**
 * TEST — Clínica descobrível + especialidades procuradas (ADR-180 F10.2). DB-backed, det.
 * Prova: RN-PN-9 (opt-in default OFF → publicProfile null); especialidades procuradas vêm
 * dos demand_gap ALTOS (sem contagem crua — RN-PN-10); a projeção pública só sai quando
 * descobrível e só carrega o tier público; isolado por org.
 *
 * Uso: npm run test:clinic-discovery
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clindisc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-clindisc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ClinicDiscoveryService: DISC } = await import("../src/server/ClinicDiscoveryService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled, address_city, address_state) VALUES (?, ?, 'Clínica Pet A', 'active', 'petshop', 1, 'Porto Alegre', 'RS')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'B', 'active', 'petshop', 1)`).run(randomUUID(), B);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svc, A);
  const pid = PRO.upsertIdentity({ name: "Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: pid, permissions: { services: [svc] } }).id; REL.accept(A, rel);

  // 0. RN-PN-9 — default OFF → publicProfile null.
  check("0.1 default OFF", DISC.settings(A).discoverable === false);
  check("0.2 não descobrível → publicProfile null", DISC.publicProfile(A) === null);

  // 1. Gera demanda ALTA de cardiologia (3 waitlist, 0 atendido). ContactId com marcador
  //    distintivo ("PATMARKER", fora do alfabeto hex do UUID) pra detectar vazamento no §3.
  for (let i = 0; i < 3; i++) BOOK.waitlist(A, { relationshipId: rel, serviceId: svc, contactId: `PATMARKER${i}` });
  check("1.1 especialidade procurada derivada do gap", DISC.soughtSpecialties(A).includes("Cardiologia"));

  // 2. Liga a descoberta → publicProfile sai, só tier público.
  DISC.setDiscoverable(A, true);
  const prof = DISC.publicProfile(A)!;
  check("2.1 descobrível → projeção pública existe", !!prof);
  check("2.2 carrega identidade + região", prof.businessName === "Clínica Pet A" && prof.city === "Porto Alegre" && prof.state === "RS");
  check("2.3 procura reflete o gap", prof.soughtSpecialties.includes("Cardiologia"));

  // 3. RN-PN-10 — a projeção NÃO carrega nada privado (contagem crua / paciente / receita).
  const json = JSON.stringify(prof);
  check("3.1 sem contagem crua de demanda", !/"unmet"|"declined"|"met"/.test(json));
  check("3.2 sem id de contato/paciente", !json.includes("PATMARKER"));

  // 4. Desligar → volta a null (RN-PN-9).
  DISC.setDiscoverable(A, false);
  check("4.1 desligar tira do diretório", DISC.publicProfile(A) === null);

  // 5. Isolamento: B (sem demanda, sem flag) → null + procura vazia.
  check("5.1 org B não descobrível", DISC.publicProfile(B) === null);
  check("5.2 org B sem procura", DISC.soughtSpecialties(B).length === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-discovery: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
