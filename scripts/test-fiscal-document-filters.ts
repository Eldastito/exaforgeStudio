/**
 * TESTE — Filtros de loja e período em FiscalDocumentService.list (ADR-200).
 * Uso: npm run test:fiscal-document-filters
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-filters-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-filters-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { FiscalDocumentService } = await import("../src/server/FiscalDocumentService.js");
  const { default: db } = await import("../src/server/db.js");
  const ORG = "org-filters";

  function addDoc(storeId: string, issueAt: string) {
    db.prepare(`INSERT INTO fiscal_documents (id, organization_id, store_id, document_type, access_key, content_level, issue_at) VALUES (?, ?, ?, 'nfe', ?, 'authorized_process', ?)`)
      .run(randomUUID(), ORG, storeId, randomUUID().replace(/-/g, "").slice(0, 44).padEnd(44, "0"), issueAt);
  }
  addDoc("loja-1", "2026-06-01T10:00:00-03:00");
  addDoc("loja-1", "2026-06-15T10:00:00-03:00");
  addDoc("loja-2", "2026-06-20T10:00:00-03:00");
  addDoc("loja-2", "2026-07-05T10:00:00-03:00");

  check("sem filtro → todos (4)", FiscalDocumentService.list(ORG).length === 4);
  check("por loja-1 → 2", FiscalDocumentService.list(ORG, { storeId: "loja-1" }).length === 2);
  check("por loja-2 → 2", FiscalDocumentService.list(ORG, { storeId: "loja-2" }).length === 2);
  check("período junho (from/to) → 3", FiscalDocumentService.list(ORG, { from: "2026-06-01", to: "2026-06-30" }).length === 3);
  check("from inclusivo (>= 15/06) → 3", FiscalDocumentService.list(ORG, { from: "2026-06-15" }).length === 3);
  check("to inclusivo (<= 20/06) → 3", FiscalDocumentService.list(ORG, { to: "2026-06-20" }).length === 3);
  check("loja-2 + julho → 1", FiscalDocumentService.list(ORG, { storeId: "loja-2", from: "2026-07-01", to: "2026-07-31" }).length === 1);
  check("loja-1 + julho → 0", FiscalDocumentService.list(ORG, { storeId: "loja-1", from: "2026-07-01", to: "2026-07-31" }).length === 0);
  check("data inválida é ignorada (não filtra)", FiscalDocumentService.list(ORG, { from: "xx" }).length === 4);
  check("isolamento por org (outra org → 0)", FiscalDocumentService.list("org-x").length === 0);

  console.log("\n=== Filtros de documento fiscal — loja e período (ADR-200) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal no teste:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
