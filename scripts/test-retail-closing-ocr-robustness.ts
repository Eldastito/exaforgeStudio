/**
 * TESTE — Robustez da leitura por FOTO da folha de fechamento (ADR-083 Fase C)
 * -------------------------------------------------------------------------
 * Fecha a regressão relatada pelo cliente ("a foto parou de ler / leitura com
 * baixa confiança 0% em todas as fotos"): a folha do fechamento é RICA e o JSON
 * da visão estourava o limite de tokens, chegava CORTADO, o `JSON.parse` cru
 * falhava e virava um `{}` silencioso (confiança 0) — o gestor lia como "a IA
 * não conseguiu ler", sem saber que na verdade a folha era grande demais.
 *
 * Prova, offline (extrator injetável, sem provedor de visão):
 *   1. `repairTruncatedJson` salva o PREFIXO legível de um JSON cortado (no meio
 *      de um valor, no meio de uma string, com cerca ```json) e devolve null pro
 *      que é irrecuperável — NUNCA inventa o pedaço cortado.
 *   2. `submitFromImage` deixa de engolir o parse quebrado: leitura cortada vira
 *      `readError:'truncated'` (salva o que deu, vai pra conferência humana) e
 *      leitura ilegível vira `readError:'unreadable'` — nunca 'extracted' mudo.
 *   3. Uma leitura RICA e válida continua virando 'extracted' (0-regressão).
 *
 * Uso:  npm run test:retail-closing-ocr-robustness
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ocr-robust-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-ocr-robustness-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService, __setClosingExtractorForTests } = await import("../src/server/RetailOpsService.js");
  const { repairTruncatedJson } = await import("../src/server/llm.js");

  const DATE = "2026-08-05";

  // ---- 1. repairTruncatedJson (unidade) ----
  check("JSON válido passa direto", repairTruncatedJson('{"a":1,"b":2}') === '{"a":1,"b":2}');
  {
    // Cortado no meio de um número → salva o campo anterior completo, fecha o objeto.
    const r = repairTruncatedJson('{"dinheiro": 100.5, "pix": 200, "credito": 15');
    const p = r ? JSON.parse(r) : null;
    check("Corte no meio de um valor salva o prefixo", !!p && p.dinheiro === 100.5 && p.pix === 200, r || "null");
    check("Corte no meio de um valor descarta o campo incompleto", !!p && p.credito === undefined);
  }
  {
    // Cortado no meio de uma string → descarta a string cortada e a sua chave.
    const r = repairTruncatedJson('{"total": 3806.2, "malote": "MAL-00');
    const p = r ? JSON.parse(r) : null;
    check("Corte no meio de uma string salva os campos completos", !!p && p.total === 3806.2, r || "null");
    check("Corte no meio de uma string descarta a string incompleta", !!p && p.malote === undefined);
  }
  {
    // Corte dentro de um array aninhado → fecha array e objeto.
    const r = repairTruncatedJson('{"ranking": [{"nome":"Luiz","valor":7579.7},{"nome":"Vini","valor":5904');
    const p = r ? JSON.parse(r) : null;
    check("Corte em array aninhado salva os itens completos", !!p && Array.isArray(p.ranking) && p.ranking[0]?.nome === "Luiz", r || "null");
  }
  check("Cerca ```json é removida antes de parsear", repairTruncatedJson('```json\n{"x":1}\n```') !== null);
  check("Vazio devolve null", repairTruncatedJson("") === null);
  check("Sem nada recuperável devolve null", repairTruncatedJson("nao é json nenhum {[") === null);

  // ---- Setup para submitFromImage ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Loja OCR" });

  // ---- 2a. Leitura RICA e válida → 'extracted' (0-regressão) ----
  __setClosingExtractorForTests(async () => JSON.stringify({
    dinheiro: 500, pix: 1200, credito: 1800, debito: 306.2, total: 3806.2,
    ranking: [{ nome: "Luiz", valor: 7579.7, atendimentos: 20, pecas: 40 }],
    confidence: 95,
  }));
  const okRead = await RetailClosingService.submitFromImage(A, store.id, DATE, "b64", "image/jpeg", { source: "test" });
  check("Leitura válida vira 'extracted'", okRead?.closing?.status === "extracted", okRead?.closing?.status);
  check("Leitura válida NÃO carrega readError", okRead?.extraction?.readError == null);
  check("Leitura válida traz o total", okRead?.extraction?.informedTotal === 3806.2);

  // ---- 2b. Leitura CORTADA (JSON truncado) → readError 'truncated' + salva prefixo ----
  __setClosingExtractorForTests(async () => '{"dinheiro": 500, "pix": 1200, "credito": 18');
  const trunc = await RetailClosingService.submitFromImage(A, store.id, "2026-08-06", "b64", "image/jpeg", { source: "test" });
  check("Leitura cortada marca readError 'truncated'", trunc?.extraction?.readError === "truncated", trunc?.extraction?.readError || "null");
  check("Leitura cortada NUNCA vira 'extracted'", trunc?.closing?.status === "needs_review", trunc?.closing?.status);
  check("Leitura cortada salva o que deu pra ler (dinheiro+pix)", trunc?.extraction?.dinheiro === 500 && trunc?.extraction?.pix === 1200);
  check("Leitura cortada exige conferência humana", trunc?.extraction?.needsReview === true);

  // ---- 2c. Marcador _truncated (vindo do extractClosingFromImage quando finish_reason='length') ----
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 100, confidence: 40, _truncated: true }));
  const marked = await RetailClosingService.submitFromImage(A, store.id, "2026-08-07", "b64", "image/jpeg", { source: "test" });
  check("Marcador _truncated vira readError 'truncated'", marked?.extraction?.readError === "truncated");
  check("Marcador _truncated força conferência humana", marked?.closing?.status === "needs_review");

  // ---- 2d. Leitura ILEGÍVEL (nada recuperável) → readError 'unreadable' ----
  __setClosingExtractorForTests(async () => "isto nao é json {[");
  const bad = await RetailClosingService.submitFromImage(A, store.id, "2026-08-08", "b64", "image/jpeg", { source: "test" });
  check("Leitura ilegível marca readError 'unreadable'", bad?.extraction?.readError === "unreadable", bad?.extraction?.readError || "null");
  check("Leitura ilegível vira 'needs_review'", bad?.closing?.status === "needs_review");

  __setClosingExtractorForTests(null);

  console.log("\n=== Retail Ops — Robustez da leitura por foto (ADR-083 Fase C) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
