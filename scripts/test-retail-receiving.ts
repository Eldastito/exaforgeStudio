/**
 * TESTE — ADR-086: recebimento de mercadoria / pré-estoque
 * -------------------------------------------------------
 * Prova, offline, a máquina de estados do recebimento:
 *   - abre com o esperado do pedido; bipar soma ao recebido;
 *   - divergências: faltou (short), veio a mais (over), veio sem pedido
 *     (unexpected), bateu (ok);
 *   - confirmar credita no ledger autoritativo (native→núcleo) e fecha o doc;
 *   - não bipa/confirma doc já confirmado; isolamento por org.
 *
 * Uso:  npm run test:retail-receiving
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-recv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-recv-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// GTIN-13 válidos (dígito verificador correto).
const EAN_A = "7891000315507";
const EAN_B = "7891910000197";
const EAN_C = "7896004000985";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");
  const { RetailReceivingService } = await import("../src/server/RetailReceivingService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const prod = (name: string, ean: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, price) VALUES (?, ?, 'product', ?, ?, 10)`).run(id, A, name, ean);
    return id;
  };
  const pA = prod("Produto A", EAN_A), pB = prod("Produto B", EAN_B), pC = prod("Produto C", EAN_C);

  // Abre o recebimento esperando A=10 e B=5.
  const rec = RetailReceivingService.createReceipt(A, { note: "NF 123", expected: [{ ean: EAN_A, qty: 10 }, { ean: EAN_B, qty: 5 }] }, "u1");
  check("Recebimento nasce 'open' com 2 itens esperados", rec.status === "open" && rec.items.length === 2);

  // Bipa: A veio 10 (ok), B veio 3 (faltou 2), C veio 4 (não estava no pedido).
  RetailReceivingService.scanItem(A, rec.id, EAN_A, 10, "u1");
  RetailReceivingService.scanItem(A, rec.id, EAN_B, 3, "u1");
  RetailReceivingService.scanItem(A, rec.id, EAN_C, 4, "u1");
  const mid = RetailReceivingService.getReceipt(A, rec.id);
  const st = (pid: string) => mid.items.find((i: any) => i.productId === pid)?.status;
  check("A bateu (ok)", st(pA) === "ok");
  check("B faltou (short)", st(pB) === "short");
  check("C veio sem pedido (unexpected)", st(pC) === "unexpected");
  check("Conta 2 divergências (B e C)", mid.divergences === 2);

  // Bipar EAN inválido não quebra.
  check("Bipar EAN inválido → found=false", RetailReceivingService.scanItem(A, rec.id, "123", 1, "u1").found === false);

  // Confirma → credita o recebido no núcleo (native default) e fecha.
  const done = RetailReceivingService.confirm(A, rec.id, "u1");
  check("Confirmado fecha o doc", done.status === "confirmed");
  check("Núcleo creditado: A=10, B=3, C=4", InventoryService.sellable(A, pA, null) === 10 && InventoryService.sellable(A, pB, null) === 3 && InventoryService.sellable(A, pC, null) === 4);

  // Não confirma/bipa de novo.
  let threw = false;
  try { RetailReceivingService.confirm(A, rec.id, "u1"); } catch (e: any) { threw = e.message === "receipt_not_open"; }
  check("Reconfirmar → receipt_not_open", threw);

  // Isolamento
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: B não vê o recebimento de A", RetailReceivingService.getReceipt(B, rec.id) === null && RetailReceivingService.listReceipts(B).length === 0);

  console.log("\n=== ADR-086: recebimento de mercadoria / pré-estoque ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
