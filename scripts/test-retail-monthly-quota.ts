/**
 * TESTE — Cota MENSAL dividida por SEMANA/DIA respeitando FOLGAS (QUOTA-004).
 *
 * Pedido do cliente (planilha "MENSAL"): informar o alvo do MÊS da loja e o
 * sistema divide pelas semanas/dias PROPORCIONAL aos dias em que a loja opera
 * na escala — semana com mais folga fica com fatia menor; dia fechado = 0.
 * A soma dos dias bate EXATAMENTE o alvo mensal (resíduo no último dia aberto).
 * Aplicar grava a cota diária da loja, de onde a cota por vendedor já deriva.
 *
 * Uso:  npm run test:retail-monthly-quota
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mquota-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-mquota-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService } = await import("../src/server/RetailOpsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), B);
  const store = RetailStoreService.create(A, { name: "Av Brasil", code: "1" }).id;
  const store2 = RetailStoreService.create(A, { name: "Loja 2", code: "2" }).id;

  const MONTH = "2026-08"; // agosto/2026 = 31 dias
  const daysOf = (a: string, b: string): string[] => { const out: string[] = []; for (let t = Date.parse(a + "T12:00:00Z"); t <= Date.parse(b + "T12:00:00Z"); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const allDays = daysOf("2026-08-01", "2026-08-31");
  const setEscala = (storeId: string, date: string, status: "work" | "off") =>
    db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status, created_by) VALUES (?, ?, ?, ?, 'mat:1', 'Ana', ?, NULL)
       ON CONFLICT(organization_id, store_id, work_date, seller_key) DO UPDATE SET status = excluded.status`).run(randomUUID(), A, storeId, date, status);
  const sumDays = (r: any) => r.weeks.reduce((a: number, w: any) => a + w.days.reduce((x: number, d: any) => x + d.amount, 0), 0);
  const flatDays = (r: any) => r.weeks.flatMap((w: any) => w.days);

  // ===== 1. mês todo aberto → fatia igual por dia, soma bate =====
  for (const d of allDays) setEscala(store, d, "work");
  const r1 = await RetailQuotaService.distributeMonthly(A, store, MONTH, 3100, {}); // 3100/31 = 100/dia
  check("1.1 totalOpenDays = 31 (mês todo aberto)", r1.totalOpenDays === 31, `${r1.totalOpenDays}`);
  check("1.2 perDay = 100,00", near(r1.perDay, 100), `${r1.perDay}`);
  check("1.3 soma dos dias = 3100 (bate o alvo)", near(sumDays(r1), 3100), `${sumDays(r1)}`);
  check("1.4 todo dia = 100 e aberto", flatDays(r1).every((d: any) => near(d.amount, 100) && d.open === true));
  check("1.5 preview NÃO grava (applied false, sem cota no banco)", r1.applied === false && !RetailQuotaService.get(A, store, "2026-08-05"));

  // ===== 2. folga zera o dia; semana com folga fica com fatia menor =====
  setEscala(store, "2026-08-10", "off"); // 10/08 vira folga (loja fechada nesse dia)
  const r2 = await RetailQuotaService.distributeMonthly(A, store, MONTH, 3000, {}); // 30 dias abertos → 100/dia
  check("2.1 totalOpenDays = 30 (um dia fechado)", r2.totalOpenDays === 30, `${r2.totalOpenDays}`);
  const d10 = flatDays(r2).find((d: any) => d.date === "2026-08-10");
  check("2.2 dia de folga: amount 0 e open false", near(d10.amount, 0) && d10.open === false);
  check("2.3 soma dos dias = 3000 (folga não recebe)", near(sumDays(r2), 3000), `${sumDays(r2)}`);
  const wkWithOff = r2.weeks.find((w: any) => w.days.some((d: any) => d.date === "2026-08-10"));
  const wkFull = r2.weeks.find((w: any) => w.openDays === 7);
  check("2.4 a semana com folga tem menos dias abertos que uma semana cheia", !!wkFull && wkWithOff.openDays < wkFull.openDays, `${wkWithOff?.openDays} < ${wkFull?.openDays}`);

  // ===== 3. resíduo do arredondamento vai no último dia aberto (soma exata) =====
  const r3 = await RetailQuotaService.distributeMonthly(A, store, MONTH, 1000, {}); // 1000/30 = 33,33...
  check("3.1 soma dos dias = 1000 exatos (resíduo no último aberto)", near(sumDays(r3), 1000), `${sumDays(r3)}`);
  const openAmounts = flatDays(r3).filter((d: any) => d.open).map((d: any) => d.amount);
  check("3.2 último dia aberto absorve o resíduo (≠ perDay)", Math.abs(openAmounts[openAmounts.length - 1] - r3.perDay) > 0.001, `${openAmounts[openAmounts.length - 1]} vs ${r3.perDay}`);

  // ===== 4. loja SEM escala → todos os dias contam como abertos (fallback) =====
  const r4 = await RetailQuotaService.distributeMonthly(A, store2, MONTH, 3100, {});
  check("4.1 sem escala: totalOpenDays = 31 (não zera a loja)", r4.totalOpenDays === 31, `${r4.totalOpenDays}`);
  check("4.2 sem escala: soma bate 3100", near(sumDays(r4), 3100));
  check("4.3 sem escala: weekHasSchedule false em todas as semanas", r4.weeks.every((w: any) => w.weekHasSchedule === false));

  // ===== 5. mês todo fechado → erro honesto (não inventa cota) =====
  const store3 = RetailStoreService.create(A, { name: "Loja Fechada", code: "3" }).id;
  for (const d of allDays) db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status, created_by) VALUES (?, ?, ?, ?, 'mat:1', 'Ana', 'off', NULL)`).run(randomUUID(), A, store3, d);
  let threw5 = false; try { await RetailQuotaService.distributeMonthly(A, store3, MONTH, 3100, {}); } catch { threw5 = true; }
  check("5.1 mês todo em folga → lança (não distribui)", threw5);

  // ===== 6. valor inválido / loja inexistente → erro =====
  let threw6a = false; try { await RetailQuotaService.distributeMonthly(A, store, MONTH, 0, {}); } catch { threw6a = true; }
  check("6.1 cota mensal 0 → lança", threw6a);
  let threw6b = false; try { await RetailQuotaService.distributeMonthly(A, randomUUID(), MONTH, 100, {}); } catch { threw6b = true; }
  check("6.2 loja inexistente → lança", threw6b);
  let threw6c = false; try { await RetailQuotaService.distributeMonthly(A, store, "2026-8", 100, {}); } catch { threw6c = true; }
  check("6.3 mês malformado → lança", threw6c);

  // ===== 7. APPLY grava cota diária + atualiza snapshot/desvio do fechamento =====
  // Fechamento no dia 05 informado ANTES de aplicar (pra ver o desvio recalcular).
  RetailClosingService.submitDetailed(A, store, "2026-08-05", { dinheiro: 150, pix: 50 }); // informado 200
  const r7 = await RetailQuotaService.distributeMonthly(A, store, MONTH, 3000, { apply: true }); // 30 abertos → 100/dia
  check("7.1 applied true", r7.applied === true);
  check("7.2 cota diária gravada: dia 05 = 100", near(RetailQuotaService.get(A, store, "2026-08-05")?.quota_amount, 100));
  check("7.3 dia de folga 10 gravado como 0", near(RetailQuotaService.get(A, store, "2026-08-10")?.quota_amount, 0));
  const c5: any = db.prepare(`SELECT quota_amount, informed_total, variance_amount FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = '2026-08-05'`).get(A, store);
  check("7.4 snapshot do fechamento: cota vira 100", near(c5?.quota_amount, 100), `${c5?.quota_amount}`);
  check("7.5 desvio recalculado: informado 200 − cota 100 = +100", near(c5?.variance_amount, 100), `${c5?.variance_amount}`);
  const source = RetailQuotaService.get(A, store, "2026-08-05")?.source;
  check("7.6 source marcada 'monthly_distribute'", source === "monthly_distribute", `${source}`);

  // ===== 8. isolamento por org: distribuir na org A não cria cota na org B =====
  const storeB = RetailStoreService.create(B, { name: "Loja B", code: "1" }).id;
  check("8.1 org B não tem cota do dia 05 (nada vazou de A)", !RetailQuotaService.get(B, storeB, "2026-08-05"));
  check("8.2 org A dia 05 segue 100", near(RetailQuotaService.get(A, store, "2026-08-05")?.quota_amount, 100));

  console.log("\n=== TEST: Cota mensal dividida por semana (folgas) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
