/**
 * TESTE — Cache curto das telas analíticas + invalidação nos pontos de escrita
 * (PDR TOULON, Fatia 4C / PERF-005).
 * ---------------------------------------------------------------------------
 * Prova, offline:
 *   - get miss → undefined; set+get hit; TTL expira (now injetável);
 *   - invalidate(org) derruba só a org; isolamento multi-tenant no prefixo;
 *   - bound de memória descarta o mais antigo;
 *   - a invalidação DISPARA nos pontos que o PDR exige (RN §9):
 *       custo (setMany) · custo variável (setManyVariable) ·
 *       margem/custos (saveFinancialSettings) · loja (update: margem/código) ·
 *       fechamento (setInformed / setStatus) · preço (applyBulk).
 *
 * Determinístico e offline (zero-token).
 *
 * Uso:  npm run test:retail-analytics-cache
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-analytics-cache-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-analytics-cache-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailAnalyticsCache: C } = await import("../src/server/RetailAnalyticsCache.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailPricingService } = await import("../src/server/RetailPricingService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // ===== 1. get/set/TTL =====
  C.clearAll();
  check("get miss → undefined", C.get(A, "k1") === undefined);
  C.set(A, "k1", { v: 1 });
  check("set + get → hit", JSON.stringify(C.get(A, "k1")) === JSON.stringify({ v: 1 }));
  const t0 = 1_000_000;
  C.set(A, "k2", { v: 2 }, { ttlMs: 1000, now: t0 });
  check("dentro do TTL → hit", C.get(A, "k2", t0 + 999) !== undefined);
  check("após o TTL → miss (limpa)", C.get(A, "k2", t0 + 1001) === undefined);

  // ===== 2. invalidate por org + isolamento =====
  C.clearAll();
  C.set(A, "a1", 1); C.set(A, "a2", 2); C.set(B, "b1", 3);
  const dropped = C.invalidate(A);
  check("invalidate(A) derruba as 2 chaves da A", dropped === 2);
  check("invalidate(A) NÃO toca a B", C.get(B, "b1") === 3);
  check("A ficou vazia", C.get(A, "a1") === undefined && C.get(A, "a2") === undefined);

  // ===== 3. bound de memória (descarta o mais antigo) =====
  C.clearAll();
  for (let i = 0; i < 600; i++) C.set(A, "bulk:" + i, i);
  check("bound de memória: size <= 500", C.size() <= 500, String(C.size()));
  check("mais antigo caiu (bulk:0 miss)", C.get(A, "bulk:0") === undefined);
  check("mais novo sobrevive (bulk:599 hit)", C.get(A, "bulk:599") === 599);

  // ===== 4. invalidação nos pontos de escrita =====
  const loja = RetailStoreService.create(A, { name: "Loja Cache", code: "10" });
  const seed = (k = "probe") => { C.clearAll(); C.set(A, k, "x"); return () => C.get(A, k); };

  let probe = seed();
  RetailStoreCostService.setMany(A, loja.id, { aluguel: 100 });
  check("custo (setMany) invalida", probe() === undefined);

  probe = seed();
  RetailStoreCostService.setManyVariable(A, loja.id, { card_fee: { percent: 2 } });
  check("custo variável (setManyVariable) invalida", probe() === undefined);

  probe = seed();
  RetailStoreCostService.saveFinancialSettings(A, loja.id, { grossMarginPercent: 55, expectedVersion: 0 } as any, "u1");
  check("margem/custos (saveFinancialSettings) invalida", probe() === undefined);

  probe = seed();
  RetailStoreService.update(A, loja.id, { grossMarginPercent: 60 }, "u1");
  check("loja (update) invalida", probe() === undefined);

  const closing = RetailClosingService.getOrCreate(A, loja.id, "2026-08-05");
  probe = seed();
  RetailClosingService.setInformed(A, closing.id, { informedTotal: 500 }, "u1");
  check("fechamento (setInformed) invalida", probe() === undefined);

  probe = seed();
  RetailClosingService.setStatus(A, closing.id, "approved", "u1");
  check("fechamento (setStatus) invalida", probe() === undefined);

  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, price) VALUES (?, ?, 'P', 'product', 1, 10)`).run(prod, A);
  probe = seed();
  RetailPricingService.applyBulk(A, "u1", [{ productId: prod, newPrice: 20 } as any]);
  check("preço (applyBulk) invalida", probe() === undefined);

  console.log("\n=== TEST: Cache das analíticas (Fatia 4C) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
