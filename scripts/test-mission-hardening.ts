/**
 * TEST — Mission OS hardening (ADR-189 F12). Doc-of-record EXECUTÁVEL de dupla função:
 * (A) codifica os guardrails RN-MOL-1..9 como REGRESSÃO sobre os serviços REAIS F1–F11;
 * (B) verifica a FIAÇÃO de produção (passes no Scheduler, rotas montadas, flags/colunas, testes wired, runbook/ADR).
 *
 * Uso: npm run test:mission-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mhard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mhard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionReversePlanner: RP } = await import("../src/server/MissionReversePlanner.js");
  const { MissionRuntimeService: RT } = await import("../src/server/MissionRuntimeService.js");
  const { MissionCheckpointService: CP } = await import("../src/server/MissionCheckpointService.js");
  const { MissionProactiveService: PRO } = await import("../src/server/MissionProactiveService.js");
  const { NavigationManifestService: NAV } = await import("../src/server/NavigationManifestService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = (flag = 1) => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 'varejo', 'autonomo', '[]', 'active', ?)`).run(randomUUID(), o, flag); return o; };
  const A = mkOrg(1);

  // ── RN-MOL-1: composição — o efeito da missão vai pra decision_actions (tabela canônica), sem executor paralelo.
  const m = M.create(A, { title: "Recuperar R$20k", targetMetric: "revenue", targetValue: 20000, targetUnit: "BRL", deadline: `${new Date().getUTCFullYear() + 1}-06-30`, source: "user" });
  M.setAutonomy(A, m.id, "suggest");
  const act = RT.proposeAction(A, m.id, { domain: "collection", actionType: "mission_outreach", title: "Cobrar" });
  check("RN-1 efeito em decision_actions (composição, sem executor paralelo)", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE id=? AND organization_id=?`).get(act.action.id, A) as any).n === 1);

  // ── RN-MOL-2: Missão = entidade própria que COMPÕE o Goal (métrica desconhecida rejeitada; não é linha de goal).
  check("RN-2 métrica desconhecida rejeitada (compõe BusinessGoal.isKnownMetric)", throws(() => M.create(A, { title: "x", targetMetric: "nao_existe" })));
  check("RN-2 missão vive em `missions` (entidade própria)", (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n >= 1);

  // ── RN-MOL-3: determinístico antes de LLM — reverse-plan reproduzível.
  const p1 = JSON.stringify(RP.plan(A, m.id, { avgTicket: 500, saleConversionRate: 0.25, contactConversionRate: 0.4, baseAvailable: 100 }));
  const p2 = JSON.stringify(RP.plan(A, m.id, { avgTicket: 500, saleConversionRate: 0.25, contactConversionRate: 0.4, baseAvailable: 100 }));
  check("RN-3 reverse-plan determinístico (reproduzível)", p1 === p2);

  // ── RN-MOL-4: shadow-first — autopilot recusado (create/setAutonomy/proactive setMode); off não propõe.
  check("RN-4 create autopilot recusado", throws(() => M.create(A, { title: "y", autonomyLevel: "autopilot" })));
  check("RN-4 setAutonomy autopilot recusado", throws(() => M.setAutonomy(A, m.id, "autopilot")));
  check("RN-4 proactive setMode 'auto' recusado", throws(() => PRO.setMode(A, "auto")));
  const mOff = M.create(A, { title: "off" });
  check("RN-4 missão 'off' não propõe (shadow-first)", throws(() => RT.proposeAction(A, mOff.id, { domain: "collection", actionType: "x", title: "x" })));

  // ── RN-MOL-5: RESULTADO ≠ EXECUÇÃO — checkpoint nunca marca achieved; propose nunca 'done'.
  db.prepare(`UPDATE missions SET mission_status='running' WHERE id=?`).run(m.id);
  CP.publishCheckpointSignal(A, m.id, { asOf: `${new Date().getUTCFullYear() + 1}-06-01`, actualValue: 100 });
  check("RN-5 checkpoint não marca achieved", M.get(A, m.id)!.status !== "achieved");
  check("RN-5 ação proposta nunca 'done' (propor ≠ executar)", act.action.status !== "done");

  // ── RN-MOL-6: governança — a ação nasce awaiting_approval/approved (nunca executa direto).
  check("RN-6 ação governada (awaiting_approval|approved)", ["awaiting_approval", "approved"].includes(act.action.status));

  // ── RN-MOL-7: UX reversível — nav swap Executando↔Missões net-zero por flag.
  const owner = (org: string) => ({ userId: "u1", role: "owner", role_profile_id: (PermissionService.seedSystemProfiles(org), (db.prepare(`SELECT id FROM role_profiles WHERE organization_id=? AND system_key='owner'`).get(org) as any).id), organizationId: org });
  const navOn = NAV.forUser(A, owner(A)); const B = mkOrg(0); const navOff = NAV.forUser(B, owner(B));
  const keys = (x: any) => x.primary.map((p: any) => p.key);
  check("RN-7 nav reversível (on=missoes, off=executando, net-zero)", keys(navOn).includes("missoes") && keys(navOff).includes("executando") && navOn.primary.length === navOff.primary.length);

  // ── RN-MOL-8: isolamento — get cross-org null.
  check("RN-8 isolamento (get cross-org null)", M.get(B, m.id) === null);

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: MissionCheckpointService.pass + MissionProactiveService.pass no Scheduler", scheduler.includes("MissionCheckpointService.pass") && scheduler.includes("MissionProactiveService.pass"));
  const server = fs.readFileSync(path.join(ROOT, "server.ts"), "utf8");
  check("wiring: rota /missions montada", server.includes('"/missions", missionsRoutes') || server.includes("'/missions', missionsRoutes"));
  const dbsrc = fs.readFileSync(path.join(ROOT, "src/server/db.ts"), "utf8");
  check("wiring: flags/colunas (mission_layer_enabled + mission_proactive_mode + tabela missions)", dbsrc.includes("mission_layer_enabled") && dbsrc.includes("mission_proactive_mode") && dbsrc.includes("CREATE TABLE IF NOT EXISTS missions"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:mission-contract", "test:mission-intent", "test:mission-reverse-plan", "test:mission-readiness", "test:mission-runtime", "test:mission-checkpoint", "test:mission-home", "test:mission-nav", "test:mission-legacy-reduction", "test:mission-debrief", "test:mission-proactive", "test:mission-hardening"];
  check("wiring: 12 testes mission wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/mission-operacao.md")));
  check("wiring: ADR-189 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-189-mission-operating-layer.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
