/**
 * TEST — People workload / sobrecarga com evidência (Epic 7 — fatia 3).
 * Carga de tarefas + disponibilidade declarada; sinal `people` idempotente.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:people-workload
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wl-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-wl-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EmployeeService: E } = await import("../src/server/EmployeeService.js");
  const { WorkloadService: W } = await import("../src/server/WorkloadService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  const ASOF = "2026-07-23";
  // usuário + colaborador vinculado
  const mkEmp = (name: string, userId: string) => { const r = E.create(orgA, { name, userId }); return r.id!; };
  const addTask = (userId: string, status: string, dueAt: string | null) => {
    db.prepare("INSERT INTO tasks (id, organization_id, title, assigned_to, status, due_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), orgA, `T-${randomUUID().slice(0, 4)}`, userId, status, dueAt);
  };

  const uSobre = "user_sobre", uOk = "user_ok", uAus = "user_aus";
  const eSobre = mkEmp("Sobrecarregado", uSobre);
  const eOk = mkEmp("Tranquilo", uOk);
  const eAus = mkEmp("Ausente", uAus);

  // Sobrecarregado: 7 abertas (>=6) sendo 4 vencidas (>=3).
  for (let i = 0; i < 3; i++) addTask(uSobre, "a_fazer", "2030-01-01"); // futuras
  for (let i = 0; i < 4; i++) addTask(uSobre, "a_fazer", "2020-01-01"); // vencidas
  // Tranquilo: 2 abertas, nenhuma vencida.
  addTask(uOk, "a_fazer", "2030-01-01"); addTask(uOk, "fazendo", null);
  // Ausente: 2 abertas + ausência declarada cobrindo ASOF.
  addTask(uAus, "a_fazer", "2030-01-01"); addTask(uAus, "a_fazer", null);
  W.addAvailability(orgA, { employeeId: eAus, kind: "absence", startDate: "2026-07-20", endDate: "2026-07-30", note: "férias" });

  const rep = W.assess(orgA, { asOfDate: ASOF });
  const by = (id: string) => rep.employees.find((r: any) => r.employeeId === id);

  // ===== 1. Sobrecarregado por volume + vencidas =====
  check("sobrecarregado é sinalizado", by(eSobre).overloaded === true);
  check("conta abertas (7) e vencidas (4)", by(eSobre).openTasks === 7 && by(eSobre).overdueTasks === 4);
  check("severidade 'risk' quando há vencidas", by(eSobre).severity === "risk");
  check("evidência traz amostra de tarefas", Array.isArray(by(eSobre).evidence.taskSample) && by(eSobre).evidence.taskSample.length === 3);
  check("razão cita as regras que dispararam", /abertas/.test(by(eSobre).reason) && /vencidas/.test(by(eSobre).reason));

  // ===== 2. Tranquilo NÃO é sobrecarga =====
  check("tranquilo não sinaliza", by(eOk).overloaded === false && by(eOk).severity === null && by(eOk).reason === null);

  // ===== 3. Ausente com tarefas abertas =====
  check("ausente é sinalizado (tarefas com responsável ausente)", by(eAus).overloaded === true && /AUSENTE/.test(by(eAus).reason));
  check("availability reflete a ausência", by(eAus).availability === "absence" && by(eAus).severity === "risk");

  check("overloadedCount = 2 (sobrecarregado + ausente)", rep.overloadedCount === 2);

  // ===== 4. asOfDate: sem ausência fora da janela =====
  const repFuture = W.assess(orgA, { asOfDate: "2026-08-15" });
  check("fora da janela de ausência, disponibilidade volta a 'available'", repFuture.employees.find((r: any) => r.employeeId === eAus).availability === "available");

  // ===== 5. Só colaboradores ativos com usuário vinculado =====
  E.create(orgA, { name: "Sem acesso ao sistema" }); // sem user_id → fora do assess
  check("colaborador sem usuário vinculado não entra no assess", W.assess(orgA, { asOfDate: ASOF }).employees.length === 3);

  // ===== 6. Sinais de sobrecarga (idempotente por dia) =====
  const p1 = W.publishOverloadSignals(orgA, { asOfDate: ASOF });
  check("publica 1 sinal por sobrecarregado (2)", p1.published === 2);
  const sigs = db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'employee_overload'").get(orgA) as any;
  check("sinais 'employee_overload' no ledger", sigs.n === 2);
  W.publishOverloadSignals(orgA, { asOfDate: ASOF });
  const sigs2 = db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'employee_overload'").get(orgA) as any;
  check("re-publicar no mesmo dia não duplica (dedupe)", sigs2.n === 2);

  // ===== 7. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: org B tem assess vazio", W.assess(orgB, { asOfDate: ASOF }).employees.length === 0);
  check("isolamento: addAvailability rejeita colaborador de outra org", W.addAvailability(orgB, { employeeId: eSobre, startDate: "2026-07-20" }).ok === false);

  console.log("\n=== TEST: People workload / sobrecarga (Epic 7 — fatia 3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ People workload OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
