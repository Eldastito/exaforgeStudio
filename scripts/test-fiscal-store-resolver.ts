/**
 * TESTE — Resolução de loja do documento fiscal (ADR-200, Fase 2, PR A).
 * ---------------------------------------------------------------------
 * Cobre FiscalStoreResolverService (dest/CNPJ → loja) e a integração no
 * FiscalDocumentService: documento autorizado com loja resolvível fica
 * ready_for_receipt com store_id; sem loja determinística fica
 * store_assignment_required; resumo aguarda o XML completo; e o enrich
 * resumo→completo resolve a loja no mesmo registro.
 *
 * Banco temporário + fixtures da Fase 0. Uso: npm run test:fiscal-store-resolver
 */
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-store-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-store-1234567890";

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
  const { FiscalStoreResolverService, normalizeCnpj } = await import("../src/server/FiscalStoreResolverService.js");
  const { FiscalDocumentService } = await import("../src/server/FiscalDocumentService.js");
  const { parseNFeDocument } = await import("../src/server/nfeParser.js");
  const { default: db } = await import("../src/server/db.js");

  const ORG = "org-store-A";
  const ORG2 = "org-store-B";
  const DEST_CNPJ = "98765432000155"; // destinatário nas fixtures
  const KEY = "35240612345678000199550010000001231000000122";

  function addStore(orgId: string, id: string, name: string, cnpj: string | null, active = 1) {
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, cnpj) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, name, active, cnpj);
  }

  // normalizeCnpj -------------------------------------------------------------
  check("normalizeCnpj: máscara → 14 dígitos", normalizeCnpj("98.765.432/0001-55") === DEST_CNPJ);
  check("normalizeCnpj: < 14 dígitos → null", normalizeCnpj("123") === null);
  check("normalizeCnpj: vazio → null", normalizeCnpj(null) === null);

  // resolve --------------------------------------------------------------------
  check("sem loja cadastrada → not_found", FiscalStoreResolverService.resolve(ORG, DEST_CNPJ).status === "not_found");
  check("CNPJ ausente → no_cnpj", FiscalStoreResolverService.resolve(ORG, null).status === "no_cnpj");

  addStore(ORG, "store-1", "Loja Centro", "98.765.432/0001-55"); // cadastrado COM máscara
  const r1 = FiscalStoreResolverService.resolve(ORG, DEST_CNPJ);
  check("1 loja com CNPJ (mascarado) → resolved", r1.status === "resolved" && (r1 as any).storeId === "store-1");

  addStore(ORG, "store-2", "Loja Shopping", "11222333000144"); // outra loja, outro CNPJ
  check("CNPJ distinto por loja → segue resolvendo a certa", FiscalStoreResolverService.resolve(ORG, DEST_CNPJ).status === "resolved");

  addStore(ORG, "store-1b", "Loja Duplicada", DEST_CNPJ); // MESMO CNPJ (cenário anômalo)
  check("2 lojas mesmo CNPJ → ambiguous", FiscalStoreResolverService.resolve(ORG, DEST_CNPJ).status === "ambiguous");

  addStore(ORG2, "store-x", "Loja Outra Org", DEST_CNPJ);
  check("isolamento por org: org2 resolve a sua própria loja", (FiscalStoreResolverService.resolve(ORG2, DEST_CNPJ) as any).storeId === "store-x");

  // loja inativa é ignorada
  const ORG3 = "org-store-C";
  addStore(ORG3, "store-inativa", "Loja Fechada", DEST_CNPJ, 0);
  check("loja inativa não resolve → not_found", FiscalStoreResolverService.resolve(ORG3, DEST_CNPJ).status === "not_found");

  // Integração no persist ------------------------------------------------------
  const autorizado = parseNFeDocument(readFix("procNFe-autorizado.xml"));
  const resumo = parseNFeDocument(readFix("resNFe.xml"));

  // Org com loja única resolvível → store_id setado + ready_for_receipt
  const ORG_OK = "org-persist-ok";
  addStore(ORG_OK, "loja-ok", "Loja OK", DEST_CNPJ);
  FiscalDocumentService.persist(ORG_OK, autorizado, { source: "manual_upload" });
  const docOk = FiscalDocumentService.getByAccessKey(ORG_OK, KEY);
  check("persist autorizado + loja resolvível → store_id = loja-ok", docOk?.store_id === "loja-ok");
  check("persist autorizado + loja resolvível → ready_for_receipt", docOk?.processing_state === "ready_for_receipt");

  // Org SEM loja correspondente → store_assignment_required, store_id null
  const ORG_NO = "org-persist-nostore";
  FiscalDocumentService.persist(ORG_NO, autorizado, { source: "manual_upload" });
  const docNo = FiscalDocumentService.getByAccessKey(ORG_NO, KEY);
  check("persist autorizado sem loja → store_id null", docNo?.store_id === null);
  check("persist autorizado sem loja → store_assignment_required", docNo?.processing_state === "store_assignment_required");

  // Enrich: resumo (awaiting) → completo resolve a loja no mesmo registro
  const ORG_ENR = "org-persist-enrich";
  addStore(ORG_ENR, "loja-enr", "Loja Enrich", DEST_CNPJ);
  FiscalDocumentService.persist(ORG_ENR, resumo, { source: "provider" });
  const docSum = FiscalDocumentService.getByAccessKey(ORG_ENR, KEY);
  check("resumo → awaiting_full_xml, sem loja", docSum?.processing_state === "awaiting_full_xml" && docSum?.store_id === null);
  FiscalDocumentService.persist(ORG_ENR, autorizado, { source: "manual_upload" });
  const docEnr = FiscalDocumentService.getByAccessKey(ORG_ENR, KEY);
  check("enrich → loja resolvida no mesmo registro", docEnr?.store_id === "loja-enr");
  check("enrich → ready_for_receipt", docEnr?.processing_state === "ready_for_receipt");

  // Relatório ------------------------------------------------------------------
  console.log("\n=== Resolução de loja — Fase 2 PR A (ADR-200) ===\n");
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
