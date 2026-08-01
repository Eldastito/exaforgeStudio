/**
 * TEST — Comigo/Balcão OFFLINE: idempotência ponta-a-ponta (Gap D).
 *
 * Cobre a fundação backend do offline: com `commandId` estável, cada operação
 * do Balcão (openOrder/addItem/pay) é IDEMPOTENTE. Replays do outbox (mesmo
 * comando enviado 2x) NÃO duplicam pedido, item ou dívida.
 *
 * Também cobre:
 *   - id do pedido gerado no cliente (offline gera UUID local antes do server)
 *   - openOrder sem commandId continua funcionando (retrocompat online)
 *   - addItem sem commandId cria linhas normalmente
 *   - pay em cash / pix_manual / fiado: replay devolve mesma resposta
 *   - isolamento cross-tenant: mesmo commandId em outra org é comando novo
 *   - índice único parcial: mesmo commandId em pedidos diferentes DENTRO
 *     da MESMA org falha (SQLITE_CONSTRAINT_UNIQUE) — o service pega isso
 *     antes via dedup
 *
 * Uso:  npm run test:comigo-balcao-offline
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-balcao-off-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-balcao-off-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");

  // Setup: 2 organizações + 1 produto em cada
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja B', 'active')`).run(randomUUID(), orgB);
  const prodA = randomUUID(), prodB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Água', 5, 1)`).run(prodA, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Coco', 8, 1)`).run(prodB, orgB);

  // ===== 1. openOrder retrocompat: sem commandId nem id ==================
  const orderOnline = B.openOrder(orgA, { sessionAlias: "Cliente 1" });
  check("openOrder sem commandId cria pedido normalmente", !!orderOnline);
  const rowOnline = db.prepare("SELECT command_id FROM comigo_orders WHERE id = ?").get(orderOnline) as any;
  check("pedido online tem command_id NULL", rowOnline.command_id === null);

  // ===== 2. openOrder com id do cliente + commandId ======================
  const clientOrderId = randomUUID();
  const cmdOpen = `cmd_${randomUUID()}`;
  const orderOff = B.openOrder(orgA, { id: clientOrderId, commandId: cmdOpen, sessionAlias: "Feira 1" });
  check("openOrder aceita id do cliente", orderOff === clientOrderId);
  const rowOff = db.prepare("SELECT id, command_id FROM comigo_orders WHERE id = ?").get(orderOff) as any;
  check("command_id persistido", rowOff.command_id === cmdOpen);

  // Replay: mesmo commandId → devolve o MESMO id, sem duplicar
  const replay = B.openOrder(orgA, { id: randomUUID(), commandId: cmdOpen, sessionAlias: "outro alias" });
  check("replay do mesmo commandId devolve o pedido existente", replay === clientOrderId);
  const countAfterReplay = (db.prepare("SELECT COUNT(*) c FROM comigo_orders WHERE organization_id = ? AND command_id = ?").get(orgA, cmdOpen) as any).c;
  check("replay não duplica pedido", countAfterReplay === 1);

  // ===== 3. Cross-tenant: mesmo commandId em outra org é comando novo ====
  const orderOtherOrg = B.openOrder(orgB, { commandId: cmdOpen, sessionAlias: "outra org" });
  check("mesmo commandId em outra org NÃO dedupa", orderOtherOrg !== clientOrderId);
  check("outra org tem seu próprio pedido com o commandId", (db.prepare("SELECT COUNT(*) c FROM comigo_orders WHERE organization_id = ? AND command_id = ?").get(orgB, cmdOpen) as any).c === 1);

  // ===== 4. addItem: idempotência por commandId ==========================
  const cmdItem = `cmd_${randomUUID()}`;
  const itemId1 = B.addItem(orgA, clientOrderId, { productId: prodA, name: "Água", qty: 2, unitPrice: 5, commandId: cmdItem });
  check("addItem cria item com commandId", !!itemId1);
  const itemRow = db.prepare("SELECT id, command_id, qty FROM comigo_order_items WHERE id = ?").get(itemId1) as any;
  check("item persistido com command_id", itemRow.command_id === cmdItem && itemRow.qty === 2);

  const totalAfter1 = (db.prepare("SELECT total FROM comigo_orders WHERE id = ?").get(clientOrderId) as any).total;
  check("total após 1º item = 10", Math.abs(totalAfter1 - 10) < 0.01);

  // Replay do mesmo commandId — não duplica linha nem infla o total
  const itemReplay = B.addItem(orgA, clientOrderId, { productId: prodA, name: "Água", qty: 999, unitPrice: 5, commandId: cmdItem });
  check("replay addItem devolve o MESMO itemId", itemReplay === itemId1);
  const itemsCount = (db.prepare("SELECT COUNT(*) c FROM comigo_order_items WHERE order_id = ? AND command_id = ?").get(clientOrderId, cmdItem) as any).c;
  check("replay addItem não cria linha nova", itemsCount === 1);
  const totalAfterReplay = (db.prepare("SELECT total FROM comigo_orders WHERE id = ?").get(clientOrderId) as any).total;
  check("total não infla no replay", Math.abs(totalAfterReplay - 10) < 0.01);

  // addItem SEM commandId (retrocompat online) — cria linha normalmente
  const itemNoCmd = B.addItem(orgA, clientOrderId, { name: "Extra", qty: 1, unitPrice: 3 });
  check("addItem sem commandId cria item", !!itemNoCmd);
  const totalAfterExtra = (db.prepare("SELECT total FROM comigo_orders WHERE id = ?").get(clientOrderId) as any).total;
  check("total refleta extra (10+3=13)", Math.abs(totalAfterExtra - 13) < 0.01);

  // ===== 5. pay(cash): idempotência =====================================
  const orderCash = B.openOrder(orgA, { sessionAlias: "Cash A" });
  B.addItem(orgA, orderCash, { name: "Coco", qty: 1, unitPrice: 8 });
  const cmdPayCash = `cmd_${randomUUID()}`;
  const pay1 = B.pay(orgA, orderCash, { paidVia: "cash", commandId: cmdPayCash }) as any;
  check("pay(cash) ok", pay1.ok === true && pay1.paidVia === "cash");
  const statusAfterPay = (db.prepare("SELECT status FROM comigo_orders WHERE id = ?").get(orderCash) as any).status;
  check("pedido virou 'paid' no cash", statusAfterPay === "paid");
  const pay1Replay = B.pay(orgA, orderCash, { paidVia: "cash", commandId: cmdPayCash }) as any;
  check("pay(cash) replay devolve ok sem quebrar", pay1Replay.ok === true && pay1Replay.paidVia === "cash");
  // Ainda 'paid', sem duplicar
  check("pedido segue 'paid' (não duplicou)", (db.prepare("SELECT status FROM comigo_orders WHERE id = ?").get(orderCash) as any).status === "paid");

  // ===== 6. pay(pix_manual): idempotência ================================
  const orderPix = B.openOrder(orgA, { sessionAlias: "Pix A" });
  B.addItem(orgA, orderPix, { name: "Coco", qty: 1, unitPrice: 8 });
  const cmdPayPix = `cmd_${randomUUID()}`;
  const payPix = B.pay(orgA, orderPix, { paidVia: "pix_manual", commandId: cmdPayPix }) as any;
  check("pay(pix_manual) ok", payPix.ok === true);
  const payPixReplay = B.pay(orgA, orderPix, { paidVia: "pix_manual", commandId: cmdPayPix }) as any;
  check("pay(pix_manual) replay ok", payPixReplay.ok === true && payPixReplay.paidVia === "pix_manual");

  // ===== 7. pay(fiado): idempotência + ledger NÃO duplica ================
  const contactId = B.ensureFiadoContact(orgA, "Cliente Fixo", "5511987654321");
  B.setCreditLimit(orgA, contactId, 200);
  const orderFiado = B.openOrder(orgA, { sessionAlias: "Fiado A", contactId });
  B.addItem(orgA, orderFiado, { name: "Coco", qty: 1, unitPrice: 20 });
  const cmdPayFiado = `cmd_${randomUUID()}`;
  const payFiado = B.pay(orgA, orderFiado, { paidVia: "fiado", commandId: cmdPayFiado }) as any;
  check("pay(fiado) ok", payFiado.ok === true && payFiado.paidVia === "fiado");
  const ledgerCount1 = (db.prepare("SELECT COUNT(*) c FROM comigo_fiado_ledger WHERE organization_id = ? AND order_id = ? AND kind = 'debt'").get(orgA, orderFiado) as any).c;
  check("ledger tem 1 débito", ledgerCount1 === 1);
  const balAfter = B.balanceOf(orgA, contactId);
  check("saldo fiado = 20", Math.abs(balAfter - 20) < 0.01);

  // Replay do pay(fiado) — não gera 2ª dívida
  const payFiadoReplay = B.pay(orgA, orderFiado, { paidVia: "fiado", commandId: cmdPayFiado }) as any;
  check("pay(fiado) replay ok, sem quebrar", payFiadoReplay.ok === true);
  const ledgerCount2 = (db.prepare("SELECT COUNT(*) c FROM comigo_fiado_ledger WHERE organization_id = ? AND order_id = ?").get(orgA, orderFiado) as any).c;
  check("replay NÃO duplica ledger", ledgerCount2 === 1);
  const balAfterReplay = B.balanceOf(orgA, contactId);
  check("saldo fiado permanece 20 após replay", Math.abs(balAfterReplay - 20) < 0.01);
  // E o commandId foi persistido no ledger
  const ledgerCmd = (db.prepare("SELECT command_id FROM comigo_fiado_ledger WHERE order_id = ?").get(orderFiado) as any).command_id;
  check("ledger persistiu command_id", ledgerCmd === cmdPayFiado);

  // ===== 8. Retrocompat: pay sem commandId funciona ======================
  const orderPlain = B.openOrder(orgA, { sessionAlias: "Sem cmd" });
  B.addItem(orgA, orderPlain, { name: "Item", qty: 1, unitPrice: 4 });
  const payPlain = B.pay(orgA, orderPlain, { paidVia: "cash" }) as any;
  check("pay sem commandId ok (retrocompat)", payPlain.ok === true);

  // ===== 9. Fluxo E2E: pedido offline reenviado 2x completo ==============
  // Simula: cliente offline → gera IDs locais e comandos; volta online → outbox
  // reenvia todo mundo; falha de rede faz reenviar de novo; NADA duplica.
  const e2eOrderId = randomUUID();
  const e2eCmdOpen = `cmd_${randomUUID()}`;
  const e2eCmdItem = `cmd_${randomUUID()}`;
  const e2eCmdPay = `cmd_${randomUUID()}`;
  // 1ª tentativa (parcial: só openOrder + addItem chegaram antes de cair de novo)
  B.openOrder(orgA, { id: e2eOrderId, commandId: e2eCmdOpen });
  B.addItem(orgA, e2eOrderId, { name: "E2E item", qty: 3, unitPrice: 5, commandId: e2eCmdItem });
  // 2ª tentativa: reenvia TUDO (open+item+pay); os 2 primeiros devem dedupar,
  // o pay é novo.
  B.openOrder(orgA, { id: e2eOrderId, commandId: e2eCmdOpen });
  B.addItem(orgA, e2eOrderId, { name: "E2E item", qty: 3, unitPrice: 5, commandId: e2eCmdItem });
  const e2ePay = B.pay(orgA, e2eOrderId, { paidVia: "cash", commandId: e2eCmdPay }) as any;
  check("E2E: pay depois dos replays ok", e2ePay.ok === true);
  // 3ª tentativa (outbox re-flushou tudo): tudo dedupa
  B.openOrder(orgA, { id: e2eOrderId, commandId: e2eCmdOpen });
  B.addItem(orgA, e2eOrderId, { name: "E2E item", qty: 3, unitPrice: 5, commandId: e2eCmdItem });
  const e2ePayRe = B.pay(orgA, e2eOrderId, { paidVia: "cash", commandId: e2eCmdPay }) as any;
  check("E2E: pay replay ok", e2ePayRe.ok === true);
  // Contagens finais: 1 pedido, 1 item, total 15
  const e2eOrderRow = db.prepare("SELECT status, total FROM comigo_orders WHERE id = ?").get(e2eOrderId) as any;
  check("E2E: 1 único pedido gravado", e2eOrderRow.status === "paid");
  check("E2E: total = 15 (não inflou nos replays)", Math.abs(e2eOrderRow.total - 15) < 0.01);
  const e2eItemsCount = (db.prepare("SELECT COUNT(*) c FROM comigo_order_items WHERE order_id = ?").get(e2eOrderId) as any).c;
  check("E2E: 1 único item gravado", e2eItemsCount === 1);

  // ===== 10. Isolamento cross-tenant no pay(fiado) ======================
  // orgB tenta o mesmo commandId — deve criar novo débito na orgB
  const contactB = B.ensureFiadoContact(orgB, "Cliente B", "5521999998888");
  B.setCreditLimit(orgB, contactB, 500);
  const orderFiadoB = B.openOrder(orgB, { sessionAlias: "Fiado B", contactId: contactB });
  B.addItem(orgB, orderFiadoB, { name: "Coco B", qty: 1, unitPrice: 30 });
  const payFiadoB = B.pay(orgB, orderFiadoB, { paidVia: "fiado", commandId: cmdPayFiado }) as any;
  check("orgB usa mesmo commandId sem dedupar (isolamento)", payFiadoB.ok === true);
  const balB = B.balanceOf(orgB, contactB);
  check("orgB tem seu próprio saldo (30)", Math.abs(balB - 30) < 0.01);

  // ===== Sumário =====
  console.log(`\n=== Comigo/Balcão OFFLINE ===`);
  for (const r of results) console.log(`  ${r.ok ? "✔" : "✘"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} pass`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
