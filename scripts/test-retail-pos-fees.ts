/**
 * TESTE — Tarifas POS crédito/débito + custo esperado (PDR TOULON, Fatia 3 / POS).
 * ------------------------------------------------------------------------------
 * Prova, offline (RetailPosFeeService):
 *   - set/rules por meio de pagamento (crédito/débito, percent + fixo);
 *   - expectedCost com regra detalhada: valor×% + qtd×fixo por meio;
 *   - AC-05: crédito R$1000 em 10 transações, 2% + R$0,30 → R$23,00;
 *   - AC-06: com regra detalhada NÃO usa a legada (nunca soma as duas);
 *   - sem regra detalhada → fallback legado (card_fee agregado);
 *   - validação (percentual fora de 0..100) + isolamento.
 *
 * Uso:  npm run test:retail-pos-fees
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pos-fees-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-pos-fees-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailPosFeeService: Pos } = await import("../src/server/RetailPosFeeService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Barra', 'B01', 1)`).run(store, A);

  // ===== 0. sem regra → fallback legado (card_fee agregado) =====
  db.prepare(`INSERT INTO retail_store_variable_costs (id, organization_id, store_id, category, percent, fixed_per_sale) VALUES (?, ?, ?, 'card_fee', 3, 0.5)`).run(randomUUID(), A, store);
  const legacy = Pos.expectedCost(A, store, { creditValue: 1000, creditQty: 10, debitValue: 0, debitQty: 0 });
  check("sem detalhada → basis legacy", legacy.basis === "legacy");
  check("legado: 1000×3% + 10×0,50 = 35", legacy.total === 35, `total=${legacy.total}`);

  // ===== 1. set detalhado crédito/débito =====
  const r = Pos.set(A, store, { credit: { percent: 2, fixedPerTransaction: 0.30 }, debit: { percent: 1.5, fixedPerTransaction: 0.10 }, provider: "Sicredi" }, "boss");
  check("rules: crédito 2% + 0,30", r.credit.percent === 2 && r.credit.fixedPerTransaction === 0.3 && r.hasDetailed === true);
  check("rules: débito 1,5% + 0,10", r.debit.percent === 1.5 && r.debit.fixedPerTransaction === 0.1);

  // ===== 2. AC-05: crédito 1000 em 10 transações, 2% + 0,30 → 23,00 =====
  const exp = Pos.expectedCost(A, store, { creditValue: 1000, creditQty: 10, debitValue: 0, debitQty: 0 });
  check("AC-05: custo esperado crédito = 23,00", exp.basis === "detailed" && exp.credit.cost === 23, `cost=${exp.credit.cost}`);

  // ===== 3. AC-06: detalhada NÃO usa a legada (nunca soma) =====
  // legado seria 35; detalhado (só crédito) = 23; débito 0 (sem valor). Total = 23.
  check("AC-06: detalhada substitui legada (total 23, não 23+35)", exp.total === 23);
  // com débito informado, soma os dois meios detalhados
  const exp2 = Pos.expectedCost(A, store, { creditValue: 1000, creditQty: 10, debitValue: 500, debitQty: 5 });
  check("crédito+débito detalhados: 23 + (500×1,5% + 5×0,10) = 23 + 8,00 = 31,00", exp2.total === 31, `total=${exp2.total}`);

  // ===== 4. remover a detalhada de um tipo volta ao legado só quando não sobra nenhuma =====
  Pos.set(A, store, { credit: null, debit: null }, "boss");
  const back = Pos.expectedCost(A, store, { creditValue: 1000, creditQty: 10 });
  check("removidas as detalhadas → volta ao legado (35)", back.basis === "legacy" && back.total === 35);

  // ===== 5. validação =====
  let bad = false;
  try { Pos.set(A, store, { credit: { percent: 150, fixedPerTransaction: 0 } }, "boss"); } catch { bad = true; }
  check("percentual > 100 é rejeitado", bad);

  // ===== 6. isolamento =====
  let iso = false;
  try { Pos.set(B, store, { credit: { percent: 1, fixedPerTransaction: 0 } }, "x"); } catch { iso = true; }
  check("org B não configura tarifa da loja de A", iso);

  console.log("\n=== TEST: Tarifas POS crédito/débito (Fatia 3) ===\n");
  for (const r2 of results) console.log(`${r2.ok ? "✅" : "❌"} ${r2.name}${r2.ok || !r2.detail ? "" : ` — ${r2.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
