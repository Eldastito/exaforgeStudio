/**
 * TESTE — Link curto de campanha + vitrine "Visto no Instagram" (ADR-207 F5).
 *
 * Prova, com o handler de redirecionamento, a vitrine pública e as rotas do dono REAIS:
 *  - o código curto redireciona (302) para a vitrine/produto COM a atribuição da F1, e o funil da F1 enxerga
 *    a visita e o pedido que vierem por ele (ponta a ponta);
 *  - código inválido/arquivado/de outra loja cai na vitrine SEM atribuição (nunca 404 pro cliente, sem vazar);
 *  - o destino é sempre caminho interno da própria loja; produto sumido/inativo não quebra o link;
 *  - o gerador normaliza o que o dono digita ("Promo Verão" → promo-verao) e recusa o que não faz sentido;
 *  - "Visto no Instagram" só mostra produto de link Instagram marcado e hoje visível na vitrine;
 *  - rotas do dono: só dono/admin; isolamento por empresa; limite de links ativos.
 *
 * Uso: npm run test:storefront-short-links
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-short-links-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-short-links-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const storefrontAdmin = (await import("../src/server/routes/storefront.js")).default;
  const { storefrontGoHandler } = await import("../src/server/routes/storefrontGo.js");
  const { StorefrontShortLinkService: L } = await import("../src/server/StorefrontShortLinkService.js");
  const { StorefrontAttributionService: A } = await import("../src/server/StorefrontAttributionService.js");
  const { parseAttributionParams } = await import("../src/storefront/attribution.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");

  const orgId = randomUUID(), otherOrg = randomUUID();
  for (const [id, slug] of [[orgId, "toulon"], [otherOrg, "outra"]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug.toUpperCase());
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, ?)`).run(id, slug, `Loja ${slug}`);
  }
  const mkProduct = (org: string, name: string, extra: { active?: number; visible?: number } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, storefront_visible) VALUES (?, ?, ?, 'product', 100, ?, ?)`).run(id, org, name, extra.active ?? 1, extra.visible ?? 1);
    return id;
  };
  const camisa = mkProduct(orgId, "Camisa Polo"), vestido = mkProduct(orgId, "Vestido Floral"), oculto = mkProduct(orgId, "Peça Oculta", { visible: 0 }), inativo = mkProduct(orgId, "Peça Inativa", { active: 0 });
  const produtoOutra = mkProduct(otherOrg, "Produto de Outra");

  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), atendente = mkUser(orgId, "Ana", "agent"), donoOutra = mkUser(otherOrg, "Ze", "owner");

  const app = express(); app.use(express.json());
  app.use("/api/public", storefrontPublic);
  app.get("/loja/:slug/go/:code", storefrontGoHandler);
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/storefront", storefrontAdmin);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const base = `http://127.0.0.1:${port}`;
  const go = async (slug: string, code: string) => { const r = await fetch(`${base}/loja/${slug}/go/${code}`, { redirect: "manual" }); return { status: r.status, loc: r.headers.get("location") || "", cache: r.headers.get("cache-control") || "" }; };
  const admin = async (uid: string, method: string, p: string, body?: any) => {
    const r = await fetch(`${base}/api/storefront${p}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };

  // ── 1. Gerador ────────────────────────────────────────────────────────────
  let err = ""; try { L.create(orgId, { campaign: "x" }); } catch (e: any) { err = e.message; }
  check("1.1 sem origem não gera link", /de onde/i.test(err));
  const l1 = L.create(orgId, { source: "instagram", campaign: "Promo Verão!", content: "Reels 1", label: "Bio do Instagram" }, dono);
  check("1.2 código de 7 letras/números legíveis", /^[abcdefghjkmnpqrstuvwxyz23456789]{7}$/.test(l1.code));
  check("1.3 'Promo Verão!' vira 'promo-verao' (não some em silêncio) e 'Reels 1' vira 'reels-1'", l1.campaign === "promo-verao" && l1.content === "reels-1" && l1.source === "instagram");
  check("1.4 origem desconhecida vira 'other' (mesma regra da F1)", L.create(orgId, { source: "pombo-correio" }).source === "other");
  err = ""; try { L.create(orgId, { source: "instagram", productId: produtoOutra }); } catch (e: any) { err = e.message; }
  check("1.5 produto de OUTRA empresa é recusado", /produto/i.test(err));
  err = ""; try { L.create(orgId, { source: "instagram", productId: inativo }); } catch (e: any) { err = e.message; }
  check("1.6 produto inativo é recusado", /produto/i.test(err));
  const codes = new Set(Array.from({ length: 40 }, () => L.create(orgId, { source: "whatsapp", campaign: "lote" }).code));
  check("1.7 códigos não repetem", codes.size === 40);

  // ── 2. Redirecionamento + atribuição ponta a ponta ────────────────────────
  const r1 = await go("toulon", l1.code);
  const u1 = new URL(r1.loc, "http://x");
  check("2.1 302 para a vitrine com a atribuição da F1", r1.status === 302 && u1.pathname === "/loja/toulon" && u1.searchParams.get("zf_source") === "instagram" && u1.searchParams.get("zf_campaign") === "promo-verao" && u1.searchParams.get("zf_content") === "reels-1", r1.loc);
  check("2.2 sem cache (destino pode mudar)", /no-store/.test(r1.cache));
  check("2.3 código em MAIÚSCULAS também funciona (digitado à mão)", (await go("toulon", l1.code.toUpperCase())).loc === r1.loc);
  const parsed = parseAttributionParams(u1.search);
  check("2.4 o parser da vitrine (F1) lê exatamente o que o link entrega", parsed?.source === "instagram" && parsed?.campaign === "promo-verao" && parsed?.content === "reels-1");

  const pLink = L.create(orgId, { source: "instagram", campaign: "lancamento", ref: "campaign:abc", productId: camisa });
  const rp = await go("toulon", pLink.code);
  const up = new URL(rp.loc, "http://x");
  check("2.5 link de produto vai direto ao produto (slug resolvido no clique) + fio zf_ref", rp.status === 302 && /^\/loja\/toulon\/produto\/camisa-polo/.test(up.pathname) && up.searchParams.get("zf_ref") === "campaign:abc", rp.loc);

  // visita pelo link → funil da F1 + números do link
  const ev = await fetch(`${base}/api/public/store/toulon/event`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "view", attribution: parseAttributionParams(u1.search) }) });
  check("2.6 visita com a atribuição do link é aceita", ev.status === 204);
  const order = await fetch(`${base}/api/public/store/toulon/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ productId: camisa, quantity: 1 }], customer: { name: "Maria" }, attribution: parseAttributionParams(u1.search) }) });
  const oj = await order.json() as any;
  OrdersService.updateStatus(orgId, oj.orderId, "pago");
  const mine = L.list(orgId).find((x) => x.id === l1.id)!;
  check("2.7 o número do link vem do funil da F1: 1 visita, 1 pedido pago (fato)", mine.results?.views === 1 && mine.results?.paidOrders === 1 && mine.results?.revenuePaid === 100, JSON.stringify(mine.results));
  check("2.8 link sem nenhum acesso: results nulo (não inventa zero)", L.list(orgId).find((x) => x.id === pLink.id)!.results === null);

  // ── 3. Códigos ruins nunca viram 404 nem vazam ─────────────────────────────
  const bad = await go("toulon", "zzzzzzz");
  check("3.1 código inexistente → vitrine pura, SEM atribuição", bad.status === 302 && bad.loc === "/loja/toulon");
  L.archive(orgId, l1.id);
  const arch = await go("toulon", l1.code);
  check("3.2 link arquivado → vitrine pura (igual a inexistente: não vaza)", arch.status === 302 && arch.loc === "/loja/toulon" && arch.loc === bad.loc);
  const otherLink = L.create(otherOrg, { source: "instagram", campaign: "outra" });
  check("3.3 código de OUTRA loja usado nesta vitrine → vitrine pura", (await go("toulon", otherLink.code)).loc === "/loja/toulon");
  check("3.4 loja inexistente → 404 normal", (await go("nao-existe", l1.code)).status === 404);
  db.prepare("UPDATE products_services SET active = 0 WHERE id = ?").run(camisa);
  const gone = await go("toulon", pLink.code);
  const ug = new URL(gone.loc, "http://x");
  check("3.5 produto desativado depois: link não quebra — vai à vitrine, mantém a atribuição", gone.status === 302 && ug.pathname === "/loja/toulon" && ug.searchParams.get("zf_campaign") === "lancamento");
  db.prepare("UPDATE products_services SET active = 1 WHERE id = ?").run(camisa);
  const weird = ["..%2F..%2Fetc", "%2F%2Fevil.com", "a%0d%0aSet-Cookie:x", "javascript:alert(1)", "%5C%5Cevil.com", "x".repeat(300)];
  const locs: string[] = [];
  for (const w of weird) { const r = await go("toulon", w); locs.push(r.loc); }
  check("3.6 destino é SEMPRE caminho interno da loja (sem open-redirect/injeção de cabeçalho)", locs.every((l) => l.startsWith("/loja/toulon")), JSON.stringify(locs));

  // ── 4. "Visto no Instagram" ────────────────────────────────────────────────
  const shelfOf = async () => ((await (await fetch(`${base}/api/public/store/toulon`)).json()) as any).collections?.find((c: any) => c.title === "Visto no Instagram") || null;
  check("4.1 sem link marcado, a prateleira não existe", (await shelfOf()) === null);
  err = ""; try { L.create(orgId, { source: "whatsapp", productId: vestido, featured: true }); } catch (e: any) { err = e.message; }
  check("4.2 prateleira só aceita link do INSTAGRAM", /Instagram/.test(err));
  err = ""; try { L.create(orgId, { source: "instagram", featured: true }); } catch (e: any) { err = e.message; }
  check("4.3 prateleira exige um PRODUTO", /produto/i.test(err));
  const fv = L.create(orgId, { source: "instagram", campaign: "post-vestido", productId: vestido, featured: true });
  const fc = L.create(orgId, { source: "instagram", campaign: "post-camisa", productId: camisa, featured: true });
  const sh1 = await shelfOf();
  check("4.4 produtos dos links marcados aparecem, mais recente primeiro", !!sh1 && sh1.productIds.length === 2 && sh1.productIds[0] === camisa && sh1.productIds[1] === vestido, JSON.stringify(sh1));
  const full = (await (await fetch(`${base}/api/public/store/toulon`)).json()) as any;
  check("4.5 a prateleira é a 1ª coleção da vitrine", full.collections[0].title === "Visto no Instagram");
  db.prepare("UPDATE products_services SET storefront_visible = 0 WHERE id = ?").run(vestido);
  check("4.6 produto escondido da vitrine some da prateleira", (await shelfOf())?.productIds.join() === camisa);
  db.prepare("UPDATE products_services SET storefront_visible = 1, active = 0 WHERE id = ?").run(camisa);
  db.prepare("UPDATE products_services SET active = 1 WHERE id = ?").run(camisa);
  const ho = L.create(orgId, { source: "instagram", productId: oculto, featured: true });
  check("4.7 produto oculto marcado nunca aparece", !((await shelfOf())?.productIds || []).includes(oculto) && !!ho.id);
  L.archive(orgId, fc.id);
  check("4.8 arquivar o link tira o produto da prateleira", !((await shelfOf())?.productIds || []).includes(camisa));
  L.setFeatured(orgId, fv.id, false);
  check("4.9 desmarcar esvazia a prateleira (some, não fica vazia)", (await shelfOf()) === null);
  err = ""; try { L.setFeatured(orgId, pLink.id === fv.id ? "" : L.create(orgId, { source: "email", productId: vestido }).id, true); } catch (e: any) { err = e.message; }
  check("4.10 não dá pra marcar link que não é do Instagram", /Instagram/.test(err));
  for (let i = 0; i < 15; i++) { const pid = mkProduct(orgId, `Produto ${i}`); L.create(orgId, { source: "instagram", productId: pid, featured: true }); }
  check("4.11 prateleira limitada a 12 produtos", (await shelfOf())?.productIds.length === 12);

  // ── 5. Rotas do dono ───────────────────────────────────────────────────────
  const created = await admin(dono, "POST", "/short-links", { source: "instagram", campaign: "Dia das Mães", productId: vestido });
  check("5.1 dono cria link (201) já normalizado", created.status === 201 && created.json.campaign === "dia-das-maes" && !!created.json.code, JSON.stringify(created.json));
  check("5.2 dono lista com o slug da loja", (await admin(dono, "GET", "/short-links")).json.slug === "toulon" && (await admin(dono, "GET", "/short-links")).json.links.some((x: any) => x.id === created.json.id));
  check("5.3 atendente NÃO cria (403)", (await admin(atendente, "POST", "/short-links", { source: "instagram" })).status === 403);
  check("5.4 atendente NÃO lista (403) — a lista traz receita", (await admin(atendente, "GET", "/short-links")).status === 403);
  check("5.5 dados inválidos → 400", (await admin(dono, "POST", "/short-links", { campaign: "sem origem" })).status === 400);
  check("5.6 dono de OUTRA empresa não vê o link", !(await admin(donoOutra, "GET", "/short-links")).json.links.some((x: any) => x.id === created.json.id));
  const cross = await admin(donoOutra, "POST", `/short-links/${created.json.id}/archive`);
  check("5.7 dono de OUTRA empresa não arquiva (404) e o link segue ativo", cross.status === 404 && (db.prepare("SELECT active a FROM storefront_short_links WHERE id = ?").get(created.json.id) as any).a === 1);
  check("5.8 dono arquiva", (await admin(dono, "POST", `/short-links/${created.json.id}/archive`)).status === 200 && (db.prepare("SELECT active a FROM storefront_short_links WHERE id = ?").get(created.json.id) as any).a === 0);
  check("5.9 arquivado não é apagado (histórico preservado)", !!db.prepare("SELECT 1 FROM storefront_short_links WHERE id = ?").get(created.json.id));
  check("5.10 featured via rota exige Instagram+produto (400)", (await admin(dono, "PUT", `/short-links/${L.create(orgId, { source: "email" }).id}/featured`, { featured: true })).status === 400);

  // ── 6. Limite de links ativos ─────────────────────────────────────────────
  const have = (db.prepare("SELECT COUNT(*) c FROM storefront_short_links WHERE organization_id = ? AND active = 1").get(orgId) as any).c as number;
  const ins = db.prepare("INSERT INTO storefront_short_links (id, organization_id, code, source) VALUES (?, ?, ?, 'email')");
  for (let i = 0; i < 300 - have; i++) ins.run(randomUUID(), orgId, `fill${String(i).padStart(4, "0")}`);
  err = ""; try { L.create(orgId, { source: "instagram" }); } catch (e: any) { err = e.message; }
  check("6.1 no limite de 300 links ativos, novo link é recusado", /Limite/.test(err));
  L.archive(orgId, (db.prepare("SELECT id FROM storefront_short_links WHERE organization_id = ? AND active = 1 LIMIT 1").get(orgId) as any).id);
  check("6.2 arquivar libera espaço", !!L.create(orgId, { source: "instagram" }).id);
  check("6.3 a outra empresa não é afetada pelo limite desta", !!L.create(otherOrg, { source: "instagram" }).id);

  server.close();
  console.log("\n=== Link curto de campanha + 'Visto no Instagram' (ADR-207 F5) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
