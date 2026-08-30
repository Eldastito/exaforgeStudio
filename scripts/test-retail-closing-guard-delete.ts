/**
 * TESTE — Fechamento: trava de LOJA FECHADA (CLOSE-002) + EXCLUIR fechamento
 * (CLOSE-003).
 *
 * Pedidos do lojista: (1) não deixar informar fechamento numa loja de folga
 * geral no dia (evita lançamento no dia/loja errado — o "Informado 6086" do
 * Carioca); (2) poder EXCLUIR um fechamento errado, limpando também a cota do
 * dia (a coluna Cota da tela vem do snapshot do fechamento).
 *
 * Uso:  npm run test:retail-closing-guard-delete
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-close-guard-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-close-guard-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const DATE = "2026-08-30";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService, RetailQuotaService } = await import("../src/server/RetailOpsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const fechada = RetailStoreService.create(A, { name: "Av Brasil", code: "1" }).id;
  const aberta = RetailStoreService.create(A, { name: "Carioca", code: "2" }).id;
  const semEscala = RetailStoreService.create(A, { name: "Grande Rio", code: "3" }).id;

  const sch = db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  sch.run(randomUUID(), A, fechada, DATE, "mat:1", "Fulano", "off");
  sch.run(randomUUID(), A, fechada, DATE, "mat:2", "Ciclano", "off");
  sch.run(randomUUID(), A, aberta, DATE, "mat:3", "Beltrano", "work");
  // semEscala: nada.

  // ===== 1. isStoreClosedOnDate =====
  check("1.1 loja com todos de folga → fechada", RetailClosingService.isStoreClosedOnDate(A, fechada, DATE) === true);
  check("1.2 loja com alguém trabalhando → aberta", RetailClosingService.isStoreClosedOnDate(A, aberta, DATE) === false);
  check("1.3 loja sem escala no dia → não trava", RetailClosingService.isStoreClosedOnDate(A, semEscala, DATE) === false);

  // ===== 2. trava no setInformed / submitDetailed =====
  const cFech = RetailClosingService.getOrCreate(A, fechada, DATE);
  let threwInform = false;
  try { RetailClosingService.setInformed(A, cFech.id, { informedTotal: 6086.2 }); } catch { threwInform = true; }
  check("2.1 setInformed BLOQUEADO em loja fechada", threwInform);
  let threwDetailed = false;
  try { RetailClosingService.submitDetailed(A, fechada, DATE, { dinheiro: 100 }); } catch { threwDetailed = true; }
  check("2.2 submitDetailed BLOQUEADO em loja fechada", threwDetailed);
  check("2.3 nada foi informado (informed_total segue nulo/0)", !(Number(RetailClosingService.get(A, cFech.id)?.informed_total) > 0));

  // ===== 3. loja aberta / sem escala → informar funciona =====
  const cAb = RetailClosingService.getOrCreate(A, aberta, DATE);
  const okAb = RetailClosingService.setInformed(A, cAb.id, { informedTotal: 1000 });
  check("3.1 loja ABERTA informa normal", !!okAb && Number(okAb.informed_total) === 1000);
  const cSem = RetailClosingService.getOrCreate(A, semEscala, DATE);
  const okSem = RetailClosingService.setInformed(A, cSem.id, { informedTotal: 500 });
  check("3.2 loja SEM escala informa normal", !!okSem && Number(okSem.informed_total) === 500);

  // ===== 4. remove() apaga fechamento + itens + cota do dia =====
  RetailQuotaService.set(A, { storeId: aberta, quotaDate: DATE, quotaAmount: 523.36 });
  // recria snapshot no fechamento (informar já gravou; cota estava 0 → set agora)
  const removed = RetailClosingService.remove(A, cAb.id);
  check("4.1 remove devolve true", removed === true);
  check("4.2 fechamento sumiu", RetailClosingService.get(A, cAb.id) === null);
  check("4.3 itens do fechamento sumiram", (db.prepare(`SELECT COUNT(*) n FROM retail_daily_closing_items WHERE closing_id = ?`).get(cAb.id) as any).n === 0);
  check("4.4 cota do dia da loja sumiu (coluna Cota vira —)", RetailQuotaService.get(A, aberta, DATE) === null);
  check("4.5 remove de id inexistente → false", RetailClosingService.remove(A, randomUUID()) === false);

  console.log("\n=== TEST: Fechamento — trava loja fechada + excluir ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
