/**
 * TEST — Outcome Measurement / Impact Ledger unificado (ADR-136, Epic 2 — C2b).
 * Esperado × realizado por ação; fato ≠ estimativa; ponte do caixa legado.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:outcome-measurement
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-outcomes-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-outcomes-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { OutcomeMeasurementService: O } = await import("../src/server/OutcomeMeasurementService.js");
  const { CashActionService: C } = await import("../src/server/CashActionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ===== 1. Concluir uma ação registra o outcome esperado×realizado =====
  const c = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar R$ 4.200", expectedImpact: 4200, basis: "estimate" });
  D.approve(orgA, c.id, "user-1");
  const done = D.complete(orgA, c.id, { resultAmount: 3800 });
  check("concluir gera 1 outcome na ação", (done.outcomes || []).length === 1);
  const oc = (done.outcomes || [])[0];
  check("outcome carrega esperado (4200) e realizado (3800)", oc && oc.expected_value === 4200 && oc.realized_value === 3800);
  check("outcome herda a basis da ação (estimate)", oc && oc.basis === "estimate" && oc.measurement_method === "self_reported");

  // ===== 2. forAction lista os outcomes =====
  check("forAction devolve o outcome da ação", O.forAction(orgA, c.id).length === 1);

  // ===== 3. record manual valida ação existente e isolamento =====
  let threwGhost = false;
  try { O.record(orgA, "ação-inexistente", { realizedValue: 1 }); } catch { threwGhost = true; }
  check("record em ação inexistente lança erro", threwGhost);

  // ===== 4. Ledger unificado: totais e SEPARAÇÃO fato ≠ estimativa =====
  // Uma ação de venda 'comprovada' (fact).
  const s = D.propose(orgA, { domain: "sales", actionType: "create_task", title: "Venda confirmada", expectedImpact: 1000, basis: "fact" });
  D.complete(orgA, s.id, { resultAmount: 1200 }); // create_task nasce approved → conclui direto
  const led = O.ledger(orgA);
  check("ledger soma esperado (4200+1000=5200)", led.totals.expected === 5200);
  check("ledger soma realizado (3800+1200=5000)", led.totals.realized === 5000);
  check("gap = realizado - esperado (-200)", led.totals.gap === -200);
  check("fato separado do estimado (fact realizado=1200)", led.totals.fact.realized === 1200 && led.totals.fact.expected === 1000);
  check("estimativa separada (estimate realizado=3800)", led.totals.estimate.realized === 3800 && led.totals.estimate.expected === 4200);
  check("ledger junta metadados da ação (domain/title)", led.items.some((i: any) => i.domain === "finance" && i.title.includes("Cobrar")));

  // ===== 5. Ponte do caixa legado: cash_action vinculada espelha outcome =====
  const bridge = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Ponte caixa", expectedImpact: 500, basis: "estimate" });
  D.approve(orgA, bridge.id, "user-1"); // fica 'approved' mas NÃO concluída pela decisão
  const ca = C.create(orgA, { kind: "cobrar_receber", title: "Cobrar fiado", expectedImpact: 500, decisionActionId: bridge.id });
  check("cash_action criada com vínculo", (ca as any).ok === true);
  C.complete(orgA, (ca as any).id, 450);
  const bridgeOutcomes = O.forAction(orgA, bridge.id);
  check("concluir o caixa espelha outcome na decisão vinculada", bridgeOutcomes.length === 1 && bridgeOutcomes[0].realized_value === 450);
  check("outcome-ponte traz evidência de origem (cash_action)", bridgeOutcomes[0].evidence && bridgeOutcomes[0].evidence.source === "cash_action.complete");

  // ===== 6. Caixa SEM vínculo não cria outcome (comportamento legado intacto) =====
  const legacy = C.create(orgA, { kind: "campanha", title: "Campanha solta", expectedImpact: 300 });
  C.complete(orgA, (legacy as any).id, 300);
  check("caixa sem vínculo não gera outcome unificado", O.ledger(orgA).items.every((i: any) => (i.evidence?.cash_action_id || null) !== (legacy as any).id));

  // ===== 7. Isolamento por organização =====
  const orgB = mkOrg();
  check("isolamento: org B tem ledger vazio", O.ledger(orgB).items.length === 0);
  let threwCross = false;
  try { O.record(orgB, c.id, { realizedValue: 1 }); } catch { threwCross = true; }
  check("isolamento: org B não mede ação de A", threwCross);

  console.log("\n=== TEST: Outcome Measurement / Impact Ledger unificado (ADR-136 C2b) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Outcome Measurement OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
