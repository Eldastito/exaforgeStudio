/**
 * TEST — Tratamentos preventivos do pet (Petshop F7). DB-backed, det., isolado.
 * Vermífugo/antipulga/carrapaticida NÃO são vacina (carteira própria) mas seguem
 * o MESMO padrão de lembrete por `next_due_at`. Prova (RN-004, conv. nº 12, iso):
 *   - addTreatment valida o pet + o tipo (não inventa); list;
 *   - dueTreatments detecta vencidos/a vencer (só pets ativos, status applied);
 *   - publishTreatmentReminders publica no business_signals (dedupe), idempotente;
 *   - o histórico do pet (F6) inclui o tratamento;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:clinic-pet-treatment
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pet-treat-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pet-treat-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ClinicPetService: PET } = await import("../src/server/ClinicPetService.js");
  const { ClinicPetHistoryService: HIST } = await import("../src/server/ClinicPetHistoryService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Petshop A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Petshop B', 'active', 'petshop')`).run(randomUUID(), B);
  const tutorA = randomUUID(), tutorB = randomUUID();
  const mkContact = (org: string, id: string, name: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', ?, ?)`).run(id, org, name, id.slice(0, 8));
  mkContact(A, tutorA, "Maria Silva"); mkContact(B, tutorB, "João (org B)");
  const rex = PET.create(A, { tutorContactId: tutorA, name: "Rex", species: "cachorro" }, "u1");
  const petB = PET.create(B, { tutorContactId: tutorB, name: "Toby", species: "cachorro" }, "u2");

  const NOW = "2026-08-20T12:00:00Z";

  // ═══ 1. add valida pet + tipo ═══
  let bad = false; try { PET.addTreatment(A, "nao-existe", { treatmentType: "vermifugo" }); } catch { bad = true; }
  check("1.1 rejeita pet inexistente", bad);
  let badType = false; try { PET.addTreatment(A, rex.id, { treatmentType: "poção-mágica" }); } catch { badType = true; }
  check("1.2 rejeita tipo inválido (não inventa)", badType);
  const t1 = PET.addTreatment(A, rex.id, { treatmentType: "Vermifugo", product: "Vermivet", appliedAt: "2026-07-20", nextDueAt: "2026-08-19" }, "u1"); // vencido em NOW
  const t2 = PET.addTreatment(A, rex.id, { treatmentType: "antipulga", product: "Bravecto", appliedAt: "2026-08-10", nextDueAt: "2026-09-05" }, "u1"); // a vencer
  const t3 = PET.addTreatment(A, rex.id, { treatmentType: "carrapaticida", appliedAt: "2026-08-10", nextDueAt: "2027-06-01" }, "u1"); // longe (ok)
  check("1.3 cria tratamentos", !!t1.id && !!t2.id && !!t3.id);
  check("1.4 tipo normalizado pra minúsculo", PET.listTreatments(A, rex.id).some((t) => t.treatmentType === "vermifugo"));

  // ═══ 2. list ═══
  const list = PET.listTreatments(A, rex.id);
  check("2.1 lista os 3 tratamentos", list.length === 3);

  // ═══ 3. dueTreatments (só vencidos/a vencer, dentro da janela) ═══
  const due = PET.dueTreatments(A, { nowISO: NOW, withinDays: 30 });
  check("3.1 detecta 2 (1 vencido + 1 a vencer); o de 2027 fica de fora", due.length === 2);
  check("3.2 vermífugo marcado overdue", due.some((d) => d.treatmentType === "vermifugo" && d.status === "overdue"));
  check("3.3 antipulga marcado due", due.some((d) => d.treatmentType === "antipulga" && d.status === "due"));
  check("3.4 carrega tutor + pet pro lembrete", due.every((d) => d.tutorContactId === tutorA && d.petName === "Rex"));

  // pet inativo não entra
  PET.update(A, rex.id, { status: "inactive" }, "u1");
  check("3.5 pet inativo → some do due (só pets ativos)", PET.dueTreatments(A, { nowISO: NOW }).length === 0);
  PET.update(A, rex.id, { status: "active" }, "u1");

  // ═══ 4. lembrete no business_signals (dedupe, idempotente) ═══
  const r1 = await PET.publishTreatmentReminders(A, { nowISO: NOW });
  check("4.1 publica 2 sinais", r1.published === 2);
  const sigCount = () => (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'pet_treatment_due'`).get(A) as any).c;
  check("4.2 2 sinais no ledger", sigCount() === 2);
  await PET.publishTreatmentReminders(A, { nowISO: NOW });
  check("4.3 idempotente (dedupe por treatmentId → ainda 2)", sigCount() === 2);
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'pet_treatment_due' AND dedupe_key = ?`).get(A, `clinic:pet_treatment_due:${t1.id}`) as any;
  check("4.4 sinal do vermífugo com dedupe correto + severidade attention (vencido)", !!sig && sig.severity === "attention");

  // ═══ 5. histórico do pet inclui tratamento ═══
  const hist = HIST.history(A, rex.id);
  check("5.1 histórico inclui os 3 tratamentos", hist.filter((e) => e.kind === "treatment").length === 3);
  const onlyTreat = HIST.history(A, rex.id, { kinds: ["treatment"] });
  check("5.2 filtro por kind='treatment' funciona", onlyTreat.length === 3 && onlyTreat.every((e) => e.kind === "treatment"));
  check("5.3 título humano (Vermífugo/Antipulgas)", onlyTreat.some((e) => e.title === "Vermífugo") && onlyTreat.some((e) => e.title === "Antipulgas"));

  // ═══ 6. isolamento ═══
  check("6.1 org B não vê tratamentos de A", PET.listTreatments(B, rex.id).length === 0);
  PET.addTreatment(B, petB.id, { treatmentType: "vermifugo", nextDueAt: "2026-08-01" }, "u2");
  check("6.2 due de A não vaza pra B (e vice-versa)", PET.dueTreatments(A, { nowISO: NOW }).every((d) => d.petId === rex.id));
  check("6.3 sinais de B isolados", (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'pet_treatment_due'`).get(B) as any).c === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-pet-treatment: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
