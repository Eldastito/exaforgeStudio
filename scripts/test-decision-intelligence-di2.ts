/**
 * TEST — Decision Intelligence DI-2 (aditivo sobre ADR-135/136).
 *   - DecisionEngine: estratégias premortem/red_team/advocate (determinísticas),
 *     roteadas por nível de impacto (L0/L1 não disparam análise profunda).
 *   - DecisionRiskService: grava riscos + publica em business_signals (sem
 *     alerta próprio), ciclo predicted→resolved.
 *   - DecisionSimulatorService.scenarios: banda conservador/base/agressivo.
 * Determinístico, sem chave de IA. Isolado por org.
 *
 * Uso: npm run test:decision-intelligence-di2
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di2-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di2-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionEngine: E } = await import("../src/server/DecisionEngine.js");
  const { DecisionRiskService: R } = await import("../src/server/DecisionRiskService.js");
  const { DecisionSimulatorService: Sim } = await import("../src/server/DecisionSimulatorService.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };

  // ===================== Cenários (banda) =====================
  const orgS = mkOrg();
  const sc = Sim.scenarios(orgS, { base: 1000 });
  check("scenarios: base = valor informado", sc.base.value === 1000);
  check("scenarios: conservador 0.75× / agressivo 1.15×", sc.conservative.value === 750 && sc.aggressive.value === 1150);
  check("scenarios: spread = agressivo - conservador", sc.spread === 400);
  check("scenarios: sem base cai no proxy de receita 30d", Sim.scenarios(orgS).method === "proxy_receita_30d");

  // ===================== Roteamento por impacto =====================
  const orgA = mkOrg();
  F.recordEvent(orgA, { direction: "in", amount: 5000 }); // caixa 5000 (finance disponível)

  // L1 (R$300): NÃO dispara análise profunda.
  const low = E.analyze(orgA, { title: "Enviar follow-up", decisionType: "generic", impactAmount: 300, impactUnit: "BRL" });
  check("L1: análise pulada (baixo impacto)", low.skipped === true && low.applied.length === 0);
  check("L1: recomendação = proceed", low.recommendation.stance === "proceed");

  // L3 (R$150k, severity risk): roda as três estratégias.
  const hi = E.analyze(orgA, { title: "Comprar coleção nova", decisionType: "purchase", impactAmount: 150000, impactUnit: "BRL", severity: "risk", expectedValue: 155000, premises: [{ label: "crescimento de 20%", basis: "estimate", confidence: 0.5 }] });
  check("L3: aplica premortem + red_team + advocate", hi.applied.includes("premortem") && hi.applied.includes("redTeam") && hi.applied.includes("advocate"));
  check("L3: nível reportado é L3", hi.level === "L3" && hi.skipped === false);

  // Pre-Mortem: risco de caixa presente + campos monitoráveis completos.
  const cash = hi.premortem.risks.find((r: any) => r.dedupeKey === "purchase:cash_pressure");
  check("premortem: risco de pressão de caixa presente", !!cash && cash.probability === "high");
  check("premortem: todo risco tem indicador líder + limiar + mitigação", hi.premortem.risks.every((r: any) => r.leadingIndicator && r.threshold && r.mitigation));
  check("premortem: risco de demanda presente", hi.premortem.risks.some((r: any) => r.dedupeKey === "purchase:demand_below_expected"));

  // Red Team: desafia premissa estimada + valor esperado sem fato que sustente.
  check("red_team: desafia a premissa fraca", hi.redTeam.challenges.some((c: any) => c.premise === "crescimento de 20%"));
  check("red_team: desafia o valor esperado sem evidência (espelha PRD §32)", hi.redTeam.challenges.some((c: any) => c.premise === "valor esperado" && c.severity === "risk"));

  // Advocate: tese + upside do cenário agressivo.
  check("advocate: traz tese + suporte + upside", typeof hi.advocate.thesis === "string" && Array.isArray(hi.advocate.support) && hi.advocate.upside != null);

  // Síntese: com riscos altos → cautela; advisória.
  check("recomendação: proceed_with_caution (há riscos altos)", hi.recommendation.stance === "proceed_with_caution" && hi.recommendation.advisory === true);

  // L4: exige aprovação humana (advisório).
  const crit = E.analyze(orgA, { title: "Abrir filial", decisionType: "expansion", impactAmount: 60000, impactUnit: "BRL", severity: "critical" });
  check("L4: postura hold_for_human", crit.level === "L4" && crit.recommendation.stance === "hold_for_human");

  // Modo explícito força a estratégia mesmo em baixo impacto.
  const forced = E.analyze(orgA, { title: "Testinho", impactAmount: 100, impactUnit: "BRL", premises: [] }, { mode: "red_team" });
  check("modo explícito força a estratégia mesmo em L0/L1", forced.applied.length === 1 && forced.applied[0] === "redTeam" && !!forced.redTeam);

  // ===================== Persistência + publicação no ledger =====================
  const orgP = mkOrg();
  F.recordEvent(orgP, { direction: "in", amount: 3000 });
  const decId = "dec_" + randomUUID().slice(0, 8);
  const persisted = E.analyze(orgP, { title: "Comprar estoque grande", decisionType: "purchase", impactAmount: 120000, impactUnit: "BRL", severity: "risk", decisionId: decId }, { mode: "all", persist: true });
  check("persist: gravou riscos em decision_risks", persisted.persisted.ids.length > 0);
  check("persist: publicou sinais monitoráveis (>0)", persisted.persisted.published > 0);
  const dRisks = R.list(orgP, { decisionId: decId });
  check("decision_risks: lista os riscos da decisão", dRisks.length === persisted.persisted.ids.length && dRisks[0].decision_id === decId);
  const decSignals = S.list(orgP, { domain: "decision", status: "open" });
  check("ledger: risco monitorável virou sinal (domain 'decision', reusa business_signals)", decSignals.length === persisted.persisted.published);

  // Reprocessar a mesma decisão é idempotente (dedupe_key) — não duplica.
  const again = E.analyze(orgP, { title: "Comprar estoque grande", decisionType: "purchase", impactAmount: 120000, impactUnit: "BRL", severity: "risk", decisionId: decId }, { mode: "all", persist: true });
  check("persist: idempotente (não duplica riscos)", R.list(orgP, { decisionId: decId }).length === dRisks.length && again.persisted.ids.length === dRisks.length);

  // Resolver um risco fecha também o sinal correspondente.
  const published = dRisks.find((r: any) => r.signal_id);
  const beforeOpen = S.list(orgP, { domain: "decision", status: "open" }).length;
  const resolved = R.resolve(orgP, published.id);
  check("resolve: marca o risco como resolvido", resolved.ok === true && R.list(orgP, { status: "resolved" }).some((r: any) => r.id === published.id));
  check("resolve: fecha o sinal no ledger (resolveByDedupe)", S.list(orgP, { domain: "decision", status: "open" }).length === beforeOpen - 1);

  // ===================== Isolamento =====================
  const orgB = mkOrg();
  check("isolamento: outra org não vê riscos", R.list(orgB).length === 0);
  check("isolamento: outra org não vê sinais de decisão", S.list(orgB, { domain: "decision" }).length === 0);

  console.log("\n=== TEST: Decision Intelligence DI-2 (ADR-135/136 aditivo) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
