/**
 * TEST — Histórico de saúde do pet (Petshop F6). DB-backed, det., isolado.
 * Prova que o timeline CONSOLIDA read-only os eventos que já existem (vacina,
 * internação, cirurgia, atendimento/banho&tosa), ordenado por data desc, isolado
 * por org e sem inventar (pet inexistente → vazio).
 *
 * Uso: npm run test:clinic-pet-history
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pethist-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pethist-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ClinicPetService: PET } = await import("../src/server/ClinicPetService.js");
  const { ClinicPetCareService: CARE } = await import("../src/server/ClinicPetCareService.js");
  const { ClinicPetHistoryService: HIST } = await import("../src/server/ClinicPetHistoryService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Pet A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Pet B', 'active', 'petshop')`).run(randomUUID(), B);
  const tutor = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run(tutor, A);
  const pet = PET.create(A, { tutorContactId: tutor, name: "Rex" }).id;

  // Eventos em datas distintas para checar ordenação.
  PET.addVaccination(A, pet, { vaccine: "V10", appliedAt: "2026-01-10", nextDueAt: "2027-01-10" });
  const h = CARE.admit(A, pet, { reason: "observação" }); CARE.discharge(A, h.id, {});
  CARE.scheduleSurgery(A, pet, { procedureName: "Castração", scheduledAt: "2026-08-01T09:00:00Z" });
  // Atendimento (appointment) ligado ao pet + um banho & tosa (grooming).
  const svc = randomUUID();
  db.prepare(`INSERT INTO clinic_grooming_services (id, organization_id, name, duration_min, active) VALUES (?, ?, 'Banho', 60, 1)`).run(svc, A);
  const ap1 = randomUUID();
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, pet_id) VALUES (?, ?, ?, 'Consulta geral', '2026-03-15T10:00:00Z', 'completed', ?)`).run(ap1, A, tutor, pet);
  const ap2 = randomUUID();
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, pet_id, grooming_service_id) VALUES (?, ?, ?, 'Banho', '2026-05-20T14:00:00Z', 'completed', ?, ?)`).run(ap2, A, tutor, pet, svc);

  const hist = HIST.history(A, pet);
  check("1.1 consolida os 5 tipos de evento", hist.length === 5);
  check("1.2 tem vacina", hist.some((e) => e.kind === "vaccination" && /V10/.test(e.title)));
  check("1.3 tem internação", hist.some((e) => e.kind === "hospitalization"));
  check("1.4 tem cirurgia", hist.some((e) => e.kind === "surgery" && /Castra/i.test(e.title)));
  check("1.5 tem atendimento (consulta)", hist.some((e) => e.kind === "appointment" && /Consulta/i.test(e.title)));
  check("1.6 distingue banho & tosa (grooming)", hist.some((e) => e.kind === "grooming" && /Banho/i.test(e.title)));
  // Ordenação desc: o evento mais recente (cirurgia 2026-08-01) vem antes do mais antigo (vacina 2026-01-10).
  const idxSurg = hist.findIndex((e) => e.kind === "surgery");
  const idxVax = hist.findIndex((e) => e.kind === "vaccination");
  check("1.7 ordenado por data (mais recente primeiro)", idxSurg < idxVax);

  // filtro por kinds
  const onlyVax = HIST.history(A, pet, { kinds: ["vaccination"] });
  check("2.1 filtro por kind", onlyVax.length === 1 && onlyVax[0].kind === "vaccination");

  // isolamento + honestidade
  check("3.1 pet inexistente → vazio (não inventa)", HIST.history(A, "nao-existe").length === 0);
  check("3.2 pet de A não tem histórico em B (isolamento)", HIST.history(B, pet).length === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-pet-history: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
