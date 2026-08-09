/**
 * TEST — Decision Intelligence DI-5.1 (ADR-157): LlmResearchProvider + custo real.
 *
 * O provider usa a IA que já roda no repo (chat()/llm.js) para sintetizar o
 * panorama do nicho. Guardrails testados OFFLINE (sem chave de IA):
 * - `stub` segue como default do registry; `llm` é selecionável por env/nome.
 * - Sem OPENAI_API_KEY, o LlmResearchProvider cai no stub determinístico
 *   (RN-157-5) — nunca lança, CI verde.
 * - Query/conteúdo derivam só da taxonomia (vertical, topic, region, timeframe)
 *   e não carregam PII (RN-157-1).
 * - O custo por chamada é registrado no `research_usage_log` (ADR-156 D6) e o
 *   orçamento de plataforma bloqueia a chamada PAGA antes do provider.
 * - O compartilhado nunca tem `organization_id`.
 *
 * Uso: npm run test:decision-intelligence-di5
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di5-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di5-1234567890";
// Determinismo: garante o caminho offline (fallback pro stub) independente do
// ambiente de CI — o LlmResearchProvider não deve lançar nem chamar rede aqui.
delete process.env.OPENAI_API_KEY;
delete process.env.EXTERNAL_RESEARCH_PROVIDER;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchBudgetService: Budget } = await import("../src/server/ResearchBudgetService.js");
  const { getResearchProvider, LlmResearchProvider } = await import("../src/server/ExternalResearchProvider.js");
  const { containsPII } = await import("../src/server/researchAnonymize.js");

  // ===================== Seleção de provider =====================
  check("provider 'llm' é selecionável por nome", getResearchProvider("llm").name === "llm");
  check("default do registry segue 'stub'", getResearchProvider().name === "stub");
  process.env.EXTERNAL_RESEARCH_PROVIDER = "llm";
  check("env EXTERNAL_RESEARCH_PROVIDER seleciona o provider", getResearchProvider().name === "llm");
  delete process.env.EXTERNAL_RESEARCH_PROVIDER;
  check("LlmResearchProvider tem nome 'llm'", new LlmResearchProvider().name === "llm");

  // ===================== research() offline: fallback determinístico =====================
  const q = { vertical: "moda", topic: "inverno", region: "brasil", timeframe: "2026", query: "moda inverno brasil 2026" };
  const res = await getResearchProvider("llm").research(q);
  check("llm.research offline não lança e devolve conteúdo", !!res && !!res.content);
  check("offline cai no stub determinístico (generatedBy=stub)", res.content?.generatedBy === "stub");
  check("confidence normalizada em [0,1]", typeof res.confidence === "number" && res.confidence >= 0 && res.confidence <= 1);
  check("conteúdo sem PII (RN-157-1)", !containsPII(JSON.stringify(res.content)));
  check("escopo deriva só da taxonomia do nicho", typeof res.content?.scope === "string" && res.content.scope.includes("moda") && res.content.scope.includes("inverno") && res.content.scope.includes("brasil"));

  // ===================== Custo real: registro no research_usage_log =====================
  Budget.setBudgetCents(0); // ilimitado (só pra exercitar o registro sem bloquear)
  const before = (db.prepare("SELECT COUNT(*) c FROM research_usage_log").get() as any).c;
  await VIS.runResearch({ userId: "admin1" }, { vertical: "servicos", topic: "x" }, { providerName: "llm" });
  const after = (db.prepare("SELECT COUNT(*) c FROM research_usage_log").get() as any).c;
  check("runResearch(provider=llm) registra 1 uso no ledger de plataforma", after === before + 1);
  const logRow = db.prepare("SELECT provider, cost_cents FROM research_usage_log ORDER BY created_at DESC LIMIT 1").get() as any;
  check("uso registra o nome do provider ('llm')", logRow.provider === "llm");
  check("offline (fallback stub) custa 0 — não gasta orçamento", Number(logRow.cost_cents) === 0);

  // ===================== budget_exceeded bloqueia a chamada PAGA antes do provider =====================
  Budget.setBudgetCents(100);
  const costing = { name: "costing", research: () => ({ content: { summary: "x" }, sources: [], confidence: 0.5, costCents: 200 }) };
  await VIS.runResearch({ userId: "admin1" }, { vertical: "servicos", topic: "y" }, { provider: costing as any });
  check("orçamento esgota após a pesquisa cara (custo real medido)", Budget.status().exhausted === true);
  let blocked = false;
  try { await VIS.runResearch({ userId: "admin1" }, { vertical: "servicos", topic: "z" }, { provider: costing as any }); }
  catch (e: any) { blocked = e?.code === "budget_exceeded"; }
  check("provider pago é bloqueado ANTES de chamar (budget_exceeded)", blocked === true);

  // ===================== Compartilhado sem organization_id =====================
  const rawRow = db.prepare("SELECT * FROM vertical_intelligence LIMIT 1").get() as any;
  check("compartilhado NÃO tem organization_id", !!rawRow && !("organization_id" in rawRow));

  console.log("\n=== TEST: Decision Intelligence DI-5.1 (LlmResearchProvider + custo real) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-5.1 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
