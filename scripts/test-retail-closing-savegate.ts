/**
 * TESTE — Dupla checagem da IA no fechamento (SAVE-GATE-001).
 *
 * Pedido do lojista: a plataforma NÃO pode salvar valores lidos por OCR sem um
 * humano confirmar que conferiu com a foto — principalmente valores. O
 * preenchimento 100% manual continua livre (não veio da IA).
 *
 * Uso:  npm run test:retail-closing-savegate
 */
let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { canSaveClosing } = await import("../src/features/retailClosingForm.js");

  // ===== 1. manual (sem foto) → salva livre =====
  check("1.1 manual com valor salva", canSaveClosing({ totalVendas: 1065, scanPending: false, scanConfirmed: false }) === true);
  check("1.2 manual sem valor NÃO salva", canSaveClosing({ totalVendas: 0, scanPending: false, scanConfirmed: false }) === false);

  // ===== 2. veio de foto → trava até confirmar =====
  check("2.1 OCR não confirmado BLOQUEIA salvar", canSaveClosing({ totalVendas: 1065, scanPending: true, scanConfirmed: false }) === false);
  check("2.2 OCR confirmado LIBERA salvar", canSaveClosing({ totalVendas: 1065, scanPending: true, scanConfirmed: true }) === true);
  check("2.3 OCR confirmado mas sem valor ainda NÃO salva", canSaveClosing({ totalVendas: 0, scanPending: true, scanConfirmed: true }) === false);

  // ===== 3. bordas numéricas =====
  check("3.1 total negativo não salva", canSaveClosing({ totalVendas: -5, scanPending: false, scanConfirmed: false }) === false);
  check("3.2 total exatamente 0 não salva", canSaveClosing({ totalVendas: 0, scanPending: false, scanConfirmed: false }) === false);

  console.log("\n=== TEST: Dupla checagem da IA no fechamento ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
