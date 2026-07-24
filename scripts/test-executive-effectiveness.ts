/**
 * TESTE — Painel "O que costuma funcionar" no Diretor (ADR-142 Fatia 3,
 * generalizada). A eficácia APRENDIDA por tipo de ação, de TODOS os domínios
 * (genéricos via PatternMemoryService + varejo via RetailPatternMemoryService),
 * ranqueada — o Diretor passa a saber, do histórico do próprio negócio, o que
 * costuma resolver.
 *
 * Prova: learnedEffectiveness agrega e ranqueia; o bloco entra no panorama do
 * Diretor; isolamento por org. Uso:  npm run test:executive-effectiveness
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-exec-eff-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-exec-eff-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({});

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);

  const cand = (patternType: string, evidenceCount: number) => ([{
    scopeId: "s1", scopeName: "Escopo", patternType, patternKey: "k",
    evidenceCount, confidence: 0.8, impactAmount: evidenceCount, impactUnit: "units",
    evidence: { n: evidenceCount }, fallbackDescription: `${patternType} x${evidenceCount}`,
  }]);

  // Domínio genérico 1: compras → registra desfecho "funcionou" (eficácia 1.0).
  await PatternMemoryService.learn(A, "procurement", cand("fornecedor_atraso_recorrente", 4), { handledTypes: ["fornecedor_atraso_recorrente"], sourceService: "T", hypothesizer: noLLM });
  const procId = PatternMemoryService.list(A, { domain: "procurement" })[0].id;
  PatternMemoryService.recordOutcome(A, procId, { outcome: "worked" });

  // Domínio genérico 2: vendas → desfecho "sem efeito" (eficácia 0.5).
  await PatternMemoryService.learn(A, "sales", cand("produto_queda_giro_recorrente", 4), { handledTypes: ["produto_queda_giro_recorrente"], sourceService: "T", hypothesizer: noLLM });
  const salesId = PatternMemoryService.list(A, { domain: "sales" })[0].id;
  PatternMemoryService.recordOutcome(A, salesId, { outcome: "no_effect" });

  // Varejo (memória própria): simula histórico de eficácia 0.75.
  db.prepare(`INSERT INTO retail_pattern_type_stats (id, organization_id, pattern_type, acted, worked, no_effect, backfired, net_impact, effectiveness) VALUES (?, ?, 'caixa_divergente_recorrente', 2, 1, 1, 0, 0, 0.75)`).run(randomUUID(), A);

  // ===== learnedEffectiveness agrega e ranqueia =====
  const items = ExecutiveAdvisorService.learnedEffectiveness(A);
  check("agrega os 3 domínios (compras, vendas, varejo)", items.length === 3, JSON.stringify(items.map((i: any) => i.domain)));
  check("ranqueado por eficácia desc", items[0].effectiveness === 1 && items[1].effectiveness === 0.75 && items[2].effectiveness === 0.5, JSON.stringify(items.map((i: any) => i.effectiveness)));
  check("inclui o varejo com domínio retail_ops", items.some((i: any) => i.domain === "retail_ops" && i.patternType === "caixa_divergente_recorrente"));
  check("traz a ação recomendada do tipo", /renegociar|alternativo/i.test(items[0].recommendedAction || ""), items[0].recommendedAction);
  check("conta funcionou/sem efeito/piorou", items[1].acted === 2 && items[1].worked === 1 && items[1].noEffect === 1, JSON.stringify(items[1]));

  // ===== Bloco entra no panorama do Diretor =====
  const block = ExecutiveAdvisorService.learnedEffectivenessBlock(A);
  check("bloco tem o cabeçalho 'O QUE COSTUMA FUNCIONAR'", block.includes("O QUE COSTUMA FUNCIONAR"), block.slice(0, 120));
  check("bloco menciona os tipos aprendidos", block.includes("fornecedor_atraso_recorrente") && block.includes("caixa_divergente_recorrente"));
  const panorama = ExecutiveAdvisorService.buildPanorama(A);
  check("panorama do Diretor inclui o bloco", panorama.includes("O QUE COSTUMA FUNCIONAR"));

  // ===== Isolamento =====
  check("isolamento: org B sem eficácia aprendida", ExecutiveAdvisorService.learnedEffectiveness(B).length === 0);
  check("isolamento: bloco vazio p/ org B", ExecutiveAdvisorService.learnedEffectivenessBlock(B) === "");

  console.log("\n=== Painel 'O que costuma funcionar' (Diretor) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
