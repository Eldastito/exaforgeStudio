/**
 * TESTE — Recuperação de soluções validadas (PRD Moda/TOULON, LEARN-006; ADR-174)
 * ----------------------------------------------------------------------------
 * Prova, offline (ManagerSolutionRetrievalService):
 *   - recupera só soluções PROMOVIDAS de MESMO tipo de problema (contexto);
 *   - declara origem humana + onde funcionou + evidência;
 *   - evidência LOCAL (uma loja) → não generalizável + cautela de teste;
 *   - evidência de REDE + confiante → generalizable, mas cautela de acompanhar;
 *   - confiança baixa → "insuficiente / hipótese";
 *   - revogada (dormant) NÃO aparece (LEARN-007);
 *   - tipo diferente de problema não casa;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:manager-solution-retrieval
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgr-sol-retr-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-mgr-sol-retrieval-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ManagerSolutionService } = await import("../src/server/ManagerSolutionService.js");
  const { ManagerSolutionRetrievalService } = await import("../src/server/ManagerSolutionRetrievalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;
  const author = randomUUID(), boss = randomUUID();
  const storeA = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Savassi', 'L1', 1)`).run(storeA, A);

  // Um PADRÃO de problema (divergência) — o "contexto" a consultar.
  const problem = randomUUID();
  db.prepare(`INSERT INTO retail_store_patterns (id, organization_id, store_id, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?, ?, ?, 'caixa_divergente_recorrente', 'k1', 'Caixa diverge às sextas', 0.8, 'validated', 3)`).run(problem, A, storeA);
  // Outro padrão de OUTRO tipo (não deve casar).
  const problemOther = randomUUID();
  db.prepare(`INSERT INTO retail_store_patterns (id, organization_id, store_id, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?, ?, ?, 'estoque_negativo_recorrente', 'k2', 'Estoque negativo', 0.7, 'validated', 2)`).run(problemOther, A, storeA);

  // Helper: cria proposta ligada a um padrão, leva a promoted com dada confiança/escopo.
  const promote = (storeId: string | null, refPatternId: string, conf: number) => {
    const p = ManagerSolutionService.create(A, { storeId, refType: "pattern", refId: refPatternId, title: "Dupla conferência", proposal: "Conferir caixa a dois no fechamento." }, author);
    ManagerSolutionService.submit(A, p.id, author);
    ManagerSolutionService.approveForTest(A, p.id, boss, true);
    ManagerSolutionService.startTest(A, p.id, null, boss);
    ManagerSolutionService.recordOutcome(A, p.id, { final: 20, confidence: conf, period: "30d" }, boss);
    return ManagerSolutionService.promote(A, p.id, boss, true);
  };

  // Solução LOCAL (loja) confiante para o problema de divergência.
  promote(storeA, problem, 0.8);

  // ===== 1. Recupera pelo padrão (mesmo tipo) =====
  const sols = ManagerSolutionRetrievalService.forPattern(A, problem);
  check("recupera 1 solução do mesmo tipo", sols.length === 1, `n=${sols.length}`);
  const s = sols[0];
  check("declara origem humana + autor", s.origin === "humana" && s.author_user_id === author);
  check("declara onde funcionou (loja)", s.whereWorked === "Savassi" && s.scope === "loja");
  check("evidência com confiança/final", s.evidence.final === 20 && s.evidence.confidence === 0.8);
  check("LOCAL → não generalizável + cautela de teste", s.generalizable === false && /teste controlado/.test(s.caveat));

  // ===== 2. Não casa com outro TIPO de problema =====
  check("tipo diferente não recupera", ManagerSolutionRetrievalService.forPattern(A, problemOther).length === 0);

  // ===== 3. REDE + confiante → generalizável (mas com cautela de acompanhar) =====
  promote(null, problem, 0.9);
  const sols2 = ManagerSolutionRetrievalService.forPattern(A, problem);
  const net = sols2.find((x: any) => x.scope === "rede");
  check("solução de rede recuperada", !!net);
  check("rede+confiante → generalizable", net.generalizable === true && /ACOMPANHAR/i.test(net.caveat));

  // ===== 4. Confiança baixa → insuficiente/hipótese =====
  promote(null, problem, 0.3);
  const sols3 = ManagerSolutionRetrievalService.forPattern(A, problem);
  const weak = sols3.find((x: any) => x.evidence.confidence === 0.3);
  check("confiança baixa → não generalizável + hipótese", weak.generalizable === false && /insuficiente|HIP/i.test(weak.caveat));

  // ===== 5. Revogada some (LEARN-007) =====
  const before = ManagerSolutionRetrievalService.forPattern(A, problem).length;
  // revoga a primeira local
  const firstLocal = db.prepare(`SELECT pattern_key FROM retail_store_patterns WHERE organization_id = ? AND pattern_type='manager_solution' AND store_id = ? LIMIT 1`).get(A, storeA) as any;
  const propId = String(firstLocal.pattern_key).slice("solution:".length);
  ManagerSolutionService.revoke(A, propId, "não sustentou", boss);
  const after = ManagerSolutionRetrievalService.forPattern(A, problem).length;
  check("revogada some da recuperação", after === before - 1, `${before}→${after}`);

  // ===== 6. Isolamento =====
  check("org B não recupera soluções da A", ManagerSolutionRetrievalService.retrieve(B, { patternType: "caixa_divergente_recorrente" }).length === 0);

  console.log("\n=== TEST: Recuperação de soluções validadas (LEARN-006) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
