/**
 * TESTE — Economia por canal + desconto máximo seguro (ADR-207 F6). Fachada READ-ONLY.
 *
 * Prova:
 *  - a matemática (contribuição e desconto máximo) com contas feitas à mão E por propriedade (o máximo respeita o piso,
 *    0,1 ponto a mais já o viola);
 *  - custo da peça ausente = sem margem e sem desconto (nunca inventa); custo do canal não informado = TETO, nunca "seguro";
 *  - sem piso informado pelo dono não há desconto seguro;
 *  - custos físicos vêm do cadastro existente (variáveis da loja, tarifas de POS, comissão) sem duplicar; a regra detalhada de
 *    cartão SUBSTITUI a agregada (não soma); comissão só entra quando é % simples;
 *  - verificação de cupom ("posso dar 20%?") classifica produto a produto e não cria cupom;
 *  - rotas só do dono/admin; isolamento por empresa; NADA além da configuração é gravado.
 *
 * Uso: npm run test:channel-economics
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-channel-econ-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-channel-econ-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number | null | undefined, b: number, eps = 0.011) => a != null && Math.abs(a - b) <= eps;

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontAdmin = (await import("../src/server/routes/storefront.js")).default;
  const E = await import("../src/server/ChannelEconomicsService.js");
  const { ChannelEconomicsService: S, contributionAt, maxDiscountPct } = E;
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { RetailPosFeeService } = await import("../src/server/RetailPosFeeService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  // ── 1. Matemática pura ─────────────────────────────────────────────────────
  const model = { variablePercent: 12, fixedPerSale: 9 };
  const c0 = contributionAt(300, 110, model, 0);
  check("1.1 contribuição sem desconto: 300 − 110 − (12% de 300 + 9) = 145 (48,3%)", near(c0.amount, 145) && c0.percent === 48.3, JSON.stringify(c0));
  const c20 = contributionAt(300, 110, model, 20);
  check("1.2 com 20%: líquido 240, custos % caem junto → 240 − 110 − (28,8 + 9) = 92,2 (38,4%)", near(c20.amount, 92.2) && c20.percent === 38.4, JSON.stringify(c20));
  const m = maxDiscountPct(300, 110, model, 20);
  check("1.3 desconto máximo com piso 20%: 41,6% (conta à mão: líquido mínimo 175)", m.state === "ok" && m.percent === 41.6, JSON.stringify(m));
  const ratio = (d: number) => { const c = contributionAt(300, 110, model, d); return (c.amount! / c.net!) * 100; };   // sem o arredondamento de exibição
  check("1.4 em 41,6% a contribuição fica ≥ 20% e em 41,7% já quebra o piso", ratio(41.6) >= 20 && ratio(41.7) < 20, `${ratio(41.6)} / ${ratio(41.7)}`);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let propOk = true, tested = 0, firstBad = "";
  for (let i = 0; i < 400; i++) {
    const price = 20 + rnd() * 980, cost = rnd() * price * 0.8, v = rnd() * 30, f = rnd() * 15, floor = rnd() * 40;
    const mdl = { variablePercent: v, fixedPerSale: f };
    const r = maxDiscountPct(price, cost, mdl, floor);
    if (r.state !== "ok") continue;
    tested++;
    const at = contributionAt(price, cost, mdl, r.percent), over = contributionAt(price, cost, mdl, r.percent + 0.1);
    // tolerância do arredondamento de centavos (contributionAt arredonda a 2 casas)
    if (!(at.percent! >= floor - 0.15) || !(over.percent! < floor + 0.15) || r.percent < 0) { propOk = false; firstBad ||= JSON.stringify({ price, cost, v, f, floor, r, at, over }); }
  }
  check(`1.5 propriedade em ${tested} casos aleatórios: o máximo respeita o piso e é máximo (±0,1 ponto)`, propOk && tested > 100, firstBad);
  check("1.6 preço que já não cobre o piso → 0% e estado explicado", (() => { const r = maxDiscountPct(100, 90, { variablePercent: 10, fixedPerSale: 0 }, 20); return r.percent === 0 && r.state === "price_below_floor"; })());
  check("1.7 custos % + piso ≥ 100% → piso inalcançável", maxDiscountPct(100, 10, { variablePercent: 70, fixedPerSale: 0 }, 30).state === "floor_unreachable" && maxDiscountPct(100, 10, { variablePercent: 80, fixedPerSale: 0 }, 30).state === "floor_unreachable");
  check("1.8 sem preço ou sem custo → null (não vira 0)", contributionAt(0, 10, model).amount === null && contributionAt(100, null, model).amount === null);

  // ── 2. Dados de apoio ──────────────────────────────────────────────────────
  const orgId = randomUUID(), otherOrg = randomUUID();
  for (const id of [orgId, otherOrg]) db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkProduct = (org: string, name: string, price: number, cost: number | null, opts: { variantCosts?: number[] } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible) VALUES (?, ?, ?, 'product', ?, 1, 1)`).run(id, org, name, price);
    if (cost != null) db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, avg_cost) VALUES (?, ?, ?, NULL, 5, ?)`).run(randomUUID(), org, id, cost);
    for (const [i, vc] of (opts.variantCosts || []).entries()) db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, 3, ?)`).run(randomUUID(), org, id, `var${i}`, vc);
    return id;
  };
  const camisa = mkProduct(orgId, "Camisa Polo", 300, 110);
  const semCusto = mkProduct(orgId, "Peça sem custo", 200, null);
  const outra = mkProduct(otherOrg, "Produto de outra", 100, 30);
  const loja1 = RetailStoreService.create(orgId, { name: "Toulon 1079", code: "10" });
  const snapshot = () => JSON.stringify({
    coupons: db.prepare("SELECT COUNT(*) c FROM storefront_coupons").get(), orders: db.prepare("SELECT COUNT(*) c FROM orders").get(),
    prices: db.prepare("SELECT id, price FROM products_services ORDER BY id").all(), inv: db.prepare("SELECT id, avg_cost, quantity_available FROM inventory_items ORDER BY id").all(),
    sig: db.prepare("SELECT COUNT(*) c FROM business_signals").get(), act: db.prepare("SELECT COUNT(*) c FROM decision_actions").get(),
  });
  const before = snapshot();

  // ── 3. Custo da peça e qualidade ──────────────────────────────────────────
  const noCost = S.productEconomics(orgId, semCusto, "online")!;
  check("3.1 sem custo da peça: qualidade insuficiente e SEM margem (não inventa)", noCost.quality === "insufficient" && noCost.contribution.amount === null && noCost.missing.includes("custo da peça"));
  const noCostSafe = S.safeDiscount(orgId, semCusto, "online")!;
  check("3.2 sem custo: desconto seguro indisponível, com o motivo", noCostSafe.status === "unavailable" && noCostSafe.maxPercent === null && /custo da peça/.test(noCostSafe.reason!));

  // custo só em variações → maior (conservador) e marcado como estimativa
  const grade = mkProduct(orgId, "Camisa Grade", 300, null, { variantCosts: [100, 130, 120] });
  const gc = S.unitCost(orgId, grade);
  check("3.3 custo só por variação: usa o MAIOR (conservador) e marca estimativa", gc.value === 130 && gc.basis === "estimate");
  check("3.4 custo da linha base é fato", S.unitCost(orgId, camisa).basis === "fact" && S.unitCost(orgId, camisa).value === 110);

  // ── 4. Online: teto × seguro × sem piso ────────────────────────────────────
  let e = S.productEconomics(orgId, camisa, "online")!;
  check("4.1 online sem nenhum custo informado: PARCIAL, faltam imposto/pagamento/embalagem", e.quality === "partial" && ["Imposto sobre a venda", "Taxa de pagamento (Pix/cartão)", "Embalagem"].every((x) => e.missing.includes(x)));
  check("4.2 a margem parcial é marcada como TETO (upperBound)", e.contribution.upperBound === true && near(e.contribution.amount, 190));
  let sd = S.safeDiscount(orgId, camisa, "online")!;
  check("4.3 sem piso do dono: não há desconto seguro (não inventa piso)", sd.status === "unavailable" && sd.maxPercent === null && /margem mínima/.test(sd.reason!));
  S.saveSettings(orgId, { floorPercent: 20 }, "u1");
  sd = S.safeDiscount(orgId, camisa, "online")!;
  check("4.4 com piso mas custo do canal incompleto: 'upper_bound' (teto) — NUNCA 'safe'", sd.status === "upper_bound" && sd.maxPercent != null && /TETO/.test(sd.caveat!));
  S.saveSettings(orgId, { online: { taxPercent: 6, paymentFeePercent: 3, paymentFeeFixed: 0, packagingFixed: 9 } });
  e = S.productEconomics(orgId, camisa, "online")!;
  check("4.5 online completo: qualidade confiável; variável 9% + R$9 fixo", e.quality === "reliable" && e.variablePercent === 9 && e.fixedPerSale === 9 && e.contribution.upperBound === false);
  check("4.6 contribuição online à mão: 300 − 110 − (27 + 9) = 154 (51,3%)", near(e.contribution.amount, 154) && e.contribution.percent === 51.3, JSON.stringify(e.contribution));
  sd = S.safeDiscount(orgId, camisa, "online")!;
  const expected = maxDiscountPct(300, 110, { variablePercent: 9, fixedPerSale: 9 }, 20).percent;
  check("4.7 desconto seguro online = fórmula fechada (e status 'safe')", sd.status === "safe" && sd.maxPercent === expected && expected > 40, `${sd.maxPercent} vs ${expected}`);
  const at = sd.scenarios.find((x: any) => x.discountPercent === 30)!;
  check("4.8 cenários 0–30% com a contribuição de cada um e se respeita o piso", sd.scenarios.length === 7 && at.aboveFloor === true && at.contribution != null);
  const tight = mkProduct(orgId, "Peça apertada", 100, 85);
  check("4.9 preço que já não cobre o piso: 0% com explicação", (() => { const r = S.safeDiscount(orgId, tight, "online")!; return r.status === "safe" && r.maxPercent === 0 && /abaixo da sua margem mínima/.test(r.reason!); })());

  // ── 5. Físico: reaproveita o cadastro da loja ──────────────────────────────
  const loja2 = RetailStoreService.create(orgId, { name: "Toulon Centro", code: "20" });
  let ph = S.productEconomics(orgId, camisa, "physical")!;
  check("5.1 duas lojas e nenhuma escolhida: pede a loja (insuficiente), não faz média escondida", ph.quality === "insufficient" && ph.storeId === null && (ph.stores || []).length === 2 && ph.missing.includes("loja física"));
  ph = S.productEconomics(orgId, camisa, "physical", loja1.id)!;
  check("5.2 loja sem custos cadastrados: PARCIAL (faltam imposto e cartão)", ph.quality === "partial" && ph.missing.includes("Imposto sobre a venda") && ph.missing.includes("Taxa de cartão"));
  RetailStoreCostService.setManyVariable(orgId, loja1.id, { tax_sale: { percent: 6 }, card_fee: { percent: 3 }, packaging: { fixedPerSale: 2 } });
  ph = S.productEconomics(orgId, camisa, "physical", loja1.id)!;
  check("5.3 com imposto e cartão cadastrados (e nenhuma regra de comissão): confiável; 9% + R$2", ph.quality === "reliable" && ph.variablePercent === 9 && ph.fixedPerSale === 2, JSON.stringify([ph.quality, ph.variablePercent, ph.fixedPerSale, ph.missing]));
  check("5.4 sem regra de comissão fica explícito ('no_rule'), não escondido", ph.components.find((c: any) => c.key === "commission")?.origin === "no_rule");
  RetailPosFeeService.set(orgId, loja1.id, { credit: { percent: 3.5, fixedPerTransaction: 0 }, debit: { percent: 1.5, fixedPerTransaction: 0 } });
  ph = S.productEconomics(orgId, camisa, "physical", loja1.id)!;
  check("5.5 regra detalhada de cartão SUBSTITUI a agregada (maior taxa, sem somar): 6 + 3,5 = 9,5%", ph.variablePercent === 9.5 && !!ph.components.find((c: any) => c.key === "card_fee")?.note, String(ph.variablePercent));
  RetailCommissionService.createRule(orgId, { name: "Comissão rede", scope: "store", calculationType: "percent_sales", config: { percent: 3 } });
  ph = S.productEconomics(orgId, camisa, "physical", loja1.id)!;
  check("5.6 comissão % simples entra: 6 + 3,5 + 3 = 12,5%", ph.variablePercent === 12.5 && ph.quality === "reliable", String(ph.variablePercent));
  RetailCommissionService.createRule(orgId, { name: "Bônus de cota", scope: "store", calculationType: "quota_bonus", config: { bonus: 500 } });
  ph = S.productEconomics(orgId, camisa, "physical", loja1.id)!;
  check("5.7 comissão por cota/faixa NÃO é modelada: PARCIAL e declarado", ph.quality === "partial" && ph.notModeled.includes("Comissão") && ph.contribution.upperBound === true);
  check("5.8 a margem física é menor que a online só pelos custos reais de cada canal", ph.contribution.amount != null && ph.contribution.amount! < 300);

  const cmp = S.compare(orgId, camisa, loja1.id)!;
  check("5.9 comparação traz as duas margens e a diferença (marcada como teto quando parcial)", !!cmp.difference && cmp.difference.upperBound === true && near(cmp.difference.amount, cmp.online.contribution.amount! - cmp.physical.contribution.amount!));
  check("5.10 sem a loja física a diferença não é inventada", S.compare(orgId, camisa)!.difference === null);

  // ── 6. Cupom: "posso dar 20%?" ─────────────────────────────────────────────
  const apertado = mkProduct(orgId, "Apertado 12", 100, 50);        // suporta pouco
  const folgado = mkProduct(orgId, "Folgado", 400, 100);
  const baixo = mkProduct(orgId, "Abaixo do piso", 100, 95);
  const rawCheck = S.couponCheck(orgId, { type: "percent", value: 20 }, { productIds: [folgado, apertado, baixo, semCusto] });
  check("6.1 cupom de 20%: folgado suporta, apertado suporta menos, abaixo do piso nenhum, sem custo = sem dados",
    rawCheck.counts.supports === 1 && rawCheck.counts.supportsLess === 1 && rawCheck.counts.belowFloor === 1 && rawCheck.counts.unknown === 1, JSON.stringify(rawCheck.counts));
  const ap = rawCheck.examples.supportsLess[0];
  check("6.2 o 'suporta menos' diz até quanto (e fica dentro do piso)", ap.productId === apertado && ap.maxPercent! > 0 && ap.maxPercent! < 20 && contributionAt(100, 50, { variablePercent: 9, fixedPerSale: 9 }, ap.maxPercent!).percent! >= 20 - 0.15);
  const fixedCheck = S.couponCheck(orgId, { type: "fixed", value: 30 }, { productIds: [folgado, baixo] });
  check("6.3 cupom de R$30: vira % pelo preço de cada produto (7,5% no de R$400)", fixedCheck.examples.supports[0]?.productId === folgado && fixedCheck.examples.supports[0].askedPercent === 7.5, JSON.stringify(fixedCheck.counts));
  let bad = 0; for (const v of [0, -5, 100, NaN]) { try { S.couponCheck(orgId, { type: "percent", value: v }); } catch { bad++; } }
  check("6.4 desconto inválido é erro (0, negativo, 100%, NaN)", bad === 4);
  S.saveSettings(orgId, { online: { packagingFixed: null } });
  const unconf = S.couponCheck(orgId, { type: "percent", value: 5 }, { productIds: [folgado] });
  check("6.5 custo do canal incompleto: tudo vira 'sem confirmação' — nenhum entra como 'suporta'", unconf.counts.supports === 0 && unconf.counts.unconfirmed === 1);
  S.saveSettings(orgId, { online: { packagingFixed: 9 } });
  const isolated = S.couponCheck(orgId, { type: "percent", value: 5 }, { productIds: [outra, folgado] });
  check("6.6 produto de OUTRA empresa é ignorado", isolated.evaluated === 1);

  // ── 7. Qualidade do dado ───────────────────────────────────────────────────
  const q = S.dataQuality(orgId, loja1.id);
  check("7.1 qualidade: cobertura de custo derivada e lacunas listadas", q.products === 7 && q.withCost === 6 && q.coveragePct === 85.7 && q.gaps.some((g: string) => /sem custo/.test(g)), JSON.stringify([q.products, q.withCost, q.coveragePct, q.gaps]));
  check("7.2 85,7% de cobertura → parcial (limiar de 90% para confiável)", q.status === "partial");
  const q2 = S.dataQuality(otherOrg);
  check("7.3 outra empresa: parcial/insuficiente próprio, sem vazar nada desta", q2.products === 1 && q2.withCost === 1 && q2.status === "partial" && q2.floorSet === false);
  const empty = randomUUID(); db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'E', 'active')`).run(empty);
  check("7.4 empresa sem produto: cobertura null e insuficiente (nunca 0% inventado)", S.dataQuality(empty).coveragePct === null && S.dataQuality(empty).status === "insufficient");

  // ── 8. Configuração ────────────────────────────────────────────────────────
  let rej = 0; for (const p of [{ floorPercent: -1 }, { floorPercent: 96 }, { floorPercent: "abc" as any }, { online: { taxPercent: 61 } }, { online: { paymentFeePercent: -2 } }]) { try { S.saveSettings(orgId, p as any); } catch { rej++; } }
  check("8.1 valores inválidos são erro (nunca viram 0 em silêncio)", rej === 5 && S.settings(orgId).floorPercent === 20);
  check("8.2 null limpa o campo (volta a 'não informado')", S.saveSettings(orgId, { floorPercent: null }).floorPercent === null && S.saveSettings(orgId, { floorPercent: 20 }).floorPercent === 20);
  check("8.3 zero explícito é diferente de não informado", S.saveSettings(orgId, { online: { taxPercent: 0 } }).online.taxPercent === 0 && S.settings(otherOrg).online.taxPercent === null);
  check("8.4 configuração fica no audit", ((db.prepare("SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CHANNEL_ECONOMICS_SETTINGS'").get(orgId) as any).c as number) >= 3);
  S.saveSettings(orgId, { online: { taxPercent: 6 } });

  // ── 9. Read-only: nada além da configuração mudou ─────────────────────────
  check("9.1 nenhum cupom, pedido, preço, estoque, sinal ou ação foi criado/alterado", snapshot() === before.replace(/"prices":\[.*?\],"inv"/s, (m) => m) || (() => {
    const a = JSON.parse(snapshot()), b = JSON.parse(before);
    // produtos/estoque criados pelo próprio teste mudam as listas; o que não pode mudar: cupons, pedidos, sinais, ações e os preços/custos dos que já existiam
    return a.coupons.c === b.coupons.c && a.orders.c === b.orders.c && a.sig.c === b.sig.c && a.act.c === b.act.c
      && b.prices.every((p: any) => a.prices.find((x: any) => x.id === p.id)?.price === p.price)
      && b.inv.every((p: any) => { const x = a.inv.find((y: any) => y.id === p.id); return x && x.avg_cost === p.avg_cost && x.quantity_available === p.quantity_available; });
  })());

  // ── 10. Rotas (só dono/admin) ──────────────────────────────────────────────
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), agente = mkUser(orgId, "Ana", "agent"), donoOutra = mkUser(otherOrg, "Ze", "owner");
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const row = req.headers["x-uid"] ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(String(req.headers["x-uid"])) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/storefront", storefrontAdmin);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const call = async (uid: string, method: string, p: string, body?: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/storefront${p}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const routes: Array<[string, string, any?]> = [["GET", "/economics/settings"], ["PUT", "/economics/settings", { floorPercent: 20 }], ["GET", "/economics/quality"], ["GET", `/economics/product/${camisa}`], ["GET", `/economics/safe-discount/${camisa}`], ["POST", "/economics/coupon-check", { type: "percent", value: 10 }]];
  let denied = 0; for (const [m, p, b] of routes) if ((await call(agente, m, p, b)).status === 403) denied++;
  check("10.1 atendente é barrado (403) em TODAS as rotas de economia", denied === routes.length, `${denied}/${routes.length}`);
  const okP = await call(dono, "GET", `/economics/product/${camisa}?storeId=${loja1.id}`);
  check("10.2 dono lê físico × online do produto", okP.status === 200 && okP.json.physical?.channel === "physical" && okP.json.online?.channel === "online");
  const okS = await call(dono, "GET", `/economics/safe-discount/${camisa}`);
  check("10.3 dono lê o desconto seguro (online por padrão)", okS.status === 200 && okS.json.channel === "online" && okS.json.status === "safe");
  check("10.4 dono de OUTRA empresa não enxerga o produto (404)", (await call(donoOutra, "GET", `/economics/product/${camisa}`)).status === 404 && (await call(donoOutra, "GET", `/economics/safe-discount/${camisa}`)).status === 404);
  check("10.5 configuração é por empresa: o dono de outra não vê o piso desta", (await call(donoOutra, "GET", "/economics/settings")).json.floorPercent === null && (await call(dono, "GET", "/economics/settings")).json.floorPercent === 20);
  check("10.6 PUT inválido → 400 e nada muda", (await call(dono, "PUT", "/economics/settings", { floorPercent: 200 })).status === 400 && S.settings(orgId).floorPercent === 20);
  const cc = await call(dono, "POST", "/economics/coupon-check", { type: "percent", value: 20 });
  check("10.7 verificação de cupom pela rota", cc.status === 200 && cc.json.evaluated >= 5 && typeof cc.json.counts.supports === "number");
  check("10.8 cupom inválido → 400", (await call(dono, "POST", "/economics/coupon-check", { type: "percent", value: 150 })).status === 400);
  check("10.9 qualidade do dado pela rota", (await call(dono, "GET", `/economics/quality?storeId=${loja1.id}`)).json.products === 7);
  server.close();

  console.log("\n=== Economia por canal + desconto máximo seguro (ADR-207 F6) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
