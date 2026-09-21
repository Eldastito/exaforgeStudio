/**
 * TESTE — Associação manual de item na conferência (ADR-200, Fase 2 / API).
 * ---------------------------------------------------------------------
 * Cobre FiscalReceivingService.mapReceiptItem: associa um item não-mapeado a um
 * produto (mapping_status confirmed) E memoriza fornecedor+cProd para as
 * próximas notas; só em recebimento aberto; valida produto e bloqueios.
 *
 * Banco temporário + fixtures. Uso: npm run test:fiscal-map-receipt-item
 */
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-mapitem-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-mapitem-1234567890";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, "fixtures", "fiscal-inbound");
const readFix = (f: string) => fs.readFileSync(path.join(FIX_DIR, f), "utf8");

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { parseNFeDocument } = await import("../src/server/nfeParser.js");
  const { FiscalDocumentService } = await import("../src/server/FiscalDocumentService.js");
  const { FiscalReceivingService } = await import("../src/server/FiscalReceivingService.js");
  const { FiscalProductMappingService } = await import("../src/server/FiscalProductMappingService.js");
  const { default: db } = await import("../src/server/db.js");

  const ORG = "org-mapitem";
  const DEST = "98765432000155";
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, cnpj) VALUES ('loja-m', ?, 'Loja M', 1, ?)`).run(ORG, DEST);
  // Item 1 (EAN 7891234567895) resolve sozinho; item 2 (FORN-002) fica unresolved
  // e é o alvo da associação manual.
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, active) VALUES ('prod-tee', ?, 'product', 'Camiseta', '7891234567895', 1)`).run(ORG);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active) VALUES ('prod-jeans', ?, 'product', 'Calça Jeans', 1)`).run(ORG);

  const autorizado = parseNFeDocument(readFix("procNFe-autorizado.xml"));
  const p = FiscalDocumentService.persist(ORG, autorizado, { source: "manual_upload" });
  const r = FiscalReceivingService.createExpectedFromDocument(ORG, p.documentId!);
  const rec = FiscalReceivingService.getReceipt(ORG, r.receiptId!);
  const itUnmapped = rec.items.find((i: any) => !i.product_service_id);
  check("item 2 nasce unresolved", !!itUnmapped && itUnmapped.mapping_status === "unresolved");

  // Associa manualmente
  const m = FiscalReceivingService.mapReceiptItem(ORG, r.receiptId!, itUnmapped.id, "prod-jeans", null, "user-1");
  check("mapReceiptItem → ok", m.ok === true, m.reason);
  const recAfter = FiscalReceivingService.getReceipt(ORG, r.receiptId!);
  const itNow = recAfter.items.find((i: any) => i.id === itUnmapped.id);
  check("item agora confirmed + produto", itNow.mapping_status === "confirmed" && itNow.product_service_id === "prod-jeans");
  check("recebimento reporta 0 sem mapeamento", recAfter.unmapped === 0, `unmapped=${recAfter.unmapped}`);

  // Memorizou fornecedor+cProd: resolveItem do mesmo fornecedor+cProd retorna confirmed
  const resolved = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: "12345678000199", supplierProductCode: "FORN-002" });
  check("memorizou fornecedor+cProd (próxima nota resolve sozinha)", resolved.status === "confirmed" && resolved.productServiceId === "prod-jeans");

  // Bloqueios
  const bad = FiscalReceivingService.mapReceiptItem(ORG, r.receiptId!, itUnmapped.id, "nao-existe", null);
  check("produto inexistente → rejeitado", bad.ok === false && bad.reason === "produto inexistente");

  // Após confirmar o recebimento, não dá mais pra mapear
  FiscalReceivingService.setReceived(ORG, r.receiptId!, itNow.id, 8);
  FiscalReceivingService.confirm(ORG, r.receiptId!);
  const afterConfirm = FiscalReceivingService.mapReceiptItem(ORG, r.receiptId!, itNow.id, "prod-jeans", null);
  check("recebimento confirmado → map bloqueado", afterConfirm.ok === false && afterConfirm.reason === "receipt_not_open");

  console.log("\n=== Associação manual de item — Fase 2 / API (ADR-200) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}${rr.detail ? ` — ${rr.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal no teste:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
