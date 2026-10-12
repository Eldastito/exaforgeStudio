/**
 * TESTE — Política de frete definida pelo dono (ADR-207 F7).
 *
 * Sobe a vitrine pública e as rotas do dono REAIS e prova:
 *  - política desligada = checkout de sempre (colunas de frete nulas, mesmo total, resposta sem bloco de frete);
 *  - validação da tabela (CEP, faixa, sobreposição, valores) e preço por faixa → fixo → "a combinar";
 *  - o total_amount do pedido segue sendo o dos PRODUTOS (relatórios não mudam); o cliente paga produtos + frete;
 *  - o servidor recalcula o frete (valor vindo do cliente é ignorado);
 *  - retirada na loja nunca paga frete;
 *  - frete GRÁTIS só com as três provas (valor mínimo, teto de subsídio, margem que aguenta o frete) — cada uma é uma prova
 *    própria e, sem poder PROVAR a margem (custo/piso/custo do canal ausentes), o cliente paga;
 *  - a resposta pública não mostra margem, custo nem o motivo; o motivo é só do dono;
 *  - rotas só dono/admin, isolamento por empresa.
 *
 * Uso: npm run test:shipping-policy
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-shipping-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-shipping-1234567890abcd";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const storefrontAdmin = (await import("../src/server/routes/storefront.js")).default;
  const { ShippingPolicyService: SP, normalizeCep } = await import("../src/server/ShippingPolicyService.js");
  const { ChannelEconomicsService: CE } = await import("../src/server/ChannelEconomicsService.js");
  const { StorefrontAttributionService: Attr } = await import("../src/server/StorefrontAttributionService.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService: R } = await import("../src/server/RetailOnlineReserveService.js");
  const { StorePickupService: P } = await import("../src/server/StorePickupService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");

  const orgId = randomUUID(), otherOrg = randomUUID();
  for (const [id, slug] of [[orgId, "toulon"], [otherOrg, "outra"]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug.toUpperCase());
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, ?)`).run(id, slug, `Loja ${slug}`);
  }
  db.prepare("UPDATE storefront_settings SET whatsapp_number = '5511999990000' WHERE organization_id = ?").run(orgId);
  const mkProduct = (org: string, name: string, price: number, cost: number | null, mode?: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible${mode ? ", sale_mode" : ""}) VALUES (?, ?, ?, 'product', ?, 1, 1${mode ? ", ?" : ""})`).run(...([id, org, name, price].concat(mode ? [mode] : [])) as any);
    if (cost != null) db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, avg_cost) VALUES (?, ?, ?, NULL, 500, ?)`).run(randomUUID(), org, id, cost);
    return id;
  };
  const camisa = mkProduct(orgId, "Camisa", 200, 80);          // contribuição boa
  const fina = mkProduct(orgId, "Peça fina", 400, 267);        // 22% de contribuição
  const semCusto = mkProduct(orgId, "Sem custo", 200, null);
  const granel = mkProduct(orgId, "Granel", 100, 10, "weight");
  const outra = mkProduct(otherOrg, "De outra", 100, 30);
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), agente = mkUser(orgId, "Ana", "agent"), donoOutra = mkUser(otherOrg, "Ze", "owner");

  const app = express(); app.use(express.json());
  app.use("/api/public", storefrontPublic);
  app.use((req: any, _res: any, next: any) => {
    const row = req.headers["x-uid"] ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(String(req.headers["x-uid"])) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/storefront", storefrontAdmin);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const base = `http://127.0.0.1:${port}`;
  const pub = async (p: string, body?: any) => { const r = await fetch(`${base}/api/public/store/toulon${p}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
  const admin = async (uid: string, method: string, p: string, body?: any) => { const r = await fetch(`${base}/api/storefront${p}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
  const order = (items: any[], extra: any = {}) => pub("/order", { items, customer: { name: "Maria", phone: "11988887777" }, ...extra });
  const row = (id: string) => db.prepare("SELECT total_amount, shipping_amount, shipping_absorbed, shipping_cep, shipping_rule, status FROM orders WHERE id = ?").get(id) as any;
  const cart = (pid: string, qty: number) => [{ productId: pid, quantity: qty }];

  // ── 1. Política desligada = checkout de sempre ─────────────────────────────
  check("1.1 vitrine: frete desligado por padrão", (await pub("/shipping")).json.enabled === false);
  SP.save(orgId, { ranges: [{ cepFrom: "20000000", cepTo: "20999999", amount: 15 }], fixedAmount: 12 });   // configurada, mas NÃO ligada
  const off = await order(cart(camisa, 1), { shippingCep: "20000-000" });
  check("1.2 desligada: pedido idêntico — frete nulo, total = produtos, resposta sem bloco 'shipping'", off.status === 200 && off.json.total === 200 && off.json.shipping === undefined && row(off.json.orderId).shipping_amount === null && row(off.json.orderId).shipping_rule === null, JSON.stringify([off.json.total, off.json.shipping]));
  check("1.3 desligada: cotação não existe", (await pub("/shipping/quote", { items: cart(camisa, 1), cep: "20000000" })).json.enabled === false);

  // ── 2. Validação da tabela ────────────────────────────────────────────────
  const bad = (patch: any) => { try { SP.save(orgId, patch); return false; } catch { return true; } };
  check("2.1 CEP inválido, faixa invertida, sobreposta e valor ruim são recusados", bad({ ranges: [{ cepFrom: "123", cepTo: "20999999", amount: 5 }] }) && bad({ ranges: [{ cepFrom: "21000000", cepTo: "20000000", amount: 5 }] })
    && bad({ ranges: [{ cepFrom: "20000000", cepTo: "20999999", amount: 5 }, { cepFrom: "20500000", cepTo: "21999999", amount: 7 }] }) && bad({ ranges: [{ cepFrom: "20000000", cepTo: "20999999", amount: -1 }] })
    && bad({ ranges: [{ cepFrom: "20000000", cepTo: "20999999" } as any] }) && bad({ fixedAmount: -3 }) && bad({ freeAbove: "abc" as any }) && bad({ maxAbsorb: 5000 }));
  check("2.2 a política anterior não foi corrompida pelas tentativas inválidas", SP.settings(orgId).ranges.length === 1 && SP.settings(orgId).fixedAmount === 12);
  SP.save(orgId, { enabled: true, ranges: [
    { cepFrom: "22000000", cepTo: "22999999", amount: 30, label: "Barra" },
    { cepFrom: "20000000", cepTo: "20999999", amount: 15, label: "Zona Sul" },
    { cepFrom: "21000000", cepTo: "21999999", amount: 5 },
  ], fixedAmount: null }, dono);
  check("2.3 faixas salvas ordenadas, CEP normalizado", SP.settings(orgId).ranges.map((r: any) => r.cepFrom).join() === "20000000,21000000,22000000" && normalizeCep("20000-000") === "20000000");
  check("2.4 em branco limpa (fixo volta a nulo); a configuração fica no audit", SP.settings(orgId).fixedAmount === null && (db.prepare("SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'SHIPPING_POLICY_SET'").get(orgId) as any).c >= 2);

  // ── 3. Preço: faixa → fixo → a combinar ───────────────────────────────────
  check("3.1 CEP na faixa → valor da faixa (aceita hífen)", SP.basePrice(orgId, "20040-020")?.amount === 15 && SP.basePrice(orgId, "20040-020")?.label === "Zona Sul");
  check("3.2 CEP fora de qualquer faixa e sem fixo → null (não inventa preço)", SP.basePrice(orgId, "30000000") === null && SP.basePrice(orgId, "") === null);
  const g = (await pub("/shipping")).json;
  check("3.3 vitrine pede CEP quando há faixas", g.enabled === true && g.needsCep === true);
  const noCep = await pub("/shipping/quote", { items: cart(camisa, 1) });
  check("3.4 sem CEP: 'a combinar' e pede o CEP — não bloqueia", noCep.json.enabled === true && noCep.json.toArrange === true && noCep.json.needsCep === true && noCep.json.amount === null);
  const tOrder = await order(cart(camisa, 1));
  check("3.5 pedido sem CEP segue: frete NULO (a combinar), total = produtos, resposta avisa", tOrder.status === 200 && tOrder.json.total === 200 && tOrder.json.shipping?.toArrange === true && row(tOrder.json.orderId).shipping_amount === null && decodeURIComponent(tOrder.json.whatsappUrl).includes("Frete: a combinar"));
  SP.save(orgId, { fixedAmount: 12 });
  check("3.6 com frete fixo, CEP fora das faixas cai no fixo", SP.basePrice(orgId, "30000000")?.amount === 12 && SP.basePrice(orgId, "30000000")?.source === "fixed");
  SP.save(orgId, { fixedAmount: null });

  // ── 4. Pedido com frete: produtos × total a pagar ─────────────────────────
  const paid = await order(cart(camisa, 1), { shippingCep: "20040-020" });
  const pr = row(paid.json.orderId);
  check("4.1 frete da faixa: total_amount segue = PRODUTOS (200); frete em coluna própria (15)", paid.status === 200 && pr.total_amount === 200 && pr.shipping_amount === 15 && pr.shipping_cep === "20040020" && pr.shipping_absorbed === 0);
  check("4.2 o cliente paga produtos + frete (resposta e mensagem)", paid.json.total === 215 && paid.json.shipping?.amount === 15 && decodeURIComponent(paid.json.whatsappUrl).includes("Frete: R$ 15.00") && decodeURIComponent(paid.json.whatsappUrl).includes("Total: R$ 215.00"));
  const forged = await order(cart(camisa, 1), { shippingCep: "20040-020", shippingAmount: 0, shipping_amount: 0, shipping: { amount: 0 } });
  check("4.3 valor de frete vindo do cliente é IGNORADO (o servidor recalcula)", row(forged.json.orderId).shipping_amount === 15 && forged.json.total === 215);
  const q = await pub("/shipping/quote", { items: cart(camisa, 1), cep: "20040-020" });
  check("4.4 a cotação bate com o pedido (mesmo valor e mesmo total)", q.json.amount === 15 && q.json.payable === 215 && q.json.payable === paid.json.total);
  Attr.attachToOrder(orgId, paid.json.orderId, { source: "instagram", campaign: "c", content: null, ref: null }, null);
  OrdersService.updateStatus(orgId, paid.json.orderId, "pago"); db.prepare("UPDATE orders SET payment_status = 'paid' WHERE id = ?").run(paid.json.orderId);
  const fun = (Attr.funnel(orgId, { days: 30 }) as any).attributed.find((x: any) => x.source === "instagram");
  check("4.5 relatórios (funil de atribuição) contam só os PRODUTOS, sem o frete", fun?.revenuePaid === 200, JSON.stringify(fun?.revenuePaid));
  const cupom = db.prepare("INSERT INTO storefront_coupons (id, organization_id, code, type, value, active) VALUES (?, ?, 'DEZ', 'percent', 10, 1)").run(randomUUID(), orgId);
  const withCoupon = await order(cart(camisa, 1), { shippingCep: "20040-020", coupon: "DEZ" });
  check("4.6 com cupom: produtos com desconto (180) + frete 15 = 195", cupom.changes === 1 && row(withCoupon.json.orderId).total_amount === 180 && withCoupon.json.total === 195);

  // ── 5. Retirada nunca paga frete ──────────────────────────────────────────
  const loja = RetailStoreService.create(orgId, { name: "Toulon 1079", code: "10" });
  R.setEnabled(orgId, true); P.setSettings(orgId, { enabled: true }); P.setStore(orgId, loja.id, true); R.setReserve(orgId, loja.id, camisa, null, 50);
  const pick = await order(cart(camisa, 1), { fulfillment: "pickup", pickupStoreId: loja.id, shippingCep: "20040-020" });
  check("5.1 retirada na loja: sem frete (colunas nulas, total = produtos)", pick.status === 200 && pick.json.total === 200 && pick.json.shipping === undefined && row(pick.json.orderId).shipping_amount === null);

  // ── 6. Frete GRÁTIS: as três provas ───────────────────────────────────────
  CE.saveSettings(orgId, { floorPercent: 20, online: { taxPercent: 6, paymentFeePercent: 3, paymentFeeFixed: 0, packagingFixed: 9 } });
  SP.save(orgId, { freeAbove: 300, maxAbsorb: 25 });
  const free = async (items: any[], cep = "20040-020", extra: any = {}) => { const o = await order(items, { shippingCep: cep, ...extra }); return { o, r: row(o.json.orderId) }; };

  const a = await free(cart(camisa, 1));
  check("6.1 abaixo do valor mínimo (200 < 300) → paga o frete", a.r.shipping_amount === 15 && a.r.shipping_absorbed === 0 && a.r.shipping_rule === "below_threshold");
  const b = await free(cart(camisa, 2));
  check("6.2 as três provas ok (400 ≥ 300, 15 ≤ 25, (195−15)/400 = 45% ≥ 20%) → GRÁTIS; empresa absorve 15 e fica registrado", b.r.shipping_amount === 0 && b.r.shipping_absorbed === 15 && b.r.shipping_rule === "applied" && b.o.json.total === 400 && b.o.json.shipping?.free === true && decodeURIComponent(b.o.json.whatsappUrl).includes("Frete: grátis"));
  const c = await free(cart(camisa, 2), "22040-020");
  check("6.3 frete acima do teto de subsídio (30 > 25) → paga, mesmo com tudo mais ok", c.r.shipping_amount === 30 && c.r.shipping_rule === "above_max_absorb");
  const d = await free(cart(camisa, 2), "20040-020", { coupon: "DEZ" });
  check("6.4 o desconto conta: 400 − 10% = 360 ainda ≥ 300 → grátis", d.r.shipping_amount === 0);
  SP.save(orgId, { freeAbove: 390 });
  const d2 = await free(cart(camisa, 2), "20040-020", { coupon: "DEZ" });
  check("6.5 mínimo 390: com cupom o pedido (360) fica abaixo → paga (cupom não burla o mínimo)", d2.r.shipping_amount === 15 && d2.r.shipping_rule === "below_threshold");
  SP.save(orgId, { freeAbove: 300 });
  // margem fina: contribuição 22% antes do frete; após absorver 15 → 18,25% < 20%
  const e = await free(cart(fina, 1));
  check("6.6 contribuição OK antes do frete (22%) mas QUEBRA o piso depois de absorvê-lo (18,25% < 20%) → paga", e.r.shipping_amount === 15 && e.r.shipping_rule === "would_break_floor", JSON.stringify(e.r));
  const e2 = await free(cart(fina, 1), "21040-020");
  check("6.7 mesmo produto com frete barato (5): (88−5)/400 = 20,75% ≥ 20% → grátis", e2.r.shipping_amount === 0 && e2.r.shipping_absorbed === 5);
  const f = await free([...cart(camisa, 2), ...cart(semCusto, 1)]);
  check("6.8 um item SEM custo conhecido → não dá pra provar a margem → paga", f.r.shipping_amount === 15 && f.r.shipping_rule === "economics_unconfirmed");
  const gran = await free([...cart(camisa, 2), { productId: granel, quantity: 1, option: { type: "weight", grams: 500 } }]);
  check("6.9 item por peso/volume (sem produto vinculado) → não dá pra provar → paga", gran.r.shipping_amount === 15 && gran.r.shipping_rule === "economics_unconfirmed");
  CE.saveSettings(orgId, { floorPercent: null });
  const h = await free(cart(camisa, 2));
  check("6.10 sem margem mínima do dono → nunca grátis", h.r.shipping_amount === 15 && h.r.shipping_rule === "floor_not_set");
  CE.saveSettings(orgId, { floorPercent: 20, online: { packagingFixed: null } });
  const i = await free(cart(camisa, 2));
  check("6.11 custo do canal online incompleto → nunca grátis", i.r.shipping_amount === 15 && i.r.shipping_rule === "economics_unconfirmed");
  CE.saveSettings(orgId, { online: { packagingFixed: 9 } });
  SP.save(orgId, { freeAbove: null });
  const j = await free(cart(camisa, 2));
  check("6.12 sem valor mínimo definido pelo dono → nunca grátis", j.r.shipping_amount === 15 && j.r.shipping_rule === "no_threshold");
  SP.save(orgId, { freeAbove: 300, maxAbsorb: null });
  check("6.13 sem teto de subsídio, o teto não limita (frete 30 ainda grátis com margem folgada)", (await free(cart(camisa, 2), "22040-020")).r.shipping_amount === 0);
  SP.save(orgId, { maxAbsorb: 25 });

  // ── 7. A resposta pública não vaza nada interno ───────────────────────────
  const pubQ = await pub("/shipping/quote", { items: cart(camisa, 2), cep: "20040-020" });
  const leak = JSON.stringify(pubQ.json);
  check("7.1 cotação pública só traz valor/grátis/rótulo (sem motivo, margem, custo ou piso)", !/reason|margin|margem|cost|custo|floor|piso|absorb|contribution/i.test(leak) && pubQ.json.free === true && pubQ.json.amount === 0, leak);
  check("7.2 produto de OUTRA empresa no carrinho é ignorado", (await pub("/shipping/quote", { items: cart(outra, 1), cep: "20040-020" })).json.enabled === false);

  // ── 8. Rotas do dono ──────────────────────────────────────────────────────
  const routes: Array<[string, string, any?]> = [["GET", "/shipping-policy"], ["PUT", "/shipping-policy", { fixedAmount: 10 }], ["POST", "/shipping-policy/simulate", { items: cart(camisa, 1) }]];
  let denied = 0; for (const [m, p, bd] of routes) if ((await admin(agente, m, p, bd)).status === 403) denied++;
  check("8.1 atendente é barrado (403) nas 3 rotas", denied === 3);
  check("8.2 dono lê a política", (await admin(dono, "GET", "/shipping-policy")).json.freeAbove === 300);
  check("8.3 PUT inválido → 400 e nada muda", (await admin(dono, "PUT", "/shipping-policy", { fixedAmount: -1 })).status === 400 && SP.settings(orgId).fixedAmount === null);
  const put = await admin(dono, "PUT", "/shipping-policy", { enabled: true, maxAbsorb: 25 });
  check("8.4 dono salva", put.status === 200 && put.json.maxAbsorb === 25);
  const sim = await admin(dono, "POST", "/shipping-policy/simulate", { items: cart(camisa, 2), cep: "20040-020" });
  check("8.5 simulador do dono mostra o MOTIVO (interno) e o que a empresa absorveria", sim.status === 200 && sim.json.free === true && sim.json.reason === "applied" && sim.json.absorbed === 15);
  const sim2 = await admin(dono, "POST", "/shipping-policy/simulate", { items: cart(semCusto, 2), cep: "20040-020" });
  check("8.6 simulador explica por que NÃO é grátis (custo ausente)", sim2.json.free === false && sim2.json.reason === "economics_unconfirmed");
  check("8.7 simulador sem produto válido → 400", (await admin(dono, "POST", "/shipping-policy/simulate", { items: cart(outra, 1) })).status === 400);
  check("8.8 a política é por empresa: o dono de outra não vê a desta", (await admin(donoOutra, "GET", "/shipping-policy")).json.enabled === false && (await admin(donoOutra, "GET", "/shipping-policy")).json.freeAbove === null);

  // ── 9. orderContribution: custo fixo conta UMA vez por pedido ─────────────
  const oc = CE.orderContribution(orgId, [{ productId: camisa, qty: 2, unitPrice: 200 }], 0);
  check("9.1 contribuição do pedido: 400 − 160 − 36 (9%) − 9 (embalagem UMA vez) = 195", oc.quality === "reliable" && oc.contribution === 195 && oc.percent === 48.8, JSON.stringify(oc));
  check("9.2 sem custo da peça → insuficiente (sem número)", CE.orderContribution(orgId, [{ productId: semCusto, qty: 1, unitPrice: 200 }]).contribution === null);
  check("9.3 item sem produto vinculado → insuficiente", CE.orderContribution(orgId, [{ productId: null, qty: 1, unitPrice: 50 }]).quality === "insufficient");

  server.close();
  console.log("\n=== Política de frete (ADR-207 F7) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
