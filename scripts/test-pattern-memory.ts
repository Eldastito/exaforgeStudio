/**
 * TESTE — Memória de Padrões GENÉRICA (ADR-142 generalizada, PatternMemoryService).
 *
 * Prova que o loop de aprendizado do varejo virou um motor de domínio-neutro:
 *   1) Motor genérico (domínio sintético "procurement"): LEMBRAR por recorrência
 *      → VALIDAR por regra → REALIMENTAR (padrão validado vira sinal) → DECAIR
 *      quando some (e resolver o sinal) → MEDIR (desfecho ajusta a eficácia do tipo);
 *   2) Um domínio real "aprende" só escrevendo o detector: ProductionPatternMemory
 *      detecta atraso de produção recorrente por produto sobre production_orders,
 *      publica o sinal e ele entra no Pareto com ação recomendada;
 *   3) Opt-in por org + isolamento.
 *
 * Hypothesizer injetado (zero-token). Uso:  npm run test:pattern-memory
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pattern-memory-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pattern-memory-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({}); // hypothesizer vazio → usa fallbackDescription

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { ProductionPatternMemory } = await import("../src/server/ProductionPatternMemory.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);

  // Opt-in só na org A.
  check("padrões desligados por padrão", PatternMemoryService.isEnabled(A) === false);
  PatternMemoryService.setEnabled(A, true);
  check("opt-in liga a memória", PatternMemoryService.isEnabled(A) === true);

  // ===== 1. Motor genérico com domínio sintético "procurement" =====
  const cand = (evidenceCount: number, confidence: number) => ([{
    scopeId: "sup1", scopeName: "Fornecedor X", patternType: "fornecedor_atrasa", patternKey: "atraso",
    evidenceCount, confidence, impactAmount: evidenceCount, impactUnit: "orders",
    evidence: { supplier: "Fornecedor X", late: evidenceCount }, fallbackDescription: `Fornecedor X atrasou ${evidenceCount}x.`,
  }]);
  const opts = { handledTypes: ["fornecedor_atrasa"], sourceService: "TestProcurement", hypothesizer: noLLM };

  const r1 = await PatternMemoryService.learn(A, "procurement", cand(4, 0.8), opts);
  check("aprende e valida (evidência forte)", r1.detected === 1 && r1.validated === 1 && r1.published === 1, JSON.stringify(r1));
  const stored = PatternMemoryService.list(A, { domain: "procurement" });
  check("padrão persistido como validated", stored.length === 1 && stored[0].status === "validated", JSON.stringify(stored[0]?.status));
  check("descrição usa fallback (sem LLM)", /Fornecedor X atrasou/.test(stored[0]?.description || ""));
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND domain='procurement' AND signal_type='fornecedor_atrasa' AND status='open'`).get(A) as any;
  check("padrão validado publicou sinal (domínio procurement)", !!sig && sig.source_service === "TestProcurement", JSON.stringify({ has: !!sig, src: sig?.source_service }));
  const patternId = stored[0].id;

  // Passe seguinte SEM o candidato → decai e resolve o sinal.
  const r2 = await PatternMemoryService.learn(A, "procurement", [], opts);
  check("decai o padrão que sumiu", r2.decayed === 1 && r2.resolved === 1, JSON.stringify(r2));
  const afterDecay = PatternMemoryService.list(A, { domain: "procurement" })[0];
  check("confiança decaiu (0.8→0.48) e virou candidate", afterDecay.status === "candidate" && Number(afterDecay.confidence) < 0.8, JSON.stringify({ st: afterDecay.status, c: afterDecay.confidence }));
  check("sinal do padrão foi resolvido", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='procurement' AND signal_type='fornecedor_atrasa' AND status='open'`).get(A));

  // MEDIR: desfecho ajusta a eficácia aprendida do tipo.
  const rec = PatternMemoryService.recordOutcome(A, patternId, { outcome: "worked", realizedImpact: 3 });
  check("recordOutcome (worked) → eficácia 1.0", rec.ok === true && rec.effectiveness === 1, JSON.stringify(rec));
  const ts = PatternMemoryService.typeStats(A, "procurement", "fornecedor_atrasa");
  check("type-stats registra acted=1, worked=1", !!ts && ts.acted === 1 && ts.worked === 1, JSON.stringify(ts));
  check("outcome inválido é rejeitado", PatternMemoryService.recordOutcome(A, patternId, { outcome: "xpto" }).ok === false);

  // ===== 2. Domínio REAL: produção aprende só com o detector =====
  const today = new Date().toISOString().slice(0, 10);
  const pid = randomUUID();
  db.prepare(`INSERT INTO manufactured_products (id, organization_id, product_service_id, name) VALUES (?, ?, ?, 'Cadeira')`).run(pid, A, randomUUID());
  // 4 ordens do MESMO produto entregues com atraso (completed_at > promised_date) na janela.
  const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  for (let i = 0; i < 4; i++) {
    const promised = daysAgo(20 + i * 3);
    const completed = daysAgo(20 + i * 3 - 5); // 5 dias após o prometido
    db.prepare(`INSERT INTO production_orders (id, organization_id, manufactured_product_id, qty_planned, qty_produced, status, promised_date, completed_at) VALUES (?, ?, ?, 10, 10, 'done', ?, ?)`)
      .run(randomUUID(), A, pid, promised, `${completed} 12:00:00`);
  }
  const rp = await ProductionPatternMemory.learnPass(A, { asOf: today, hypothesizer: noLLM });
  check("produção aprende atraso recorrente (validado)", rp.enabled === true && rp.detected === 1 && rp.validated === 1 && rp.published === 1, JSON.stringify(rp));
  const prodSig = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND domain='production' AND signal_type='producao_atrasada_recorrente' AND status='open'`).get(A) as any;
  check("padrão de produção virou sinal", !!prodSig && prodSig.source_service === "ProductionPatternMemory", JSON.stringify({ has: !!prodSig }));

  // O sinal entra no Pareto com a ação recomendada específica.
  const pareto = ImpactPrioritizationService.prioritize(A, { globalLimit: 12 }).global;
  const prodPri = pareto.find((p: any) => p.signalType === "producao_atrasada_recorrente");
  check("sinal do padrão entra no Pareto", !!prodPri, JSON.stringify(pareto.map((p: any) => p.signalType)));
  check("Pareto sugere atacar o gargalo", /gargalo/i.test(prodPri?.recommendedAction || ""), prodPri?.recommendedAction);

  // ===== 3. Opt-in + isolamento =====
  const rb = await ProductionPatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  check("org B (desligada) não aprende", rb.enabled === false && rb.detected === 0);
  check("isolamento: org B sem padrões", PatternMemoryService.list(B).length === 0);
  check("isolamento: org B sem sinais de padrão", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND source_service IN ('PatternMemoryService','ProductionPatternMemory')`).get(B));

  console.log("\n=== Memória de Padrões genérica (ADR-142 generalizada) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
