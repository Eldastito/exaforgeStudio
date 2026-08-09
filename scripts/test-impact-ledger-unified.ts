/**
 * TEST — Espinha Única F3.1–F3.4 (ADR-158 D5): Impact Ledger UNIFICADO (derivado).
 *
 * Prova, determinístico e sem IA:
 *   - reúne as 4 fontes (action_ledger, Comigo, Retail, RIC) no ledger
 *     unificado, por CATEGORIA;
 *   - agrega DENTRO da categoria (mesma unidade) e NUNCA entre categorias
 *     (sem total geral inflado — ADR-085 D4 / PRD §32);
 *   - unidades corretas (BRL vs minutes) e basis correto (fact vs estimate);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:impact-ledger-unified
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-impact-ledger-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-impact-ledger-123456";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { UnifiedImpactLedgerService: L } = await import("../src/server/UnifiedImpactLedgerService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  // Ação de baixo risco (tasks/create_task) já nasce aprovada → concluir direto.
  const doneWith = (orgId: string, title: string, cat: any, resultAmount?: number) => {
    const a = D.propose(orgId, { domain: "tasks", actionType: "create_task", title });
    D.complete(orgId, a.id, { resultAmount: resultAmount ?? null, categoryOutcomes: cat });
    return a.id;
  };

  const orgA = mkOrg();
  doneWith(orgA, "recuperou 3800", { revenueRecovered: 3800 }, 3800);
  doneWith(orgA, "recuperou +200", { revenueRecovered: 200 }, 200);
  doneWith(orgA, "economizou tempo+custo", { timeSavedMinutes: 120, costAvoided: 500 });
  doneWith(orgA, "evitou perda", { lossPrevented: 900 });

  const led = L.build(orgA);

  // ===== 1. Categorias presentes, agregadas dentro da categoria =====
  check("revenueRecovered soma dentro da categoria (3800+200=4000)", led.categories.revenueRecovered?.total === 4000);
  // 1 linha = 1 FONTE (action_ledger já soma os outcomes internamente); F3.2+
  // adicionam novas linhas (Comigo/Retail/RIC) à mesma categoria.
  check("revenueRecovered tem 1 linha (1 fonte: action_ledger)", led.categories.revenueRecovered?.lines.length === 1);
  check("revenueRecovered unidade BRL", led.categories.revenueRecovered?.unit === "BRL");
  check("costAvoided = 500", led.categories.costAvoided?.total === 500);
  check("lossPrevented = 900", led.categories.lossPrevented?.total === 900);
  check("timeSaved = 120, unidade minutes", led.categories.timeSaved?.total === 120 && led.categories.timeSaved?.unit === "minutes");

  // ===== 2. Fonte rotulada + rastreável =====
  check("fonte 'action_ledger' listada", led.sources.includes("action_ledger"));
  check("linha carrega a fonte", led.categories.revenueRecovered?.lines[0].source === "action_ledger");

  // ===== 3. NUNCA soma entre categorias (sem total geral) =====
  check("sem total geral inflado (nenhuma chave total/grandTotal no topo)",
    !("total" in led) && !("grandTotal" in (led as any)));
  check("disclaimer de não-soma presente", typeof led.disclaimer === "string" && led.disclaimer.includes("nunca somadas"));

  // ===== 4. Provider Comigo (F3.2): lucro comprovado = categoria própria =====
  const orgC = mkOrg();
  db.prepare("UPDATE organization_settings SET comigo_impact_baseline_at = ? WHERE organization_id = ?").run("2020-01-01T00:00:00.000Z", orgC);
  const oid = randomUUID();
  db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', 200)").run(oid, orgC);
  db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 2, 100, 60)").run(randomUUID(), oid);
  const ledC = L.build(orgC);
  check("comigo: provenValue = lucro comprovado (rev 200 - custo 120 = 80)", ledC.categories.provenValue?.total === 80);
  check("comigo: unidade BRL, fonte 'comigo', basis fact", ledC.categories.provenValue?.unit === "BRL" && ledC.categories.provenValue?.lines[0].source === "comigo" && ledC.categories.provenValue?.lines[0].basis === "fact");
  check("comigo: fonte 'comigo' listada", ledC.sources.includes("comigo"));
  check("provenValue é categoria SEPARADA de revenueRecovered (nunca somadas)", !ledC.categories.revenueRecovered && !!ledC.categories.provenValue);
  check("org sem Comigo (orgA) não tem provenValue", !led.categories.provenValue);

  // ===== 5. Provider Retail (F3.3): valor comprovado do mês, MESMA categoria =====
  const month = new Date().toISOString().slice(0, 7);
  const orgR = mkOrg();
  const storeId = randomUUID();
  db.prepare("INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Loja 1', 1)").run(storeId, orgR);
  db.prepare("INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', 1000, 850)")
    .run(randomUUID(), orgR, storeId, `${month}-15`);
  const ledR = L.build(orgR);
  check("retail: provenValue = |1000-850| = 150", ledR.categories.provenValue?.total === 150);
  check("retail: fonte 'retail', basis fact", ledR.categories.provenValue?.lines[0].source === "retail" && ledR.categories.provenValue?.lines[0].basis === "fact");
  check("retail: fonte 'retail' listada", ledR.sources.includes("retail"));

  // cross-fonte: a mesma org ganha Comigo (lucro 80) → provenValue SOMA dentro
  // da categoria (150+80=230, 2 linhas) — o coração da unificação.
  db.prepare("UPDATE organization_settings SET comigo_impact_baseline_at = ? WHERE organization_id = ?").run("2020-01-01T00:00:00.000Z", orgR);
  const oid2 = randomUUID();
  db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', 200)").run(oid2, orgR);
  db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 2, 100, 60)").run(randomUUID(), oid2);
  const ledR2 = L.build(orgR);
  check("cross-fonte: provenValue soma comigo+retail (150+80=230)", ledR2.categories.provenValue?.total === 230);
  check("cross-fonte: provenValue tem 2 linhas (comigo + retail)", ledR2.categories.provenValue?.lines.length === 2);
  check("cross-fonte: ambas as fontes listadas", ledR2.sources.includes("retail") && ledR2.sources.includes("comigo"));

  // ===== 6. Provider RIC (F3.4): recuperável (estimativa) + recuperada (fato) =====
  const { RevenueIntelligenceService: RIC } = await import("../src/server/RevenueIntelligenceService.js");
  const orgI = mkOrg();
  // Ticket fixo torna a estimativa determinística (senão puxaria o AOV histórico).
  RIC.saveConfig(orgI, { custom_ticket_amount: 1000 });
  // (a) recuperável (IRR): 1 orçamento 'sent' vencido (>72h) → 1 × prob_quote(0.50) × 1000 = 500 (ESTIMATE).
  db.prepare("INSERT INTO quotes (id, organization_id, status, total_amount, sent_at) VALUES (?, ?, 'sent', 999, '2020-01-01 00:00:00')").run(randomUUID(), orgI);
  // (b) recuperada (RRI): 1 pedido PAGO atribuído a lembrete de PIX → 300 (FACT).
  db.prepare("INSERT INTO orders (id, organization_id, status, total_amount, pix_reminder_count, paid_at, created_at) VALUES (?, ?, 'pago', 300, 1, datetime('now'), datetime('now'))").run(randomUUID(), orgI);
  const ledI = L.build(orgI);
  check("ric: recoverableRevenue = 1×0.5×1000 = 500 (estimativa)", ledI.categories.recoverableRevenue?.total === 500);
  check("ric: recoverableRevenue basis=estimate, fonte 'ric'", ledI.categories.recoverableRevenue?.lines[0].basis === "estimate" && ledI.categories.recoverableRevenue?.lines[0].source === "ric");
  check("ric: recoveredRevenue = 300 (fato, pedido pago atribuído a fluxo)", ledI.categories.recoveredRevenue?.total === 300);
  check("ric: recoveredRevenue basis=fact, unidade BRL", ledI.categories.recoveredRevenue?.lines[0].basis === "fact" && ledI.categories.recoveredRevenue?.unit === "BRL");
  check("ric: fonte 'ric' listada", ledI.sources.includes("ric"));
  // recoveredRevenue (RIC, por ATRIBUIÇÃO de pedido pago) é categoria SEPARADA de
  // revenueRecovered (action_ledger, por OUTCOME de decisão): bases de medição
  // distintas — somar double-count-aria o mesmo dinheiro (ADR-085 D4).
  check("ric: recoveredRevenue ≠ revenueRecovered (categorias separadas, nunca somadas)", !ledI.categories.revenueRecovered && !!ledI.categories.recoveredRevenue);
  check("org sem RIC (orgA) não tem categorias RIC", !led.categories.recoverableRevenue && !led.categories.recoveredRevenue);

  // ===== 7. Isolamento multi-tenant =====
  const orgB = mkOrg();
  const ledB = L.build(orgB);
  check("isolamento: org B tem ledger vazio", Object.keys(ledB.categories).length === 0 && ledB.sources.length === 0);

  console.log("\n=== TEST: Impact Ledger Unificado (ADR-158 F3.1–F3.4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Impact Ledger Unificado (F3.1–F3.4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
