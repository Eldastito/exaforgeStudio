/**
 * TEST — Recovery Viability / IRF + diagnóstico estrutural (PRD-ZF-UNIFIED-GAP-CLOSURE-03
 * F3.6/F3.7, PR-6). O IRF ESTENDE o índice de sobrevivência (não cria índice paralelo):
 * reusa o score existente como base + dimensões de dívida (servibilidade + estrutura).
 *
 * Cobre: composição/estrutura + reuso do SurvivalIndexService (0-regressão) · dimensões de
 * dívida (sem dívida=100; sem parcela=neutro+caveat; vencido penaliza; negociabilidade) ·
 * determinismo · matriz de crise (classifyCrisis puro) · IRF cai com dívida ruim · isolamento.
 *
 * Uso: npm run test:recovery-viability
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-irf-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-irf-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RecoveryViabilityService: V } = await import("../src/server/RecoveryViabilityService.js");
  const { RecoveryDebtService: D } = await import("../src/server/RecoveryDebtService.js");
  const { SurvivalIndexService: SI } = await import("../src/server/SurvivalIndexService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // ── 1. Org vazia: estrutura + honestidade ──
  const v0 = V.viability(A);
  check("1.1 3 componentes com pesos 55/30/15", v0.components.length === 3 && v0.components[0].weight === 55 && v0.components[1].weight === 30 && v0.components[2].weight === 15);
  check("1.2 faixa indefinido sem base op e sem dívida", v0.faixa === "indefinido");
  check("1.3 org vazia → sem crise afirmada (stable|undetermined)", v0.crisis.shape === "stable" || v0.crisis.shape === "undetermined");
  check("1.4 disclaimer presente (não é parecer)", /orientativo/.test(v0.disclaimer));
  check("1.5 sem dívida: servibilidade e estrutura = 100", v0.components[1].score === 100 && v0.components[2].score === 100);

  // ── 2. Reuso do índice de sobrevivência (0-regressão: mesmo número) ──
  const siScore = SI.score(A).score;
  check("2.1 componente base = score do SurvivalIndexService", v0.components[0].score === siScore);

  // ── 3. Dívida sem parcela mensal → servibilidade neutra + caveat ──
  D.create(A, { creditor: "Banco", category: "loan", amountTotal: 100000, amountOverdue: 0 }, "u1");
  const v1 = V.viability(A);
  check("3.1 servibilidade neutra sem parcela", v1.components[1].score === 50 && v1.components[1].hasData === false);
  check("3.2 caveat de parcela não informada", v1.caveats.some((c) => /[Pp]arcelas mensais não informadas/.test(c)));

  // ── 4. Dívida totalmente vencida → estrutura penalizada ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  D.create(B, { creditor: "X", category: "supplier", amountTotal: 10000, amountOverdue: 10000, negotiability: "low" }, "u1");
  const vB = V.viability(B);
  check("4.1 estrutura penalizada por vencido (< 100)", vB.components[2].score < 100);
  check("4.2 nota menciona vencida", /vencida/.test(vB.components[2].note));

  // negociabilidade alta melhora a estrutura vs baixa (mesmo vencido)
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), C);
  D.create(C, { creditor: "Y", category: "supplier", amountTotal: 10000, amountOverdue: 10000, negotiability: "high" }, "u1");
  const vC = V.viability(C);
  check("4.3 negociabilidade alta > estrutura que baixa", vC.components[2].score > vB.components[2].score);

  // ── 5. IRF cai com dívida vencida: A (sem vencido) vs B (vencido total), bases op ~neutras ──
  check("5.1 estrutura de B (vencido) < estrutura de A (sem vencido)", vB.components[2].score < v1.components[2].score);
  check("5.2 IRF de B (vencido) < IRF de A (sem vencido)", (vB.irf ?? 100) < (v1.irf ?? 0));

  // ── 6. Determinismo ──
  const d1 = V.viability(B), d2 = V.viability(B);
  check("6.1 determinístico (IRF igual em 2 chamadas)", d1.irf === d2.irf && d1.crisis.shape === d2.crisis.shape);

  // ── 7. Matriz de crise (classifyCrisis puro) ──
  const undet = V.classifyCrisis({ opResult: -100, opResultAffirmable: false, hasDebt: true, coverage: 0.2, survivalDays: 10, totalOverdue: 100, totalKnown: 100 });
  check("7.1 undetermined quando op não afirmável", undet.shape === "undetermined");
  const oper = V.classifyCrisis({ opResult: -500, opResultAffirmable: true, hasDebt: false, coverage: null, survivalDays: 120, totalOverdue: 0, totalKnown: 0 });
  check("7.2 operational: op negativo, sem pressão de dívida", oper.shape === "operational");
  const fin = V.classifyCrisis({ opResult: 1000, opResultAffirmable: true, hasDebt: true, coverage: 0.5, survivalDays: 30, totalOverdue: 0, totalKnown: 5000 });
  check("7.3 financial: op positivo, serviço não coberto", fin.shape === "financial");
  const mixed = V.classifyCrisis({ opResult: -200, opResultAffirmable: true, hasDebt: true, coverage: 0.4, survivalDays: 20, totalOverdue: 500, totalKnown: 1000 });
  check("7.4 mixed: op negativo E pressão de dívida", mixed.shape === "mixed");
  const stable = V.classifyCrisis({ opResult: 2000, opResultAffirmable: true, hasDebt: true, coverage: 3, survivalDays: 200, totalOverdue: 0, totalKnown: 1000 });
  check("7.5 stable: op positivo, dívida coberta", stable.shape === "stable");

  // ── 8. Isolamento ──
  check("8.1 A e B independentes (dívida de B não afeta A)", V.viability(A).components[2].score !== vB.components[2].score || D.summary(A).itemsCount !== D.summary(B).itemsCount);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} recovery-viability: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
