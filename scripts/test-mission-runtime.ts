/**
 * TEST — Mission Runtime (ADR-189 F5, Mission OS). DB-backed, determinístico.
 * Prova: a missão executa via caminho GOVERNADO (DecisionActionService.propose → tabela canônica
 * decision_actions, sem executor paralelo); ação nasce governada (nunca 'done' no propose — propor ≠
 * executar); missão em 'off' NÃO propõe (shadow-first); status da missão move por governança;
 * ligação por correlation_id='mission:<id>'; RESULTADO ≠ EXECUÇÃO (nunca achieved); isolamento.
 *
 * Uso: npm run test:mission-runtime
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mrt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mrt-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionRuntimeService: RT } = await import("../src/server/MissionRuntimeService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), o); return o; };
  const A = mkOrg();
  const effect = { domain: "collection", actionType: "mission_outreach", title: "Cobrar clientes 45-75 dias" };

  // 1. Missão em 'off' → NÃO propõe (shadow-first).
  const m = M.create(A, { title: "Recuperar R$20k", targetMetric: "revenue", targetValue: 20000 });
  check("1.1 autonomia 'off' → proposeAction lança (shadow-first)", throws(() => RT.proposeAction(A, m.id, effect)));

  // 2. Sobe pra 'suggest' e propõe: ação governada na tabela canônica, ligada por correlation.
  M.setAutonomy(A, m.id, "suggest");
  const r = RT.proposeAction(A, m.id, effect);
  check("2.1 ação criada em decision_actions (tabela canônica, sem executor paralelo)", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE id=? AND organization_id=?`).get(r.action.id, A) as any).n === 1);
  check("2.2 ligada por correlation_id='mission:<id>'", r.action.correlationId === `mission:${m.id}`);
  check("2.3 governada: nunca 'done' no propose (propor ≠ executar)", r.action.status !== "done");
  check("2.4 status governado (awaiting_approval ou approved)", ["awaiting_approval", "approved"].includes(r.action.status));

  // 3. Status da missão move por governança (waiting_approval × running), nunca achieved.
  check("3.1 missão em waiting_approval/running (não achieved)", ["waiting_approval", "running"].includes(r.mission.status));
  check("3.2 RESULTADO ≠ EXECUÇÃO: propor não marca achieved", r.mission.status !== "achieved");

  // 4. actions() + runtime() derivam.
  const rt = RT.runtime(A, m.id);
  check("4.1 runtime conta a ação proposta", rt.counts.proposed === 1 && rt.actions.length === 1);
  check("4.2 runtime não infere achieved", rt.status !== "achieved");

  // 5. Efeito inválido (sem domain/actionType/title) → erro.
  check("5.1 efeito sem campos → erro", throws(() => RT.proposeAction(A, m.id, { domain: "", actionType: "", title: "" } as any)));

  // 6. Isolamento: propor missão de outra org → erro; ação de A não aparece em B.
  const B = mkOrg();
  check("6.1 cross-org propose → erro", throws(() => RT.proposeAction(B, m.id, effect)));
  check("6.2 actions isolado (B não vê a ação de A)", RT.actions(B, m.id).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-runtime: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
