/**
 * TEST — Invariantes de Verdade Financeira (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F1.4/F2 / PR-12).
 *
 * A auditoria (AUDIT-ZF-UNIFIED-GAP-CLOSURE-03, addendum) reclassificou a F1.4 (Financial Event
 * Identity) de CREATE → ALREADY_DONE + DEFER: a identidade canônica de caixa JÁ EXISTE (índice
 * UNIQUE em `cash_events`) e o overlap pedido↔fechamento é agregado (irresolvível por chave,
 * tratado honestamente pelo PnlReconciliationService). Este teste TRAVA esses dois fatos como
 * INVARIANTE (regressão), em vez de construir um motor de reconciliação paralelo.
 *
 * Cobre:
 *  - F1.4 (identidade canônica): a MESMA origem (source_type,source_id) NÃO dobra o caixa
 *    (dedup pelo UNIQUE de cash_events); origens distintas contam; deduped é reportado.
 *  - F2 (verdade da receita): o PnlReconciliationService mantém o total (a+b+c, 0-regressão),
 *    NUNCA deduplica em silêncio, e SINALIZA overlap como hipótese quando os dois rails têm
 *    receita (ponte on) — e não sinaliza quando a ponte está off.
 *
 * Uso: npm run test:financial-truth-invariants
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ftinv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ftinv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");
  const { PnlReconciliationService: PNL } = await import("../src/server/PnlReconciliationService.js");
  const { RetailRevenueBridgeService: BR } = await import("../src/server/RetailRevenueBridgeService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // ── F1.4 — identidade canônica de caixa (a MESMA origem não dobra) ──
  const e1 = L.recordEvent(A, { direction: "in", amount: 1000, sourceType: "order", sourceId: "ORD-1" });
  check("1.1 primeiro evento registra", e1.ok === true && !("deduped" in e1 && (e1 as any).deduped));
  const e2 = L.recordEvent(A, { direction: "in", amount: 1000, sourceType: "order", sourceId: "ORD-1" });
  check("1.2 MESMA origem (source_type,source_id) é deduplicada", e2.ok === true && (e2 as any).deduped === true);
  check("1.3 caixa NÃO dobrou (1000, não 2000)", L.cashOnHand(A) === 1000);
  const e3 = L.recordEvent(A, { direction: "in", amount: 500, sourceType: "order", sourceId: "ORD-2" });
  check("1.4 origem DISTINTA conta", (e3 as any).deduped !== true && L.cashOnHand(A) === 1500);
  // Prova estrutural: o índice UNIQUE existe (a chave canônica que a F1.4 pediria "criar" já existe).
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cash_events_source'").get() as any;
  check("1.5 índice canônico UNIQUE(org,source_type,source_id) existe", !!idx);

  // ── F2 — verdade da receita: total preservado, overlap sinalizado (nunca dobra em silêncio) ──
  const period = new Date().toISOString().slice(0, 7);
  // rail core: um pedido pago no mês
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 1000, ?)`).run(randomUUID(), A, `${period}-15 12:00:00`);
  // rail loja: um fechamento elegível no mês (ponte ainda OFF)
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', ?, 'approved', 500)`).run(randomUUID(), A, `${period}-15`);

  const offR = PNL.monthlyRevenue(A, period);
  check("2.1 ponte OFF: só core, sem overlap (0-regressão)", offR.bridgeEnabled === false && offR.segments.storeClosings === 0 && offR.overlapRisk === false && offR.total === 1000);

  BR.setEnabled(A, true);
  const onR = PNL.monthlyRevenue(A, period);
  check("2.2 ponte ON: total = core + loja (a+b+c, sem dedup silencioso)", onR.total === 1500 && onR.segments.coreOrders === 1000 && onR.segments.storeClosings === 500);
  check("2.3 overlap SINALIZADO (não somado às cegas)", onR.overlapRisk === true && /duas vezes/.test(onR.note));

  // Sinal advisory: hipótese, não inventa dinheiro.
  const pub = PNL.publishOverlapSignal(A, period);
  check("2.4 publica sinal de overlap", pub.published === true);
  const sig = BS.list(A, { domain: "pnl_reconciliation" }).find((s: any) => s.dedupe_key === `pnl_overlap:${period}`);
  check("2.5 sinal é hipótese, sem dinheiro inventado", !!sig && sig.basis === "hypothesis" && (sig.impact_amount === null || sig.impact_amount === undefined));

  // ── Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("3.1 org B: caixa zero (não vê A)", L.cashOnHand(B) === 0 && PNL.monthlyRevenue(B, period).total === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} financial-truth-invariants: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
