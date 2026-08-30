/**
 * TESTE — RetailQuotaService.suggestForDate: sugestão de cota diária pelo PDV
 * COM trava da escala (QUOTA-002).
 *
 * Bug do lojista: a sugestão dava cota numa loja onde NINGUÉM trabalha no dia
 * (domingo de folga geral). Prova:
 *   - loja com escala no dia mas ninguém 'work' → cota 0 (skipped);
 *   - ao aplicar, ZERA cota já gravada e o snapshot do fechamento (corrige o
 *     valor errado que aparecia na tela);
 *   - loja aberta (alguém 'work') → sugere pelo histórico e grava;
 *   - loja SEM escala lançada no dia → mantém comportamento antigo (sugere);
 *   - isolamento por org.
 *
 * Uso:  npm run test:retail-quota-suggest
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-quota-suggest-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-quota-suggest-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const DATE = "2026-08-30"; // domingo (dow 0)
const PAST_SUNDAYS = ["2026-08-23", "2026-08-16", "2026-08-09"]; // mesmo dia da semana, < 56 dias

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailQuotaService } = await import("../src/server/RetailOpsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  const mkStore = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, name.slice(0, 3)); return id; };
  const fechada = mkStore(A, "Av Brasil");   // escala no dia, todos de folga
  const aberta = mkStore(A, "Carioca");      // alguém trabalha no dia
  const semEscala = mkStore(A, "Grande Rio"); // sem escala lançada no dia

  // Histórico do PDV (system_total nos domingos passados) — todas com média > 0.
  const hist = db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, ?, ?, 'approved', ?)`);
  for (const st of [fechada, aberta, semEscala]) for (const d of PAST_SUNDAYS) hist.run(randomUUID(), A, st, d, 5000);

  // Escala do dia-alvo: Av Brasil todos de folga; Carioca com 1 trabalhando.
  const sch = db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  sch.run(randomUUID(), A, fechada, DATE, "mat:1", "Fulano", "off");
  sch.run(randomUUID(), A, fechada, DATE, "mat:2", "Ciclano", "off");
  sch.run(randomUUID(), A, aberta, DATE, "mat:3", "Beltrano", "work");
  // semEscala: nenhuma entrada no dia.

  // Cota ERRADA já gravada na loja fechada (o 4990 da tela) + fechamento com snapshot.
  RetailQuotaService.set(A, { storeId: fechada, quotaDate: DATE, quotaAmount: 4990.5, source: "pdv_suggest" });
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, quota_amount) VALUES (?, ?, ?, ?, 'pending', ?)`).run(randomUUID(), A, fechada, DATE, 4990.5);

  // ===== dry-run (apply=false) =====
  const dry = RetailQuotaService.suggestForDate(A, DATE, { apply: false });
  const sFech = dry.suggestions.find((x: any) => x.storeId === fechada);
  const sAb = dry.suggestions.find((x: any) => x.storeId === aberta);
  const sSem = dry.suggestions.find((x: any) => x.storeId === semEscala);
  check("1.1 loja FECHADA vem como skipped, sugerido 0", !!sFech && sFech.skipped === true && sFech.suggested === 0, JSON.stringify(sFech));
  check("1.2 loja ABERTA sugere > 0 (histórico)", !!sAb && sAb.suggested > 0 && !sAb.skipped, JSON.stringify(sAb));
  check("1.3 loja SEM escala no dia AINDA sugere (não suprime)", !!sSem && sSem.suggested > 0 && !sSem.skipped, JSON.stringify(sSem));
  check("1.4 dry-run não gravou nada na loja fechada (cota segue 4990,50)", Number(RetailQuotaService.get(A, fechada, DATE)?.quota_amount) === 4990.5);

  // ===== apply=true =====
  RetailQuotaService.suggestForDate(A, DATE, { apply: true });
  check("2.1 loja FECHADA: cota ZERADA ao aplicar", Number(RetailQuotaService.get(A, fechada, DATE)?.quota_amount) === 0, `${RetailQuotaService.get(A, fechada, DATE)?.quota_amount}`);
  const snap = db.prepare(`SELECT quota_amount FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ? AND status = 'pending'`).get(A, fechada, DATE) as any;
  check("2.2 loja FECHADA: snapshot do fechamento zerado", Number(snap?.quota_amount) === 0, `${snap?.quota_amount}`);
  check("2.3 loja ABERTA: cota gravada > 0", Number(RetailQuotaService.get(A, aberta, DATE)?.quota_amount) > 0, `${RetailQuotaService.get(A, aberta, DATE)?.quota_amount}`);
  check("2.4 loja SEM escala: cota gravada > 0", Number(RetailQuotaService.get(A, semEscala, DATE)?.quota_amount) > 0);

  // ===== isolamento =====
  const isoB = RetailQuotaService.suggestForDate(B, DATE, { apply: false });
  check("3.1 org B não vê lojas de A", isoB.suggestions.length === 0, JSON.stringify(isoB.suggestions));

  console.log("\n=== TEST: suggestForDate (cota PDV + trava da escala) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
