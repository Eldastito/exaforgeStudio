/**
 * TESTE — Atribuição manual de loja (ADR-200). Uso: npm run test:fiscal-assign-store
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-assign-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-assign-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { FiscalDocumentService } = await import("../src/server/FiscalDocumentService.js");
  const { default: db } = await import("../src/server/db.js");
  const ORG = "org-assign";

  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES ('loja-a', ?, 'Loja A', 1)`).run(ORG);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES ('loja-inativa', ?, 'Loja Inativa', 0)`).run(ORG);

  function addDoc(id: string, state: string, goodsReceiptId: string | null = null) {
    db.prepare(`INSERT INTO fiscal_documents (id, organization_id, document_type, access_key, content_level, processing_state, goods_receipt_id) VALUES (?, ?, 'nfe', ?, 'authorized_process', ?, ?)`)
      .run(id, ORG, randomUUID().replace(/-/g, "").slice(0, 44).padEnd(44, "0"), state, goodsReceiptId);
  }
  addDoc("doc1", "store_assignment_required");
  addDoc("doc2", "store_assignment_required");
  addDoc("doc3", "receipt_open", "rec-1"); // já tem recebimento

  // Atribuição válida
  const r1 = FiscalDocumentService.assignStore(ORG, "doc1", "loja-a");
  check("assignStore válido → ok", r1.ok === true, r1.reason);
  const d1 = FiscalDocumentService.get(ORG, "doc1");
  check("store_id setado", d1?.store_id === "loja-a");
  check("estado → ready_for_receipt", d1?.processing_state === "ready_for_receipt");

  // Loja inválida / inativa / de outra org
  check("loja inativa → rejeitado", FiscalDocumentService.assignStore(ORG, "doc2", "loja-inativa").ok === false);
  check("loja inexistente → rejeitado", FiscalDocumentService.assignStore(ORG, "doc2", "nao-existe").ok === false);
  check("doc2 permanece sem loja", FiscalDocumentService.get(ORG, "doc2")?.store_id == null);

  // Documento com recebimento já criado
  check("doc com recebimento → rejeitado", FiscalDocumentService.assignStore(ORG, "doc3", "loja-a").ok === false);

  // Documento inexistente / isolamento
  check("doc inexistente → rejeitado", FiscalDocumentService.assignStore(ORG, "nao-existe", "loja-a").ok === false);
  check("outra org não atribui doc alheio", FiscalDocumentService.assignStore("org-x", "doc1", "loja-a").ok === false);

  console.log("\n=== Atribuição manual de loja (ADR-200) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal no teste:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
