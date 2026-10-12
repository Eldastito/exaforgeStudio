/**
 * TESTE — Mídia paga, etapa 1 (ADR-207 F10): CAC máximo / ROAS / POAS / ponto de equilíbrio, SEM API de anúncios.
 *
 * Prova, com o serviço e as rotas do dono REAIS (contas conferidas à mão):
 *  - plano: CAC máximo = contribuição online − lucro mínimo; ROAS mínimo, ROAS de equilíbrio, POAS mínimo; vendas p/ equilíbrio;
 *    produto sem custo → null (nunca inventa); margem que não cobre o lucro exigido → inviável; margem parcial vira TETO;
 *  - cenários só com CPC/conversão informados (nenhuma faixa inventada), arredondamento seguro, dentro/fora do CAC máximo;
 *  - gasto lançado pelo dono (validação, remoção, isolamento);
 *  - resultado real: ROAS, contribuição (desconto e frete subsidiado entram), IA da F8, lucro e POAS; sem gasto/sem custo → null;
 *    só pedidos PAGOS; janela de dias; "custo por pedido pago" (não CAC); isolamento;
 *  - rotas: só dono/administrador.
 *
 * Uso: npm run test:paid-media
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-paid-media-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-paid-media-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number | null | undefined, b: number, eps = 0.011) => a != null && Math.abs(a - b) <= eps;

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontAdmin = (await import("../src/server/routes/storefront.js")).default;
  const { PaidMediaService: P } = await import("../src/server/PaidMediaService.js");
  const { ChannelEconomicsService: E } = await import("../src/server/ChannelEconomicsService.js");

  const orgId = randomUUID(), other = randomUUID();
  for (const id of [orgId, other]) db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkProduct = (org: string, name: string, price: number, cost: number | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible) VALUES (?, ?, ?, 'product', ?, 1, 1)`).run(id, org, name, price);
    if (cost != null) db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, avg_cost) VALUES (?, ?, ?, NULL, 5, ?)`).run(randomUUID(), org, id, cost);
    return id;
  };
  const camisa = mkProduct(orgId, "Camisa Polo", 300, 110), semCusto = mkProduct(orgId, "Sem custo", 200, null), barata = mkProduct(orgId, "Meia", 40, 30);
  const camisaOutra = mkProduct(other, "Camisa X", 300, 110);

  // ── 1. plano com custo do canal INCOMPLETO → margem é TETO
  const pPartial = P.plan(orgId, { productId: camisa, minProfitPerSale: 100 }) as any;
  check("1.1 canal incompleto: margem marcada como TETO (upper bound) e qualidade parcial", pPartial.contributionIsUpperBound === true && pPartial.quality === "partial" && near(pPartial.contributionPerSale, 190), JSON.stringify([pPartial.contributionPerSale, pPartial.quality]));

  // custo do canal completo: contribuição = 300 − 110 − (9% de 300) − 9 = 154
  E.saveSettings(orgId, { floorPercent: 20, online: { taxPercent: 6, paymentFeePercent: 3, paymentFeeFixed: 0, packagingFixed: 9 } }, "u1");
  const before = JSON.stringify({ o: db.prepare("SELECT COUNT(*) c FROM orders").get(), prod: db.prepare("SELECT id, price FROM products_services ORDER BY id").all(), act: db.prepare("SELECT COUNT(*) c FROM decision_actions").get(), sig: db.prepare("SELECT COUNT(*) c FROM business_signals").get() });
  const p = P.plan(orgId, { productId: camisa, minProfitPerSale: 100, budget: 1000 }) as any;
  check("1.2 contribuição online = 154 (conta à mão), não é teto", near(p.contributionPerSale, 154) && p.contributionIsUpperBound === false && p.quality === "reliable");
  check("1.3 CAC máximo = 154 − 100 = 54", p.viable === true && near(p.maxCac, 54));
  check("1.4 ROAS mínimo no teto = 300/54 = 5,56 · ROAS de equilíbrio = 300/154 = 1,95 · POAS mínimo = 100/54 = 1,85", near(p.minRoasAtMaxCac, 5.56) && near(p.breakEvenRoas, 1.95) && near(p.minPoas, 1.85), JSON.stringify([p.minRoasAtMaxCac, p.breakEvenRoas, p.minPoas]));
  check("1.5 preço máximo pago por venda antes do prejuízo = contribuição (154)", near(p.breakEvenCostPerSale, 154));
  check("1.6 orçamento R$ 1.000: equilíbrio = ceil(1000/154) = 7 vendas (R$ 2.100) · no teto de CAC compra floor(1000/54) = 18", p.salesToBreakEven === 7 && near(p.revenueToBreakEven, 2100) && p.salesAtMaxCac === 18, JSON.stringify([p.salesToBreakEven, p.revenueToBreakEven, p.salesAtMaxCac]));
  check("1.7 declara que é estimativa, não garantia", p.basis === "estimate" && /Não é garantia/.test(p.note));
  const pf = P.plan(orgId, { productId: camisa, minProfitPerSale: 100, budget: 1000, fixedCampaignCost: 154 }) as any;
  check("1.8 custo fixo da campanha (IA/produção/frete reservado) entra no equilíbrio: (1000+154)/154 = 7,49 → 8", pf.salesToBreakEven === 8 && near(pf.fixedCampaignCost, 154));
  check("1.9 sem orçamento: só os limites, sem inventar quantidades", (P.plan(orgId, { productId: camisa, minProfitPerSale: 100 }) as any).salesToBreakEven === undefined);

  // ── 2. casos de borda do plano
  const semC = P.plan(orgId, { productId: semCusto, minProfitPerSale: 50 }) as any;
  check("2.1 sem custo da peça: sem número, com o motivo (não vira 0 nem 'viável')", semC.viable === null && semC.contributionPerSale === null && semC.reason === "contribution_unknown" && /custo da peça/.test(semC.message));
  const inv = P.plan(orgId, { productId: camisa, minProfitPerSale: 154 }) as any;
  check("2.2 lucro exigido = contribuição → inviável (CAC máximo 0)", inv.viable === false && inv.maxCac === null && inv.reason === "margin_below_required_profit");
  const inv2 = P.plan(orgId, { productId: barata, minProfitPerSale: 5 }) as any;
  check("2.3 produto de margem baixa (R$ 40, custo 30): contribuição abaixo do exigido → inviável", inv2.viable === false, JSON.stringify([inv2.contributionPerSale, inv2.viable]));
  const thrown = (fn: () => any) => { try { fn(); return ""; } catch (e: any) { return e.message as string; } };
  check("2.4 lucro mínimo obrigatório e > 0", /lucro mínimo/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: 0 }))) && /lucro mínimo/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: NaN as any }))));
  check("2.5 produto de OUTRA empresa → não encontrado", /não encontrado/.test(thrown(() => P.plan(orgId, { productId: camisaOutra, minProfitPerSale: 10 }))));
  check("2.6 orçamento/custo fixo inválidos", /Orçamento/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: 10, budget: -5 }))) && /fixo/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: 10, fixedCampaignCost: -1 }))));

  // ── 3. cenários (só números do dono)
  const sc = P.plan(orgId, { productId: camisa, minProfitPerSale: 100, budget: 1000, scenarios: [
    { label: "conservador", cpc: 2, conversionPct: 2.5 }, { label: "base", cpc: 1, conversionPct: 4 },
  ] }) as any;
  const [s1, s2] = sc.scenarios;
  check("3.1 conservador: 500 visitas × 2,5% = 12 pedidos · CAC 80 > 54 (fora do teto)", s1.visits === 500 && s1.orders === 12 && near(s1.cac, 80) && s1.withinMaxCac === false, JSON.stringify(s1));
  check("3.2 conservador: receita 3.600 · lucro 12×154 − 1000 = 848 · ROAS 3,6 · POAS 0,85", near(s1.revenue, 3600) && near(s1.profit, 848) && near(s1.roas, 3.6) && near(s1.poas, 0.85));
  check("3.3 base: 1000 visitas × 4% = 40 (sem erro de ponto flutuante) · CAC 25 dentro do teto · lucro 5.160 · POAS 5,16", s2.orders === 40 && near(s2.cac, 25) && s2.withinMaxCac === true && near(s2.profit, 5160) && near(s2.poas, 5.16), JSON.stringify(s2));
  check("3.4 ROAS alto não esconde lucro baixo: dois cenários com POAS bem diferente", s1.roas > 3 && s1.poas < 1);
  check("3.5 cenário exige orçamento; CPC/conversão inválidos recusados; máx. 3", /orçamento/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: 100, scenarios: [{ label: "a", cpc: 1, conversionPct: 2 }] }))) && /Cenário inválido/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: 100, budget: 100, scenarios: [{ label: "a", cpc: 0, conversionPct: 2 }] }))) && /Cenário inválido/.test(thrown(() => P.plan(orgId, { productId: camisa, minProfitPerSale: 100, budget: 100, scenarios: [{ label: "a", cpc: 1, conversionPct: 101 }] }))));
  check("3.6 sem cenário do dono, nenhum cenário é inventado", (p as any).scenarios === undefined);

  // ── 4. gasto lançado
  const a1 = P.addSpend(orgId, { campaign: "Verão!", amount: 300 }, "u1");
  P.addSpend(orgId, { campaign: "verao", amount: 200, note: "  reels\n semana 2 " });
  check("4.1 campanha normalizada (mesmo slug dos links) e nota higienizada", a1.campaign === "ver-o" && P.listSpend(orgId).find((x: any) => x.note)?.note === "reels semana 2", a1.campaign);
  P.removeSpend(orgId, a1.id);
  P.addSpend(orgId, { campaign: "Verao", amount: 300 });
  check("4.2 lançamentos 'Verao' e 'verao' somam na mesma campanha", P.listSpend(orgId, { campaign: "verao" }).length === 2 && P.listSpend(orgId, { campaign: "verao" }).every((x: any) => x.campaign === "verao"));
  check("4.3 validações: valor, campanha, data", /valor/.test(thrown(() => P.addSpend(orgId, { campaign: "x", amount: 0 }))) && /valor/.test(thrown(() => P.addSpend(orgId, { campaign: "x", amount: -3 }))) && /campanha/.test(thrown(() => P.addSpend(orgId, { campaign: "  ", amount: 5 }))) && /Data/.test(thrown(() => P.addSpend(orgId, { campaign: "x", amount: 5, spentOn: "ontem" }))));
  check("4.4 remover: só da própria empresa", P.removeSpend(other, P.listSpend(orgId)[0].id) === false && P.removeSpend(orgId, "nao-existe") === false);
  P.addSpend(orgId, { campaign: "sem-custo", amount: 100 });
  P.addSpend(orgId, { campaign: "antiga", amount: 999, spentOn: new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10) });
  P.addSpend(other, { campaign: "verao", amount: 7777 });

  // ── 5. resultado real
  const mkOrder = (org: string, o: { campaign: string | null; productId: string; qty?: number; price: number; discount?: number; shipAbsorbed?: number; status?: string; pay?: string; daysAgo?: number }) => {
    const id = randomUUID(), qty = o.qty ?? 1, total = o.price * qty - (o.discount ?? 0);
    db.prepare(`INSERT INTO orders (id, organization_id, status, payment_status, total_amount, discount_amount, shipping_absorbed, created_by, attr_campaign, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'storefront', ?, datetime('now', ?))`)
      .run(id, org, o.status ?? "pago", o.pay ?? "paid", total, o.discount ?? 0, o.shipAbsorbed ?? null, o.campaign, `-${o.daysAgo ?? 0} days`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, 'P', ?, ?, ?)`).run(randomUUID(), id, org, o.productId, o.price, qty, o.price * qty);
    return id;
  };
  mkOrder(orgId, { campaign: "verao", productId: camisa, price: 300 });                                        // 154
  mkOrder(orgId, { campaign: "Verao", productId: camisa, price: 300, discount: 30, shipAbsorbed: 20 });       // 270−110−24,3−9 = 126,7 −20 frete = 106,7
  mkOrder(orgId, { campaign: "verao", productId: camisa, price: 300, status: "aguardando_pagamento", pay: "pending" });   // não pago: fora
  mkOrder(orgId, { campaign: "verao", productId: camisa, price: 300, status: "cancelado", pay: "paid" });      // cancelado: fora
  mkOrder(orgId, { campaign: "sem-custo", productId: semCusto, price: 200 });
  mkOrder(orgId, { campaign: "sem-gasto", productId: camisa, price: 300 });
  mkOrder(orgId, { campaign: "antiga", productId: camisa, price: 300, daysAgo: 60 });
  mkOrder(other, { campaign: "verao", productId: camisaOutra, price: 300 });
  db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, cost_cents, request_id) VALUES (?, ?, 'm', 'chat', 250, 'campaign:verao')`).run(randomUUID(), orgId);

  const r = P.results(orgId, { days: 30 });
  const by = (c: string) => r.campaigns.find((x) => x.campaign === c) as any;
  const v = by("verao");
  check("5.1 verao: gasto 500 (300+200), 2 pedidos pagos, receita 570", near(v.spend, 500) && v.paidOrders === 2 && near(v.revenuePaid, 570), JSON.stringify(v));
  check("5.2 verao: ROAS = 570/500 = 1,14", near(v.roas, 1.14));
  check("5.3 verao: contribuição = 154 + (126,7 − 20 de frete subsidiado) = 260,7", near(v.contribution, 260.7), String(v.contribution));
  check("5.4 verao: IA da F8 entra (R$ 2,50) · lucro = 260,7 − 500 − 2,5 = −241,8 · POAS −0,48", near(v.aiCost, 2.5) && near(v.profit, -241.8) && near(v.poas, -0.48), JSON.stringify([v.aiCost, v.profit, v.poas]));
  check("5.5 custo por pedido PAGO = 500/2 = 250 (não é CAC)", near(v.costPerPaidOrder, 250) && /não é o custo de um cliente novo/.test(r.note));
  check("5.6 só pedido pago e não cancelado conta", v.paidOrders === 2);
  const sc0 = by("sem-custo");
  check("5.7 produto sem custo: contribuição, lucro e POAS = null (não 0) — mas ROAS existe", sc0.contribution === null && sc0.profit === null && sc0.poas === null && near(sc0.roas, 2));
  const sg = by("sem-gasto");
  check("5.8 vendeu sem gasto lançado: gasto/ROAS/lucro/POAS null (não R$ 0, não ∞)", sg.spend === null && sg.roas === null && sg.profit === null && sg.poas === null && sg.paidOrders === 1 && near(sg.contribution, 154));
  check("5.9 janela 30d exclui gasto e pedido de 60 dias; 90d inclui", by("antiga") === undefined && near((P.results(orgId, { days: 90 }).campaigns.find((x) => x.campaign === "antiga") as any)?.spend, 999));
  check("5.10 ordenado por gasto desc", r.campaigns[0].campaign === "verao");
  const ro = P.results(other, { days: 30 }).campaigns;
  check("5.11 isolamento: outra empresa só vê o dela", ro.length === 1 && near((ro[0] as any).spend, 7777) && (ro[0] as any).paidOrders === 1);
  check("5.12 margem parcial (canal incompleto) é marcada como TETO", (() => { E.saveSettings(orgId, { online: { taxPercent: null, paymentFeePercent: null, paymentFeeFixed: null, packagingFixed: null } }); const x = P.results(orgId, { days: 30 }).campaigns.find((c) => c.campaign === "verao") as any; E.saveSettings(orgId, { online: { taxPercent: 6, paymentFeePercent: 3, paymentFeeFixed: 0, packagingFixed: 9 } }); return x.contributionIsUpperBound === true; })());
  const afterSnap = JSON.parse(JSON.stringify({ prod: db.prepare("SELECT id, price FROM products_services ORDER BY id").all(), act: db.prepare("SELECT COUNT(*) c FROM decision_actions").get(), sig: db.prepare("SELECT COUNT(*) c FROM business_signals").get() }));
  const b4 = JSON.parse(before);
  check("5.13 calcular não escreve nada: preços, ações e sinais intactos (pedidos só os que o teste criou)", JSON.stringify(afterSnap) === JSON.stringify({ prod: b4.prod, act: b4.act, sig: b4.sig }));

  // ── 6. rotas
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), atendente = mkUser(orgId, "Ana", "agent"), donoOutra = mkUser(other, "Ze", "owner");
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/storefront", storefrontAdmin);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (uid: string, method: string, p2: string, body?: any) => { const rr = await fetch(`http://127.0.0.1:${port}/api/storefront${p2}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined }); return { status: rr.status, body: await rr.json().catch(() => ({})) as any }; };
  const plan = await call(dono, "POST", "/economics/media-plan", { productId: camisa, minProfitPerSale: 100, budget: 1000, scenarios: [{ label: "base", cpc: 1, conversionPct: 4 }] });
  check("6.1 dono: plano pela rota (strings vazias viram 'não informado')", plan.status === 200 && near(plan.body.maxCac, 54) && plan.body.scenarios.length === 1 && (await call(dono, "POST", "/economics/media-plan", { productId: camisa, minProfitPerSale: 100, budget: "", fixedCampaignCost: "" })).status === 200);
  check("6.2 plano inválido → 400 com a mensagem", (await call(dono, "POST", "/economics/media-plan", { productId: camisa })).status === 400);
  check("6.3 atendente barrado em TODAS as rotas de dinheiro", (await call(atendente, "POST", "/economics/media-plan", { productId: camisa, minProfitPerSale: 1 })).status === 403 && (await call(atendente, "GET", "/economics/media-results")).status === 403 && (await call(atendente, "POST", "/economics/media-spend", { campaign: "x", amount: 1 })).status === 403 && (await call(atendente, "GET", "/economics/media-spend")).status === 403 && (await call(atendente, "DELETE", "/economics/media-spend/x")).status === 403);
  const add = await call(dono, "POST", "/economics/media-spend", { campaign: "rota", amount: 50, note: "teste" });
  check("6.4 dono lança e lista o gasto", add.status === 200 && (await call(dono, "GET", "/economics/media-spend?campaign=rota")).body.entries.length === 1);
  check("6.5 gasto inválido → 400", (await call(dono, "POST", "/economics/media-spend", { campaign: "rota", amount: "abc" })).status === 400);
  check("6.6 outra empresa não apaga o lançamento alheio; o dono apaga", (await call(donoOutra, "DELETE", `/economics/media-spend/${add.body.id}`)).status === 404 && (await call(dono, "DELETE", `/economics/media-spend/${add.body.id}`)).status === 200);
  check("6.7 resultado pela rota (?days chega ao serviço)", (await call(dono, "GET", "/economics/media-results?days=90")).body.days === 90);
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
