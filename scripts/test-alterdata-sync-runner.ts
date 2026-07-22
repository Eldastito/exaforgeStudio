/**
 * TEST — Runner + mapper de estoque Alterdata (ADR-105, Fase 1c).
 *
 * Prova, offline (HTTP fake), o sync ponta a ponta:
 *   - runOrg puxa Referencia→produto, CodigoDeBarras→variante, Saldo→estoque/loja;
 *   - mapper de estoque: filial→loja por código, produto→variante por sku/EAN,
 *     permite negativo, pula sem loja / sem produto, idempotente;
 *   - runOrg em org desligada lança erro;
 *   - marca o cursor de última execução (gate do Scheduler).
 *
 * Uso: npm run test:alterdata-sync-runner
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-runner-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-runner-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSupplyMapper } = await import("../src/server/AlterdataSupplyMapper.js");
  const { AlterdataStockMapper } = await import("../src/server/AlterdataStockMapper.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Toulon Filial 1", code: "1", whatsappIdentifier: "5531900000001" });

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));

  // ===== 1. runOrg desligado lança erro =====
  let offErr = false;
  try { await AlterdataSyncRunner.runOrg(A); } catch (e: any) { offErr = /desligada/i.test(String(e.message)); }
  check("runOrg em org desligada lança erro", offErr === true);

  // Liga a integração.
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });

  // ===== 2. Sync end-to-end (mock roteia por path) =====
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/Referencia/versao/")) return resp(200, [{ referenciaId: "1001", descricao: "Camisa Slim", preco: 189.9, grupo: "Camisas", controleVersao: 5 }], {});
    if (url.includes("/CodigoDeBarras/versao/")) return resp(200, [{ codigo: "1001", cor: "Preto", tamanho: "M", ean: "7891234567901", controleVersao: 6 }], {});
    if (url.includes("/Saldo/versao/")) return resp(200, [{ filial: "1", produto: "7891234567901", saldoAtual: 7, controleVersao: 8 }], {});
    return resp(200, [], {});
  });

  const summary = await AlterdataSyncRunner.runOrg(A);
  check("runOrg importa 1 referência", summary.referencias === 1, JSON.stringify(summary));
  check("runOrg importa 1 variante", summary.variantes === 1);
  check("runOrg aplica 1 saldo", summary.saldos.applied === 1, JSON.stringify(summary.saldos));

  const prod = db.prepare(`SELECT * FROM products_services WHERE organization_id=? AND external_ref='1001'`).get(A) as any;
  check("produto criado pelo runner", !!prod && prod.name === "Camisa Slim");
  const variant = db.prepare(`SELECT * FROM product_variants WHERE organization_id=? AND product_service_id=?`).get(A, prod.id) as any;
  check("variante criada (M/Preto, EAN no sku)", variant && variant.size === "M" && variant.sku === "7891234567901");
  const stock = db.prepare(`SELECT * FROM retail_store_inventory WHERE organization_id=? AND store_id=? AND product_service_id=? AND variant_id=?`).get(A, store.id, prod.id, variant.id) as any;
  check("estoque da variante na loja = 7", stock && Number(stock.quantity_available) === 7, JSON.stringify(stock));
  check("cursor de última execução gravado", Number(AlterdataConnectorService.getCursor(A, "_meta", "lastRun", "")) > 0);

  // ===== 3. Mapper de estoque: casos diretos =====
  // Saldo negativo permitido + idempotência.
  AlterdataStockMapper.upsertSaldos(A, [{ filial: "1", produto: "7891234567901", saldoAtual: -3 }]);
  const neg = db.prepare(`SELECT quantity_available FROM retail_store_inventory WHERE organization_id=? AND store_id=? AND variant_id=?`).get(A, store.id, variant.id) as any;
  check("saldo negativo é aplicado (permite <0)", Number(neg.quantity_available) === -3);

  // Filial inexistente → skippedNoStore.
  const r2 = AlterdataStockMapper.upsertSaldos(A, [{ filial: "99", produto: "7891234567901", saldoAtual: 5 }]);
  check("filial sem loja → skippedNoStore", r2.skippedNoStore === 1 && r2.applied === 0);

  // Produto inexistente → skippedNoProduct.
  const r3 = AlterdataStockMapper.upsertSaldos(A, [{ filial: "1", produto: "0000000000000", saldoAtual: 5 }]);
  check("produto sem match → skippedNoProduct", r3.skippedNoProduct === 1 && r3.applied === 0);

  // Resolve por produto (referência) quando produto = external_ref do produto.
  AlterdataSupplyMapper.upsertReferencias(A, [{ referenciaId: "2002", descricao: "Sem grade", preco: 50 }]);
  const r4 = AlterdataStockMapper.upsertSaldos(A, [{ filial: "1", produto: "2002", saldoAtual: 4 }]);
  check("saldo casa por referência do produto (variant_id vazio)", r4.applied === 1);

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Runner + estoque Alterdata (ADR-105, Fase 1c) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
