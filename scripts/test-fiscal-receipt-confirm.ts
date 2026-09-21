/**
 * TESTE — Confirmação do recebimento fiscal (ADR-200, Fase 2, PR C2).
 * ---------------------------------------------------------------------
 * Cobre FiscalReceivingService.setReceived/confirm: credita SÓ o recebido no
 * ledger autoritativo (native=core, supervised=shadow); idempotente por chave
 * de movimento (re-confirm não duplica); quantidade FRACIONADA não credita e
 * é sinalizada (fractional_pending); item sem produto/não-estocável é pulado;
 * documento vira 'completed'.
 *
 * Banco temporário + fixtures. Uso: npm run test:fiscal-receipt-confirm
 */
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-confirm-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-confirm-1234567890";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, "fixtures", "fiscal-inbound");
const readFix = (f: string) => fs.readFileSync(path.join(FIX_DIR, f), "utf8");

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { parseNFeDocument } = await import("../src/server/nfeParser.js");
  const { FiscalDocumentService } = await import("../src/server/FiscalDocumentService.js");
  const { FiscalReceivingService } = await import("../src/server/FiscalReceivingService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { default: db } = await import("../src/server/db.js");

  const DEST = "98765432000155";
  const KEY = "35240612345678000199550010000001231000000122";
  const autorizado = parseNFeDocument(readFix("procNFe-autorizado.xml"));
  const decimal = parseNFeDocument(readFix("procNFe-quantidade-decimal.xml"));

  const coreQty = (orgId: string, productId: string): number => {
    const r = db.prepare(`SELECT quantity_available AS q FROM inventory_items WHERE organization_id = ? AND product_service_id = ? AND variant_id IS NULL`).get(orgId, productId) as any;
    return Number(r?.q || 0);
  };

  // ===== NATIVE: credita no core ==============================================
  const ORG = "org-cf-native";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, retail_stock_source) VALUES (?, ?, 'native')`).run("s-native", ORG);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, cnpj) VALUES ('loja-n', ?, 'Loja N', 1, ?)`).run(ORG, DEST);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, active) VALUES ('prodN', ?, 'product', 'Camiseta', '7891234567895', 1)`).run(ORG);

  const p = FiscalDocumentService.persist(ORG, autorizado, { source: "manual_upload" });
  const r = FiscalReceivingService.createExpectedFromDocument(ORG, p.documentId!);
  const rec = FiscalReceivingService.getReceipt(ORG, r.receiptId!);
  const itMapped = rec.items.find((i: any) => i.product_service_id === "prodN");
  const itUnmapped = rec.items.find((i: any) => !i.product_service_id);

  // recebe 8 (esperado 12) no item mapeado; item sem produto recebe 5 (será pulado)
  FiscalReceivingService.setReceived(ORG, r.receiptId!, itMapped.id, 8);
  FiscalReceivingService.setReceived(ORG, r.receiptId!, itUnmapped.id, 5);

  const c = FiscalReceivingService.confirm(ORG, r.receiptId!);
  check("native: confirm → confirmed", c.status === "confirmed", c.status);
  check("native: creditou 1 item", c.credited === 1, `credited=${c.credited}`);
  check("native: core recebeu 8 (só o recebido, não o esperado)", coreQty(ORG, "prodN") === 8, `qty=${coreQty(ORG, "prodN")}`);
  const recC = FiscalReceivingService.getReceipt(ORG, r.receiptId!);
  check("native: item sem produto sinalizado unmapped", recC.items.find((i: any) => !i.product_service_id)?.ledger_status === "unmapped");
  check("native: recebimento confirmed", recC.status === "confirmed");
  const doc = FiscalDocumentService.getByAccessKey(ORG, KEY);
  check("native: documento → completed", doc?.processing_state === "completed");

  // Idempotência: re-confirm não credita de novo
  const c2 = FiscalReceivingService.confirm(ORG, r.receiptId!);
  check("native: re-confirm → already (idempotente)", c2.status === "already", c2.status);
  check("native: core continua 8 (sem duplicar)", coreQty(ORG, "prodN") === 8, `qty=${coreQty(ORG, "prodN")}`);
  const movs = (db.prepare(`SELECT COUNT(*) AS n FROM fiscal_receipt_movements WHERE receipt_id = ?`).get(r.receiptId) as any).n;
  check("native: 1 chave de movimento gravada", movs === 1, `n=${movs}`);

  // ===== FRACIONADO: não credita, sinaliza ===================================
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, active) VALUES ('prodKG', ?, 'product', 'Tecido KG', '7890000000017', 1)`).run(ORG);
  const pd = FiscalDocumentService.persist(ORG, decimal, { source: "manual_upload" });
  const rd = FiscalReceivingService.createExpectedFromDocument(ORG, pd.documentId!);
  const recd = FiscalReceivingService.getReceipt(ORG, rd.receiptId!);
  const itKg = recd.items[0];
  FiscalReceivingService.setReceived(ORG, rd.receiptId!, itKg.id, 2.5); // fracionado
  const cd = FiscalReceivingService.confirm(ORG, rd.receiptId!);
  check("fracionado: confirm ok mas creditou 0", cd.status === "confirmed" && cd.credited === 0, `credited=${cd.credited}`);
  check("fracionado: core do KG permanece 0", coreQty(ORG, "prodKG") === 0, `qty=${coreQty(ORG, "prodKG")}`);
  const recdC = FiscalReceivingService.getReceipt(ORG, rd.receiptId!);
  check("fracionado: item sinalizado fractional_pending", recdC.items[0].ledger_status === "fractional_pending", recdC.items[0].ledger_status);

  // ===== SUPERVISED: credita na sombra, core intocado ========================
  const ORGS = "org-cf-super";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, retail_stock_source) VALUES (?, ?, 'supervised')`).run("s-super", ORGS);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, cnpj) VALUES ('loja-s', ?, 'Loja S', 1, ?)`).run(ORGS, DEST);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, active) VALUES ('prodS', ?, 'product', 'Camiseta S', '7891234567895', 1)`).run(ORGS);
  const ps = FiscalDocumentService.persist(ORGS, autorizado, { source: "manual_upload" });
  const rs = FiscalReceivingService.createExpectedFromDocument(ORGS, ps.documentId!);
  const recs = FiscalReceivingService.getReceipt(ORGS, rs.receiptId!);
  const itS = recs.items.find((i: any) => i.product_service_id === "prodS");
  FiscalReceivingService.setReceived(ORGS, rs.receiptId!, itS.id, 10);
  const cs = FiscalReceivingService.confirm(ORGS, rs.receiptId!);
  check("supervised: confirm → confirmed, creditou 1", cs.status === "confirmed" && cs.credited === 1);
  const shadow = RetailInventoryService.get(ORGS, "loja-s", "prodS", null);
  check("supervised: sombra da loja recebeu 10", Number(shadow?.quantity_available || 0) === 10, `qty=${shadow?.quantity_available}`);
  check("supervised: core NÃO foi tocado", coreQty(ORGS, "prodS") === 0, `qty=${coreQty(ORGS, "prodS")}`);

  // Relatório ------------------------------------------------------------------
  console.log("\n=== Confirmação do recebimento fiscal — Fase 2 PR C2 (ADR-200) ===\n");
  for (const rr of results) {
    console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}${rr.detail ? ` — ${rr.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
