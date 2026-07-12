/**
 * TESTE — Retail Ops Fase C: fechamento por foto + IA/OCR (ADR-083)
 * ----------------------------------------------------------------
 * Prova, offline (extrator de visão injetado, sem rede), o flagship:
 *   - a IA lê a folha → valores por forma de pagamento viram itens + total;
 *   - o fechamento do dia é preenchido e o desvio vs cota é calculado;
 *   - alta confiança → 'extracted'; baixa confiança → 'needs_review' (nunca
 *     aprova sozinha — ADR-083 D4);
 *   - total ausente na folha → usa a soma das formas de pagamento;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-scan
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-c-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-c-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService, __setClosingExtractorForTests } = await import("../src/server/RetailOpsService.js");

  const DATE = "2026-07-10";
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Loja Barra", whatsappIdentifier: "5511900000001" });
  RetailQuotaService.set(A, { storeId: store.id, quotaDate: DATE, quotaAmount: 10000 });

  // ---- 1. Alta confiança: extrai, preenche e calcula o desvio ----
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 1250, pix: 3400, credito: 7100, total: 11750, confidence: 95 }));
  const out = await RetailClosingService.submitFromImage(A, store.id, DATE, "ZmFrZQ==", "image/jpeg", { source: "image_ocr" });
  check("A IA extrai e devolve o resultado", !!out && out.extraction.confidence === 95);
  const c = out!.closing;
  check("Total informado = total da folha (11750)", c.informed_total === 11750);
  check("Itens por forma de pagamento gravados", c.items.length === 3 && c.items.some((i: any) => i.payment_method === "pix" && i.informed_amount === 3400));
  check("Desvio calculado vs cota (11750 - 10000 = 1750)", c.variance_amount === 1750);
  check("Alta confiança → status 'extracted'", c.status === "extracted");
  check("extracted_json guardado", !!c.extracted_json && JSON.parse(c.extracted_json).credito === 7100);

  // ---- 2. Baixa confiança → needs_review (conferência humana) ----
  const B_DATE = "2026-07-11";
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 500, pix: 900, total: 1400, confidence: 55 }));
  const low = await RetailClosingService.submitFromImage(A, store.id, B_DATE, "ZmFrZQ==", "image/jpeg", {});
  check("Baixa confiança → 'needs_review'", low!.closing.status === "needs_review");

  // ---- 3. Total ausente na folha → usa a soma das formas ----
  const C_DATE = "2026-07-12";
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 200, pix: 300, credito: 500, confidence: 92 }));
  const noTotal = await RetailClosingService.submitFromImage(A, store.id, C_DATE, "ZmFrZQ==", "image/jpeg", {});
  check("Total ausente → soma das formas (1000)", noTotal!.closing.informed_total === 1000);

  // ---- 4. Reprocessar o mesmo dia atualiza o mesmo fechamento (idempotente) ----
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 2000, pix: 0, total: 2000, confidence: 90 }));
  const again = await RetailClosingService.submitFromImage(A, store.id, DATE, "ZmFrZQ==", "image/jpeg", {});
  check("Reprocessar o mesmo dia não cria fechamento novo", again!.closing.id === c.id && again!.closing.informed_total === 2000);

  // ---- 5. Isolamento ----
  const Borg = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), Borg);
  check("Isolamento: B não vê o fechamento de A", RetailClosingService.listByDate(Borg, DATE).length === 0);

  __setClosingExtractorForTests(null);
  console.log("\n=== Retail Ops — Fase C: fechamento por foto + IA/OCR (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
