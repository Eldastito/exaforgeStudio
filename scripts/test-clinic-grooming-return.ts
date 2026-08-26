/**
 * TEST — Retorno de banho & tosa (Petshop F8). DB-backed, det., isolado.
 * Banho é recorrente (o maior driver de recompra). O lembrete DERIVA do último
 * grooming do pet + `recurrence_days` do serviço — não inventa recorrência.
 * Prova (RN-004, conv. nº 12, isolamento):
 *   - recurrence_days no CRUD do serviço (normaliza; null = sem lembrete);
 *   - dueGroomingReturns: overdue/due pela janela; serviço sem recorrência não
 *     gera; quem JÁ reagendou (grooming futuro) é excluído; só pets ativos;
 *   - publishGroomingReturnReminders publica no business_signals (dedupe, idemp.);
 *   - self-heal: reagendar resolve o lembrete aberto;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:clinic-grooming-return
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-groom-ret-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-groom-ret-123456";

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
  const mel = PET.create(A, { tutorContactId: tutorA, name: "Mel", species: "cachorro" }, "u1");
  const bob = PET.create(A, { tutorContactId: tutorA, name: "Bob", species: "cachorro" }, "u1");
  const petB = PET.create(B, { tutorContactId: tutorB, name: "Toby", species: "cachorro" }, "u2");

  // insere um grooming PASSADO direto (controla a data)
  const mkGroom = (org: string, petId: string, tutorId: string, svcId: string, startISO: string, status = "completed") =>
    db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, pet_id, grooming_service_id, scheduled_start, status) VALUES (?, ?, ?, 'Banho', ?, ?, ?, ?)`).run(randomUUID(), org, tutorId, petId, svcId, startISO, status);

  const NOW = "2026-08-20T12:00:00Z";

  // ═══ 1. recurrence_days no CRUD (normaliza; null desliga) ═══
  const svc = G.createService(A, { name: "Banho mensal", recurrenceDays: 30 }, "u1");
  check("1.1 cria serviço com recorrência 30", G.listServices(A).find((s) => s.id === svc.id)?.recurrenceDays === 30);
  const svcNoRec = G.createService(A, { name: "Tosa avulsa" }, "u1");
  check("1.2 serviço sem recorrência → null (não inventa)", G.listServices(A).find((s) => s.id === svcNoRec.id)?.recurrenceDays === null);
  G.updateService(A, svcNoRec.id, { recurrenceDays: 0 }, "u1");
  check("1.3 recorrência 0/inválida → null (desliga)", G.listServices(A).find((s) => s.id === svcNoRec.id)?.recurrenceDays === null);

  // ═══ 2. dueGroomingReturns ═══
  mkGroom(A, rex.id, tutorA, svc.id, "2026-07-01T10:00:00Z");  // +30 = 2026-07-31 → overdue em NOW
  mkGroom(A, mel.id, tutorA, svc.id, "2026-08-05T10:00:00Z");  // +30 = 2026-09-04 → due (15d) em NOW
  mkGroom(A, bob.id, tutorA, svcNoRec.id, "2026-06-01T10:00:00Z"); // serviço SEM recorrência → nunca
  const due = G.dueGroomingReturns(A, { nowISO: NOW, withinDays: 30 });
  check("2.1 detecta 2 retornos (Rex overdue + Mel due)", due.length === 2);
  check("2.2 Rex overdue", due.some((d) => d.petName === "Rex" && d.status === "overdue"));
  check("2.3 Mel due", due.some((d) => d.petName === "Mel" && d.status === "due"));
  check("2.4 serviço sem recorrência não gera retorno (Bob fora)", !due.some((d) => d.petName === "Bob"));
  check("2.5 carrega tutor + serviço + previsão", due.every((d) => d.tutorContactId === tutorA && d.serviceName === "Banho mensal" && !!d.nextDueAt));

  // já reagendou (grooming futuro) → excluído
  mkGroom(A, rex.id, tutorA, svc.id, "2026-09-10T10:00:00Z", "scheduled");
  check("2.6 quem já tem grooming FUTURO é excluído (Rex sai)", !G.dueGroomingReturns(A, { nowISO: NOW }).some((d) => d.petName === "Rex"));

  // pet inativo sai
  PET.update(A, mel.id, { status: "inactive" }, "u1");
  check("2.7 pet inativo → some", !G.dueGroomingReturns(A, { nowISO: NOW }).some((d) => d.petName === "Mel"));
  PET.update(A, mel.id, { status: "active" }, "u1");

  // ═══ 3. lembrete no business_signals (dedupe, idempotente) ═══
  // remove o futuro do Rex pra ele voltar a ser "due" e publicar
  db.prepare(`DELETE FROM appointments WHERE organization_id = ? AND pet_id = ? AND status = 'scheduled'`).run(A, rex.id);
  const r1 = await G.publishGroomingReturnReminders(A, { nowISO: NOW });
  check("3.1 publica 2 sinais", r1.published === 2);
  const sigOpen = () => (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'pet_grooming_return_due' AND status = 'open'`).get(A) as any).c;
  check("3.2 2 sinais abertos", sigOpen() === 2);
  await G.publishGroomingReturnReminders(A, { nowISO: NOW });
  check("3.3 idempotente (dedupe por pet+serviço → ainda 2)", sigOpen() === 2);

  // ═══ 4. self-heal: reagendar resolve o sinal aberto ═══
  G.book(A, { petId: rex.id, groomingServiceId: svc.id, scheduledStart: "2026-09-15T10:00:00Z" }, "u1");
  await new Promise((r) => setTimeout(r, 60)); // self-heal é best-effort (import async)
  check("4.1 reagendar resolve o lembrete do Rex (1 aberto restante)", sigOpen() === 1);

  // ═══ 5. isolamento ═══
  const svcB = G.createService(B, { name: "Banho", recurrenceDays: 30 }, "u2");
  mkGroom(B, petB.id, tutorB, svcB.id, "2026-06-01T10:00:00Z");
  check("5.1 due de A não vaza pra B", G.dueGroomingReturns(A, { nowISO: NOW }).every((d) => d.petId !== petB.id));
  check("5.2 B tem seu próprio retorno", G.dueGroomingReturns(B, { nowISO: NOW }).some((d) => d.petId === petB.id));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-grooming-return: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
