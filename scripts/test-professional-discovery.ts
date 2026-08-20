/**
 * TEST — Descoberta bidirecional (ADR-180 F10.3). DB-backed, det., SEM rede (match usa
 * coords/estado existentes). Prova: clínica acha especialista descobrível que casa
 * especialidade+região; profissional acha clínica descobrível que procura sua especialidade;
 * exclui quem já tem vínculo; só aparece quem optou (RN-PN-9); região filtra; projeção sem
 * dado privado (RN-PN-10).
 *
 * Uso: npm run test:professional-discovery
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-discovery-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-discovery-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ClinicDiscoveryService: CDISC } = await import("../src/server/ClinicDiscoveryService.js");
  const { ProfessionalDiscoveryService: DISC } = await import("../src/server/ProfessionalDiscoveryService.js");

  // Clínica A em RS procurando Cardiologia; clínica C em SP (fora de região).
  const A = `org_${randomUUID().slice(0, 8)}`, C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled, network_discoverable, address_city, address_state) VALUES (?, ?, 'Clínica RS', 'active', 'petshop', 1, 1, 'Porto Alegre', 'RS')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled, network_discoverable, address_city, address_state) VALUES (?, ?, 'Clínica SP', 'active', 'petshop', 1, 1, 'São Paulo', 'SP')`).run(randomUUID(), C);
  const svcA = randomUUID(), svcC = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svcA, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svcC, C);

  // Cardiologista descobrível em RS; Ortopedista descobrível em RS (não casa); um cardio NÃO descobrível.
  const cardio = PRO.upsertIdentity({ name: "Dra. Cardio", council: "CRMV-SP", registrationNumber: "111", specialties: ["Cardiologia Veterinária"] }, A).id;
  PRO.setDiscoverability(cardio, { discoverable: true, baseState: "RS", baseCity: "Porto Alegre" });
  const orto = PRO.upsertIdentity({ name: "Dr. Orto", council: "CRMV-SP", registrationNumber: "222", specialties: ["Ortopedia"] }, A).id;
  PRO.setDiscoverability(orto, { discoverable: true, baseState: "RS" });
  const hidden = PRO.upsertIdentity({ name: "Oculto", council: "CRMV-SP", registrationNumber: "333", specialties: ["Cardiologia"] }, A).id; // NÃO descobrível

  // Gera a procura por Cardiologia nas duas clínicas (demand_gap alto).
  const relSeed = REL.invite(A, { professionalId: hidden, permissions: { services: [svcA] } }).id; REL.accept(A, relSeed);
  for (let i = 0; i < 3; i++) BOOK.waitlist(A, { relationshipId: relSeed, serviceId: svcA, contactId: `p${i}` });
  const relC = REL.invite(C, { professionalId: hidden, permissions: { services: [svcC] } }).id; REL.accept(C, relC);
  for (let i = 0; i < 3; i++) BOOK.waitlist(C, { relationshipId: relC, serviceId: svcC, contactId: `q${i}` });
  check("0.1 A procura Cardiologia", CDISC.soughtSpecialties(A).includes("Cardiologia"));

  // 1. A (RS) acha o cardiologista de RS; NÃO o ortopedista; NÃO o oculto.
  const specs = DISC.specialistsFor(A);
  check("1.1 acha o cardiologista descobrível", specs.some((s) => s.professionalId === cardio));
  check("1.2 casa a especialidade (fuzzy 'Cardiologia Veterinária' × 'Cardiologia')", specs.find((s) => s.professionalId === cardio)?.matchedSpecialties.includes("Cardiologia"));
  check("1.3 NÃO acha o ortopedista (especialidade não casa)", !specs.some((s) => s.professionalId === orto));
  check("1.4 NÃO acha o não-descobrível (RN-PN-9)", !specs.some((s) => s.professionalId === hidden));

  // 2. RN-PN-10 — projeção sem dado privado (paciente/contagem).
  const json = JSON.stringify(specs);
  check("2.1 projeção sem id de paciente", !json.includes("p0") && !json.includes("q0"));
  check("2.2 projeção sem contagem crua", !/"unmet"|"declined"|"met"/.test(json));

  // 3. Região: C (SP) procura Cardiologia mas o cardiologista está em RS → fora do estado.
  const specsC = DISC.specialistsFor(C);
  check("3.1 C (SP) não acha o cardiologista de RS (região)", !specsC.some((s) => s.professionalId === cardio));

  // 4. Já-vinculado é excluído: vincula o cardio à A → some da descoberta de A.
  const relCardio = REL.invite(A, { professionalId: cardio }).id;
  check("4.1 vinculado (pending) sai da descoberta", !DISC.specialistsFor(A).some((s) => s.professionalId === cardio));

  // 5. Lado profissional: o cardio (RS) acha a Clínica RS que procura Cardiologia; revoga o vínculo p/ reaparecer.
  REL.revoke(A, relCardio);
  const clinics = DISC.clinicsSeeking(cardio);
  check("5.1 profissional acha a clínica que procura sua especialidade", clinics.some((c) => c.organizationId === A));
  check("5.2 NÃO acha a clínica de SP (região)", !clinics.some((c) => c.organizationId === C));

  // 6. Clínica não-descobrível não aparece pro profissional (RN-PN-9).
  CDISC.setDiscoverable(A, false);
  check("6.1 clínica desligada some da descoberta do profissional", !DISC.clinicsSeeking(cardio).some((c) => c.organizationId === A));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-discovery: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
