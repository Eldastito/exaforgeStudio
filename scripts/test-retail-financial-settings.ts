/**
 * TESTE — Config financeira ATÔMICA da loja (PDR TOULON, Fatia 1C / SAVE-001..003).
 * ------------------------------------------------------------------------------
 * Prova, offline (RetailStoreCostService.financialSettings / saveFinancialSettings):
 *   - GET composto devolve margem + fixos + variáveis + versão;
 *   - PUT grava tudo numa transação e INCREMENTA a versão;
 *   - validação (margem fora de 0..100) NÃO persiste NADA (all-or-nothing);
 *   - expectedVersion desatualizada → conflito (o route mapeia 409);
 *   - só mexe nas categorias enviadas; isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-financial-settings
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-finsettings-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-finsettings-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Barra', 'B01', 1)`).run(store, A);

  // ===== 1. GET inicial: vazio + versão 0 =====
  const fs0 = RetailStoreCostService.financialSettings(A, store);
  check("GET inicial: margem null, versão 0", fs0.grossMarginPercent === null && fs0.version === 0);
  check("GET inicial: expõe as chaves de fixos/variáveis", !!fs0.fixedCosts?.byCategory && !!fs0.variableCosts?.byCategory);

  // ===== 2. PUT composto grava tudo + versão 1 =====
  const r1 = RetailStoreCostService.saveFinancialSettings(A, store, {
    grossMarginPercent: 55,
    fixedCosts: { aluguel: 3000 },
    variableCosts: { card_fee: { percent: 2.49, fixedPerSale: 0.39 } },
    expectedVersion: 0,
  }, "user1");
  check("PUT grava margem", r1.grossMarginPercent === 55);
  check("PUT grava custo fixo", r1.fixedCosts.byCategory.aluguel === 3000);
  check("PUT grava custo variável (percent+fixo)", r1.variableCosts.byCategory.card_fee.percent === 2.49 && r1.variableCosts.byCategory.card_fee.fixedPerSale === 0.39);
  check("PUT incrementa a versão (0→1)", r1.version === 1);

  // ===== 3. validação NÃO persiste nada (all-or-nothing) =====
  let threw = false;
  try { RetailStoreCostService.saveFinancialSettings(A, store, { grossMarginPercent: 150, fixedCosts: { aluguel: 9999 } }, "user1"); }
  catch { threw = true; }
  check("margem inválida (150) é rejeitada", threw);
  const afterBad = RetailStoreCostService.financialSettings(A, store);
  check("nada persistiu na falha: aluguel ainda 3000, versão ainda 1", afterBad.fixedCosts.byCategory.aluguel === 3000 && afterBad.version === 1);

  // ===== 4. conflito otimista =====
  let conflict: any = null;
  try { RetailStoreCostService.saveFinancialSettings(A, store, { fixedCosts: { aluguel: 3200 }, expectedVersion: 0 }, "user2"); }
  catch (e: any) { conflict = e; }
  check("expectedVersion desatualizada → VERSION_CONFLICT + currentVersion", conflict?.code === "VERSION_CONFLICT" && conflict?.currentVersion === 1);
  check("conflito não gravou (aluguel segue 3000)", RetailStoreCostService.financialSettings(A, store).fixedCosts.byCategory.aluguel === 3000);

  // ===== 5. só mexe no que veio =====
  const r2 = RetailStoreCostService.saveFinancialSettings(A, store, { variableCosts: { pix_fee: { percent: 1, fixedPerSale: 0 } }, expectedVersion: 1 }, "user1");
  check("PUT parcial preserva margem/fixos anteriores", r2.grossMarginPercent === 55 && r2.fixedCosts.byCategory.aluguel === 3000 && r2.variableCosts.byCategory.pix_fee.percent === 1 && r2.version === 2);

  // ===== 6. isolamento =====
  let isoThrew = false;
  try { RetailStoreCostService.financialSettings(B, store); } catch { isoThrew = true; }
  check("org B não lê a config financeira da loja de A", isoThrew);

  console.log("\n=== TEST: Config financeira atômica (Fatia 1C) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
