/**
 * TEST — Decision Intelligence DI-4.2 (ADR-156 D6): orçamento de pesquisa de
 * PLATAFORMA. Guardrail que precede o provider real (DI-4.4): recusa a pesquisa
 * ANTES de chamar o provider quando o teto mensal estoura. Gasto derivado por
 * SUM (sem contador mutável). Determinístico, offline. Sem chave de IA.
 *
 * Uso: npm run test:decision-intelligence-di4-budget
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di4b-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di4b-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchBudgetService: Budget } = await import("../src/server/ResearchBudgetService.js");

  // Provider que custa 300c por chamada e conta invocações.
  let calls = 0;
  const costingProvider = { name: "costing", research: (q: any) => { calls++; return { content: { summary: `mkt ${q.vertical}` }, sources: [], confidence: 0.5, costCents: 300 }; } };

  // ===================== Ilimitado (default 0) nunca bloqueia =====================
  check("budget default = 0 (ilimitado)", Budget.getBudgetCents() === 0 && Budget.status().unlimited === true);
  await VIS.runResearch(null, { vertical: "moda", topic: "a" }, { provider: costingProvider as any });
  check("ilimitado: pesquisa roda e registra custo", calls === 1 && Budget.spentThisMonthCents() === 300);
  check("status: gasto derivado por SUM (300c)", Budget.status().spentCents === 300);

  // ===================== Teto que permite 1 e barra a 2ª =====================
  Budget.setBudgetCents(500); // já gastou 300; sobra 200
  check("setBudget grava o teto", Budget.getBudgetCents() === 500);
  const st1 = Budget.status();
  check("status: teto 500, gasto 300, restante 200, pct 60", st1.budgetCents === 500 && st1.spentCents === 300 && st1.remainingCents === 200 && st1.pct === 60 && st1.exhausted === false);

  // Ainda não estourou (300 < 500) → deixa rodar mais 1 (fica 600).
  await VIS.runResearch(null, { vertical: "moda", topic: "b" }, { provider: costingProvider as any });
  check("dentro do teto: 2ª pesquisa roda (gasto 600)", calls === 2 && Budget.spentThisMonthCents() === 600);
  check("agora o teto estourou (600 >= 500)", Budget.status().exhausted === true);

  // Estourado → recusa ANTES de chamar o provider.
  let blocked = false, code = "";
  try { await VIS.runResearch(null, { vertical: "moda", topic: "c" }, { provider: costingProvider as any }); }
  catch (e: any) { blocked = true; code = e?.code; }
  check("estourado: runResearch recusa (budget_exceeded)", blocked === true && code === "budget_exceeded");
  check("estourado: o provider NÃO foi chamado (calls segue 2)", calls === 2);

  // ===================== Voltar a ilimitado libera =====================
  Budget.setBudgetCents(0);
  await VIS.runResearch(null, { vertical: "moda", topic: "d" }, { provider: costingProvider as any });
  check("teto 0 volta a liberar a pesquisa", calls === 3);

  // ===================== research_usage_log é de plataforma (sem org) =====================
  const row = db.prepare("SELECT * FROM research_usage_log LIMIT 1").get() as any;
  check("research_usage_log NÃO tem coluna organization_id (plataforma)", !!row && !("organization_id" in row));

  console.log("\n=== TEST: Decision Intelligence DI-4.2 (orçamento de pesquisa) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-4.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
