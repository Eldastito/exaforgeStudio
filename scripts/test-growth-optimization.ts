/**
 * TEST — Governed optimization (PRD 11 / ADR-168 F16). DB-backed, determinístico.
 * Prova: proposta do autopilot (F15) → comando GOVERNADO via DecisionAction; NASCE
 * awaiting_approval (RN-CG-08/10 — nunca executa direto); grounded no plano vivo (RN-CG-09);
 * idempotente por (kind, ref); execute só corre em ação APROVADA; efeito é diretiva honesta;
 * isolamento.
 *
 * Uso: npm run test:growth-optimization
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gopt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gopt-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GrowthOptimizationService: OPT } = await import("../src/server/GrowthOptimizationService.js");
  const { GrowthAutopilotService: AP } = await import("../src/server/GrowthAutopilotService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");

  const org = `org_go_${randomUUID().slice(0, 8)}`;
  const orgB = `org_go_${randomUUID().slice(0, 8)}`;
  for (const o of [org, orgB]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);

  // ── setup: uma oportunidade de conteúdo (F7) + um campeão (F9) ──
  BusinessSignalService.publish(org, {
    domain: "social", signalType: "content_opportunity", severity: "attention", basis: "hypothesis",
    confidence: 0.5, impactAmount: null, sourceService: "test", subjectType: "opportunity",
    subjectId: "social_opportunity:moda:linho:instagram", dedupeKey: "social_opportunity:moda:linho:instagram",
    evidence: { vertical: "moda", topic: "linho", channel: "instagram", note: "Em alta." },
  });
  const sig = db.prepare(`SELECT id FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(org, "social_opportunity:moda:linho:instagram") as any;
  db.prepare(`INSERT INTO content_sale_attributions (id, organization_id, correlation_id, contact_id, revenue, revenue_basis, source) VALUES (?, ?, 'corr:champ', ?, 300, 'fact', 'orders')`).run(randomUUID(), org, randomUUID());
  const e = EXP.create(org, "u", { hypothesis: "qual vende", variants: [{ variantKey: "x:A", correlationId: "corr:champ" }, { variantKey: "x:B", correlationId: "corr:other" }] });
  EXP.decide(org, e.id);

  // ── 1. list(): anota as propostas do autopilot com estado de governança ──
  const listed = OPT.list(org);
  check("1.1 lista traz as propostas do autopilot", listed.proposals.length >= 2);
  check("1.2 nenhuma governada ainda", listed.proposals.every((p: any) => p.governed === false && p.actionId === null));

  // ── 2. propose(create_content): vira comando GOVERNADO awaiting_approval (RN-CG-08/10) ──
  const a1 = OPT.propose(org, { kind: "create_content", ref: sig.id }, "owner-1");
  check("2.1 ação criada com command_type growth_optimization", a1.command_type === "growth_optimization" && a1.domain === "social");
  check("2.2 NASCE awaiting_approval (nunca executa direto)", a1.status === "awaiting_approval");
  check("2.3 herda o fio do sinal (correlation_id)", !!a1.correlation_id);
  check("2.4 payload carrega kind+ref+label", (() => { const p = JSON.parse(a1.command_payload_json); return p.kind === "create_content" && p.ref === sig.id && !!p.label; })());

  // ── 3. Idempotência por (kind, ref) ──
  const a1b = OPT.propose(org, { kind: "create_content", ref: sig.id }, "owner-1");
  check("3.1 2ª proposta devolve a MESMA ação (idempotente)", a1b.id === a1.id);
  check("3.2 uma só decision_action de otimização", (db.prepare(`SELECT COUNT(*) AS n FROM decision_actions WHERE organization_id = ? AND action_type = 'growth_optimization'`).get(org) as any).n === 1);

  // ── 4. list() agora marca a proposta governada ──
  const listed2 = OPT.list(org);
  const cc = listed2.proposals.find((p: any) => p.kind === "create_content" && p.ref === sig.id);
  check("4.1 proposta governada anotada", !!cc && cc.governed === true && cc.actionId === a1.id && cc.actionStatus === "awaiting_approval");

  // ── 5. Grounding (RN-CG-09): proposta inexistente é recusada, não inventada ──
  let threw = false;
  try { OPT.propose(org, { kind: "create_content", ref: "nao-existe" }, "owner-1"); } catch { threw = true; }
  check("5.1 proposta obsoleta/inexistente recusada (grounded)", threw);

  // ── 6. RN-CG-08: execute NÃO roda enquanto a ação não está aprovada ──
  let execBlocked = false;
  try { await OPT.execute(org, a1.id); } catch { execBlocked = true; }
  check("6.1 execute barrado em ação não-aprovada", execBlocked);
  check("6.2 nenhum efeito executado ainda", (db.prepare(`SELECT COUNT(*) AS n FROM action_execution_log WHERE action_id = ? AND mode = 'execute' AND status = 'done'`).get(a1.id) as any).n === 0);

  // ── 7. Fluxo governado: aprova → execute roda o efeito (diretiva honesta) ──
  db.prepare(`UPDATE decision_actions SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(a1.id);
  const out = await OPT.execute(org, a1.id);
  check("7.1 execute produz a diretiva de conteúdo", out.result?.effect === "growth_optimization_applied" && /linho/i.test(out.result?.summary || ""));
  check("7.2 efeito registrado (idempotência durável)", (db.prepare(`SELECT COUNT(*) AS n FROM action_execution_log WHERE action_id = ? AND mode = 'execute' AND status = 'done'`).get(a1.id) as any).n === 1);
  // 2º execute barrado (idempotência do executor).
  let dup = false; try { await OPT.execute(org, a1.id); } catch { dup = true; }
  check("7.3 2º execute barrado (idempotência do executor)", dup);

  // ── 8. promote_champion também vira comando governado ──
  const champ = OPT.list(org).proposals.find((p: any) => p.kind === "promote_champion");
  check("8.1 há proposta de campeão", !!champ);
  if (champ) {
    const a2 = OPT.propose(org, { kind: "promote_champion", ref: champ.ref }, "owner-1");
    check("8.2 campeão vira ação awaiting_approval", a2.action_type === "growth_optimization" && a2.status === "awaiting_approval");
    check("8.3 title menciona a variante campeã", /x:A/.test(String(a2.title)));
  } else { check("8.2 campeão vira ação awaiting_approval", false); check("8.3 title menciona a variante campeã", false); }

  // ── 9. Isolamento ──
  check("9.1 org B não vê ações do org A", (db.prepare(`SELECT COUNT(*) AS n FROM decision_actions WHERE organization_id = ?`).get(orgB) as any).n === 0);
  check("9.2 org B lista vazia (autopilot vazio)", OPT.list(orgB).proposals.length === 0);

  // ── 10. Handler registrado no MESMO registry do executor (§37 — sem runtime paralelo) ──
  check("10.1 growth_optimization tem handler registrado", CommandExecutorService.canHandle("growth_optimization"));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} growth-optimization: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
