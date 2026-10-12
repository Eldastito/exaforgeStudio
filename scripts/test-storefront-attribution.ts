/**
 * TESTE — Atribuição social → Loja Virtual (ADR-207 F1). Sobe o router público REAL.
 * Prova: sanitização (entrada pública não confiável) · 0-regressão sem parâmetros · visita e pedido gravam a origem ·
 * o lead só é ligado ao conteúdo com contato válido DA PRÓPRIA org (token) · funil derivado (fato pago ≠ aguardando,
 * conversão null sem visitas, margem null sem custo) · isolamento entre empresas · helpers do navegador (TTL) · fiação.
 * Uso: npm run test:storefront-attribution
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-attr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-store-attr-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const { StorefrontAttributionService: SVC } = await import("../src/server/StorefrontAttributionService.js");
  const { ContentLeadAttributionService: LEAD } = await import("../src/server/ContentLeadAttributionService.js");
  const H = await import("../src/storefront/attribution.js");

  // ── sanitize ──
  check("sanitize: canal conhecido normaliza caixa", SVC.sanitize({ source: " Instagram " })?.source === "instagram");
  check("sanitize: canal desconhecido vira 'other' (sem explodir cardinalidade)", SVC.sanitize({ source: "meu-canal-x" })?.source === "other");
  check("sanitize: caracteres perigosos descartados", SVC.sanitize({ campaign: "a b<script>", content: "x'; DROP", ref: "ok:1" })?.campaign === null && SVC.sanitize({ campaign: "a b<script>", content: "x'; DROP", ref: "ok:1" })?.content === null);
  check("sanitize: fio válido é mantido", SVC.sanitize({ ref: "campaign:abc-123" })?.ref === "campaign:abc-123");
  check("sanitize: tamanho limitado", (SVC.sanitize({ campaign: "a".repeat(500) })?.campaign || "").length === 60);
  check("sanitize: nada válido → null", SVC.sanitize({ campaign: "<>" }) === null && SVC.sanitize(null) === null && SVC.sanitize("x") === null && SVC.sanitize({}) === null);
  check("sanitize: valores não-string ignorados", SVC.sanitize({ source: 5, campaign: { a: 1 } }) === null);

  // ── ambiente: 2 empresas ──
  const mkOrg = (slug: string) => {
    const orgId = randomUUID(), productId = randomUUID(), chan = randomUUID(), contact = randomUUID();
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgId, slug);
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, 'Loja')`).run(orgId, slug);
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa', 100, 1)`).run(productId, orgId);
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'C', 'evolution_go', 'x', 'active')`).run(chan, orgId);
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Maria', '5511')`).run(contact, orgId, chan);
    const t = randomUUID(); db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status) VALUES (?, ?, ?, 'open')`).run(t, orgId, contact);
    const tok = "tok_" + randomUUID().replace(/-/g, "").slice(0, 16);
    db.prepare(`INSERT INTO storefront_links (token, organization_id, contact_id, ticket_id) VALUES (?, ?, ?, ?)`).run(tok, orgId, contact, t);
    return { orgId, productId, contact, tok, slug };
  };
  const A = mkOrg("toulon-a"), B = mkOrg("outra-b");

  const app = express(); app.use(express.json()); app.use("/api/public", storefrontPublic);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/public/store`;
  const post = (slug: string, p: string, body: any) => fetch(`${base}/${slug}/${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const buy = async (o: typeof A, extra: any = {}, withToken = true) => {
    const r = await post(o.slug, "order", { ...(withToken ? { token: o.tok } : {}), customer: { name: "Maria", phone: "5511" }, items: [{ productId: o.productId, quantity: 1, option: null }], ...extra });
    return (await r.json().catch(() => ({}))) as any;
  };
  const ordRow = (id: string) => db.prepare(`SELECT attr_source s, attr_campaign c, attr_content ct, attr_ref r, status FROM orders WHERE id = ?`).get(id) as any;

  // ── visita: sem atribuição = igual a antes; com = gravada ──
  await post(A.slug, "event", { type: "view" });
  await post(A.slug, "event", { type: "view", attribution: { source: "instagram", campaign: "linen_out26", content: "reel_143", ref: "campaign:linen" } });
  await post(A.slug, "event", { type: "view", attribution: { source: "instagram", campaign: "linen_out26", content: "reel_143", ref: "campaign:linen" } });
  await post(A.slug, "event", { type: "product_click", productId: A.productId, attribution: { source: "instagram", campaign: "linen_out26", content: "reel_143" } });
  const evPlain = db.prepare(`SELECT attr_source FROM storefront_events WHERE organization_id = ? AND type='view' AND attr_source IS NULL`).all(A.orgId) as any[];
  check("visita sem atribuição: gravada como sempre (colunas nulas)", evPlain.length === 1);
  const evAttr = db.prepare(`SELECT COUNT(*) n FROM storefront_events WHERE organization_id = ? AND attr_source = 'instagram' AND attr_campaign = 'linen_out26'`).get(A.orgId) as any;
  check("visita/clique com atribuição: gravados com a origem", evAttr.n === 3);
  await post(A.slug, "event", { type: "view", attribution: { source: "<img>", campaign: "x y" } });
  check("atribuição inválida na visita: grava a visita SEM origem (nunca lixo)", (db.prepare(`SELECT COUNT(*) n FROM storefront_events WHERE organization_id = ? AND type='view' AND attr_source IS NULL`).get(A.orgId) as any).n === 2);

  // ── pedido ──
  const o0 = await buy(A);
  check("pedido sem atribuição: cria como sempre, sem origem e sem lead", !!o0.orderId && ordRow(o0.orderId).s === null && LEAD.leadCount(A.orgId, "campaign:linen") === 0);
  const attr = { source: "instagram", campaign: "linen_out26", content: "reel_143", ref: "campaign:linen" };
  const o1 = await buy(A, { attribution: attr });
  const r1 = ordRow(o1.orderId);
  check("pedido com atribuição: origem gravada", r1.s === "instagram" && r1.c === "linen_out26" && r1.ct === "reel_143" && r1.r === "campaign:linen");
  check("contato do token ligado ao conteúdo (lead) uma vez", LEAD.leadCount(A.orgId, "campaign:linen") === 1 && LEAD.leadsFor(A.orgId, "campaign:linen")[0].contactId === A.contact);
  const o2 = await buy(A, { attribution: attr });
  check("2º pedido do mesmo contato: não duplica o lead (idempotente)", LEAD.leadCount(A.orgId, "campaign:linen") === 1 && !!o2.orderId);
  const o3 = await buy(A, { attribution: { source: "tiktok", campaign: "x", ref: "campaign:anon" } }, false);
  check("pedido anônimo (sem token): origem gravada, mas NENHUM lead inventado", ordRow(o3.orderId).s === "tiktok" && LEAD.leadCount(A.orgId, "campaign:anon") === 0);
  const o4 = await buy(A, { token: B.tok, attribution: { source: "instagram", ref: "campaign:cross" } }, false);
  const o4b = await post(A.slug, "order", { token: B.tok, customer: { name: "x", phone: "1" }, items: [{ productId: A.productId, quantity: 1 }], attribution: { source: "instagram", ref: "campaign:cross" } }).then((r) => r.json()) as any;
  check("token de OUTRA empresa na loja A: nenhum lead em A nem em B", LEAD.leadCount(A.orgId, "campaign:cross") === 0 && LEAD.leadCount(B.orgId, "campaign:cross") === 0 && !!o4b.orderId && !!o4);
  const o5 = await buy(A, { attribution: { source: "instagram", campaign: "bad campaign!", ref: "ok:5" } });
  check("pedido com campo inválido: ignora só o campo ruim", ordRow(o5.orderId).s === "instagram" && ordRow(o5.orderId).c === null && ordRow(o5.orderId).r === "ok:5");
  const before = (db.prepare(`SELECT COUNT(*) n FROM orders WHERE organization_id = ?`).get(A.orgId) as any).n;
  const bad = await post(A.slug, "order", { items: [], attribution: attr });
  check("carrinho vazio continua recusado (fluxo antigo intacto)", bad.status === 400 && (db.prepare(`SELECT COUNT(*) n FROM orders WHERE organization_id = ?`).get(A.orgId) as any).n === before);

  // ── funil ──
  db.prepare(`UPDATE orders SET status='pago', payment_status='paid' WHERE id = ?`).run(o1.orderId);          // pago (fato)
  db.prepare(`UPDATE order_items SET unit_cost = 40 WHERE order_id = ?`).run(o1.orderId);                      // custo conhecido
  const f = SVC.funnel(A.orgId, { days: 30 });
  const row = f.attributed.find((r) => r.source === "instagram" && r.campaign === "linen_out26")!;
  check("funil: visitas e cliques da campanha", row.views === 2 && row.productClicks === 1);
  check("funil: pedidos da campanha (pago × aguardando separados)", row.orders === 2 && row.paidOrders === 1 && row.awaitingOrders === 1);
  check("funil: receita = só o pago (fato); aguardando à parte, nunca somado", row.revenuePaid === 100 && row.revenueAwaiting === 100);
  check("funil: conversão = pagos / visitas", row.conversionPct === 50);
  check("funil: margem do pago só com custo conhecido (fato)", row.marginPaid === 60);
  db.prepare(`UPDATE orders SET status='pago', payment_status='paid' WHERE id = ?`).run(o5.orderId);
  const f2 = SVC.funnel(A.orgId, { days: 30 });
  const rNoCost = f2.attributed.find((r) => r.source === "instagram" && r.campaign === null)!;
  check("funil: pago SEM custo conhecido → margem null (não inventa lucro)", rNoCost.paidOrders === 1 && rNoCost.marginPaid === null);
  const rNoViews = f2.attributed.find((r) => r.source === "tiktok")!;
  check("funil: origem sem visitas → conversão null (nunca 0%)", rNoViews.views === 0 && rNoViews.conversionPct === null);
  check("funil: pedido sem origem fica à parte (unattributed), com o aviso de que é declarado", !!f2.unattributed && f2.unattributed.orders >= 1 && /declarad/i.test(f2.note) && f2.basis === "declared_by_link");
  check("funil: isolamento — empresa B não vê nada da A", SVC.funnel(B.orgId).attributed.length === 0 && (SVC.funnel(B.orgId).unattributed?.orders ?? 0) === 0);
  check("funil: cancelado não conta", (() => { db.prepare(`UPDATE orders SET status='cancelado' WHERE id = ?`).run(o2.orderId); const x = SVC.funnel(A.orgId).attributed.find((r) => r.campaign === "linen_out26")!; return x.orders === 1; })());
  check("funil: janela de dias limitada (1..365)", SVC.funnel(A.orgId, { days: 99999 }).days === 365 && SVC.funnel(A.orgId, { days: 0 }).days === 30 && SVC.funnel(A.orgId, { days: -5 }).days === 1);

  // ── helpers do navegador ──
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
  const NOW = 1_700_000_000_000;
  check("navegador: lê zf_* da URL", H.parseAttributionParams("?zf_source=instagram&zf_campaign=c1&zf_content=r1&zf_ref=campaign:1&c=tok")?.campaign === "c1");
  check("navegador: URL sem zf_* → null", H.parseAttributionParams("?c=tok") === null && H.parseAttributionParams("") === null);
  const st = mem();
  H.resolveAttribution("?zf_source=instagram&zf_campaign=c1", st, NOW);
  check("navegador: guarda e reaproveita na página seguinte (sem zf_* na URL)", H.resolveAttribution("", st, NOW + 60_000)?.campaign === "c1");
  check("navegador: expira em 7 dias", H.resolveAttribution("", st, NOW + H.ATTRIBUTION_TTL_MS + 1) === null);
  check("navegador: novo link sobrescreve o guardado", (() => { H.resolveAttribution("?zf_source=facebook&zf_campaign=c2", st, NOW + 120_000); return H.resolveAttribution("", st, NOW + 130_000)?.source === "facebook"; })());
  check("navegador: storage ausente/corrompido nunca lança", H.resolveAttribution("", null, NOW) === null && (() => { const b = mem(); b.setItem(H.ATTRIBUTION_KEY, "{lixo"); return H.resolveAttribution("", b, NOW) === null; })() && H.resolveAttribution("?zf_source=x", { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } }, NOW)?.source === "x");
  check("navegador: relógio voltou (futuro) → ignora", (() => { const b = mem(); H.resolveAttribution("?zf_source=x", b, NOW); return H.resolveAttribution("", b, NOW - 1000) === null; })());

  // ── fiação ──
  const sf = read("src/storefront/Storefront.tsx"), pub = read("src/server/routes/storefrontPublic.ts"), priv = read("src/server/routes/storefront.ts"), dbs = read("src/server/db.ts");
  check("vitrine manda a atribuição na visita e no pedido", /attribution: currentAttribution\(\) \?\? undefined/.test(sf) && (sf.match(/currentAttribution\(\)/g) || []).length >= 3);
  check("rota do funil é só dono/administrador", /router\.get\("\/attribution", requireRole\("owner", "admin"\)/.test(priv));
  check("atribuição do pedido é best-effort (try/catch) e depois da transação", /tx\(\);\s*\n\s*\/\/ ADR-207 F1[\s\S]{0,300}try \{ StorefrontAttributionService\.attachToOrder/.test(pub));
  check("o contato do lead vem do token (contactId), nunca do body", /attachToOrder\(orgId, orderId, StorefrontAttributionService\.sanitize\(body\.attribution\), contactId\)/.test(pub) && !/body\.contactId/.test(pub));
  check("migração é aditiva (só ALTER ADD COLUMN / CREATE INDEX IF NOT EXISTS)", /ADR-207 F1[\s\S]*attr_ref TEXT/.test(dbs) && !/DROP TABLE/.test(dbs.slice(dbs.indexOf("ADR-207 F1"))));
  check("slug da loja não é alterado pela atribuição", !/UPDATE storefront_settings SET slug/.test(read("src/server/StorefrontAttributionService.ts")));

  server.close();
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
