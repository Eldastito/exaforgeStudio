/**
 * TESTE — Mapeamento item fiscal → produto/variante (ADR-200, Fase 2, PR B).
 * ---------------------------------------------------------------------
 * Cobre FiscalProductMappingService: resolução por EAN, memória confirmada
 * fornecedor+cProd (prioridade sobre EAN), upsert do confirmMapping,
 * normalização de CNPJ, fallback quando o produto do mapa some, e isolamento
 * por org.
 *
 * Banco temporário. Uso: npm run test:fiscal-product-mapping
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-map-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-map-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { FiscalProductMappingService } = await import("../src/server/FiscalProductMappingService.js");
  const { default: db } = await import("../src/server/db.js");

  const ORG = "org-map-A";
  const ORG2 = "org-map-B";
  const SUP = "12345678000199";       // emitente das fixtures (fornecedor)
  const EAN1 = "7891234567895";

  function addProduct(orgId: string, id: string, name: string, ean: string | null, externalRef: string | null = null) {
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, ean, external_ref, active) VALUES (?, ?, 'product', ?, ?, ?, 1)`)
      .run(id, orgId, name, ean, externalRef);
  }

  const prodEan = randomUUID();
  const prodMapped = randomUUID();
  addProduct(ORG, prodEan, "Camiseta (por EAN)", EAN1);
  addProduct(ORG, prodMapped, "Camiseta (catálogo interno)", null, "REF-INT-001");

  // 1. Resolução por EAN --------------------------------------------------------
  const r1 = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", ean: EAN1 });
  check("EAN casa → resolved", r1.status === "resolved" && r1.productServiceId === prodEan, `${r1.status}/${r1.source}`);
  check("EAN → source ean", r1.source === "ean");

  // 2. Sem EAN e sem mapa → unresolved -----------------------------------------
  const r2 = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-999", ean: null });
  check("sem EAN e sem mapa → unresolved", r2.status === "unresolved");

  // 3. Confirmar mapa fornecedor+cProd e resolver ------------------------------
  const okc = FiscalProductMappingService.confirmMapping(ORG, { supplierCnpj: "12.345.678/0001-99", supplierProductCode: "FORN-999", productServiceId: prodMapped }, "user-1");
  check("confirmMapping (CNPJ mascarado) → ok", okc.ok === true);
  const r3 = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-999" });
  check("após confirmar → confirmed", r3.status === "confirmed" && r3.productServiceId === prodMapped, `${r3.status}`);
  check("confirmed → source mapping", r3.source === "mapping");

  // 4. Mapa confirmado tem PRIORIDADE sobre EAN --------------------------------
  FiscalProductMappingService.confirmMapping(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", productServiceId: prodMapped }, "user-1");
  const r4 = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", ean: EAN1 });
  check("mapa confirmado vence o EAN", r4.status === "confirmed" && r4.productServiceId === prodMapped);

  // 5. Upsert: reconfirmar troca o alvo ----------------------------------------
  FiscalProductMappingService.confirmMapping(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", productServiceId: prodEan }, "user-2");
  const r5 = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", ean: EAN1 });
  check("reconfirmar (upsert) troca o alvo", r5.productServiceId === prodEan);
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM supplier_product_mappings WHERE organization_id = ? AND supplier_cnpj = ? AND supplier_product_code = 'FORN-001'`).get(ORG, SUP) as any).n;
  check("upsert não duplicou o mapa", cnt === 1, `count=${cnt}`);

  // 6. Fallback: produto do mapa removido → volta a resolver por EAN -----------
  FiscalProductMappingService.confirmMapping(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", productServiceId: prodMapped }, "user-1");
  db.prepare(`DELETE FROM products_services WHERE organization_id = ? AND id = ?`).run(ORG, prodMapped);
  const r6 = FiscalProductMappingService.resolveItem(ORG, { supplierCnpj: SUP, supplierProductCode: "FORN-001", ean: EAN1 });
  check("mapa aponta p/ produto inexistente → cai no EAN", r6.status === "resolved" && r6.productServiceId === prodEan, `${r6.status}`);

  // 7. confirmMapping rejeita produto inexistente ------------------------------
  const bad = FiscalProductMappingService.confirmMapping(ORG, { supplierCnpj: SUP, supplierProductCode: "X", productServiceId: "nao-existe" });
  check("confirmMapping com produto inexistente → rejeitado", bad.ok === false);

  // 8. Isolamento por org ------------------------------------------------------
  const r8 = FiscalProductMappingService.resolveItem(ORG2, { supplierCnpj: SUP, supplierProductCode: "FORN-001", ean: EAN1 });
  check("org2 não vê produto/mapa da org1 → unresolved", r8.status === "unresolved");

  // Relatório ------------------------------------------------------------------
  console.log("\n=== Mapeamento item fiscal → catálogo — Fase 2 PR B (ADR-200) ===\n");
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
