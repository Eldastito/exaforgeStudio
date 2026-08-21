/**
 * TEST — Descoberta → convite (ADR-180 F10.4). DB-backed, det., isolado.
 * Prova RN-PN-11 (descoberta ≠ conexão): a clínica convida um especialista DESCOBERTO →
 * nasce `pending` (nunca auto-vincula); o profissional EXPRESSA interesse → publica sinal
 * pra clínica (não cria vínculo). Só match real + opt-in dos dois lados; sem bypass do aceite.
 *
 * Uso: npm run test:professional-discovery-connect
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-discconnect-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-discconnect-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ClinicDiscoveryService: CDISC } = await import("../src/server/ClinicDiscoveryService.js");
  const { ProfessionalDiscoveryService: DISC } = await import("../src/server/ProfessionalDiscoveryService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled, network_discoverable, address_state) VALUES (?, ?, 'Clínica RS', 'active', 'petshop', 1, 1, 'RS')`).run(randomUUID(), A);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svc, A);

  const cardio = PRO.upsertIdentity({ name: "Dra. Cardio", council: "CRMV-SP", registrationNumber: "111", specialties: ["Cardiologia Veterinária"] }, A).id;
  PRO.setDiscoverability(cardio, { discoverable: true, baseState: "RS" });
  const hidden = PRO.upsertIdentity({ name: "Oculto", council: "CRMV-SP", registrationNumber: "222", specialties: ["Cardiologia"] }, A).id; // não descobrível

  // Semeia a procura (demand_gap alto) — via um vínculo seed + waitlists.
  const seed = REL.invite(A, { professionalId: hidden, permissions: { services: [svc] } }).id; REL.accept(A, seed);
  for (let i = 0; i < 3; i++) BOOK.waitlist(A, { relationshipId: seed, serviceId: svc, contactId: `p${i}` });
  check("0.1 clínica procura Cardiologia", CDISC.soughtSpecialties(A).includes("Cardiologia"));

  // 1. Clínica convida o especialista descoberto → PENDING (RN-PN-11: nunca auto-accepted).
  const rel = DISC.inviteSpecialist(A, cardio, "userA");
  check("1.1 convite cunha vínculo pending", rel.status === "pending" && rel.professionalId === cardio);
  check("1.2 aparece nas relações da clínica", REL.getByProfessional(A, cardio)?.status === "pending");

  // 2. Idempotente (UNIQUE org+professional) — segundo convite devolve o mesmo, sem duplicar.
  const rel2 = DISC.inviteSpecialist(A, cardio, "userA");
  check("2.1 idempotente", rel2.id === rel.id);

  // 3. Não-descobrível NÃO é convidável por aqui (RN-PN-9 — usa a via manual da F1).
  let e3 = false; try { DISC.inviteSpecialist(A, hidden, "userA"); } catch (e: any) { e3 = e.message === "professional_not_discoverable"; }
  check("3.1 não-descobrível recusado na descoberta", e3);

  // 4. Profissional EXPRESSA interesse → publica sinal (não cria vínculo). Usa outra clínica
  //    descobrível sem vínculo com ele.
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled, network_discoverable, address_state) VALUES (?, ?, 'Clínica RS 2', 'active', 'petshop', 1, 1, 'RS')`).run(randomUUID(), B);
  const svcB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svcB, B);
  const seedB = REL.invite(B, { professionalId: hidden, permissions: { services: [svcB] } }).id; REL.accept(B, seedB);
  for (let i = 0; i < 3; i++) BOOK.waitlist(B, { relationshipId: seedB, serviceId: svcB, contactId: `q${i}` });

  const req = DISC.requestJoin(cardio, B);
  check("4.1 requestJoin ok", req.ok === true);
  const sig = SIG.list(B, { status: "open" }).find((s: any) => s.signal_type === "professional_network/join_request");
  check("4.2 publica join_request na clínica", !!sig && sig.source_entity_id === cardio);
  check("4.3 NÃO criou vínculo (RN-PN-11)", REL.getByProfessional(B, cardio) === null);
  const ev = JSON.parse(sig?.evidence_json || "{}");
  check("4.4 sinal traz só tier público (sem paciente)", !JSON.stringify(ev).includes("q0") && ev.name === "Dra. Cardio");

  // 5. requestJoin sem match → erro (não fabrica).
  const orto = PRO.upsertIdentity({ name: "Orto", council: "CRMV-SP", registrationNumber: "333", specialties: ["Ortopedia"] }, A).id;
  let e5 = false; try { DISC.requestJoin(orto, B); } catch (e: any) { e5 = e.message === "no_match"; }
  check("5.1 sem match → erro", e5);

  // 6. requestJoin pra clínica não descobrível → erro.
  CDISC.setDiscoverable(B, false);
  let e6 = false; try { DISC.requestJoin(cardio, B); } catch (e: any) { e6 = e.message === "clinic_not_discoverable"; }
  check("6.1 clínica não descobrível → erro", e6);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-discovery-connect: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
