/**
 * TEST — F4.3 (RF-09 §15.2 / CA-09): convergência de conclusão/reabertura.
 *
 * Prova, offline (tmp db), que concluir/reabrir converge nos DOIS sentidos para
 * pares bridgeados, sem loop, idempotente, e 0-regressão em não-bridgeado:
 *  - Fala Tu → canônico: toggleTask done → tasks.status 'feito'; reabrir desfaz
 *    'feito' → 'a_fazer'; reabrir NÃO pisa em 'fazendo'.
 *  - canônico → Fala Tu: TaskService.move('feito')/recordResult refletem
 *    falatu_tasks.completed=1; move('a_fazer') → completed=0.
 *  - não-bridgeado: toggle no silo não cria/atinge canônico; move canônico não
 *    atinge silo alheio.
 *  - isolamento por org.
 *
 * Uso: npm run test:falatu-bridge-convergence
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ft-conv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ft-conv-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { TaskService } = await import("../src/server/TaskService.js");

  const A = "org_conv_A", B = "org_conv_B", U = "U1";
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${A}`, A);
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${B}`, B);

  // par bridgeado: falatu_task ↔ tarefa canônica
  const mkBridged = (org: string, title: string) => {
    const canon = TaskService.create(org, { title, source: "falatu" }, U);
    const ftId = randomUUID();
    db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, inbox_item_id, bridged_task_id) VALUES (?, ?, ?, ?, ?, ?)`).run(ftId, org, U, title, `ib-${randomUUID()}`, canon.id);
    return { ftId, canonId: canon.id };
  };
  const canonStatus = (org: string, id: string) => (db.prepare(`SELECT status FROM tasks WHERE id = ? AND organization_id = ?`).get(id, org) as any)?.status;
  const ftDone = (id: string) => Number((db.prepare(`SELECT completed FROM falatu_tasks WHERE id = ?`).get(id) as any)?.completed);

  // ── 1. Fala Tu → canônico ──
  const p1 = mkBridged(A, "t-conv-1");
  FalaTuService.toggleTask(A, U, p1.ftId, true);
  check("1.1 done no Fala Tu → canônico 'feito'", canonStatus(A, p1.canonId) === "feito");
  check("1.2 completed_at canônico setado", !!(db.prepare(`SELECT completed_at c FROM tasks WHERE id = ?`).get(p1.canonId) as any).c);
  FalaTuService.toggleTask(A, U, p1.ftId, false);
  check("1.3 reabrir no Fala Tu → canônico 'a_fazer'", canonStatus(A, p1.canonId) === "a_fazer");

  // ── 2. reabrir NÃO pisa em 'fazendo' ──
  const p2 = mkBridged(A, "t-conv-2");
  TaskService.move(A, p2.canonId, "fazendo", U);
  check("2.0 reflect: mover p/ fazendo deixa silo não-concluído", ftDone(p2.ftId) === 0);
  FalaTuService.toggleTask(A, U, p2.ftId, false); // reabrir quando não estava 'feito'
  check("2.1 reabrir com canônico 'fazendo' → continua 'fazendo' (não vira a_fazer)", canonStatus(A, p2.canonId) === "fazendo");
  FalaTuService.toggleTask(A, U, p2.ftId, true);
  check("2.2 concluir a partir de 'fazendo' → 'feito'", canonStatus(A, p2.canonId) === "feito");

  // ── 3. canônico → Fala Tu ──
  const p3 = mkBridged(A, "t-conv-3");
  TaskService.move(A, p3.canonId, "feito", U);
  check("3.1 concluir no quadro → silo completed=1", ftDone(p3.ftId) === 1);
  TaskService.move(A, p3.canonId, "a_fazer", U);
  check("3.2 reabrir no quadro → silo completed=0", ftDone(p3.ftId) === 0);
  // recordResult também reflete
  const p4 = mkBridged(A, "t-conv-4");
  TaskService.recordResult(A, p4.canonId, { resultFinal: 10 }, U);
  check("3.3 recordResult (conclui) → silo completed=1", ftDone(p4.ftId) === 1);

  // ── 4. idempotente / sem loop ──
  const before = canonStatus(A, p3.canonId);
  FalaTuService.toggleTask(A, U, p3.ftId, false); // já não-concluído
  check("4.1 toggle repetido estável (sem loop/erro)", canonStatus(A, p3.canonId) === before && ftDone(p3.ftId) === 0);

  // ── 5. não-bridgeado: 0-regressão ──
  const soloFt = randomUUID();
  db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, inbox_item_id) VALUES (?, ?, ?, 't-solo', ?)`).run(soloFt, A, U, `ib-${randomUUID()}`);
  const canonBefore = TaskService.list(A, {}).length;
  FalaTuService.toggleTask(A, U, soloFt, true);
  check("5.1 toggle de silo não-bridgeado não cria canônico", TaskService.list(A, {}).length === canonBefore);
  check("5.2 silo não-bridgeado concluído normalmente", ftDone(soloFt) === 1);
  // canônico independente (sem espelho) não afeta silo algum
  const loneCanon = TaskService.create(A, { title: "lone", source: "manual" }, U);
  TaskService.move(A, loneCanon.id, "feito", U);
  check("5.3 move de canônico sem espelho não toca silo", ftDone(soloFt) === 1);

  // ── 6. isolamento ──
  const pB = mkBridged(B, "t-conv-B");
  FalaTuService.toggleTask(B, U, pB.ftId, true);
  check("6.1 org B converge isolada", canonStatus(B, pB.canonId) === "feito");
  check("6.2 org A intacta", canonStatus(A, p1.canonId) === "a_fazer");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-bridge-convergence: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
