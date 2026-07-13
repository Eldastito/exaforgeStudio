/**
 * TESTE — ADR-084 D4: modo de estoque / fonte da verdade (fatia fundacional)
 * -------------------------------------------------------------------------
 * Prova, offline, a configuração e o resolvedor da invariante do D4:
 *   - default 'native' (org e loja sem override);
 *   - trocar o modo da org (native → supervised) muda o ledger autoritativo
 *     (core → shadow);
 *   - override por loja prevalece sobre o modo da org;
 *   - 'hybrid': loja sem override resolve para 'native', com override respeita;
 *   - limpar o override (null) volta a herdar da org;
 *   - modo inválido é rejeitado; loja inexistente falha; isolamento por org.
 *
 * Uso:  npm run test:retail-stock-mode
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-stockmode-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-stockmode-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStockModeService } = await import("../src/server/RetailStockModeService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });

  // ---- 1. Default 'native' ----
  check("Default: modo da org = native", RetailStockModeService.getOrgMode(A) === "native");
  check("Default: loja sem override resolve native", RetailStockModeService.resolve(A, s1.id) === "native");
  check("Default: ledger autoritativo = core", RetailStockModeService.authoritativeLedger(A, s1.id) === "core");

  // ---- 2. Modo da org supervised → shadow ----
  RetailStockModeService.setOrgMode(A, "supervised", "u1");
  check("Org supervised: resolve supervised", RetailStockModeService.resolve(A, s1.id) === "supervised");
  check("Org supervised: ledger autoritativo = shadow", RetailStockModeService.authoritativeLedger(A, s1.id) === "shadow");

  // ---- 3. Override por loja ----
  RetailStockModeService.setStoreOverride(A, s1.id, "native", "u1");
  check("Override: loja 1 native mesmo com org supervised", RetailStockModeService.resolve(A, s1.id) === "native" && RetailStockModeService.authoritativeLedger(A, s1.id) === "core");
  check("Sem override: loja 2 segue a org (supervised)", RetailStockModeService.resolve(A, s2.id) === "supervised");

  // ---- 4. Hybrid ----
  RetailStockModeService.setOrgMode(A, "hybrid", "u1");
  RetailStockModeService.setStoreOverride(A, s1.id, null, "u1"); // limpa override
  check("Hybrid: loja sem override resolve native (default documentado)", RetailStockModeService.resolve(A, s1.id) === "native");
  RetailStockModeService.setStoreOverride(A, s2.id, "supervised", "u1");
  check("Hybrid: loja com override supervised resolve supervised", RetailStockModeService.resolve(A, s2.id) === "supervised");

  // ---- 5. Validação e erros ----
  let threw = false;
  try { RetailStockModeService.setOrgMode(A, "cloud", "u1"); } catch { threw = true; }
  check("Modo inválido é rejeitado", threw);
  let threw2 = false;
  try { RetailStockModeService.setStoreOverride(A, "nao-existe", "native", "u1"); } catch (e: any) { threw2 = e.message === "store_not_found"; }
  check("Override em loja inexistente falha (store_not_found)", threw2);

  // ---- 6. status() ----
  const st = RetailStockModeService.status(A);
  check("status(): orgMode hybrid + 2 lojas com resolved", st.orgMode === "hybrid" && st.stores.length === 2 && st.stores.every((x) => !!x.resolved));

  // ---- 7. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: org B fica no default native", RetailStockModeService.getOrgMode(B) === "native");

  console.log("\n=== ADR-084 D4: modo de estoque / fonte da verdade ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
