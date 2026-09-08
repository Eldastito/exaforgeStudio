/**
 * TEST — Fluxo de Caixa gerencial método indireto (ADR-200 F2). DB-backed, determinístico.
 * Prova: resultado (DRE) − Δreceber − Δestoque + Δpagar = fluxo operacional; financiamento
 * (aportes − retiradas); variação esperada × real (Motor de Caixa) → "a conciliar"; Δestoque via
 * stock_movements (entrada − saída a custo) e "não medido" honesto quando não há movimento; o gap
 * "lucro ≠ caixa" (lucrou mas o operacional zerou porque travou em receber/estoque); isolamento.
 *
 * Uso: npm run test:managerial-cashflow
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cashflow-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cashflow-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ManagerialCashFlowService: CF } = await import("../src/server/ManagerialCashFlowService.js");

  const mkOrg = (v = "moda") => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'O', 'active', ?)`).run(o, v); return o; };
  const mkOrder = (org: string, rev: number, cost: number, date: string) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, ?)`).run(oid, org, rev, `${date} 10:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, rev, rev, cost);
  };
  const mkPayable = (org: string, amount: number, due: string, created: string, status = "open", paidAt: string | null = null) => db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status, paid_at, created_at) VALUES (?, ?, 'D', ?, ?, 'monthly', ?, ?, ?)`).run(randomUUID(), org, amount, due, status, paidAt, `${created} 10:00:00`);
  const mkReceivable = (org: string, amount: number, created: string) => db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, created_at) VALUES (?, ?, 'R', ?, ?, 'open', ?)`).run(randomUUID(), org, amount, created, `${created} 10:00:00`);
  const mkMove = (org: string, type: "entrada" | "saida", qty: number, cost: number, date: string) => db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity, unit_cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, randomUUID(), type, qty, cost, `${date} 10:00:00`);
  const mkCashEvent = (org: string, dir: "in" | "out", amount: number, date: string) => db.prepare(`INSERT INTO cash_events (id, organization_id, direction, amount, event_date) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, dir, amount, date);
  const mkDraw = (org: string, kind: string, amount: number, date: string) => db.prepare(`INSERT INTO owner_draws (id, organization_id, kind, amount, draw_date) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, kind, amount, date);

  const P = "2026-06";

  // ── A: o gap do CFO — lucrou 400, mas o operacional ZEROU (travou em receber/estoque) ──
  const A = mkOrg("moda");
  mkOrder(A, 1000, 400, "2026-06-10");                       // margem bruta 600
  mkPayable(A, 200, "2026-06-05", "2026-06-01", "paid", "2026-06-10"); // despesa do mês (pago) → DRE 200, fora do a/p no fim
  // resultado operacional = 600 − 200 = 400
  mkReceivable(A, 500, "2026-06-15");                        // vendeu fiado → Δreceber 500
  mkPayable(A, 300, "2026-07-15", "2026-06-20");             // comprou fiado (vence em julho) → Δpagar 300, fora do DRE de junho
  mkMove(A, "entrada", 10, 40, "2026-06-08");                // comprou estoque 400
  mkMove(A, "saida", 5, 40, "2026-06-12");                   // vendeu (CMV) 200 → Δestoque 200
  mkDraw(A, "pro_labore", 100, "2026-06-15");                // retirada
  mkCashEvent(A, "in", 300, "2026-06-10");
  mkCashEvent(A, "out", 50, "2026-06-20");                   // variação real = 250

  const c = CF.indirect(A, P);
  check("1.1 resultado do DRE = 400", c.resultado === 400);
  check("1.2 Δ a receber = 500", c.capitalDeGiro.deltaReceber === 500);
  check("1.3 Δ estoque = 200 (entrada 400 − saída 200), medido", c.capitalDeGiro.deltaEstoque === 200 && c.capitalDeGiro.estoqueMeasured === true);
  check("1.4 Δ a pagar = 300", c.capitalDeGiro.deltaPagar === 300);
  check("1.5 fluxo operacional = 400 − 500 − 200 + 300 = 0 (LUCRO ≠ CAIXA)", c.fluxoOperacional === 0);
  check("1.6 financiamento: retiradas 100, total −100", c.financiamento.retiradas === 100 && c.financiamento.aportes === 0 && c.financiamento.total === -100);
  check("1.7 variação esperada = 0 + (−100) = −100", c.variacaoEsperada === -100);
  check("1.8 variação real (Motor de Caixa) = 300 − 50 = 250", c.variacaoReal === 250);
  check("1.9 a conciliar = 250 − (−100) = 350", c.aConciliar === 350);
  check("1.10 lucro positivo (400) mas operacional zerado → prova o gap", c.resultado > 0 && c.fluxoOperacional === 0);
  check("1.11 sem caveat de estoque não medido (há movimento)", !c.caveats.some((x) => /NÃO medido/i.test(x)));
  check("1.12 disclaimer gerencial", /não substitui a contabilidade/i.test(c.disclaimer));

  // ── B: sem movimento de estoque → Δestoque NÃO medido (cai no a conciliar) ──
  const B = mkOrg("servicos");
  mkOrder(B, 500, 0, "2026-06-10");                          // resultado 500
  mkReceivable(B, 500, "2026-06-15");                        // Δreceber 500
  const cB = CF.indirect(B, P);
  check("2.1 Δ estoque null + não medido", cB.capitalDeGiro.deltaEstoque === null && cB.capitalDeGiro.estoqueMeasured === false);
  check("2.2 caveat 'Δ estoque NÃO medido' presente", cB.caveats.some((x) => /Δ estoque NÃO medido/i.test(x)));
  check("2.3 operacional = 500 − 500 − 0 + 0 = 0 (Δestoque null tratado como 0)", cB.fluxoOperacional === 0);
  check("2.4 sem caixa → variação real 0, a conciliar 0", cB.variacaoReal === 0 && cB.aConciliar === 0);

  // ── 3: isolamento ──
  check("3.1 A não vê o de B (resultado 400)", CF.indirect(A, P).resultado === 400);
  check("3.2 B só o seu (resultado 500)", cB.resultado === 500);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} managerial-cashflow: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
