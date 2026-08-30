/**
 * TESTE — Cota do dia editável + snapshot (QUOTA-003).
 *
 * Bug real (Carioca 29/08): a cota do dia aparecia 3.077,98 (média do PDV
 * aplicada como cota, source 'pdv_suggest') em vez dos 3.800 da folha. Como a
 * coluna "Cota" da tela lê o SNAPSHOT do fechamento (retail_daily_closings.
 * quota_amount), corrigir a cota tinha que atualizar o snapshot também.
 *
 * Cobre RetailQuotaService.setForDate:
 *  - grava a cota da loja no dia (upsert, source 'manual');
 *  - atualiza o snapshot do fechamento na hora;
 *  - recalcula o desvio quando já há "informado";
 *  - sobrepõe um palpite anterior do PDV.
 *
 * Uso:  npm run test:retail-quota-for-date
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-quota-fordate-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-quota-fordate-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const DATE = "2026-08-29";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService, RetailQuotaService } = await import("../src/server/RetailOpsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const carioca = RetailStoreService.create(A, { name: "Carioca", code: "1" }).id;

  // Palpite do PDV gravado antes (o "3.077,98 inventado").
  RetailQuotaService.set(A, { storeId: carioca, quotaDate: DATE, quotaAmount: 3077.98, source: "pdv_suggest" });
  const c = RetailClosingService.getOrCreate(A, carioca, DATE);
  check("0.1 snapshot inicial = palpite do PDV", Number(RetailClosingService.get(A, c.id)?.quota_amount) === 3077.98);

  // Lojista informa a venda do dia (1065,00) antes de corrigir a cota.
  RetailClosingService.setInformed(A, c.id, { informedTotal: 1065 });

  // ===== 1. setForDate grava a cota real e atualiza o snapshot =====
  RetailQuotaService.setForDate(A, carioca, DATE, 3800, "manual");
  const q = RetailQuotaService.get(A, carioca, DATE);
  check("1.1 cota da loja gravada = 3800", Number(q?.quota_amount) === 3800, String(q?.quota_amount));
  check("1.2 source vira 'manual' (sobrepõe pdv_suggest)", q?.source === "manual", q?.source);
  const c2 = RetailClosingService.get(A, c.id);
  check("1.3 snapshot do fechamento atualizado = 3800", Number(c2?.quota_amount) === 3800, String(c2?.quota_amount));

  // ===== 2. desvio recalculado com o informado (1065 - 3800) =====
  check("2.1 variance_amount = 1065 - 3800 = -2735", Number(c2?.variance_amount) === -2735, String(c2?.variance_amount));
  const expectedPct = Math.round((1065 - 3800) * 100.0 / 3800 * 1e6) / 1e6;
  check("2.2 variance_percent = (1065-3800)/3800", Math.abs(Number(c2?.variance_percent) - expectedPct) < 1e-6, String(c2?.variance_percent));

  // ===== 3. sem "informado" → snapshot atualiza, desvio não estoura =====
  const outro = RetailStoreService.create(A, { name: "Grande Rio", code: "2" }).id;
  const c3 = RetailClosingService.getOrCreate(A, outro, DATE);
  RetailQuotaService.setForDate(A, outro, DATE, 2500, "manual");
  const c3b = RetailClosingService.get(A, c3.id);
  check("3.1 snapshot atualiza sem informado", Number(c3b?.quota_amount) === 2500, String(c3b?.quota_amount));
  // Sem "informado" o desvio NÃO é recalculado (não vira -2500) — fica no valor
  // pré-existente (0/null), sem inventar diferença.
  check("3.2 sem informado → desvio não é recalculado", !(Number(c3b?.variance_amount) < 0), String(c3b?.variance_amount));

  console.log("\n=== TEST: Cota do dia editável + snapshot ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
