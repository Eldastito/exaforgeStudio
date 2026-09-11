/**
 * TEST — Debt Priority Matrix (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.8, PR-7). Prioriza dívidas por
 * 4 eixos (risco jurídico, criticidade operacional, custo financeiro, negociabilidade) — NÃO
 * é ordem jurídica de pagamento (RN-FR-3).
 *
 * Cobre: 4 eixos + composto + ordenação · caveat "não é ordem jurídica" · risco jurídico alto
 * → recomenda profissional · eixos desconhecidos viram dataGaps (null≠pune) · custo por juros/
 * atraso · não expõe R$ · determinismo · isolamento.
 *
 * Uso: npm run test:debt-priority
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dprio-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dprio-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { DebtPriorityService: P } = await import("../src/server/DebtPriorityService.js");
  const { RecoveryDebtService: D } = await import("../src/server/RecoveryDebtService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // Dívida 1: risco jurídico alto (execução fiscal) — deve subir e recomendar profissional.
  const d1 = D.create(A, { creditor: "Fazenda", category: "tax", amountTotal: 30000, amountOverdue: 30000, legalRisk: "high", operationalCriticality: "medium", negotiability: "low" }, "u1");
  // Dívida 2: custo financeiro alto (juros 5%), sem risco jurídico, negociável.
  const d2 = D.create(A, { creditor: "Banco", category: "loan", amountTotal: 50000, amountOverdue: 0, interestRate: 5, legalRisk: "low", operationalCriticality: "low", negotiability: "high" }, "u1");
  // Dívida 3: campos desconhecidos (só o mínimo).
  const d3 = D.create(A, { creditor: "Fornecedor", category: "supplier", amountTotal: 5000 }, "u1");

  const r = P.prioritize(A);
  check("1.1 3 itens priorizados", r.items.length === 3);
  check("1.2 caveat: NÃO é ordem jurídica", r.caveats.some((c) => /NÃO é uma ordem jurídica/.test(c)));
  check("1.3 ordenado por priorityScore desc", r.items[0].priorityScore >= r.items[1].priorityScore && r.items[1].priorityScore >= r.items[2].priorityScore);

  const it1 = r.items.find((x) => x.id === d1.id)!;
  const it2 = r.items.find((x) => x.id === d2.id)!;
  const it3 = r.items.find((x) => x.id === d3.id)!;

  check("2.1 risco jurídico alto pontua 100 no eixo", it1.axes.legalRisk.score === 100 && it1.axes.legalRisk.band === "high");
  check("2.2 legal alto recomenda validação profissional", /profissional|contador|advogado/i.test(it1.recommendedStep));
  check("2.3 reason de legal alto marca validação profissional", /validação profissional/.test(it1.reason));

  check("3.1 juros 5% → custo financeiro alto", it2.axes.financialCost.band === "high" && it2.axes.financialCost.known === true);
  check("3.2 negociável alto + custo alto → recomenda renegociação", /renegocia/i.test(it2.recommendedStep));

  check("4.1 desconhecidos viram dataGaps (não pune forte)", it3.dataGaps.length >= 2 && it3.axes.legalRisk.known === false && it3.axes.legalRisk.band === "unknown");
  check("4.2 d1 (legal alto) prioriza acima de d3 (tudo desconhecido)", it1.priorityScore > it3.priorityScore);

  // ── 5. Não expõe R$ (só scores/bands/labels/razões) ──
  const json = JSON.stringify(r);
  check("5.1 sem campos de dinheiro (amount/total) no output", !/amount|total|R\$/.test(json.replace(/priorityScore/g, "")));

  // ── 6. Determinismo ──
  const r2 = P.prioritize(A);
  check("6.1 determinístico", JSON.stringify(r.items.map((x) => [x.id, x.priorityScore])) === JSON.stringify(r2.items.map((x) => [x.id, x.priorityScore])));

  // ── 7. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("7.1 org B vazia", P.prioritize(B).items.length === 0);

  // ── 8. Canceladas saem da priorização ──
  D.cancel(A, d3.id, "u1");
  check("8.1 cancelada não é priorizada", P.prioritize(A).items.every((x) => x.id !== d3.id));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} debt-priority: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
