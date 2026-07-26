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
  // Mocks encadeáveis: o motor chama de novo com a MAIOR versão vista (contrato
  // /versao da ModaUp) — a URL com a versão do lote encerra o stream ([]).
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/Referencia/versao/0")) return resp(200, [{ referenciaId: "1001", descricao: "Camisa Slim", preco: 189.9, grupo: "Camisas", controleVersao: 5 }], {});
    // Barras por referência: GET /CodigoDeBarras/ReferenciaRede/{referencia}/{rede}
    if (url.includes("/CodigoDeBarras/ReferenciaRede/")) return resp(200, [{ codigo: "V1", cor: "Preto", tamanho: "M", ean: "7891234567901" }], {});
    if (url.includes("/Saldo/versao/1/0")) return resp(200, [{ filial: "1", produto: "7891234567901", saldoAtual: 7, controleVersao: 8 }], {});
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

  // ===== 2b. Fechamento do PDV (módulo Sales — Fase 2) =====
  // DataCaixa fechado (finalizado2=1) → busca ResumoFecharMovimento e grava o
  // "Total de Vendas" como system_total. Com o modo AUTOMÁTICO ligado, também
  // preenche o fechamento pendente (informado = PDV, itens por forma de pgto).
  AlterdataConnectorService.setPdvAutoClosing(A, true);
  const hoje = new Date().toISOString().slice(0, 10);
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/DataCaixa/versao/0")) return resp(200, { success: true, data: [{ data: `${hoje}T00:00:00`, filial: "1", turno: 1, finalizado2: 1, controleVersao: 900 }] }, {});
    if (url.includes("/ResumoFecharMovimento/1/")) return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 2253.33 }, { titulo: "Dinheiro", valor: 100.0 }, { titulo: "Cartão", valor: 2153.33 }, { titulo: "Sangria", valor: 50.0 }] }, {});
    return resp(200, { success: true, data: [] }, {});
  });
  const s2 = await AlterdataSyncRunner.runOrg(A);
  check("runOrg concilia o fechamento do PDV (caixas.applied=1)", s2.caixas?.applied === 1, JSON.stringify(s2.caixas));
  const closingRow = db.prepare(`SELECT id, system_total, informed_total, status, divergence_status FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, store.id, hoje) as any;
  check("system_total do dia gravado do PDV (2253.33)", Number(closingRow?.system_total) === 2253.33, JSON.stringify(closingRow));
  check("auto: fechamento preenchido com o total do PDV", Number(closingRow?.informed_total) === 2253.33 && closingRow?.status === "received", JSON.stringify(closingRow));
  check("auto: divergência ok (informado = PDV)", closingRow?.divergence_status === "ok", String(closingRow?.divergence_status));
  const payItems = db.prepare(`SELECT payment_method, informed_amount FROM retail_daily_closing_items WHERE closing_id=? ORDER BY payment_method`).all(closingRow.id) as any[];
  check("auto: formas de pagamento do PDV gravadas (cartão+dinheiro)", payItems.length === 2 && payItems[0]?.payment_method === "cartao" && Number(payItems[0]?.informed_amount) === 2153.33 && payItems[1]?.payment_method === "dinheiro", JSON.stringify(payItems));

  // ===== 2c. RETROATIVO: pendente com system_total (modo ligado depois) =====
  // O delta do DataCaixa não revisita caixas antigos — mas o total do PDV já
  // está no banco; o modo automático preenche direto de lá, sem API.
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const cPrev = RetailClosingService.getOrCreate(A, store.id, ontem);
  db.prepare(`UPDATE retail_daily_closings SET system_total = 500 WHERE id = ?`).run(cPrev.id);
  __setAlterdataSyncHttpForTests(async () => resp(200, { success: true, data: [] }, {}));
  await AlterdataSyncRunner.runOrg(A);
  const rowPrev = db.prepare(`SELECT informed_total, status, divergence_status FROM retail_daily_closings WHERE id = ?`).get(cPrev.id) as any;
  check("retroativo: pendente com system_total vira recebido (500, ok)", Number(rowPrev?.informed_total) === 500 && rowPrev?.status === "received" && rowPrev?.divergence_status === "ok", JSON.stringify(rowPrev));

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

  // Dígito extra do Saldo (homologação Toulon): o Saldo usa 13 dígitos
  // (ex.: 0552380350481) e as barras/preço 12 (055238035048) — o resolve deve
  // casar mesmo assim (tenta sem o último dígito).
  AlterdataSupplyMapper.upsertReferencias(A, [{ referenciaId: "055238", descricao: "Jeans 13d" }]);
  AlterdataSupplyMapper.upsertCodigosDeBarras(A, [{ codigo: "055238035048", cor: "JEANS", tamanho: "48", ean: null }], "055238");
  const r5 = AlterdataStockMapper.upsertSaldos(A, [{ filial: "1", produto: "0552380350481", saldoAtual: 9 }]);
  check("saldo de 13 dígitos casa com a variante de 12 (dígito extra)", r5.applied === 1, JSON.stringify(r5));

  // ===== 4. probeOrg: isola o endpoint em 500 (por eliminação) =====
  // Referencia → 500 (corpo vazio); demais → 200. probeOrg NÃO lança, NÃO grava,
  // e devolve o HTTP status cru de cada endpoint.
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/Referencia/versao/")) return resp(500, "", {});
    return resp(200, [], {});
  });
  const probes = await AlterdataSyncRunner.probeOrg(A);
  const byRes = (name: string) => probes.find((p) => p.resource === name || p.resource.startsWith(name));
  check("probeOrg cobre Referencia/CodigoDeBarras/Saldo", probes.length >= 3, JSON.stringify(probes.map((p) => p.resource)));
  check("probe Referencia isola o 500", byRes("Referencia")?.status === 500 && byRes("Referencia")?.ok === false, JSON.stringify(byRes("Referencia")));
  check("probe CodigoDeBarras OK (200)", byRes("CodigoDeBarras")?.ok === true && byRes("CodigoDeBarras")?.status === 200);
  check("probe Saldo OK (200)", byRes("Saldo")?.ok === true && byRes("Saldo")?.status === 200, JSON.stringify(byRes("Saldo")));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Runner + estoque Alterdata (ADR-105, Fase 1c) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
