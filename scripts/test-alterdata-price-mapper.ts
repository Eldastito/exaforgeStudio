/**
 * TEST — Mapper de Preço Alterdata (ADR-105, Fase 1d): módulo Price.
 *
 * Prova, offline, a tradução Preco → preço de venda do ZappFlow:
 *   - Preco (produto, preco1) → preço da variante (por EAN/sku) ou do produto;
 *   - produto sem match → skippedNoProduct;
 *   - runner puxa Preco quando rede + priceTable estão definidos;
 *   - preço aplicado na variante correta (fim a fim).
 *
 * Uso: npm run test:alterdata-price-mapper
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-price-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-price-1234567890";
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
  const { AlterdataPriceMapper } = await import("../src/server/AlterdataPriceMapper.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  // Catálogo base: 1 produto com 1 variante (EAN).
  AlterdataSupplyMapper.upsertReferencias(A, [{ referenciaId: "1001", descricao: "Camisa", preco: 100 }]);
  AlterdataSupplyMapper.upsertCodigosDeBarras(A, [{ codigo: "1001", cor: "Preto", tamanho: "M", ean: "7891234567901" }]);
  const prod = db.prepare(`SELECT * FROM products_services WHERE organization_id=? AND external_ref='1001'`).get(A) as any;
  const variant = db.prepare(`SELECT * FROM product_variants WHERE organization_id=? AND product_service_id=?`).get(A, prod.id) as any;

  // ===== 1. Preco → preço da variante (por EAN) =====
  const r1 = AlterdataPriceMapper.upsertPrecos(A, [{ produto: "7891234567901", tabela: 1, preco1: 149.9 }]);
  check("preço aplicado na variante", r1.applied === 1);
  const vPrice = (db.prepare(`SELECT price FROM product_variants WHERE id=?`).get(variant.id) as any).price;
  check("preço da variante = 149.90", Number(vPrice) === 149.9, String(vPrice));

  // ===== 2. Preco por referência do produto (variant_id vazio) =====
  AlterdataSupplyMapper.upsertReferencias(A, [{ referenciaId: "2002", descricao: "Sem grade", preco: 50 }]);
  const r2 = AlterdataPriceMapper.upsertPrecos(A, [{ produto: "2002", tabela: 1, preco1: 79.9 }]);
  const p2 = db.prepare(`SELECT price FROM products_services WHERE organization_id=? AND external_ref='2002'`).get(A) as any;
  check("preço aplicado no produto (sem variante)", r2.applied === 1 && Number(p2.price) === 79.9);

  // ===== 3. produto sem match → skippedNoProduct =====
  const r3 = AlterdataPriceMapper.upsertPrecos(A, [{ produto: "0000000000000", tabela: 1, preco1: 9.9 }]);
  check("produto sem match → skippedNoProduct", r3.skippedNoProduct === 1 && r3.applied === 0);

  // preço inválido (0) ignorado.
  const r4 = AlterdataPriceMapper.upsertPrecos(A, [{ produto: "7891234567901", tabela: 1, preco1: 0 }]);
  check("preço zero é ignorado", r4.applied === 0);

  // ===== 4. Runner puxa Preco quando rede + priceTable definidos =====
  RetailStoreService.create(A, { name: "Filial 1", code: "1" });
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, rede: "TOULON", filiais: ["1"], priceTable: "1",
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok", expires_in: 3600 }));
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/Preco/versao/TOULON/1/")) return resp(200, [{ produto: "7891234567901", tabela: 1, preco1: 199.9, controleVersao: 3 }], {});
    return resp(200, [], {});
  });
  const summary = await AlterdataSyncRunner.runOrg(A);
  check("runner reporta preços aplicados", summary.precos.applied === 1, JSON.stringify(summary.precos));
  const vPrice2 = (db.prepare(`SELECT price FROM product_variants WHERE id=?`).get(variant.id) as any).price;
  check("preço atualizado pelo runner (199.90)", Number(vPrice2) === 199.9, String(vPrice2));
  check("URL do Preco usa rede/tabela", true); // exercitado pelo match acima

  // Sem priceTable → runner não puxa Preco (precos zerado).
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  AlterdataConnectorService.saveSettings(B, { enabled: true, rede: "TOULON", filiais: ["1"], basePattern: "toulon-{module}.apimodaup.com.br", authConfig: { clientId: "a", clientSecret: "b" } });
  __setAlterdataSyncHttpForTests(async () => resp(200, [], {}));
  const sB = await AlterdataSyncRunner.runOrg(B);
  check("sem priceTable → runner não puxa Preco", sB.precos.applied === 0);

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Mapper de Preço Alterdata (ADR-105, Fase 1d) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
