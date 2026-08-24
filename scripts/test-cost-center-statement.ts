/**
 * TEST — Extrato do centro de custo (ADR-185 F2). DB-backed, determinístico.
 * Prova: statement compõe despesa (R$, payables) + consumo (qtd por produto+UoM) LADO A LADO,
 * NUNCA somados (RN-CC-4); consumo por produto com sua unidade (não mistura kg+unidade); honesto
 * sem dado; centro inexistente → null; isolamento.
 *
 * Uso: npm run test:cost-center-statement
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ccstmt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ccstmt-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CostCenterStatementService: STMT } = await import("../src/server/CostCenterStatementService.js");
  const { CostCenterService: CC } = await import("../src/server/CostCenterService.js");
  const { FinancialLedgerService: FIN } = await import("../src/server/FinancialLedgerService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  const cozinha = CC.create(A, { name: "Cozinha" });

  // Despesa financeira tagueada à Cozinha: gás 300 + energia 200 = 500.
  FIN.addPayable(A, { description: "Gás", amount: 300, dueDate: "2026-06-10", costCenterId: cozinha.id });
  FIN.addPayable(A, { description: "Energia", amount: 200, dueDate: "2026-06-20", costCenterId: cozinha.id });

  // Consumo de material na Cozinha: 2 produtos com UoM distintas (não misturar).
  const pFarinha = randomUUID(), pOleo = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type) VALUES (?, ?, 'Farinha', 'product')`).run(pFarinha, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type) VALUES (?, ?, 'Óleo', 'product')`).run(pOleo, A);
  const mkConsumption = (product: string, uom: string, qty: number, dir = "out") =>
    db.prepare(`INSERT INTO consumption_events (id, organization_id, product_service_id, cost_center_id, direction, quantity, uom, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-06-15')`).run(randomUUID(), A, product, cozinha.id, dir, qty, uom);
  mkConsumption(pFarinha, "kg", 25); mkConsumption(pOleo, "L", 8);
  mkConsumption(pFarinha, "kg", 5, "in"); // devolução → net 20

  const st = STMT.statement(A, cozinha.id, { from: "2026-06-01", to: "2026-06-30" })!;

  // ── despesa (R$) ──
  check("1.1 nome do centro", st.name === "Cozinha");
  check("1.2 despesa total = 500 (R$, source payables)", st.expense.total === 500 && st.expense.currency === "BRL" && st.expense.source === "payables");

  // ── consumo (qtd por produto+UoM), NUNCA somado com R$ ──
  check("2.1 2 produtos no consumo", st.consumption.items.length === 2);
  const farinha = st.consumption.items.find((i) => i.productId === pFarinha);
  const oleo = st.consumption.items.find((i) => i.productId === pOleo);
  check("2.2 farinha net 20 kg (25 saída − 5 devolução)", farinha?.net === 20 && farinha?.uom === "kg" && farinha?.name === "Farinha");
  check("2.3 óleo net 8 L (unidade distinta, não somada)", oleo?.net === 8 && oleo?.uom === "L");
  check("2.4 note deixa claro que consumo não é R$", /NÃO é R\$/.test(st.consumption.note));
  check("2.5 note do extrato: dimensões nunca somadas", /NUNCA somadas/.test(st.note));

  // ── honesto: centro sem movimento → despesa 0, consumo [] ──
  const vazio = CC.create(A, { name: "Vazio" });
  const sv = STMT.statement(A, vazio.id, { from: "2026-06-01", to: "2026-06-30" })!;
  check("3.1 centro sem dado → despesa 0, consumo []", sv.expense.total === 0 && sv.consumption.items.length === 0);

  // ── centro inexistente / de outra org → null ──
  check("4.1 centro inexistente → null", STMT.statement(A, "nao_existe", {}) === null);
  const ccB = CC.create(B, { name: "Centro B" });
  check("4.2 centro de outra org → null (isolamento)", STMT.statement(A, ccB.id, {}) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} cost-center-statement: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
