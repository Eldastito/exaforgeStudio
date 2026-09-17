/**
 * TESTE — Unificação de loja duplicada (RetailStoreService.remove) SEM perder
 * escala, malote, lotação, boletas e vendas por vendedor.
 *
 * Bug que motivou: o merge migrava fechamentos/estoque/cotas/tarefas mas
 * deixava órfãos no store_id apagado a ESCALA (sumia do fechamento diário),
 * o MALOTE inteiro (depósitos, ajustes de dia, semanas fechadas — a tela
 * zerava), o template de folga, a lotação, as boletas e as vendas por
 * vendedor; e nos dias de conflito APAGAVA os itens por forma de pagamento
 * (o 'dinheiro' do malote sumia pra sempre).
 *
 * Uso:  npm run test:retail-store-merge
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-merge-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-merge-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailCashDepositService: Cash } = await import("../src/server/RetailCashDepositService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);

  // Alvo (a loja "de verdade") + duplicata legada com o MESMO código (inserida
  // direto — a guarda de código único não existia quando duplicatas nasceram).
  const T = RetailStoreService.create(A, { name: "Toulon Centro", code: "7" }).id;
  const D = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Toulon Centro (2)', '7', 1)`).run(D, A);

  // ── Semeia a DUPLICATA com tudo que o merge precisa carregar ──────────────
  // Fechamento só na duplicata: dinheiro 200 − despesas 32 (o caso do malote).
  RetailClosingService.submitDetailed(A, D, "2026-08-12", {
    dinheiro: 200, despesas: [{ descricao: "água", valor: 32 }],
    ranking: [{ sellerName: "Ana", valor: 200, atendimentos: 3, pecas: 5 }],
  });
  // Conflito com alvo VAZIO: o alvo tem o dia pendente sem itens; a duplicata
  // tem a folha completa — o alvo deve herdar total, itens E details_json.
  RetailClosingService.getOrCreate(A, T, "2026-08-13");
  RetailClosingService.submitDetailed(A, D, "2026-08-13", { dinheiro: 100 });
  // Conflito com dados DOS DOIS lados: o alvo mantém os dele (política "o alvo
  // está mais fresco"), inclusive nas vendas por vendedor do dia.
  RetailClosingService.submitDetailed(A, T, "2026-08-14", { dinheiro: 50, ranking: [{ sellerName: "Bia", valor: 50 }] });
  RetailClosingService.submitDetailed(A, D, "2026-08-14", { dinheiro: 999, ranking: [{ sellerName: "Caio", valor: 999 }] });

  // Escala + template de folga + lotação na duplicata.
  const ins = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
  ins(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-08-12', 'mat:1', 'Ana', 'work')`, randomUUID(), A, D);
  ins(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-08-12', 'mat:2', 'Caio', 'off')`, randomUUID(), A, D);
  ins(`INSERT INTO retail_seller_off_pattern (id, organization_id, store_id, seller_key, seller_name, day_of_week) VALUES (?, ?, ?, 'mat:1', 'Ana', 1)`, randomUUID(), A, D);
  ins(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, active) VALUES (?, ?, ?, ?, 1)`, randomUUID(), A, randomUUID(), D);

  // Malote na duplicata: depósito + ajuste de dia + semana fechada.
  Cash.registerDeposit(A, D, { date: "2026-08-12", amount: 150, depositor: "Bia", receiptUrl: "/media/dep.jpg" });
  Cash.setDayOverride(A, D, "2026-08-11", 80);
  Cash.closeWeek(A, D, { weekStart: "2026-08-03", weekEnd: "2026-08-09", depositor: "Bia" });

  // Boletas + venda por vendedor manual na duplicata.
  ins(`INSERT INTO retail_boleta_days (id, organization_id, store_id, day, initial_number) VALUES (?, ?, ?, '2026-08-12', '017752')`, randomUUID(), A, D);
  ins(`INSERT INTO retail_boleta_events (id, organization_id, store_id, day, boleta_number, seq, status) VALUES (?, ?, ?, '2026-08-12', '017752', 1, 'active')`, randomUUID(), A, D);
  ins(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor, source) VALUES (?, ?, ?, '2026-08-10', 'Dani', 70, 'manual')`, randomUUID(), A, D);

  // ── Unifica: excluir a duplicata funde tudo no alvo ───────────────────────
  const res = RetailStoreService.remove(A, D);
  check("1.1 duplicata excluída e unificada no alvo", res.deleted === true && res.mergedInto === T, JSON.stringify(res));

  const count = (t: string, store: string) => Number((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE organization_id = ? AND store_id = ?`).get(A, store) as any)?.n || 0);

  // ===== 2. ESCALA (o "sumiu do fechamento diário") =====
  check("2.1 escala migrou pro alvo (2 linhas)", count("retail_schedule_entries", T) === 2, `${count("retail_schedule_entries", T)}`);
  check("2.2 template de folga migrou", count("retail_seller_off_pattern", T) === 1);
  check("2.3 lotação de vendedor migrou", count("retail_seller_store_assignments", T) === 1);

  // ===== 3. MALOTE (o "zerou depois de unificar") =====
  const led = Cash.monthLedger(A, T, "2026-08");
  const row = (d: string) => led.rows.find((r: any) => r.date === d);
  check("3.1 depósito da duplicata aparece no malote do alvo (150)", near(led.totalDeposited, 150), `${led.totalDeposited}`);
  check("3.2 ajuste de dia migrou (dia 11 = 80, source ajuste)", near(row("2026-08-11")?.cash, 80) && row("2026-08-11")?.cashSource === "ajuste", `${row("2026-08-11")?.cash}`);
  check("3.3 semana fechada migrou (dia 04 travado no alvo)", Cash.isWeekClosed(A, T, "2026-08-04") === true);
  check("3.4 dia 12: dinheiro líquido 168 (200 − 32) veio com a folha", near(row("2026-08-12")?.cash, 168), `${row("2026-08-12")?.cash}`);

  // ===== 4. CONFLITOS de fechamento =====
  check("4.1 conflito com alvo vazio: itens herdados → dinheiro 100 no malote", near(row("2026-08-13")?.cash, 100), `${row("2026-08-13")?.cash}`);
  const c13 = RetailClosingService.listByDate(A, "2026-08-13").find((c: any) => c.store_id === T) as any;
  check("4.2 conflito com alvo vazio: informado 100 + details_json herdado", near(c13?.informed_total, 100) && !!c13?.details_json, `${c13?.informed_total}`);
  check("4.3 conflito com dados dos dois: alvo mantém os dele (50, não 999)", near(row("2026-08-14")?.cash, 50), `${row("2026-08-14")?.cash}`);

  // ===== 5. Boletas + vendas por vendedor =====
  check("5.1 boletas migraram (dia + evento)", count("retail_boleta_days", T) === 1 && count("retail_boleta_events", T) === 1);
  const sales = db.prepare(`SELECT sale_date, seller_name, valor, source FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? ORDER BY sale_date`).all(A, T) as any[];
  check("5.2 venda manual re-apontada (Dani 70)", sales.some((s) => s.seller_name === "Dani" && near(s.valor, 70)));
  check("5.3 ranking da duplicata (dia sem conflito) veio (Ana 200)", sales.some((s) => s.sale_date === "2026-08-12" && s.seller_name === "Ana"));
  const d14 = sales.filter((s) => s.sale_date === "2026-08-14" && s.source === "closing");
  check("5.4 dia de conflito: só as vendas do alvo (Bia), sem dobrar", d14.length === 1 && d14[0].seller_name === "Bia", JSON.stringify(d14));

  // ===== 6. Nada órfão no store_id apagado =====
  const orphanTables = ["retail_daily_closings", "retail_schedule_entries", "retail_seller_off_pattern", "retail_seller_store_assignments", "retail_cash_deposits", "retail_cash_day_override", "retail_cash_week_closings", "retail_boleta_days", "retail_boleta_events", "retail_seller_sales"];
  const orphans = orphanTables.filter((t) => count(t, D) > 0);
  check("6.1 nenhuma tabela ficou órfã na loja apagada", orphans.length === 0, orphans.join(","));
  check("6.2 loja duplicada sumiu do cadastro", !db.prepare(`SELECT 1 FROM retail_stores WHERE organization_id = ? AND id = ?`).get(A, D));

  console.log("\n=== TEST: Unificação de loja duplicada (merge completo) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
