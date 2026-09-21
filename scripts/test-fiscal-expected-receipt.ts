/**
 * TESTE — Recebimento esperado a partir da NF-e (ADR-200, Fase 2, PR C1).
 * ---------------------------------------------------------------------
 * Cobre FiscalReceivingService.createExpectedFromDocument: cria recebimento
 * (esperado) ligado ao documento + loja, um item por linha fiscal inclusive
 * sem produto resolvido (não descarta), quantidade esperada DECIMAL, SEM
 * movimentar estoque; idempotente por documento; bloqueia sem loja e resumo.
 *
 * Banco temporário + fixtures da Fase 0. Uso: npm run test:fiscal-expected-receipt
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-recv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-recv-1234567890";

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
  const { default: db } = await import("../src/server/db.js");

  const ORG = "org-recv-A";
  const DEST = "98765432000155"; // destinatário nas fixtures
  const KEY = "35240612345678000199550010000001231000000122";
  const KEY_DEC = "35240612345678000199550010000007891000000127";

  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, cnpj) VALUES (?, ?, 'Loja Recv', 1, ?)`).run("loja-recv", ORG, DEST);
  // Produto que casa só o item 1 do procNFe autorizado (EAN 7891234567895).
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, active) VALUES (?, ?, 'product', 'Camiseta', '7891234567895', 1)`).run("prod-1", ORG);

  // Persiste o documento (resolve a loja) --------------------------------------
  const autorizado = parseNFeDocument(readFix("procNFe-autorizado.xml"));
  const p = FiscalDocumentService.persist(ORG, autorizado, { source: "manual_upload" });
  const doc = FiscalDocumentService.getByAccessKey(ORG, KEY);
  check("documento autorizado com loja resolvida", doc?.store_id === "loja-recv" && doc?.processing_state === "ready_for_receipt");

  // Cria recebimento esperado --------------------------------------------------
  const r = FiscalReceivingService.createExpectedFromDocument(ORG, p.documentId!);
  check("createExpected → created", r.status === "created" && !!r.receiptId, r.status);

  const rec = FiscalReceivingService.getReceipt(ORG, r.receiptId!);
  check("cabeçalho: status open", rec?.status === "open");
  check("cabeçalho: ligado ao documento fiscal", rec?.fiscal_document_id === p.documentId);
  check("cabeçalho: loja correta", rec?.store_id === "loja-recv");
  check("um item por linha fiscal (2)", rec?.items?.length === 2);

  const it1 = rec.items.find((i: any) => i.ean === "7891234567895");
  const it2 = rec.items.find((i: any) => i.ean === "7899876543210");
  check("item 1: mapeado por EAN (resolved + produto)", it1?.mapping_status === "resolved" && it1?.product_service_id === "prod-1");
  check("item 2: sem produto NÃO é descartado (unresolved, product null)", !!it2 && it2.mapping_status === "unresolved" && it2.product_service_id === null);
  check("item 2: descrição fiscal preservada p/ exibir", it2?.fiscal_description === "CALCA JEANS SLIM AZUL TAM 42");
  check("recebimento reporta 1 item sem mapeamento", rec?.unmapped === 1);

  // NÃO movimenta estoque ------------------------------------------------------
  const mov = (db.prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE organization_id = ?`).get(ORG) as any).n;
  check("nenhum movimento de estoque na criação", mov === 0, `count=${mov}`);
  const inv = (db.prepare(`SELECT COUNT(*) AS n FROM inventory_items WHERE organization_id = ? AND quantity_available > 0`).get(ORG) as any).n;
  check("nenhum saldo creditado na criação", inv === 0, `count=${inv}`);

  // Documento passa a receipt_open ---------------------------------------------
  const doc2 = FiscalDocumentService.getByAccessKey(ORG, KEY);
  check("documento → processing_state receipt_open", doc2?.processing_state === "receipt_open");
  check("documento → goods_receipt_id setado", doc2?.goods_receipt_id === r.receiptId);

  // Idempotência ---------------------------------------------------------------
  const r2 = FiscalReceivingService.createExpectedFromDocument(ORG, p.documentId!);
  check("recriar → exists (mesmo recibo)", r2.status === "exists" && r2.receiptId === r.receiptId, r2.status);
  const cntItems = (db.prepare(`SELECT COUNT(*) AS n FROM fiscal_goods_receipt_items WHERE receipt_id = ?`).get(r.receiptId) as any).n;
  check("não duplicou itens do recebimento", cntItems === 2, `count=${cntItems}`);

  // Quantidade decimal preservada ----------------------------------------------
  const dec = parseNFeDocument(readFix("procNFe-quantidade-decimal.xml"));
  const pd = FiscalDocumentService.persist(ORG, dec, { source: "manual_upload" });
  const rd = FiscalReceivingService.createExpectedFromDocument(ORG, pd.documentId!);
  const recD = FiscalReceivingService.getReceipt(ORG, rd.receiptId!);
  check("quantidade esperada decimal preservada (2.5)", Number(recD?.items?.[0]?.expected_qty) === 2.5, String(recD?.items?.[0]?.expected_qty));

  // Bloqueios ------------------------------------------------------------------
  const ORG_NO = "org-recv-nostore";
  const pNo = FiscalDocumentService.persist(ORG_NO, autorizado, { source: "manual_upload" });
  const rNo = FiscalReceivingService.createExpectedFromDocument(ORG_NO, pNo.documentId!);
  check("sem loja resolvida → blocked (store_assignment_required)", rNo.status === "blocked" && rNo.reason === "store_assignment_required", `${rNo.status}/${rNo.reason}`);

  const ORG_SUM = "org-recv-sum";
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, cnpj) VALUES (?, ?, 'Loja Sum', 1, ?)`).run("loja-sum", ORG_SUM, DEST);
  const resumo = parseNFeDocument(readFix("resNFe.xml"));
  const pSum = FiscalDocumentService.persist(ORG_SUM, resumo, { source: "provider" });
  const rSum = FiscalReceivingService.createExpectedFromDocument(ORG_SUM, pSum.documentId!);
  check("resumo (summary_only) → blocked (não é XML autorizado)", rSum.status === "blocked", `${rSum.status}`);

  // Relatório ------------------------------------------------------------------
  console.log("\n=== Recebimento esperado — Fase 2 PR C1 (ADR-200) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
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
