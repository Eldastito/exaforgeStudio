/**
 * TEST — Balanço Patrimonial gerencial derivado (ADR-200 F1). DB-backed, determinístico.
 * Prova: Ativo (caixa reconstruído na data + a receber aberto + estoque a custo) = Passivo
 * (a pagar aberto) + PL (capital do sócio + "a conciliar"); identidade sempre fecha; estoque
 * retail×custo com coverage parcial, fallback armazém, e "none" honesto; asOf reconstrói caixa
 * e respeita recebido/pago posterior; `preso` = a receber + estoque; isolamento.
 *
 * Uso: npm run test:managerial-balance
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-balance-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-balance-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ManagerialBalanceSheetService: BS } = await import("../src/server/ManagerialBalanceSheetService.js");

  const mkOrg = (vertical = "moda") => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'O', 'active', ?)`).run(o, vertical); return o; };
  const mkCashAccount = (org: string, balance: number) => db.prepare(`INSERT INTO cash_accounts (id, organization_id, name, type, opening_balance, current_balance, active) VALUES (?, ?, 'Caixa', 'caixa', 0, ?, 1)`).run(randomUUID(), org, balance);
  const mkCashEvent = (org: string, dir: "in" | "out", amount: number, date: string) => db.prepare(`INSERT INTO cash_events (id, organization_id, direction, amount, event_date) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, dir, amount, date);
  const mkReceivable = (org: string, amount: number, created: string, status = "open", receivedAt: string | null = null) => db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status, received_at, created_at) VALUES (?, ?, 'R', ?, ?, ?, ?, ?)`).run(randomUUID(), org, amount, created, status, receivedAt, `${created} 10:00:00`);
  const mkPayable = (org: string, amount: number, created: string, status = "open", paidAt: string | null = null) => db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, status, paid_at, created_at) VALUES (?, ?, 'P', ?, ?, ?, ?, ?)`).run(randomUUID(), org, amount, created, status, paidAt, `${created} 10:00:00`);
  const mkInvItem = (org: string, pid: string, qty: number, avgCost: number) => db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, pid, qty, avgCost);
  const mkStoreInv = (org: string, pid: string, qty: number) => db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, randomUUID(), pid, qty);
  const mkDraw = (org: string, kind: string, amount: number, date: string) => db.prepare(`INSERT INTO owner_draws (id, organization_id, kind, amount, draw_date) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, kind, amount, date);

  const ASOF = "2026-06-30";

  // ── A: rede física, cenário completo ──────────────────────────────────────
  const A = mkOrg("moda");
  mkCashAccount(A, 1000);
  mkCashEvent(A, "in", 300, "2026-07-05");   // POSTERIOR a asOf → reconstrói caixa (1000 − 300 = 700)
  mkCashEvent(A, "out", 50, "2026-06-10");   // anterior: já embutido no saldo, não mexe
  mkReceivable(A, 500, "2026-06-10");                                   // aberto → conta
  mkReceivable(A, 200, "2026-06-01", "received", "2026-06-20");         // recebido ANTES de asOf → fora
  mkReceivable(A, 300, "2026-06-01", "received", "2026-07-10");         // recebido DEPOIS de asOf → aberto na data
  mkReceivable(A, 999, "2026-06-01", "canceled");                       // cancelado → fora
  const P1 = randomUUID(), P2 = randomUUID();
  mkInvItem(A, P1, 10, 8);                    // custo conhecido
  mkStoreInv(A, P1, 10);                      // 10 × 8 = 80, coberto
  mkStoreInv(A, P2, 5);                        // sem custo → não entra, mas conta na qtd (coverage)
  mkPayable(A, 400, "2026-06-05");                                     // aberto → conta
  mkPayable(A, 100, "2026-06-01", "paid", "2026-07-02");               // pago DEPOIS de asOf → aberto na data
  mkPayable(A, 50, "2026-06-01", "paid", "2026-06-15");                // pago ANTES de asOf → fora
  mkDraw(A, "despesa_empresarial", 200, "2026-06-03");                // aporte
  mkDraw(A, "pro_labore", 300, "2026-06-08");                          // retirada

  const s = BS.snapshot(A, ASOF);
  check("1.1 caixa reconstruído na data (1000 − 300 = 700)", s.ativo.caixa === 700);
  check("1.2 a receber aberto na data = 500 + 300 = 800", s.ativo.contasReceber === 800);
  check("1.3 estoque a custo = 80 (só o coberto)", s.ativo.estoque === 80);
  check("1.4 ativo total = 700 + 800 + 80 = 1580", s.ativo.total === 1580);
  check("1.5 a pagar aberto na data = 400 + 100 = 500", s.passivo.contasPagar === 500);
  check("1.6 PL = ativo − passivo = 1080 (identidade)", s.patrimonioLiquido.total === 1080);
  check("1.7 capital do sócio = aportes 200 − retiradas 300 = −100", s.patrimonioLiquido.capitalSocio === -100 && s.patrimonioLiquido.aportes === 200 && s.patrimonioLiquido.retiradas === 300);
  check("1.8 a conciliar = 1080 − (−100) = 1180", s.patrimonioLiquido.resultadoAConciliar === 1180);
  check("1.9 identidade fecha (Ativo = Passivo + PL)", s.balances === true && s.ativo.total === s.passivo.total + s.patrimonioLiquido.total);
  check("1.10 preso = a receber + estoque = 880", s.preso === 880);
  check("1.11 fonte de estoque = retail_store, coverage ~0.67", s.stockSource === "retail_store" && s.stockCoverage != null && Math.abs(s.stockCoverage - 0.67) < 0.01);
  check("1.12 caveat de estoque parcial presente", s.caveats.some((c) => /PARCIAL/i.test(c)));
  check("1.13 disclaimer gerencial", /não substitui a contabilidade/i.test(s.disclaimer));

  // ── B: sem loja → fallback ARMAZÉM (inventory_items) ──────────────────────
  const B = mkOrg("servicos");
  mkCashAccount(B, 500);
  mkInvItem(B, randomUUID(), 4, 25);          // 4 × 25 = 100
  const sB = BS.snapshot(B, ASOF);
  check("2.1 estoque do armazém = 100, source warehouse, coverage 1", sB.ativo.estoque === 100 && sB.stockSource === "warehouse" && sB.stockCoverage === 1);
  check("2.2 ativo = caixa 500 + estoque 100 = 600", sB.ativo.total === 600);

  // ── C: sem estoque instrumentado → null + caveat, identidade ainda fecha ──
  const C = mkOrg("servicos");
  mkCashAccount(C, 300);
  mkReceivable(C, 100, "2026-06-01");
  const sC = BS.snapshot(C, ASOF);
  check("3.1 estoque null + source none", sC.ativo.estoque === null && sC.stockSource === "none");
  check("3.2 caveat 'sem estoque instrumentado'", sC.caveats.some((c) => /sem estoque instrumentado/i.test(c)));
  check("3.3 ativo = caixa 300 + a receber 100 = 400 (estoque null não vira lucro forjado)", sC.ativo.total === 400);
  check("3.4 identidade fecha mesmo sem estoque", sC.balances === true);

  // ── 4: isolamento ─────────────────────────────────────────────────────────
  check("4.1 A não vê caixa de B/C", BS.snapshot(A, ASOF).ativo.caixa === 700);
  check("4.2 B só o seu (caixa 500)", sB.ativo.caixa === 500);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} managerial-balance: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
