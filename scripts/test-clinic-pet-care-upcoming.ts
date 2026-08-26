/**
 * TEST — Visão consolidada "Próximos cuidados" (Petshop F9). DB-backed, det.
 * COMPÕE os três fluxos que já existem (vacina + vermífugo/antipulga + retorno
 * de banho & tosa) numa lista única ordenada por vencimento (atrasados primeiro).
 * Sem motor novo; não inventa (só o que cada detector devolve). Isolado por org.
 *
 * Uso: npm run test:clinic-pet-care-upcoming
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-care-up-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-care-up-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ClinicPetService: PET } = await import("../src/server/ClinicPetService.js");
  const { ClinicGroomingService: G } = await import("../src/server/ClinicGroomingService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Petshop', 'active', 'petshop')`).run(randomUUID(), o);
  const tutorA = randomUUID(), tutorB = randomUUID();
  const mkContact = (org: string, id: string) => db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Tutor', ?)`).run(id, org, id.slice(0, 8));
  mkContact(A, tutorA); mkContact(B, tutorB);
  const rex = PET.create(A, { tutorContactId: tutorA, name: "Rex", species: "cachorro" }, "u1");
  const petB = PET.create(B, { tutorContactId: tutorB, name: "Toby", species: "cachorro" }, "u2");

  const NOW = "2026-08-20T12:00:00Z";

  // 3 fluxos, todos vencendo/vencidos em NOW:
  // vacina VENCIDA (2026-08-10), tratamento A VENCER (2026-09-01), banho A VENCER
  PET.addVaccination(A, rex.id, { vaccine: "V10", appliedAt: "2026-07-10", nextDueAt: "2026-08-10" }, "u1"); // overdue
  PET.addTreatment(A, rex.id, { treatmentType: "vermifugo", appliedAt: "2026-08-01", nextDueAt: "2026-09-01" }, "u1"); // due (12d)
  const svc = G.createService(A, { name: "Banho mensal", recurrenceDays: 30 }, "u1");
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, pet_id, grooming_service_id, scheduled_start, status) VALUES (?, ?, ?, 'Banho', ?, ?, '2026-08-05T10:00:00Z', 'completed')`).run(randomUUID(), A, tutorA, rex.id, svc.id); // +30 = 2026-09-04 → due

  const up = await PET.upcomingCare(A, { nowISO: NOW, withinDays: 30 });

  // ═══ 1. consolida os três fluxos ═══
  check("1.1 lista tem 3 itens (vacina + tratamento + banho)", up.length === 3);
  check("1.2 inclui a vacina", up.some((x) => x.kind === "vaccine" && x.label.includes("V10")));
  check("1.3 inclui o vermífugo", up.some((x) => x.kind === "treatment" && x.label === "Vermífugo"));
  check("1.4 inclui o retorno de banho", up.some((x) => x.kind === "grooming" && x.label === "Banho mensal"));
  check("1.5 todos carregam pet + tutor + previsão", up.every((x) => x.petName === "Rex" && x.tutorContactId === tutorA && !!x.nextDueAt));

  // ═══ 2. ordenação: atrasados primeiro, depois por data ═══
  check("2.1 o primeiro é o ATRASADO (vacina overdue)", up[0].kind === "vaccine" && up[0].status === "overdue");
  check("2.2 os demais são 'due'", up.slice(1).every((x) => x.status === "due"));
  const dues = up.slice(1).map((x) => x.nextDueAt);
  check("2.3 'due' ordenados por data crescente", dues.join() === [...dues].sort().join());

  // ═══ 3. janela respeitada ═══
  const up7 = await PET.upcomingCare(A, { nowISO: NOW, withinDays: 7 });
  check("3.1 janela 7d exclui os que vencem além (só a vacina vencida sobra)", up7.length === 1 && up7[0].kind === "vaccine");

  // ═══ 4. isolamento ═══
  PET.addVaccination(B, petB.id, { vaccine: "V8", nextDueAt: "2026-08-01" }, "u2");
  const upB = await PET.upcomingCare(B, { nowISO: NOW });
  check("4.1 org A não vê cuidados de B", up.every((x) => x.petId !== petB.id));
  check("4.2 org B vê só o seu", upB.every((x) => x.petId === petB.id) && upB.length >= 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-pet-care-upcoming: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
