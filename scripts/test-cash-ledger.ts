/**
 * TEST — Motor de Caixa, livro-caixa (ADR-125 Fatia 1).
 *
 * Guarda central: VENDA ≠ LUCRO ≠ CAIXA — fiado/recebível não infla o caixa
 * até quitar. Cobre ganchos idempotentes (pull), contas a pagar/receber e
 * isolamento por org. Roda sem chave de IA.
 *
 * Uso: npm run test:cash-ledger
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cash-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cash-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  // ===== 1. Conta padrão + entrada/saída manual =====
  const acc = F.ensureDefaultAccount(orgId);
  check("cria conta padrão 'Caixa'", typeof acc === "string" && F.accounts(orgId).length === 1);
  F.recordEvent(orgId, { direction: "in", amount: 100 });
  F.recordEvent(orgId, { direction: "out", amount: 30 });
  check("caixa atual = 70 (100 entrou, 30 saiu)", near(F.cashOnHand(orgId), 70));
  check("entrada inválida (0) é recusada", F.recordEvent(orgId, { direction: "in", amount: 0 }).ok === false);

  // ===== 2. Idempotência do gancho por source =====
  const r1 = F.recordEvent(orgId, { direction: "in", amount: 50, sourceType: "order", sourceId: "ord-1" });
  const r2 = F.recordEvent(orgId, { direction: "in", amount: 50, sourceType: "order", sourceId: "ord-1" });
  check("evento com source é idempotente (não duplica)", r1.ok && !("deduped" in r1) && r2.ok && ("deduped" in r2));
  check("caixa reflete o gancho só uma vez (120)", near(F.cashOnHand(orgId), 120));

  // ===== 3. Venda paga (core order) vira caixa via syncFromSales =====
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 200)`).run("core-ord-1", orgId);
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'aberto', 999)`).run("core-ord-2", orgId);
  const sync = F.syncFromSales(orgId);
  check("sync cria caixa só do pedido PAGO (não do aberto)", sync.created === 1 && near(F.cashOnHand(orgId), 320));
  check("sync é idempotente (rodar de novo não soma)", F.syncFromSales(orgId).created === 0 && near(F.cashOnHand(orgId), 320));

  // ===== 4. GUARDA CENTRAL: venda no FIADO não vira caixa =====
  const caixaAntes = F.cashOnHand(orgId);
  const cid = B.ensureFiadoContact(orgId, "Fulano", "5511988887777");
  B.setCreditLimit(orgId, cid, 500);
  const o = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o, { name: "Marmita", qty: 4, unitPrice: 25 });
  B.pay(orgId, o, { paidVia: "fiado" }); // 100 no fiado
  F.syncFromSales(orgId);
  check("fiado NÃO entra no caixa", near(F.cashOnHand(orgId), caixaAntes));
  check("fiado aparece em 'a receber' (100)", near(F.summary(orgId).aReceberDetalhe.fiado, 100));

  // ===== 5. Venda à vista no Comigo (pix/dinheiro) VIRA caixa =====
  const o2 = B.openOrder(orgId, {});
  B.addItem(orgId, o2, { name: "Suco", qty: 2, unitPrice: 10 });
  B.pay(orgId, o2, { paidVia: "cash" }); // 20 à vista
  const before = F.cashOnHand(orgId);
  F.syncFromSales(orgId);
  check("venda à vista no Balcão entra no caixa (+20)", near(F.cashOnHand(orgId), before + 20));

  // ===== 6. Contas a pagar: quitar gera saída idempotente =====
  const pay = F.addPayable(orgId, { description: "Fornecedor X", amount: 40, dueDate: today }) as any;
  check("conta a pagar cadastrada", pay.ok && F.listPayables(orgId).length === 1);
  const caixaPre = F.cashOnHand(orgId);
  F.payPayable(orgId, pay.id);
  check("pagar conta gera saída de caixa (−40)", near(F.cashOnHand(orgId), caixaPre - 40));
  check("conta paga sai da lista de abertas", F.listPayables(orgId).length === 0);
  check("pagar de novo é recusado", F.payPayable(orgId, pay.id).ok === false);

  // ===== 7. Contas a receber: receber gera entrada; antes NÃO é caixa =====
  const rec = F.addReceivable(orgId, { description: "Cliente Y", amount: 60, dueDate: today }) as any;
  const caixaPre2 = F.cashOnHand(orgId);
  check("recebível em aberto NÃO está no caixa", near(F.cashOnHand(orgId), caixaPre2) && F.summary(orgId).aReceberDetalhe.manual >= 60);
  F.receiveReceivable(orgId, rec.id);
  check("receber gera entrada de caixa (+60)", near(F.cashOnHand(orgId), caixaPre2 + 60));

  // ===== 8. Realizado do dia =====
  const rz = F.realizedCash(orgId, today, today);
  check("realizado do dia diferencia entrada e saída", rz.inflow > 0 && rz.outflow > 0 && near(rz.net, rz.inflow - rz.outflow));

  // ===== 9. Isolamento por org =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org com caixa zero", near(F.cashOnHand(other), 0) && F.summary(other).aReceber === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Motor de Caixa — livro-caixa (ADR-125 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Motor de Caixa (livro-caixa) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
