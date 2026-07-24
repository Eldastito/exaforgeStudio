/**
 * TESTE — Memória de Padrões do Varejo (ADR-142 Fatia 1).
 * ----------------------------------------------------------------------------
 * Prova, offline (LLM mockado, zero-token), o loop de aprendizado da loja:
 *   - OFF (default): learnPass é no-op;
 *   - ON: detecta por REGRA divergência de caixa recorrente (4/8 → confiança
 *     0,5, validado) e estoque negativo recorrente (3 alertas → candidato);
 *   - a descrição vem do LLM (mock) → created_by_type='ai'; sem LLM → fallback
 *     determinístico ('rule');
 *   - idempotente: re-passe incrementa occurrences, não duplica;
 *   - decaimento: padrão que some decai e vira 'dormant';
 *   - isolado por organização.
 *
 * Uso:  npm run test:retail-pattern-memory
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-pattern-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-pattern-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailPatternMemoryService, __setRetailPatternHypothesizerForTests } = await import("../src/server/RetailPatternMemoryService.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Toulon 1079", code: "1079" });

  // Fechamentos na janela (asOf 2026-07-24, 8 semanas): 4 divergentes + 4 ok.
  const mkClosing = (date: string, div: string) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, divergence_status) VALUES (?, ?, ?, ?, 'approved', 100, 100, ?)`)
      .run(randomUUID(), A, store.id, date, div);
  for (const d of ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"]) mkClosing(d, "divergent");
  for (const d of ["2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"]) mkClosing(d, "ok");
  // 3 alertas de estoque negativo na janela (produtos distintos p/ a UNIQUE).
  for (const p of ["p1", "p2", "p3"]) db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, alert_type, quantity, status, detected_at) VALUES (?, ?, ?, ?, 'negative_stock', -2, 'open', '2026-07-05 10:00:00')`).run(randomUUID(), A, store.id, p);

  const ASOF = "2026-07-24";

  // ===== 1. OFF (default) — no-op =====
  const off = await RetailPatternMemoryService.learnPass(A, { asOf: ASOF });
  check("OFF: learnPass é no-op", off.enabled === false && off.detected === 0);
  check("OFF: nenhum padrão gravado", RetailPatternMemoryService.list(A).length === 0);

  // ===== 2. ON — detecta por regra, descreve com LLM (mock) =====
  RetailPatternMemoryService.setEnabled(A, true);
  let llmCalls = 0;
  __setRetailPatternHypothesizerForTests(async (_summary, cands) => {
    llmCalls++;
    const out: Record<string, string> = {};
    for (const c of cands) out[`${c.storeId || ""}|${c.patternType}|${c.patternKey}`] = `IA: padrão ${c.patternType} na loja.`;
    return out;
  });

  const r1 = await RetailPatternMemoryService.learnPass(A, { asOf: ASOF });
  check("ON: detectou 2 padrões (divergência + estoque negativo)", r1.detected === 2, JSON.stringify(r1));
  check("ON: 1 validado (divergência)", r1.validated === 1, JSON.stringify(r1));
  check("ON: LLM (mock) chamado 1x", llmCalls === 1, `${llmCalls}`);

  const div = db.prepare(`SELECT * FROM retail_store_patterns WHERE organization_id=? AND pattern_type='caixa_divergente_recorrente'`).get(A) as any;
  check("divergência: validated, confiança 0,5", div && div.status === "validated" && Number(div.confidence) === 0.5, JSON.stringify(div));
  check("divergência: occurrences=1, descrição do LLM (ai)", div && div.occurrences === 1 && div.created_by_type === "ai" && String(div.description).startsWith("IA:"));
  const neg = db.prepare(`SELECT * FROM retail_store_patterns WHERE organization_id=? AND pattern_type='estoque_negativo_recorrente'`).get(A) as any;
  check("estoque negativo: candidate, confiança 0,3", neg && neg.status === "candidate" && Number(neg.confidence) === 0.3, JSON.stringify(neg));

  // ===== 2b. Fatia 2 — padrão validado vira sinal retail_ops + entra no Diretor =====
  check("Fatia 2: publicou >=1 sinal", r1.published >= 1, JSON.stringify(r1));
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND domain='retail_ops' AND signal_type='caixa_divergente_recorrente'`).get(A) as any;
  check("Fatia 2: sinal retail_ops ABERTO p/ a divergência", sig && sig.status === "open", JSON.stringify(sig));
  const block = ExecutiveAdvisorService.retailPatternsBlock(A);
  check("Fatia 2: padrão validado entra no panorama do Diretor", block.includes("PADRÕES APRENDIDOS") && block.includes("caixa_divergente_recorrente"), block.slice(0, 120));
  // Candidato (estoque negativo) NÃO gera sinal aberto nem entra no panorama.
  check("Fatia 2: candidato não vira sinal", !db.prepare(`SELECT id FROM business_signals WHERE organization_id=? AND signal_type='estoque_negativo_recorrente' AND status='open'`).get(A));

  // ===== 3. Idempotência — re-passe incrementa occurrences, não duplica =====
  await RetailPatternMemoryService.learnPass(A, { asOf: ASOF });
  const divRows = db.prepare(`SELECT * FROM retail_store_patterns WHERE organization_id=? AND pattern_type='caixa_divergente_recorrente'`).all(A) as any[];
  check("idempotente: 1 linha de divergência (não duplica)", divRows.length === 1);
  check("idempotente: occurrences=2", divRows[0].occurrences === 2, JSON.stringify(divRows[0]));

  // ===== 4. Decaimento — padrão que some decai e adormece =====
  const d1 = await RetailPatternMemoryService.learnPass(A, { asOf: "2026-12-01" }); // janela sem dados
  check("decay: nada detectado na janela vazia", d1.detected === 0 && d1.decayed >= 2, JSON.stringify(d1));
  const divDecay = db.prepare(`SELECT confidence, status FROM retail_store_patterns WHERE organization_id=? AND pattern_type='caixa_divergente_recorrente'`).get(A) as any;
  check("decay: confiança 0,5 → 0,3 (candidate)", Number(divDecay.confidence) === 0.3 && divDecay.status === "candidate", JSON.stringify(divDecay));
  // Fatia 2: padrão que deixou de valer → sinal RESOLVIDO (para de cutucar o gestor).
  const sigResolved = db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND domain='retail_ops' AND signal_type='caixa_divergente_recorrente'`).get(A) as any;
  check("Fatia 2: padrão decaído resolve o sinal", sigResolved && sigResolved.status === "resolved" && d1.resolved >= 1, JSON.stringify({ sigResolved, resolved: d1.resolved }));
  await RetailPatternMemoryService.learnPass(A, { asOf: "2026-12-15" }); // decai de novo
  const divDormant = db.prepare(`SELECT confidence, status FROM retail_store_patterns WHERE organization_id=? AND pattern_type='caixa_divergente_recorrente'`).get(A) as any;
  check("decay: 0,3 → 0,18 vira 'dormant'", Number(divDormant.confidence) < 0.2 && divDormant.status === "dormant", JSON.stringify(divDormant));

  // ===== 5. Fallback determinístico (sem LLM) =====
  __setRetailPatternHypothesizerForTests(null);
  const C = `org_C_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), C);
  const storeC = RetailStoreService.create(C, { name: "Loja C", code: "9" });
  for (const d of ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"]) db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, divergence_status) VALUES (?, ?, ?, ?, 'approved', 'divergent')`).run(randomUUID(), C, storeC.id, d);
  RetailPatternMemoryService.setEnabled(C, true);
  await RetailPatternMemoryService.learnPass(C, { asOf: ASOF });
  const cDiv = db.prepare(`SELECT description, created_by_type FROM retail_store_patterns WHERE organization_id=? AND pattern_type='caixa_divergente_recorrente'`).get(C) as any;
  check("fallback: sem LLM → descrição determinística ('rule')", cDiv && cDiv.created_by_type === "rule" && String(cDiv.description).includes("Divergência de caixa recorrente"), JSON.stringify(cDiv));

  // ===== 5b. Fatia 3 — desfecho ajusta a eficácia do tipo (aprende o que funciona) =====
  const E = `org_E_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'E', 'active')`).run(randomUUID(), E);
  const storeE = RetailStoreService.create(E, { name: "Loja E", code: "5" });
  for (const d of ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22"]) db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, divergence_status) VALUES (?, ?, ?, ?, 'approved', 'divergent')`).run(randomUUID(), E, storeE.id, d);
  for (const d of ["2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"]) db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, divergence_status) VALUES (?, ?, ?, ?, 'approved', 'ok')`).run(randomUUID(), E, storeE.id, d);
  RetailPatternMemoryService.setEnabled(E, true);
  await RetailPatternMemoryService.learnPass(E, { asOf: ASOF });
  const pe = db.prepare(`SELECT * FROM retail_store_patterns WHERE organization_id=? AND pattern_type='caixa_divergente_recorrente'`).get(E) as any;
  check("Fatia 3: padrão validado p/ registrar desfecho", pe && pe.status === "validated");

  // "Funcionou" → eficácia do tipo sobe (1/1 = 1,0); confiança do padrão sobe.
  const o1 = RetailPatternMemoryService.recordOutcome(E, pe.id, { outcome: "worked", realizedImpact: 300 }, "u1");
  check("Fatia 3: worked → eficácia 1,0", o1.ok && o1.effectiveness === 1, JSON.stringify(o1));
  check("Fatia 3: worked → confiança do padrão sobe (0,5→0,6)", o1.patternConfidence === 0.6, JSON.stringify(o1));

  // "Piorou" → eficácia cai ((1+0)/2 = 0,5); confiança do padrão desce.
  const o2 = RetailPatternMemoryService.recordOutcome(E, pe.id, { outcome: "backfired" }, "u1");
  check("Fatia 3: backfired → eficácia baixa p/ 0,5", o2.ok && o2.effectiveness === 0.5, JSON.stringify(o2));
  check("Fatia 3: backfired → confiança do padrão desce (0,6→0,4)", o2.patternConfidence === 0.4, JSON.stringify(o2));

  // net_impact acumula; desfecho inválido é rejeitado.
  const st = RetailPatternMemoryService.typeStats(E, "caixa_divergente_recorrente")!;
  check("Fatia 3: stats acumulam (acted=2, worked=1, backfired=1, net=300)", st.acted === 2 && st.worked === 1 && st.backfired === 1 && st.net_impact === 300, JSON.stringify(st));
  check("Fatia 3: outcome inválido é rejeitado", RetailPatternMemoryService.recordOutcome(E, pe.id, { outcome: "talvez" }).ok === false);
  check("Fatia 3: padrão inexistente é rejeitado", RetailPatternMemoryService.recordOutcome(E, "nope", { outcome: "worked" }).ok === false);

  // Feed-forward: tipo com eficácia baixa (<=0,25) rebaixa o sinal para 'info'.
  RetailPatternMemoryService.recordOutcome(E, pe.id, { outcome: "backfired" }, "u1"); // acted=3, eff=(1+0+0)/3=0,33
  RetailPatternMemoryService.recordOutcome(E, pe.id, { outcome: "backfired" }, "u1"); // acted=4, eff=(1)/4=0,25
  await RetailPatternMemoryService.learnPass(E, { asOf: ASOF });
  const sigE = db.prepare(`SELECT severity, evidence_json FROM business_signals WHERE organization_id=? AND signal_type='caixa_divergente_recorrente' AND status='open'`).get(E) as any;
  check("Fatia 3: eficácia baixa rebaixa o sinal p/ 'info'", sigE && sigE.severity === "info", JSON.stringify(sigE));

  // ===== 6. Isolamento por organização =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  RetailPatternMemoryService.setEnabled(B, true);
  const rb = await RetailPatternMemoryService.learnPass(B, { asOf: ASOF });
  check("isolamento: org B sem dados → 0 padrões", rb.detected === 0 && RetailPatternMemoryService.list(B).length === 0);

  __setRetailPatternHypothesizerForTests(null);
  console.log("\n=== Memória de Padrões do Varejo (ADR-142 Fatia 1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
