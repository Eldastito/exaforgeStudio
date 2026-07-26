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
    // Fase 4: VendaMalote — venda a venda com a matrícula do vendedor (contrato
    // real: o item embrulha o registro em `caixa`).
    if (url.includes("/VendaMalote/versao/0")) return resp(200, { success: true, data: [{ caixa: { boleta: "010908", filial: "1", data: `${hoje}T00:00:00`, hora: "11:11", matricula: "10050015", usuario: "10660010", valor: 889.7, vendidas: 4, status: "N", dinheiro: 0, cartao: 0, creditoParcelado: 889.7 }, vendas: [{ item: 1, produto: "0822930941201", quantidade: 1, valor: 289.9, comissao: 5, vendedor: "10050026" }, { item: 2, produto: "0822930941202", quantidade: 3, valor: 599.8, comissao: 10, vendedor: "10050042" }], parcelasCartao: [{ numero: "000574", parcela: "1", seq: 1, codigoCartao: "05", valor: 296.57, liquido: 286.96, taxa: 3.24, vencimento: "2026-05-29T00:00:00" }, { numero: "000574", parcela: "2", seq: 2, codigoCartao: "05", valor: 296.57, liquido: 286.96, taxa: 3.24, vencimento: "2026-06-01T00:00:00" }], controleVersao: 950 }] }, {});
    return resp(200, { success: true, data: [] }, {});
  });
  const s2 = await AlterdataSyncRunner.runOrg(A);
  check("runOrg concilia o fechamento do PDV (caixas.applied=1)", s2.caixas?.applied === 1, JSON.stringify(s2.caixas));
  check("vendas do PDV importadas (VendaMalote)", s2.vendas?.imported === 1, JSON.stringify(s2.vendas));
  const pdvSale = db.prepare(`SELECT vendedor, valor, pecas FROM retail_pdv_sales WHERE organization_id=? AND filial='1' AND boleta='010908'`).get(A) as any;
  check("venda gravada com vendedor/valor/peças (matrícula 10050015)", pdvSale?.vendedor === "10050015" && Number(pdvSale?.valor) === 889.7 && Number(pdvSale?.pecas) === 4, JSON.stringify(pdvSale));
  const saleItems = db.prepare(`SELECT produto, quantidade, valor, vendedor FROM retail_pdv_sale_items WHERE organization_id=? AND filial='1' AND boleta='010908' ORDER BY item_seq`).all(A) as any[];
  check("itens da venda (vendas[]) gravados com produto/vendedor por linha", saleItems.length === 2 && saleItems[0].produto === "0822930941201" && saleItems[0].vendedor === "10050026" && Number(saleItems[1].quantidade) === 3, JSON.stringify(saleItems));
  const cardInst = db.prepare(`SELECT parcela, valor, liquido, taxa, vencimento FROM retail_pdv_card_installments WHERE organization_id=? AND filial='1' AND numero='000574' ORDER BY seq`).all(A) as any[];
  check("parcelas de cartão gravadas (líquido/taxa/vencimento)", cardInst.length === 2 && Number(cardInst[0].liquido) === 286.96 && Number(cardInst[0].taxa) === 3.24, JSON.stringify(cardInst));

  // ===== 2d. Clientes do PDV (Fase 3, opt-in) =====
  AlterdataConnectorService.setPdvCustomerImport(A, true);
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/ClienteMalote/versao/0")) return resp(200, { success: true, data: [{ cliente: { nome: "MAGNO TAVAREZ", cgc: "124-397-347/13", celular: "(21)7306-9955", email: "magno@x.com", nascimento: "1985-06-01T00:00:00", filial: "1", codigoN: "1006000001", ultimaCompra: "2017-09-09T00:00:00", inativo: 0 }, controleVersao: 990 }] }, {});
    return resp(200, { success: true, data: [] }, {});
  });
  const s3 = await AlterdataSyncRunner.runOrg(A);
  check("clientes do PDV importados (opt-in)", s3.clientes?.imported === 1, JSON.stringify(s3.clientes));
  const cli = db.prepare(`SELECT nome, celular, nascimento FROM retail_pdv_customers WHERE organization_id=? AND codigo_n='1006000001'`).get(A) as any;
  check("cliente gravado com nome/celular/aniversário", cli?.nome === "MAGNO TAVAREZ" && cli?.nascimento === "1985-06-01" && !!cli?.celular, JSON.stringify(cli));
  const closingRow = db.prepare(`SELECT id, system_total, informed_total, status, divergence_status FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, store.id, hoje) as any;
  check("system_total do dia gravado do PDV (2253.33)", Number(closingRow?.system_total) === 2253.33, JSON.stringify(closingRow));
  check("auto: fechamento preenchido com o total do PDV", Number(closingRow?.informed_total) === 2253.33 && closingRow?.status === "received", JSON.stringify(closingRow));
  check("auto: divergência ok (informado = PDV)", closingRow?.divergence_status === "ok", String(closingRow?.divergence_status));
  const payItems = db.prepare(`SELECT payment_method, informed_amount FROM retail_daily_closing_items WHERE closing_id=? ORDER BY payment_method`).all(closingRow.id) as any[];
  check("auto: formas de pagamento do PDV gravadas (cartão+dinheiro)", payItems.length === 2 && payItems[0]?.payment_method === "cartao" && Number(payItems[0]?.informed_amount) === 2153.33 && payItems[1]?.payment_method === "dinheiro", JSON.stringify(payItems));

  // ===== 2e. Comissão por VENDEDOR do ERP (Cenário A) =====
  // Venda/ComissaoVendasPorPeriodo é consultado MÊS A MÊS (janela de backfill).
  // CONTRATO REAL da ModaUp (homologação Toulon): as linhas vêm ANINHADAS em
  // `data.metaVendedorRealizado[]` (NÃO num array plano); `data.metaVendedor[]` é
  // a META (alvo) e deve ser IGNORADA. O mock repete as mesmas linhas com `data`
  // fixa em toda janela → o dedupe por (filial|matrícula|dia) colapsa para 1
  // linha por vendedor (idempotente).
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/Venda/ComissaoVendasPorPeriodo/")) return resp(200, { success: true, data: {
      metaVendedor: [{ matricula: "77777", nome: "ALVO IGNORAR", filial: "1", valor: 99999, meta: 99999 }],
      metaVendedorRealizado: [
        { matricula: "10050026", nome: "ANA SILVA", filial: "1", data: "2025-06-15T00:00:00", valorVendido: 1200, pecas: 8, comissao: 60 },
        { matricula: "10050042", nome: "BRUNO LIMA", filial: "1", data: "2025-06-15T00:00:00", valorVendido: 800, pecas: 5, comissao: 40 },
      ],
    }, pagination: { totalPages: 1 } }, {});
    return resp(200, { success: true, data: { metaVendedor: [], metaVendedorRealizado: [] }, pagination: { totalPages: 1 } }, {});
  });
  const s2e = await AlterdataSyncRunner.runOrg(A);
  check("comissão do ERP importada (2 vendedores, dedupe entre janelas)", s2e.erpComissao?.imported === 2, JSON.stringify(s2e.erpComissao));
  const erpRows = db.prepare(`SELECT matricula, seller_name, valor, comissao_erp, store_id FROM retail_erp_seller_sales WHERE organization_id=? ORDER BY valor DESC`).all(A) as any[];
  check("2 linhas de comissão gravadas (não duplica entre os 18 meses)", erpRows.length === 2, JSON.stringify(erpRows));
  check("META (metaVendedor / alvo) é ignorada — matrícula 77777 não entra", !erpRows.some(r => r.matricula === "77777"), JSON.stringify(erpRows));
  check("linha da Ana: valor 1200 / comissão ERP 60 / loja resolvida pela filial", erpRows[0]?.valor === 1200 && erpRows[0]?.comissao_erp === 60 && erpRows[0]?.store_id === store.id, JSON.stringify(erpRows[0]));
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const erpReport = RetailCommissionService.report(A, "2025-01-01", "2025-12-31");
  check("relatório marca hasErpSellerSales (coluna Comissão ERP acende)", erpReport.hasErpSellerSales === true);
  check("relatório soma a comissão do ERP p/ conferência (60+40=100)", Number(erpReport.totals?.sellerErpCommission) === 100, JSON.stringify(erpReport.totals));
  // Reingestão idempotente: rodar de novo não duplica.
  await AlterdataSyncRunner.runOrg(A);
  const erpRows2 = (db.prepare(`SELECT COUNT(*) AS n FROM retail_erp_seller_sales WHERE organization_id=?`).get(A) as any).n;
  check("reingestão idempotente (segue 2 linhas)", erpRows2 === 2, `linhas=${erpRows2}`);

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
