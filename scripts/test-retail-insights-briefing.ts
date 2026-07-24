/**
 * TESTE — Sinais do negócio no briefing (WhatsApp) e no Diretor IA, generalizados
 * para TODOS os domínios (ADR-136).
 *
 * Prova que o Pareto de sinais abertos (ImpactPrioritizationService) chega onde o
 * gestor lê — não só varejo, mas produção, compras, pessoas, estoque, vendas e
 * finanças:
 *   - o briefing da manhã (BusinessTutorService) ganha a seção "Sinais da operação"
 *     alimentada pelo Pareto, EXCLUINDO finanças (já coberto pelas prioridades da
 *     Central de Saúde) — logo produção/varejo chegam ao WhatsApp;
 *   - o panorama do Diretor IA (businessSignalsBlock) lista os sinais de TODOS os
 *     domínios (finance + production + retail_ops), provando a generalização;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-insights-briefing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-insights-brief-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-insights-brief-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");
  const { BusinessTutorService } = await import("../src/server/BusinessTutorService.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");

  const G = `org_G_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'G', 'active')`).run(randomUUID(), G);

  // Sinais abertos em TRÊS domínios distintos (como os publicadores criariam).
  BusinessSignalService.publish(G, {
    domain: "finance", signalType: "receivable_overdue", severity: "risk", basis: "fact", confidence: 1,
    impactAmount: 5000, impactUnit: "BRL", sourceService: "FinanceSignalPublisher",
    evidence: { count: 3 }, dedupeKey: "fin:recv:1",
  });
  BusinessSignalService.publish(G, {
    domain: "production", signalType: "production_order_delayed", severity: "risk", basis: "fact", confidence: 1,
    impactAmount: 20, impactUnit: "units", sourceService: "ProductionSignalPublisher",
    evidence: { orders: 4 }, dedupeKey: "prod:delay:1",
  });
  BusinessSignalService.publish(G, {
    domain: "retail_ops", signalType: "retail_seller_concentration", severity: "attention", basis: "fact", confidence: 1,
    impactAmount: null, impactUnit: null, sourceService: "RetailOpsSignalPublisher",
    evidence: { seller: "Ana", pct: 90 }, dedupeKey: "retail:seller_conc:1",
  });

  // O Pareto enxerga os três domínios.
  const pri = ImpactPrioritizationService.prioritize(G, { globalLimit: 8 }).global;
  const domains = new Set(pri.map((p: any) => p.domain));
  check("Pareto abrange os 3 domínios", domains.has("finance") && domains.has("production") && domains.has("retail_ops"), JSON.stringify([...domains]));

  // Briefing da manhã: seção "Sinais da operação" alimentada pelo Pareto, sem finanças.
  const brief = BusinessTutorService.morningBrief(G);
  check("briefing WhatsApp inclui 'Sinais da operação'", brief.text.includes("Sinais da operação"), brief.text.slice(0, 400));
  check("briefing leva o sinal de varejo (não-finanças) ao WhatsApp", /Distribuir vendas|formar mais vendedores/i.test(brief.text), brief.text);
  check("briefing NÃO duplica finanças na seção da operação", !/Cobrar recebíveis vencidos/i.test(brief.text.split("Sinais da operação")[1] || ""));

  // Panorama do Diretor IA: bloco generalizado com TODOS os domínios.
  const block = ExecutiveAdvisorService.businessSignalsBlock(G);
  check("Diretor: cabeçalho 'PRIORIDADES DO NEGÓCIO'", block.includes("PRIORIDADES DO NEGÓCIO"), block.slice(0, 160));
  check("Diretor: inclui [finance]", block.includes("[finance]"));
  check("Diretor: inclui [production]", block.includes("[production]"));
  check("Diretor: inclui [retail_ops]", block.includes("[retail_ops]"));

  // Isolamento: org sem sinais não polui briefing nem Diretor.
  const H = `org_H_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'H', 'active')`).run(randomUUID(), H);
  check("isolamento: org H sem 'Sinais da operação' no briefing", !BusinessTutorService.morningBrief(H).text.includes("Sinais da operação"));
  check("isolamento: Diretor H sem bloco de prioridades", ExecutiveAdvisorService.businessSignalsBlock(H) === "");

  console.log("\n=== Sinais do negócio no briefing + Diretor IA (generalizados) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
