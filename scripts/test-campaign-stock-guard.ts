/**
 * TESTE — Estoque ↔ campanha (ADR-207 F12).
 *
 * Prova, com o serviço, o Scheduler-pass, as rotas do dono e os consumidores REAIS:
 *  - o saldo é o MESMO da vitrine (disponível − reservado, estoque próprio e por loja); sem controle de estoque = 'unknown' (nunca alerta);
 *  - "em campanha" = link curto ATIVO com produto ou post do Instagram ligado a produto (nada por palpite);
 *  - produto em campanha com saldo baixo → aviso 'attention'; esgotado → 'risk'; repôs → o aviso se resolve sozinho; voltou a faltar → reabre;
 *  - saiu de campanha (link arquivado) → aviso resolvido; um aviso por produto (dedupe), só unidades (nada de R$), isolado por empresa;
 *  - ANTES de criar: oportunidade de produto não promove peça com saldo baixo (nem a que tem tudo reservado);
 *  - mídia paga avisa quando o produto está baixo/esgotado (sem bloquear a conta); Motor de Crescimento mostra os avisos;
 *  - rotas só dono/administrador.
 *
 * Uso: npm run test:campaign-stock-guard
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-campaign-stock-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-campaign-stock-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const social = (await import("../src/server/routes/social.js")).default;
  const { CampaignStockGuardService: G, LOW_STOCK_UNITS } = await import("../src/server/CampaignStockGuardService.js");
  const { ProductOpportunityService: PO } = await import("../src/server/ProductOpportunityService.js");
  const { PaidMediaService: PM } = await import("../src/server/PaidMediaService.js");
  const { GrowthEngineService: GE } = await import("../src/server/GrowthEngineService.js");
  const { ChannelEconomicsService: E } = await import("../src/server/ChannelEconomicsService.js");
  const { InstagramCommentIntentService: IG } = await import("../src/server/InstagramCommentIntentService.js");
  const { StorefrontStockService } = await import("../src/server/StorefrontStockService.js");

  const orgId = randomUUID(), other = randomUUID();
  for (const id of [orgId, other]) db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mk = (org: string, name: string, opts: { control?: number; qty?: number | null; reserved?: number; cost?: number } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible, stock_control_enabled) VALUES (?, ?, ?, 'product', 100, 1, 1, ?)`).run(id, org, name, opts.control ?? 1);
    if (opts.qty !== null && opts.qty !== undefined) db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, quantity_reserved, avg_cost) VALUES (?, ?, ?, NULL, ?, ?, ?)`).run(randomUUID(), org, id, opts.qty, opts.reserved ?? 0, opts.cost ?? 40);
    return id;
  };
  const link = (org: string, productId: string | null, active = 1) => db.prepare(`INSERT INTO storefront_short_links (id, organization_id, code, source, product_id, active) VALUES (?, ?, ?, 'instagram', ?, ?)`).run(randomUUID(), org, randomUUID().slice(0, 8), productId, active).lastInsertRowid;

  const ok = mk(orgId, "Camisa Ok", { qty: 20 });
  const baixo = mk(orgId, "Camisa Baixo", { qty: 3 });
  const esgotado = mk(orgId, "Camisa Esgotada", { qty: 0 });
  const reservado = mk(orgId, "Camisa Reservada", { qty: 10, reserved: 10 });   // 10 no depósito, 10 reservados → 0 vendável
  const semControle = mk(orgId, "Serviço Sem Controle", { control: 0, qty: 0 });
  const doOutro = mk(other, "Do Outro", { qty: 1 });

  // ── 1. régua de saldo
  check("1.1 limiar de 'baixo' = 5 unidades", LOW_STOCK_UNITS === 5);
  check("1.2 20 un. → ok · 3 un. → low · 0 → out", G.status(orgId, ok)!.state === "ok" && G.status(orgId, baixo)!.state === "low" && G.status(orgId, esgotado)!.state === "out");
  check("1.3 10 em estoque − 10 reservados = 0 vendável → out (mesma régua da vitrine)", G.status(orgId, reservado)!.state === "out" && G.status(orgId, reservado)!.units === 0 && StorefrontStockService.sellable(reservado) === 0);
  check("1.4 sem controle de estoque → unknown (units null, nunca alerta)", G.status(orgId, semControle)!.state === "unknown" && G.status(orgId, semControle)!.units === null);
  check("1.5 exatamente 5 → low; 6 → ok", (() => { const a = mk(orgId, "Cinco", { qty: 5 }), b = mk(orgId, "Seis", { qty: 6 }); return G.status(orgId, a)!.state === "low" && G.status(orgId, b)!.state === "ok"; })());
  check("1.6 produto de outra empresa → null (isolamento)", G.status(orgId, doOutro) === null);
  check("1.7 saldo só por loja (retail_store_inventory) também conta", (() => {
    const p = mk(orgId, "Só Rede", { qty: null });
    const st = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'L1', '10')`).run(st, orgId);
    db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, ?, 2, 0)`).run(randomUUID(), orgId, st, p);
    return G.status(orgId, p)!.state === "low" && G.status(orgId, p)!.units === 2;
  })());

  // ── 2. quem está "em campanha"
  check("2.1 sem link nem post ligado: ninguém é vigiado", G.watched(orgId).length === 0 && G.scan(orgId).checked === 0);
  link(orgId, baixo); link(orgId, esgotado); link(orgId, ok); link(orgId, reservado); link(orgId, semControle);
  link(orgId, null);                       // link sem produto: nada a vigiar
  link(orgId, doOutro as any, 1);          // product_id alheio na MESMA org não existe → status null → ignorado
  const arquivado = mk(orgId, "Arquivado", { qty: 0 }); link(orgId, arquivado, 0);   // link arquivado: não é campanha
  const wp = G.watched(orgId).map((w) => w.productId);
  check("2.2 só produtos de link ATIVO entram (arquivado/sem produto fora)", wp.includes(baixo) && wp.includes(esgotado) && !wp.includes(arquivado) && wp.length === 6, JSON.stringify(wp.length));
  const viaPost = mk(orgId, "Via Post", { qty: 1 });
  IG.linkMedia(orgId, "media-9", viaPost);
  check("2.3 post do Instagram ligado a produto também é campanha", G.watched(orgId).find((w) => w.productId === viaPost)?.sources.includes("instagram_post") === true);
  link(orgId, viaPost);
  check("2.4 mesmo produto em 2 fontes: uma entrada com as duas origens", (() => { const w = G.watched(orgId).filter((x) => x.productId === viaPost); return w.length === 1 && w[0].sources.length === 2; })());

  // ── 3. aviso na espinha
  const sig = (pid: string) => db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(orgId, `campaign.stock|${pid}`) as any;
  const r1 = G.scan(orgId);
  check("3.1 resumo do passe: 2 baixos (Baixo, Via Post), 2 esgotados (Esgotada, Reservada); o produto alheio é ignorado", r1.out === 2 && r1.low === 2 && r1.checked === 7, JSON.stringify(r1));
  check("3.2 baixo → 'attention', esgotado → 'risk'", sig(baixo).severity === "attention" && sig(baixo).signal_type === "campaign_stock_low" && sig(esgotado).severity === "risk" && sig(esgotado).signal_type === "campaign_stock_out");
  check("3.3 ok e sem controle NÃO geram aviso", !sig(ok) && !sig(semControle));
  const ev = JSON.parse(sig(baixo).evidence_json);
  check("3.4 aviso só com unidades (nada de R$), fato, com o que fazer", sig(baixo).impact_amount === null && sig(baixo).basis === "fact" && ev.units === 3 && !/R\$/.test(JSON.stringify(ev)) && /reduza a exposição/.test(ev.note));
  G.scan(orgId);
  check("3.5 reexecutar não duplica (um aviso por produto)", (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND dedupe_key LIKE 'campaign.stock|%'").get(orgId) as any).n === 4);
  // piora: baixo → esgotado
  db.prepare("UPDATE inventory_items SET quantity_available = 0 WHERE product_service_id = ?").run(baixo);
  G.scan(orgId);
  check("3.6 baixo que zera vira 'risk / out' no MESMO aviso", sig(baixo).signal_type === "campaign_stock_out" && sig(baixo).severity === "risk" && sig(baixo).status === "open");
  // repôs
  db.prepare("UPDATE inventory_items SET quantity_available = 30 WHERE product_service_id = ?").run(baixo);
  const r2 = G.scan(orgId);
  check("3.7 repôs → o aviso se resolve sozinho", sig(baixo).status === "resolved" && r2.resolved >= 1);
  // faltou de novo
  db.prepare("UPDATE inventory_items SET quantity_available = 2 WHERE product_service_id = ?").run(baixo);
  G.scan(orgId);
  check("3.8 faltou de novo → reabre o mesmo aviso (não cria outro)", sig(baixo).status === "open" && sig(baixo).signal_type === "campaign_stock_low");
  // saiu de campanha
  db.prepare("UPDATE storefront_short_links SET active = 0 WHERE organization_id = ? AND product_id = ?").run(orgId, baixo);
  G.scan(orgId);
  check("3.9 link arquivado (saiu de campanha) → aviso resolvido", sig(baixo).status === "resolved");
  // dispensado por pessoa não reabre
  db.prepare("UPDATE business_signals SET status = 'dismissed' WHERE organization_id = ? AND dedupe_key = ?").run(orgId, `campaign.stock|${esgotado}`);
  G.scan(orgId);
  check("3.10 aviso DISPENSADO por uma pessoa não é reaberto pelo sistema", sig(esgotado).status === "dismissed");
  db.prepare("UPDATE business_signals SET status = 'resolved', auto_resolved = 0 WHERE organization_id = ? AND dedupe_key = ?").run(orgId, `campaign.stock|${reservado}`);
  G.scan(orgId);
  check("3.10b aviso resolvido POR UMA PESSOA não é reaberto pelo sistema (só o que o próprio passe fechou)", sig(reservado).status === "resolved");
  check("3.11 isolamento: scan de outra empresa não toca a nossa", (() => { const before = JSON.stringify(db.prepare("SELECT id, status FROM business_signals WHERE organization_id = ? ORDER BY id").all(orgId)); G.scan(other); return before === JSON.stringify(db.prepare("SELECT id, status FROM business_signals WHERE organization_id = ? ORDER BY id").all(orgId)); })());
  check("3.12 passe do Scheduler roda as orgs em campanha sem lançar", (() => { try { G.pass(); return true; } catch { return false; } })());
  check("3.13 nada é alterado: estoque, preços e links intactos pelo scan", (() => { const q = (db.prepare("SELECT quantity_available q FROM inventory_items WHERE product_service_id = ?").get(esgotado) as any).q; return q === 0 && (db.prepare("SELECT COUNT(*) n FROM storefront_short_links WHERE organization_id = ? AND active = 1").get(orgId) as any).n >= 5; })());

  // ── 4. ANTES de criar: oportunidade de produto
  const org2 = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T2', 'active')`).run(org2);
  const cand = (qty: number, reserved = 0) => { const p = mk(org2, `Cand${qty}-${reserved}`, { qty, reserved, cost: 40 }); return p; };
  const c3 = cand(3), c5 = cand(5), c8 = cand(8), cRes = cand(20, 18), c30 = cand(30);
  const ids = PO.candidates(org2).map((c) => c.productId);
  check("4.1 oportunidade só com saldo vendável > 5 (8 e 30 sim; 3 e 5 não)", ids.includes(c8) && ids.includes(c30) && !ids.includes(c3) && !ids.includes(c5), JSON.stringify(ids.length));
  check("4.2 20 em estoque mas 18 reservados (2 vendáveis) NÃO é promovido", !ids.includes(cRes));

  // ── 5. mídia paga avisa
  E.saveSettings(orgId, { online: { taxPercent: 6, paymentFeePercent: 3, paymentFeeFixed: 0, packagingFixed: 9 } });
  const planOk = PM.plan(orgId, { productId: ok, minProfitPerSale: 10 }) as any;
  const planLow = PM.plan(orgId, { productId: viaPost, minProfitPerSale: 10 }) as any;
  const planOut = PM.plan(orgId, { productId: esgotado, minProfitPerSale: 10 }) as any;
  const planNoCtl = PM.plan(orgId, { productId: semControle, minProfitPerSale: 10 }) as any;
  check("5.1 mídia paga: produto ok → sem aviso, estado informado", planOk.stock.state === "ok" && !planOk.warnings);
  check("5.2 baixo → avisa com as unidades, sem bloquear a conta", planLow.stock.state === "low" && /Restam só 1/.test(planLow.warnings[0]) && planLow.viable === true);
  check("5.3 esgotado → avisa para não impulsionar", planOut.stock.state === "out" && /esgotado/.test(planOut.warnings[0]) && planOut.viable === true);
  check("5.4 sem controle de estoque → 'unknown', sem aviso", planNoCtl.stock.state === "unknown" && !planNoCtl.warnings);

  // ── 6. Motor de Crescimento mostra
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'instagram', 'Instagram @t', 'ig-1', 'connected', 'x')`).run(randomUUID(), orgId);
  const ov = await GE.overview(orgId) as any;
  check("6.1 Radar do Motor lista os avisos de estoque abertos (produto, estado, unidades)", ov.radar.available && ov.radar.stockAlerts.length >= 1 && ov.radar.stockAlerts.every((a: any) => a.product && ["low", "out"].includes(a.state)), JSON.stringify(ov.radar.stockAlerts));
  check("6.2 aviso resolvido/dispensado some do Motor", !ov.radar.stockAlerts.some((a: any) => a.product === "Camisa Baixo") && !ov.radar.stockAlerts.some((a: any) => a.product === "Camisa Esgotada"));

  // ── 7. rotas
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), atendente = mkUser(orgId, "Ana", "agent"), donoOutro = mkUser(other, "Ze", "owner");
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/social", social);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (uid: string, method: string, p2: string) => { const rr = await fetch(`http://127.0.0.1:${port}/api/social${p2}`, { method, headers: { "x-uid": uid } }); return { status: rr.status, body: await rr.json().catch(() => ({})) as any }; };
  const g = await call(dono, "GET", "/campaign-stock");
  check("7.1 dono vê produtos em campanha, do mais crítico ao menos", g.status === 200 && g.body.lowThreshold === 5 && g.body.items.length >= 3 && g.body.items[0].state === "out");
  check("7.2 'ok' e 'unknown' vêm depois dos críticos", (() => { const order = g.body.items.map((i: any) => i.state); return order.lastIndexOf("out") < order.indexOf("ok") || order.indexOf("ok") === -1; })());
  check("7.3 dono roda o scan pela rota", (await call(dono, "POST", "/campaign-stock/scan")).body.checked >= 1);
  check("7.4 atendente barrado nas duas rotas", (await call(atendente, "GET", "/campaign-stock")).status === 403 && (await call(atendente, "POST", "/campaign-stock/scan")).status === 403);
  check("7.5 outra empresa só vê o que é dela (nada em campanha)", (await call(donoOutro, "GET", "/campaign-stock")).body.items.length === 0);
  server.close();

  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.ok ? "" : "  → " + x.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
