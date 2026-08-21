/**
 * TEST — Geocoding p/ match por raio (ADR-180 F11.2). DB-backed, det., SEM rede
 * (geocode_cache pré-populado → `geocodeCity` resolve do cache, nunca chama Nominatim).
 * Prova: o passe preenche lat/lng das entidades DESCOBRÍVEIS sem coords; depois a descoberta
 * casa por DISTÂNCIA (raio) e não só por estado — clínica longe (mesmo estado) fica fora.
 *
 * Uso: npm run test:professional-geocode
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-geocode-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-geocode-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ClinicDiscoveryService: CDISC } = await import("../src/server/ClinicDiscoveryService.js");
  const { ProfessionalDiscoveryService: DISC } = await import("../src/server/ProfessionalDiscoveryService.js");

  // Pré-popula o cache (chave "cidade|uf|br" minúscula) — sem isso o geocode chamaria a rede.
  const seed = (city: string, uf: string, lat: number, lng: number) =>
    db.prepare(`INSERT OR REPLACE INTO geocode_cache (key, lat, lng) VALUES (?, ?, ?)`).run(`${city.toLowerCase()}|${uf.toLowerCase()}|br`, lat, lng);
  seed("Porto Alegre", "RS", -30.03, -51.23);
  seed("Canoas", "RS", -29.92, -51.18);        // ~15 km de POA
  seed("Pelotas", "RS", -31.77, -52.34);       // ~250 km de POA (mesmo estado, longe)

  // Profissional descobrível em POA, SEM coords ainda.
  const A = `org_${randomUUID().slice(0, 8)}`; // org de cadastro do prof
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'petshop')`).run(randomUUID(), A);
  const pid = PRO.upsertIdentity({ name: "Dra. Cardio", council: "CRMV-SP", registrationNumber: "111", specialties: ["Cardiologia"] }, A).id;
  PRO.setDiscoverability(pid, { discoverable: true, baseCity: "Porto Alegre", baseState: "RS" });

  // Duas clínicas descobríveis procurando Cardiologia: perto (Canoas) e longe (Pelotas), sem coords.
  const near = `org_${randomUUID().slice(0, 8)}`, far = `org_${randomUUID().slice(0, 8)}`;
  const mk = (org: string, city: string) => {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled, network_discoverable, address_city, address_state) VALUES (?, ?, ?, 'active', 'petshop', 1, 1, ?, 'RS')`).run(randomUUID(), org, `Clínica ${city}`, city);
    const svc = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svc, org);
    const seedPro = PRO.upsertIdentity({ name: `Seed ${city}`, council: "CRMV-SP", registrationNumber: `9${city}`.slice(0, 6) }, org).id;
    const rel = REL.invite(org, { professionalId: seedPro, permissions: { services: [svc] } }).id; REL.accept(org, rel);
    for (let i = 0; i < 3; i++) BOOK.waitlist(org, { relationshipId: rel, serviceId: svc, contactId: `c${i}` });
  };
  mk(near, "Canoas"); mk(far, "Pelotas");
  check("0.1 as duas clínicas procuram Cardiologia", CDISC.soughtSpecialties(near).includes("Cardiologia") && CDISC.soughtSpecialties(far).includes("Cardiologia"));

  // Antes do geocode: sem coords → o match cai pro estado (RS) → acha AS DUAS.
  const before = DISC.clinicsSeeking(pid);
  check("1.1 antes do geocode: match por estado acha as 2 (POA=null coords)", before.length === 2 && before.every((c) => c.distanceKm === null));

  // Roda o passe → preenche coords do cache (sem rede).
  const res = await DISC.geocodePass();
  check("2.1 geocodou o profissional + 2 clínicas", res.professionals === 1 && res.clinics === 2);
  check("2.2 coords do profissional preenchidas", (PRO.getById(pid)!.baseLat ?? null) !== null);

  // Depois do geocode: match por RAIO. Raio 50km → só a de Canoas (perto), não Pelotas.
  const after = DISC.clinicsSeeking(pid, { maxDistanceKm: 50 });
  check("3.1 raio 50km acha a clínica perto (Canoas)", after.some((c) => c.organizationId === near));
  check("3.2 raio 50km EXCLUI a clínica longe (Pelotas, mesmo estado)", !after.some((c) => c.organizationId === far));
  check("3.3 agora traz a distância em km", after.find((c) => c.organizationId === near)?.distanceKm != null);

  // Raio grande volta a incluir as duas.
  check("4.1 raio 500km inclui as 2 de novo", DISC.clinicsSeeking(pid, { maxDistanceKm: 500 }).length === 2);

  // Idempotente: rodar o passe de novo não regeocoda (já têm coords).
  check("5.1 2º passe não refaz (coords já preenchidas)", (await DISC.geocodePass()).professionals === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-geocode: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
