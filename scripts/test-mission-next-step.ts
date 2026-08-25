/**
 * TEST — MissionNextStepService (ADR-189 F15). A ponte gargalo→ação governada sugerida.
 * Prova: deriva do plano reverso um próximo passo aterrado em command handler REAL; shadow
 * (não escreve); premissa faltante → tarefa; gap real → campanha; qualitativa → honesto;
 * propose recusa 'off' e depois delega ao caminho GOVERNADO; grounding; isolamento.
 *
 * Uso: npm run test:mission-next-step
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mnext-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mnext-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionNextStepService: NS } = await import("../src/server/MissionNextStepService.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', 'autonomo', '[]', 'active', 1)`).run(randomUUID(), A);
  // ticket médio 500 (2 pedidos) + base de 800 contatos → cadeia fecha com gap.
  for (let i = 0; i < 2; i++) { const oid = randomUUID(); db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 500, '2026-06-10 10:00:00')`).run(oid, A); db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 500, 1, 500, 200)`).run(randomUUID(), oid, A); }
  for (let i = 0; i < 800; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), A, `c${i}`);

  const rev = M.create(A, { title: "R$100 mil", targetMetric: "revenue", targetValue: 100000, deadline: "2027-06-30" });

  // ── 1. Gap quantitativo real (taxas informadas) → alavanca de CAMPANHA registrada ──
  const withRates = NS.suggest(A, rev.id, { saleConversionRate: 0.25, contactConversionRate: 0.4 });
  check("1.1 suggestable + gargalo contacts", withRates.suggestable === true && withRates.criticalStage === "contacts");
  check("1.2 alavanca = prepare_campaign (comercial)", withRates.lever?.commandType === "prepare_campaign" && withRates.lever?.domain === "commercial");
  check("1.3 grounding: comando REALMENTE registrado", CommandExecutorService.canHandle(withRates.lever!.commandType));
  check("1.4 impacto = alvo restante (100000), BRL, hipótese", withRates.lever?.expectedImpact === 100000 && withRates.lever?.impactUnit === "BRL" && withRates.lever?.basis === "hypothesis");

  // ── 2. Premissa faltante (sem taxas) → próximo passo é FECHAR a lacuna (tarefa governada) ──
  const noRates = NS.suggest(A, rev.id, {});
  check("2.1 suggestable com premissa faltante", noRates.suggestable === true);
  check("2.2 alavanca = create_task (mission_prerequisite), sem impacto inventado", noRates.lever?.commandType === "create_task" && noRates.lever?.actionType === "mission_prerequisite" && noRates.lever?.expectedImpact === null);
  check("2.3 grounding: create_task registrado", CommandExecutorService.canHandle("create_task"));

  // ── 3. Shadow: suggest NÃO escreve nada (0-regressão de governança) ──
  const before = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n;
  NS.suggest(A, rev.id, {}); NS.suggest(A, rev.id, { saleConversionRate: 0.25, contactConversionRate: 0.4 });
  const after = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n;
  check("3.1 suggest é read-only (nenhuma decision_action criada)", before === 0 && after === 0);

  // ── 4. Missão qualitativa (sem alvo numérico) → honesto, sem alavanca ──
  const qual = M.create(A, { title: "Melhorar atendimento" });
  const qs = NS.suggest(A, qual.id, {});
  check("4.1 qualitativa não é suggestable + razão honesta", qs.suggestable === false && qs.lever === null && qs.reason.length > 0);

  // ── 5. propose delega ao caminho GOVERNADO: recusa 'off' ──
  let refusedOff = false;
  try { NS.propose(A, rev.id, { saleConversionRate: 0.25, contactConversionRate: 0.4 }); } catch { refusedOff = true; }
  check("5.1 propose recusa missão em autonomia 'off' (shadow-first)", refusedOff);

  // ── 6. Com autonomia ≥ suggest, propose cria ação governada com o fio + impacto, nunca 'done' ──
  M.setAutonomy(A, rev.id, "suggest");
  const proposed = NS.propose(A, rev.id, { saleConversionRate: 0.25, contactConversionRate: 0.4 });
  const row = db.prepare(`SELECT * FROM decision_actions WHERE id=? AND organization_id=?`).get(proposed.action.id, A) as any;
  check("6.1 decision_action criada, correlação mission:<id>, nunca 'done'", !!row && row.correlation_id === `mission:${rev.id}` && row.status !== "done");
  check("6.2 comando prepare_campaign + impacto 100000 carregados", row.command_type === "prepare_campaign" && Number(row.expected_impact) === 100000);
  check("6.3 missão moveu por governança (waiting_approval/running)", ["waiting_approval", "running"].includes(proposed.mission.status));

  // ── 7. Isolamento: outra org não enxerga a ação nem a missão de A ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), B);
  check("7.1 isolamento (B sem missões nem ações de A)", M.list(B).length === 0 && (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(B) as any).n === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-next-step: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
