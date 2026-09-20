/**
 * TESTE — 20/09/2026: dias fixos SEM funcionamento da loja (`closed_weekdays`).
 * -----------------------------------------------------------------------------
 * Caso real Toulon (Av. Brasil não abre aos domingos): a cota mensal distribuía
 * fatia de R$ 5 mil no domingo ("semana sem escala = tudo aberto"), a pendência
 * de fechamento cobrava a loja e o mês fechava "negativo/pendente" num dia em
 * que a loja simplesmente não existe.
 *
 * O dia fixo entra no MESMO chokepoint da folga geral (CLOSE-002,
 * `isStoreClosedOnDate`) e propaga: cota sugerida 0 · cota mensal pula o dia ·
 * fechamento bloqueado · sem pendência de cobrança · grade semanal marca
 * "fechada". A ESCALA lançada no dia SEMPRE vence (abre um domingo excepcional).
 *
 * Uso: npm run test:retail-store-closed-days
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-closed-days-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-closed-days-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

/** Próxima data (YYYY-MM-DD) que cai no dia-da-semana pedido (0=domingo). */
function nextDow(dow: number, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService, RetailTaskService } = await import("../src/server/RetailOpsService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_daily_closing_enabled, retail_malote_enabled) VALUES (?, ?, 'A', 'active', 1, 1)`).run(randomUUID(), A);
  const domingo = nextDow(0);
  const segunda = nextDow(1);

  // ── 1) Cadastro: gravar, normalizar, limpar e validar. ──
  const sA = RetailStoreService.create(A, { name: "Av. Brasil", code: "1082", closedWeekdays: [0] });
  check("1.1 dias fechados gravados no cadastro ([0] = domingo)", sA.closed_weekdays === "[0]", sA.closed_weekdays);
  const sUpd = RetailStoreService.update(A, sA.id, { closedWeekdays: [3, 0, 0, 9 as any, -1 as any] });
  check("1.2 normaliza (únicos, ordenados, só 0..6)", sUpd?.closed_weekdays === "[0,3]", sUpd?.closed_weekdays);
  let all7Err = "";
  try { RetailStoreService.update(A, sA.id, { closedWeekdays: [0, 1, 2, 3, 4, 5, 6] }); } catch (e: any) { all7Err = e.message; }
  check("1.3 fechada TODOS os dias é rejeitado", all7Err.includes("todos os dias"), all7Err);
  const sClear = RetailStoreService.update(A, sA.id, { closedWeekdays: null });
  check("1.4 limpar volta pro padrão (abre todos os dias)", sClear?.closed_weekdays == null, String(sClear?.closed_weekdays));
  RetailStoreService.update(A, sA.id, { closedWeekdays: [0] }); // estado do caso real

  // ── 2) Chokepoint: dia fixo fecha; escala lançada SEMPRE vence. ──
  check("2.1 domingo (dia fixo) → fechada", RetailClosingService.isStoreClosedOnDate(A, sA.id, domingo) === true);
  check("2.2 segunda → aberta", RetailClosingService.isStoreClosedOnDate(A, sA.id, segunda) === false);
  // Domingo excepcional: escala do dia com alguém 'work' → ABERTA.
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, status) VALUES (?, ?, ?, ?, 'maria', 'work')`).run(randomUUID(), A, sA.id, domingo);
  check("2.3 escala com gente trabalhando VENCE o dia fixo (domingo aberto)", RetailClosingService.isStoreClosedOnDate(A, sA.id, domingo) === false);
  db.prepare(`DELETE FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date = ?`).run(A, sA.id, domingo);
  // Folga geral por escala continua fechando qualquer dia (comportamento antigo).
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, status) VALUES (?, ?, ?, ?, 'maria', 'off')`).run(randomUUID(), A, sA.id, segunda);
  check("2.4 folga geral na escala segue fechando (segunda fechada)", RetailClosingService.isStoreClosedOnDate(A, sA.id, segunda) === true);
  db.prepare(`DELETE FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date = ?`).run(A, sA.id, segunda);

  // ── 3) Cota sugerida: domingo não ganha cota e CORRIGE a errada. ──
  RetailQuotaService.set(A, { storeId: sA.id, quotaDate: domingo, quotaAmount: 5000 }); // a cota errada do caso real
  const sug = RetailQuotaService.suggestForDate(A, domingo, { apply: true });
  const sugA = sug.suggestions.find((x: any) => x.storeId === sA.id);
  check("3.1 sugestão marca a loja como fechada (skipped)", sugA?.skipped === true && sugA?.suggested === 0, JSON.stringify(sugA));
  const qDom = RetailQuotaService.get(A, sA.id, domingo);
  check("3.2 a cota errada de 5.000 do domingo foi ZERADA", Number(qDom?.quota_amount) === 0, String(qDom?.quota_amount));

  // ── 4) Cota mensal: domingo (sem escala) fica com 0 e a soma bate o alvo. ──
  const month = domingo.slice(0, 7);
  const { RetailQuotaService: RQ } = await import("../src/server/RetailOpsService.js");
  const dist = await (RQ as any).distributeMonthly(A, sA.id, month, 26000, { apply: false });
  const allDays: any[] = dist.weeks.flatMap((w: any) => w.days);
  const sundays = allDays.filter((d: any) => new Date(`${d.date}T12:00:00Z`).getUTCDay() === 0);
  check("4.1 TODO domingo do plano fica fechado (amount 0)", sundays.length > 0 && sundays.every((d: any) => !d.open && d.amount === 0), JSON.stringify(sundays.slice(0, 3)));
  const total = Math.round(allDays.reduce((a: number, d: any) => a + d.amount, 0) * 100) / 100;
  check("4.2 a soma dos dias abertos bate EXATO o alvo (26.000)", total === 26000, String(total));
  check("4.3 dias abertos = plano − domingos", dist.totalOpenDays === allDays.length - sundays.length, `${dist.totalOpenDays}/${allDays.length}`);

  // ── 5) Fechamento bloqueado no dia fechado (CLOSE-002 estendido). ──
  const cDom = RetailClosingService.getOrCreate(A, sA.id, domingo);
  let closeErr = "";
  try { RetailClosingService.setInformed(A, cDom.id, { informedTotal: 1000 }); } catch (e: any) { closeErr = e.message; }
  check("5.1 informar fechamento no domingo é bloqueado", closeErr.includes("fechada"), closeErr);
  const cSeg = RetailClosingService.getOrCreate(A, sA.id, segunda);
  const okSeg = RetailClosingService.setInformed(A, cSeg.id, { informedTotal: 1000 });
  check("5.2 na segunda informa normal", okSeg?.status === "received" && Number(okSeg?.informed_total) === 1000);

  // ── 6) Pendências do dia: loja fechada não é cobrada. ──
  const sB = RetailStoreService.create(A, { name: "Sempre Aberta", code: "1099" });
  const nDom = RetailTaskService.generateDay(A, domingo);
  const tasksDomA = db.prepare(`SELECT COUNT(*) n FROM retail_store_daily_tasks WHERE organization_id=? AND store_id=? AND task_date=?`).get(A, sA.id, domingo) as any;
  const tasksDomB = db.prepare(`SELECT COUNT(*) n FROM retail_store_daily_tasks WHERE organization_id=? AND store_id=? AND task_date=?`).get(A, sB.id, domingo) as any;
  check("6.1 domingo: loja fechada SEM pendência; a aberta é cobrada", Number(tasksDomA?.n) === 0 && Number(tasksDomB?.n) === 2, `A=${tasksDomA?.n} B=${tasksDomB?.n} criadas=${nDom}`);
  RetailTaskService.generateDay(A, segunda);
  const tasksSegA = db.prepare(`SELECT COUNT(*) n FROM retail_store_daily_tasks WHERE organization_id=? AND store_id=? AND task_date=?`).get(A, sA.id, segunda) as any;
  check("6.2 segunda: a mesma loja volta a ser cobrada", Number(tasksSegA?.n) === 2, String(tasksSegA?.n));

  // ── 7) Grade semanal expõe os dias fechados. ──
  const week = RetailClosingService.listWeek(A, domingo);
  const rowA = week.stores.find((s: any) => s.store_id === sA.id);
  const rowB = week.stores.find((s: any) => s.store_id === sB.id);
  check("7.1 grade marca o domingo da loja como fechado", rowA?.closedDays?.[domingo] === true, JSON.stringify(rowA?.closedDays));
  check("7.2 loja sem dia fixo não é marcada", !rowB?.closedDays?.[domingo], JSON.stringify(rowB?.closedDays));

  // ── 8) Isolamento multi-tenant. ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const sOther = RetailStoreService.create(B, { name: "Outra Org", code: "1082" });
  check("8.1 org B (mesmo código de filial) segue aberta no domingo", RetailClosingService.isStoreClosedOnDate(B, sOther.id, domingo) === false);

  console.log("\n=== TEST: Dias fixos sem funcionamento da loja (closed_weekdays) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
