/**
 * TESTE — Toggle do Execution Runtime no Admin Master (ADR-152).
 * ---------------------------------------------------------------------------
 * A rota /api/admin/runtime-pilot (Master Admin) é uma casca fina sobre o
 * RuntimePilotService (o mesmo do CLI). Este teste prova a semântica que a rota
 * usa:
 *   - plan(): diagnóstico read-only, runtime começa DESLIGADO;
 *   - apply({runtime, seedPolicies}): liga a trava (execution_runtime_enabled=1);
 *   - apply({runtime, salesRecovery, seedPolicies}): liga a recuperação + semeia
 *     as policies exigidas (policiesReady.salesRecovery = true);
 *   - desligar (UPDATE execution_runtime_enabled=0, como o kill-switch da rota):
 *     runtime volta a false; as policies PERMANECEM (inertes, não são apagadas);
 *   - findOrgs() acha pelo nome; isolamento entre orgs.
 *
 * Uso:  npm run test:admin-runtime-toggle
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-admin-runtime-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-admin-runtime-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RuntimePilotService: P } = await import("../src/server/RuntimePilotService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Auto Peças TESTE', 'active', 'retail')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outra Loja', 'active', 'retail')`).run(randomUUID(), B);

  // ===== 1. estado inicial =====
  const p0 = P.plan(A);
  check("plan inicial: runtime DESLIGADO", p0.flags.runtime === false);
  check("plan inicial: recuperação desligada", p0.flags.salesRecovery === false);

  // ===== 2. ligar só o runtime (aba Operações) =====
  const p1 = P.apply(A, { runtime: true, seedPolicies: true });
  check("apply(runtime): execution_runtime_enabled = 1", p1.flags.runtime === true);
  const dbFlag = db.prepare(`SELECT execution_runtime_enabled v FROM organization_settings WHERE organization_id = ?`).get(A) as any;
  check("flag persistiu no banco", Number(dbFlag.v) === 1);

  // ===== 3. ligar a recuperação + semear policies (aba Recuperação) =====
  const p2 = P.apply(A, { runtime: true, salesRecovery: true, seedPolicies: true });
  check("apply(salesRecovery): recuperação ligada", p2.flags.salesRecovery === true);
  check("policies da recuperação semeadas (policiesReady)", p2.prereqs.policiesReady.salesRecovery === true);
  const pol = db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ? AND domain = 'runtime' AND autonomy_level='execute' AND execution_mode='approved_execution' AND active=1`).get(A) as any;
  check("agent_policies criadas com execute + approved_execution", Number(pol.c) >= 2, String(pol.c));

  // ===== 4. desligar (kill-switch da rota) — policies permanecem inertes =====
  db.prepare(`UPDATE organization_settings SET execution_runtime_enabled = 0 WHERE organization_id = ?`).run(A);
  const p3 = P.plan(A);
  check("desligar: runtime volta a false", p3.flags.runtime === false);
  const polAfter = db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ?`).get(A) as any;
  check("policies NÃO são apagadas ao desligar (ficam inertes)", Number(polAfter.c) >= 2);

  // ===== 5. busca por nome + isolamento =====
  const found = P.findOrgs("auto peças");
  check("findOrgs acha a org pelo nome", found.some((o) => o.orgId === A));
  check("findOrgs acha a org também pelo ID", P.findOrgs(A.slice(0, 8)).some((o) => o.orgId === A));
  check("plan da org B independente (runtime off)", P.plan(B).flags.runtime === false);

  console.log("\n=== TEST: Toggle do Execution Runtime (Admin Master) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
