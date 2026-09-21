/**
 * TESTE — Persistência do documento fiscal (ADR-200, Fase 1, PR 2).
 * ---------------------------------------------------------------------
 * Cobre FiscalDocumentService: upsert idempotente por (org, access_key),
 * enriquecimento resumo→completo (nunca rebaixa), dedupe multiorigem,
 * itens com quantidade decimal e xProd sem truncar, e isolamento por org.
 *
 * Usa banco temporário (padrão dos testes do repo) + fixtures da Fase 0.
 * Uso: npm run test:fiscal-document-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-doc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-doc-1234567890";

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
  const { default: db } = await import("../src/server/db.js");

  const ORG_A = "org-A";
  const ORG_B = "org-B";
  const KEY = "35240612345678000199550010000001231000000122";

  const autorizado = parseNFeDocument(readFix("procNFe-autorizado.xml"));
  const resumo = parseNFeDocument(readFix("resNFe.xml"));
  const decimal = parseNFeDocument(readFix("procNFe-quantidade-decimal.xml"));

  // 1. Criação a partir do XML completo -----------------------------------------
  const r1 = FiscalDocumentService.persist(ORG_A, autorizado, { source: "manual_upload" });
  check("persist completo → created", r1.status === "created", r1.status);
  const doc1 = FiscalDocumentService.getByAccessKey(ORG_A, KEY);
  check("documento gravado com content_level authorized_process", doc1?.content_level === "authorized_process");
  check("processing_state ready_for_receipt", doc1?.processing_state === "ready_for_receipt");
  check("2 itens persistidos", doc1?.items?.length === 2);
  check("xProd não truncado no banco", doc1?.items?.[0]?.fiscal_description === "CAMISETA BASICA GOLA CARECA PRETA TAM M");

  // 2. Idempotência: reprocessar o MESMO XML não duplica ------------------------
  const r2 = FiscalDocumentService.persist(ORG_A, autorizado, { source: "manual_upload" });
  check("reprocessar mesmo XML → unchanged", r2.status === "unchanged", r2.status);
  const countDocs = (db.prepare(`SELECT COUNT(*) AS n FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`).get(ORG_A, KEY) as any).n;
  check("continua 1 único documento (dedupe)", countDocs === 1, `count=${countDocs}`);
  const countItems = (db.prepare(`SELECT COUNT(*) AS n FROM fiscal_document_items WHERE fiscal_document_id = ?`).get(doc1.id) as any).n;
  check("continua 2 itens (sem duplicar)", countItems === 2, `count=${countItems}`);

  // 3. Não rebaixa: resumo depois do completo é no-op ---------------------------
  const r3 = FiscalDocumentService.persist(ORG_A, resumo, { source: "provider" });
  check("resumo após completo → unchanged (não rebaixa)", r3.status === "unchanged", r3.status);
  check("content_level permanece authorized_process", FiscalDocumentService.getByAccessKey(ORG_A, KEY)?.content_level === "authorized_process");

  // 4. Enriquecimento: resumo primeiro, completo depois → mesmo registro --------
  const rB1 = FiscalDocumentService.persist(ORG_B, resumo, { source: "provider" });
  check("org B: resumo → created (summary_only)", rB1.status === "created" && FiscalDocumentService.getByAccessKey(ORG_B, KEY)?.content_level === "summary_only");
  check("org B: resumo → awaiting_full_xml", FiscalDocumentService.getByAccessKey(ORG_B, KEY)?.processing_state === "awaiting_full_xml");
  check("org B: resumo → 0 itens", FiscalDocumentService.getByAccessKey(ORG_B, KEY)?.items?.length === 0);
  const rB2 = FiscalDocumentService.persist(ORG_B, autorizado, { source: "manual_upload" });
  check("org B: completo depois → enriched", rB2.status === "enriched", rB2.status);
  const docB = FiscalDocumentService.getByAccessKey(ORG_B, KEY);
  check("org B: enriquecido para authorized_process", docB?.content_level === "authorized_process");
  check("org B: agora com 2 itens", docB?.items?.length === 2);
  check("org B: enriched reaproveitou o mesmo id", rB2.documentId === rB1.documentId);

  // 5. Isolamento por org: mesma chave, registros distintos --------------------
  check("org A e org B têm documentos distintos p/ mesma chave", doc1.id !== docB.id);
  const totalKey = (db.prepare(`SELECT COUNT(*) AS n FROM fiscal_documents WHERE access_key = ?`).get(KEY) as any).n;
  check("2 documentos no total p/ a chave (um por org)", totalKey === 2, `count=${totalKey}`);

  // 6. Quantidade decimal preservada no banco ----------------------------------
  FiscalDocumentService.persist(ORG_A, decimal, { source: "manual_upload" });
  const docDec = FiscalDocumentService.getByAccessKey(ORG_A, "35240612345678000199550010000007891000000127");
  check("item por peso: commercial_qty = 2.5 no banco", docDec?.items?.[0]?.commercial_qty === 2.5, String(docDec?.items?.[0]?.commercial_qty));

  // 7. Evento/invalid não persistem documento ----------------------------------
  const evento = parseNFeDocument(readFix("procEventoNFe-cancelamento.xml"));
  const rEv = FiscalDocumentService.persist(ORG_A, evento, { source: "provider" });
  check("evento → skipped (não vira documento nesta fase)", rEv.status === "skipped", rEv.status);

  // Relatório ------------------------------------------------------------------
  console.log("\n=== Persistência do documento fiscal — Fase 1 PR 2 (ADR-200) ===\n");
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
