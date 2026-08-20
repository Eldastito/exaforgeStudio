/**
 * TEST — Banho & Tosa / grooming (Petshop F4). DB-backed, det., isolado.
 * Prova (reuso da agenda; isolamento; nunca inventa):
 *   - catálogo de serviços: create/list/update (ativar/desativar);
 *   - book cria appointment ligado ao PET + SERVIÇO (contato = tutor do pet),
 *     reusando a agenda; valida pet ativo + serviço ativo da MESMA org;
 *   - dayQueue lista os grooming do dia com pet/serviço/tutor;
 *   - isolamento multi-tenant (não agenda com pet/serviço de outra org).
 *
 * Uso: npm run test:clinic-grooming
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-groom-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-groom-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ClinicGroomingService: G } = await import("../src/server/ClinicGroomingService.js");
  const { ClinicPetService: PET } = await import("../src/server/ClinicPetService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Pet A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Pet B', 'active', 'petshop')`).run(randomUUID(), B);
  const tutorA = randomUUID(), tutorB = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run(tutorA, A);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Beto', 'beto')`).run(tutorB, B);
  const petA = PET.create(A, { tutorContactId: tutorA, name: "Toto", species: "cachorro" }).id;
  const petB = PET.create(B, { tutorContactId: tutorB, name: "Mia", species: "gato" }).id;

  // ═══════════════ 1. catálogo de serviços ═══════════════
  const banho = G.createService(A, { name: "Banho", durationMin: 40, priceCents: 5000 }, "u1");
  const tosa = G.createService(A, { name: "Tosa", durationMin: 60 }, "u1");
  check("1.1 cria serviços", !!banho.id && !!tosa.id);
  check("1.2 lista ativos", G.listServices(A).length === 2);
  let sbad = false; try { G.createService(A, {}); } catch { sbad = true; }
  check("1.3 name obrigatório", sbad);
  G.updateService(A, tosa.id, { active: false }, "u1");
  check("1.4 desativar tira da lista ativa", G.listServices(A).length === 1 && G.listServices(A, { includeInactive: true }).length === 2);

  // ═══════════════ 2. book liga pet + serviço (reuso da agenda) ═══════════════
  const appt = G.book(A, { petId: petA, groomingServiceId: banho.id, scheduledStart: "2026-08-21T10:00:00Z" }, "u1");
  check("2.1 book cria appointment", !!appt.id);
  const row = db.prepare(`SELECT contact_id, pet_id, grooming_service_id, title FROM appointments WHERE organization_id=? AND id=?`).get(A, appt.id) as any;
  check("2.2 appointment ligado ao pet + serviço", row.pet_id === petA && row.grooming_service_id === banho.id);
  check("2.3 contato = tutor do pet (não inventa)", row.contact_id === tutorA);
  check("2.4 título compõe serviço + pet", /Banho — Toto/.test(row.title));
  let bbad = false; try { G.book(A, { petId: petA, groomingServiceId: tosa.id, scheduledStart: "2026-08-21T14:00:00Z" }); } catch { bbad = true; }
  check("2.5 serviço inativo é rejeitado", bbad);
  let pbad = false; try { G.book(A, { petId: "nao-existe", groomingServiceId: banho.id, scheduledStart: "2026-08-21T15:00:00Z" }); } catch { pbad = true; }
  check("2.6 pet inexistente rejeitado", pbad);

  // ═══════════════ 3. fila do dia ═══════════════
  const queue = G.dayQueue(A, "2026-08-21");
  check("3.1 fila lista o grooming do dia", queue.length === 1 && queue[0].petName === "Toto" && queue[0].serviceName === "Banho" && queue[0].tutorName === "Ana");
  check("3.2 fila de outro dia vazia", G.dayQueue(A, "2026-08-22").length === 0);

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  let cross = false; try { G.book(A, { petId: petB, groomingServiceId: banho.id, scheduledStart: "2026-08-21T16:00:00Z" }); } catch { cross = true; }
  check("4.1 não agenda com pet de OUTRA org", cross);
  let cross2 = false; try { G.book(B, { petId: petB, groomingServiceId: banho.id, scheduledStart: "2026-08-21T16:00:00Z" }); } catch { cross2 = true; }
  check("4.2 não usa serviço de outra org (banho é de A)", cross2);
  check("4.3 fila de B vazia (isolada)", G.dayQueue(B, "2026-08-21").length === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-grooming: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
