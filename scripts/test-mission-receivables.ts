/**
 * TEST — Missões de COBRANÇA (ADR-189 F26). Terceira família de vertical (qualquer negócio que
 * fatura): o intent collect_receivable vira missão MEDÍVEL (métrica `receivables` = recuperado no
 * mês, derivado do system-of-record) e ACIONÁVEL (próximo passo = command handler `collection` que
 * já existe). Honesto (null≠0, nunca inventa dinheiro); governado; isolado por org.
 *
 * Uso: npm run test:mission-receivables
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mrec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mrec-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BusinessGoalService: BG } = await import("../src/server/BusinessGoalService.js");
  const { MissionIntentService: MI } = await import("../src/server/MissionIntentService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionNextStepService: NS } = await import("../src/server/MissionNextStepService.js");
  const { MissionCheckpointService: CP } = await import("../src/server/MissionCheckpointService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled) VALUES (?, ?, 'Serviços', 'active', 'servicos', 'autonomo', '[]', 'active', 1)`).run(randomUUID(), A);
  // Recebíveis: 12.000 recuperados ESTE mês (received) + 8.000 em aberto + 3.000 mês passado (não conta).
  const recv = (amount: number, status: string, receivedAt: string | null) => db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, received_at) VALUES (?, ?, 'Fatura', ?, '2026-08-01', ?, ?)`).run(randomUUID(), A, amount, status, receivedAt);
  recv(5000, "received", new Date().toISOString());
  recv(7000, "received", new Date().toISOString());
  recv(8000, "open", null);
  recv(3000, "received", "2026-01-15 10:00:00");

  // ── 1. Métrica receivables: recuperado no mês = 12.000 (ignora aberto e mês passado) ──
  check("1.1 métrica conhecida", BG.isKnownMetric("receivables"));
  check("1.2 recuperado no mês = 12.000 (RN-004, ignora aberto/mês passado)", BG.currentValue(A, "receivables") === 12000);

  // ── 2. Intenção de cobrança → missão MEDÍVEL (receivables/BRL) ──
  const prop = MI.propose(A, "quero recuperar R$ 20 mil de inadimplência", { persist: true });
  const mission = prop.mission!;
  check("2.1 intent collect_receivable → métrica receivables + alvo 20.000", mission.targetMetric === "receivables" && mission.targetValue === 20000 && mission.targetUnit === "BRL");

  // ── 3. Próximo passo: alavanca de COBRANÇA (collection, que existe), impacto = falta recuperar ──
  const step = NS.suggest(A, mission.id);
  check("3.1 suggestable + alavanca collection", step.suggestable === true && step.lever?.commandType === "collection" && step.lever?.domain === "finance");
  check("3.2 impacto = alvo − recuperado = 20000 − 12000 = 8000 (BRL, não inventa)", step.lever?.expectedImpact === 8000 && step.lever?.impactUnit === "BRL");

  // ── 4. Governado: propose recusa 'off'; com autonomia delega ao caminho existente ──
  let refusedOff = false;
  try { NS.propose(A, mission.id); } catch { refusedOff = true; }
  check("4.1 propose recusa 'off' (shadow-first)", refusedOff);
  M.setAutonomy(A, mission.id, "suggest");
  const proposed = NS.propose(A, mission.id);
  const row = db.prepare(`SELECT * FROM decision_actions WHERE id=? AND organization_id=?`).get(proposed.action.id, A) as any;
  check("4.2 ação governada (collection, correlation mission:<id>, nunca 'done')", row.command_type === "collection" && row.correlation_id === `mission:${mission.id}` && row.status !== "done");

  // ── 5. Trajetória: checkpoint mede pelo recuperado real (currentValue) ──
  M.setStatus(A, mission.id, "running");
  M.update(A, mission.id, { deadline: "2026-08-31" });
  db.prepare(`UPDATE missions SET created_at='2026-08-01 09:00:00' WHERE id=?`).run(mission.id);
  const cp = CP.checkpoint(A, mission.id, { asOf: "2026-08-25" });
  check("5.1 trajetória mede recuperado real (12.000 de 20.000)", cp.actual === 12000 && cp.targetValue === 20000);

  // ── 6. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), B);
  check("6.1 isolamento (B recuperado 0)", BG.currentValue(B, "receivables") === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-receivables: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
