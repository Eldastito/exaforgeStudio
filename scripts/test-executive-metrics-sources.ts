/**
 * TEST — Executive metrics com FONTE REAL (ADR-190 F2). Adiciona ao registro os indicadores
 * executivos que faltavam (vendas/novos clientes/ticket/cancelamentos/CSAT/custo/caixa/vencido/
 * inadimplência), cada um com availability HONESTA: sem fonte → measure() devolve value:null, nunca 0
 * (RN-CEO-11/§31-33). Derives sobre system-of-record real; catálogo de METAS só "up".
 *
 * Uso: npm run test:executive-metrics-sources
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ems-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ems-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BusinessGoalService: BG } = await import("../src/server/BusinessGoalService.js");
  const nowMonth = new Date().toISOString().slice(0, 7);

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), A);
  // 2 clientes, cada um com 1ª compra paga NESTE mês (novos clientes = 2). Ticket via orders.
  for (const c of ["c1", "c2"]) { const oid = randomUUID(); db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, 'pago', 400, ?)`).run(oid, A, c, `${nowMonth}-05 10:00:00`); }
  // 1 pedido cancelado neste mês.
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, 'c3', 'cancelado', 100, ?)`).run(randomUUID(), A, `${nowMonth}-06 10:00:00`);
  // Recebíveis: 3.000 em aberto, dos quais 1.000 vencidos (due < hoje) → inadimplência 33.3%.
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'V', 1000, '2020-01-01', 'open')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'F', 2000, '2999-01-01', 'open')`).run(randomUUID(), A);
  // Conta de caixa com saldo 5.000 (fonte de caixa presente).
  try { db.prepare(`INSERT INTO cash_accounts (id, organization_id, name, current_balance) VALUES (?, ?, 'Caixa', 5000)`).run(randomUUID(), A); } catch { /* schema pode ter mais colunas NOT NULL */ }

  // ── 1. Comercial: vendas/novos clientes/ticket derivados de fonte real ──
  check("1.1 new_customers = 2 (1ª compra paga no mês)", BG.currentValue(A, "new_customers") === 2 && BG.describe("new_customers")!.pillar === "commercial");
  check("1.2 average_ticket > 0 (BRL)", (BG.measure(A, "average_ticket")!.value ?? 0) > 0 && BG.describe("average_ticket")!.unit === "BRL");
  check("1.3 sales_count disponível (fonte interna)", BG.availability(A, "sales_count") === "available");

  // ── 2. Operações: cancelamentos (down) ──
  check("2.1 cancellations >= 1 (pedido cancelado), betterDirection down", (BG.currentValue(A, "cancellations") ?? 0) >= 1 && BG.describe("cancellations")!.betterDirection === "down" && BG.describe("cancellations")!.pillar === "operations");

  // ── 3. Financeiro: caixa (fact), vencido (fact), inadimplência % ──
  const mCash = BG.measure(A, "cash_balance")!;
  check("3.1 cash_balance = 5000 (fact, fonte cash_accounts)", mCash.value === 5000 && mCash.basis === "fact" && mCash.availability === "available");
  check("3.2 overdue_receivables = 1000 (vencido, down)", BG.currentValue(A, "overdue_receivables") === 1000 && BG.describe("overdue_receivables")!.betterDirection === "down");
  check("3.3 default_rate = 33.3% (vencido/total, percent)", BG.currentValue(A, "default_rate") === 33.3 && BG.describe("default_rate")!.unit === "percent");

  // ── 4. HONESTIDADE (RN-CEO-11): org SEM fonte financeira → measure value:null, nunca 0 ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Sem financeiro', 'active')`).run(randomUUID(), B);
  const cashB = BG.measure(B, "cash_balance")!;
  check("4.1 sem cash_account → availability unavailable + value NULL (não 0)", BG.availability(B, "cash_balance") === "unavailable" && cashB.value === null && cashB.basis === "unknown");
  const costB = BG.measure(B, "operating_cost")!;
  check("4.2 sem payables → custo unavailable + value NULL", costB.value === null && costB.availability === "unavailable");
  const defB = BG.measure(B, "default_rate")!;
  check("4.3 sem recebível → inadimplência unavailable + value NULL", defB.value === null && defB.availability === "unavailable");
  const csatB = BG.measure(B, "customer_satisfaction")!;
  check("4.4 sem pesquisa CSAT → satisfação unavailable + value NULL", csatB.value === null && csatB.availability === "unavailable");

  // ── 5. Catálogo de METAS só "up" (não oferece cancelamentos/inadimplência como alvo) ──
  const goalMetrics = BG.catalog().map((c: any) => c.metric);
  check("5.1 catalog (metas) exclui down metrics", !goalMetrics.includes("cancellations") && !goalMetrics.includes("default_rate") && !goalMetrics.includes("overdue_receivables"));
  check("5.2 catalog inclui up metrics (revenue, sales_count, new_customers)", goalMetrics.includes("revenue") && goalMetrics.includes("sales_count") && goalMetrics.includes("new_customers"));
  check("5.3 executiveCatalog inclui TODAS (up e down)", BG.executiveCatalog().some((d: any) => d.metricKey === "default_rate") && BG.executiveCatalog().length >= 14);

  // ── 6. Isolamento ──
  check("6.1 isolamento (B sem vendas de A)", (BG.currentValue(B, "new_customers") ?? 0) === 0 && BG.currentValue(A, "new_customers") === 2);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-metrics-sources: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
