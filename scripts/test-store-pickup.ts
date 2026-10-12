/**
 * TESTE — Retirada na loja com reserva atômica + validade (ADR-207 F3).
 *
 * Sobe o router público REAL e prova, via HTTP + service:
 *  - tudo desligado por padrão (0-regressão): sem flag não há opção nem pedido de retirada;
 *  - a retirada SÓ é oferecida quando dá pra reservar: sem pool de reserva da peça na loja,
 *    a loja não aparece como possível e o pedido é recusado SEM criar pedido;
 *  - reserva atômica: não vende acima do pool, 2ª compra que não cabe leva 409 sem pedido;
 *  - peso/volume (sem reserva) nunca vira retirada; loja de outra empresa é recusada;
 *  - validade: reserva vencida de pedido NÃO pago cancela e devolve a peça ao pool;
 *    pedido pago nunca expira; isolamento por empresa; não toca `inventory_items` de outro pedido;
 *  - pedido de entrega (sem retirada) segue idêntico ao de sempre.
 *
 * Uso: npm run test:store-pickup
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-pickup-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-store-pickup-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService: R } = await import("../src/server/RetailOnlineReserveService.js");
  const { StorePickupService: P } = await import("../src/server/StorePickupService.js");

  const orgId = randomUUID(), otherOrg = randomUUID();
  const mkOrg = (id: string, slug: string) => {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug.toUpperCase());
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, ?)`).run(id, slug, `Loja ${slug}`);
  };
  mkOrg(orgId, "toulon"); mkOrg(otherOrg, "outra");
  db.prepare("UPDATE storefront_settings SET whatsapp_number = '5511999990000' WHERE organization_id = ?").run(orgId);
  const mkProduct = (org: string, name: string, extra = "") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active${extra ? ", sale_mode" : ""}) VALUES (?, ?, ?, 'product', 100, 1${extra ? ", ?" : ""})`)
      .run(...([id, org, name].concat(extra ? [extra] : [])));
    return id;
  };
  const camisa = mkProduct(orgId, "Camisa Polo");
  const calca = mkProduct(orgId, "Calça");
  const granel = mkProduct(orgId, "Granel", "weight");
  const s1 = RetailStoreService.create(orgId, { name: "Toulon 1079", code: "10" });
  const s2 = RetailStoreService.create(orgId, { name: "Toulon Centro", code: "20" });
  const foreignStore = RetailStoreService.create(otherOrg, { name: "Loja de Outro", code: "99" });

  const app = express();
  app.use(express.json());
  app.use("/api/public", storefrontPublic);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/public/store`;
  const j = async (url: string, body?: any, slug = "toulon") => {
    const r = await fetch(`${base}/${slug}${url}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const ordersCount = () => (db.prepare("SELECT COUNT(*) c FROM orders WHERE organization_id=?").get(orgId) as any).c as number;
  const pending = (store: string, prod = camisa) => R.pendingQty(orgId, store, prod, null);
  const pickupOrder = (qty: number, storeId = s1.id, product = camisa, extra: any = {}) =>
    j("/order", { items: [{ productId: product, quantity: qty, ...(extra.option ? { option: extra.option } : {}) }], fulfillment: "pickup", pickupStoreId: storeId });
  const cart = (qty: number, product = camisa) => [{ productId: product, quantity: qty }];

  // ── 1. Padrão: tudo desligado ───────────────────────────────────────────────
  const g0 = await j("/pickup");
  check("1.1 padrão: retirada desligada na vitrine", g0.status === 200 && g0.json.enabled === false);
  const c0 = await j("/pickup/check", { items: cart(1) });
  check("1.2 padrão: check não oferece loja", c0.json.enabled === false && (c0.json.stores || []).length === 0);
  const before0 = ordersCount();
  const o0 = await pickupOrder(1);
  check("1.3 padrão: pedido de retirada é recusado (409) e NÃO cria pedido", o0.status === 409 && o0.json.code === "pickup_unavailable" && ordersCount() === before0, JSON.stringify(o0.json));

  // ── 2. Flag da empresa sem reserva online → ainda não oferece ─────────────
  P.setSettings(orgId, { enabled: true });
  P.setStore(orgId, s1.id, true);
  check("2.1 flag ligada MAS reserva online desligada → não oferecível", P.settings(orgId).offerable === false);
  check("2.2 vitrine continua sem retirada", (await j("/pickup")).json.enabled === false);

  // ── 3. Tudo ligado, mas SEM pool de reserva da peça → loja não é opção ─────
  R.setEnabled(orgId, true);
  check("3.1 flag + reserva online → oferecível", P.settings(orgId).offerable === true && (await j("/pickup")).json.enabled === true);
  const c3 = await j("/pickup/check", { items: cart(1) });
  check("3.2 loja liberada mas sem pool da peça → aparece, porém canFulfill=false",
    c3.json.stores?.length === 1 && c3.json.stores[0].id === s1.id && c3.json.stores[0].canFulfill === false, JSON.stringify(c3.json));
  const before3 = ordersCount();
  const o3 = await pickupOrder(1);
  check("3.3 pedido sem pool: 409 sem_estoque_na_loja e NENHUM pedido criado", o3.status === 409 && o3.json.reason === "sem_estoque_na_loja" && ordersCount() === before3, JSON.stringify(o3.json));
  check("3.4 nenhuma baixa pendente foi registrada", pending(s1.id) === 0);

  // ── 4. Loja não liberada para retirada não aparece ────────────────────────
  R.setReserve(orgId, s2.id, camisa, null, 5);
  check("4.1 loja 2 com pool mas sem retirada liberada → não aparece", !(await j("/pickup/check", { items: cart(1) })).json.stores.some((s: any) => s.id === s2.id));
  const o4 = await pickupOrder(1, s2.id);
  check("4.2 pedido numa loja não liberada: 409 loja_invalida", o4.status === 409 && o4.json.reason === "loja_invalida", JSON.stringify(o4.json));

  // ── 5. Pool definido → oferece e reserva ──────────────────────────────────
  R.setReserve(orgId, s1.id, camisa, null, 3);
  const c5 = await j("/pickup/check", { items: cart(2) });
  check("5.1 pool 3, carrinho 2 → canFulfill", c5.json.stores[0]?.canFulfill === true);
  check("5.2 pool 3, carrinho 4 → canFulfill=false", (await j("/pickup/check", { items: cart(4) })).json.stores[0]?.canFulfill === false);
  check("5.3 a vitrine só recebe o necessário (sem pool/saldo/endereço de rede cru)", !("qty_reserved" in (c5.json.stores[0] || {})) && !("available" in (c5.json.stores[0] || {})));

  const a = await pickupOrder(2);
  check("5.4 retirada 2/3: sucesso", a.status === 200 && a.json.ok === true && a.json.pickup?.storeName === "Toulon 1079", JSON.stringify(a.json));
  const aRow = db.prepare("SELECT * FROM orders WHERE id=?").get(a.json.orderId) as any;
  check("5.5 pedido marcado como retirada na loja certa", aRow.fulfillment_method === "pickup" && aRow.pickup_store_id === s1.id && aRow.store_id === s1.id && aRow.status === "aguardando_pagamento");
  check("5.6 observação do pedido avisa 'RETIRADA NA LOJA'", String(aRow.notes || "").includes("RETIRADA NA LOJA: Toulon 1079"));
  const mins = (new Date(String(aRow.reserve_expires_at).replace(" ", "T") + "Z").getTime() - Date.now()) / 60000;
  check("5.7 validade da reserva = 120 min (padrão)", mins > 118 && mins < 122, `${mins}`);
  check("5.8 reserva registrada (2 pendentes) e pool cai p/ 1", pending(s1.id) === 2 && R.available(orgId, s1.id, camisa, null) === 1);
  check("5.9 whatsapp avisa a retirada", decodeURIComponent(String(a.json.whatsappUrl || "")).includes("Retirada na loja: Toulon 1079"));

  // ── 6. Anti-oversell ──────────────────────────────────────────────────────
  const n6 = ordersCount();
  const b = await pickupOrder(2);
  check("6.1 2ª compra que não cabe (2 com 1): 409 e sem pedido", b.status === 409 && b.json.code === "pickup_unavailable" && ordersCount() === n6, JSON.stringify(b.json));
  check("6.2 pendente segue 2", pending(s1.id) === 2);
  const [x, y] = await Promise.all([pickupOrder(1), pickupOrder(1)]);
  check("6.3 duas compras simultâneas p/ 1 peça: só uma passa", [x.status, y.status].sort().join(",") === "200,409", `${x.status},${y.status}`);
  check("6.4 pool zerado, nunca negativo", R.available(orgId, s1.id, camisa, null) === 0);

  // ── 7. Itens que não reservam / loja de outra empresa ─────────────────────
  const w = await j("/pickup/check", { items: [{ productId: granel, quantity: 1 }] });
  check("7.1 peso/volume: check diz item_sem_retirada", w.json.reason === "item_sem_retirada" && w.json.stores.length === 0, JSON.stringify(w.json));
  const n7 = ordersCount();
  const wo = await pickupOrder(1, s1.id, granel, { option: { type: "weight", grams: 500 } });
  check("7.2 pedido com peso/volume: 409 item_sem_retirada e sem pedido", wo.status === 409 && wo.json.reason === "item_sem_retirada" && ordersCount() === n7, JSON.stringify(wo.json));
  P.setSettings(otherOrg, { enabled: true });
  db.prepare("UPDATE retail_stores SET pickup_enabled = 1 WHERE id = ?").run(foreignStore.id);
  const fo = await pickupOrder(1, foreignStore.id);
  check("7.3 loja de OUTRA empresa é recusada (loja_invalida)", fo.status === 409 && fo.json.reason === "loja_invalida", JSON.stringify(fo.json));
  let threw = false; try { P.setStore(orgId, foreignStore.id, true); } catch { threw = true; }
  check("7.4 admin não consegue liberar retirada em loja de outra empresa", threw);

  // ── 8. Validade da reserva ────────────────────────────────────────────────
  R.setReserve(orgId, s1.id, calca, null, 4);
  // linha de OUTRO pedido reservada em inventory_items: a expiração não pode mexer nela.
  const ii = randomUUID();
  db.prepare("UPDATE products_services SET stock_control_enabled = 1 WHERE id = ?").run(calca);
  db.prepare("INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, NULL, 10, 5)").run(ii, orgId, calca);
  const e1 = await pickupOrder(3, s1.id, calca);
  check("8.1 retirada de calça 3/4 ok", e1.status === 200, JSON.stringify(e1.json));
  const e2 = await pickupOrder(3, s1.id, calca);
  check("8.2 2ª retirada de 3 não cabe enquanto a 1ª está viva", e2.status === 409);
  // paga outro pedido de retirada que também vence — pago nunca expira
  const paidRes = await pickupOrder(1, s1.id, calca);
  check("8.3 retirada de 1 que cabe", paidRes.status === 200);
  db.prepare("UPDATE orders SET status='pago' WHERE id=?").run(paidRes.json.orderId);
  db.prepare("UPDATE orders SET reserve_expires_at = datetime('now','-1 minute') WHERE id IN (?,?)").run(e1.json.orderId, paidRes.json.orderId);
  // pedido de entrega (sem retirada) vencido no relógio não pode ser tocado
  const deliv = await j("/order", { items: cart(1, camisa) });
  db.prepare("UPDATE orders SET reserve_expires_at = datetime('now','-1 minute') WHERE id=?").run(deliv.json.orderId);

  // outra empresa roda a varredura: não toca nada da primeira
  check("8.4 varredura de OUTRA empresa não expira pedido desta", P.expireOverdue(otherOrg).expired === 0 && (db.prepare("SELECT status FROM orders WHERE id=?").get(e1.json.orderId) as any).status === "aguardando_pagamento");
  // a consulta de disponibilidade já limpa reserva vencida (a vitrine nunca mostra peça presa)
  const c8 = await j("/pickup/check", { items: cart(3, calca) });
  check("8.5 consulta limpa a reserva vencida: calça 3 volta a caber", c8.json.stores[0]?.canFulfill === true, JSON.stringify(c8.json));
  const e1Row = db.prepare("SELECT status FROM orders WHERE id=?").get(e1.json.orderId) as any;
  check("8.6 pedido vencido NÃO pago foi cancelado", e1Row.status === "cancelado");
  check("8.7 a reserva voltou ao pool (pendente da calça = 1, só o pago)", pending(s1.id, calca) === 1 && R.available(orgId, s1.id, calca, null) === 3);
  check("8.8 pedido PAGO nunca expira", (db.prepare("SELECT status FROM orders WHERE id=?").get(paidRes.json.orderId) as any).status === "pago");
  check("8.9 pedido de entrega nunca é tocado", (db.prepare("SELECT status FROM orders WHERE id=?").get(deliv.json.orderId) as any).status !== "cancelado");
  check("8.10 expirar NÃO mexe na reserva de outro pedido (inventory_items)", (db.prepare("SELECT quantity_reserved q FROM inventory_items WHERE id=?").get(ii) as any).q === 5);
  const e3 = await pickupOrder(3, s1.id, calca);
  check("8.11 depois de expirar, a mesma peça pode ser reservada de novo", e3.status === 200, JSON.stringify(e3.json));
  db.prepare("UPDATE orders SET reserve_expires_at = datetime('now','-1 minute') WHERE id=?").run(e3.json.orderId);
  check("8.12 pass() (Scheduler) expira em todas as empresas e é idempotente", P.pass().expired === 1 && P.pass().expired === 0);

  // ── 9. Pedido de entrega continua idêntico ────────────────────────────────
  R.setOnlineStoreId(orgId, s2.id);
  const d = await j("/order", { items: cart(1, camisa) });
  const dRow = db.prepare("SELECT fulfillment_method, pickup_store_id, reserve_expires_at, store_id FROM orders WHERE id=?").get(d.json.orderId) as any;
  check("9.1 entrega: colunas de retirada ficam NULL", d.status === 200 && dRow.fulfillment_method === null && dRow.pickup_store_id === null && dRow.reserve_expires_at === null);
  check("9.2 entrega continua reservando na filial online (comportamento de sempre)", dRow.store_id === s2.id && pending(s2.id) === 1);
  check("9.3 resposta de entrega não traz bloco de retirada", d.json.pickup === undefined);

  // ── 10. Configuração ──────────────────────────────────────────────────────
  let bad = 0;
  for (const m of [5, 1500]) { try { P.setSettings(orgId, { reserveMinutes: m }); } catch { bad++; } }
  check("10.1 validade fora de 15–1440 min é recusada", bad === 2 && P.settings(orgId).reserveMinutes === 120);
  P.setSettings(orgId, { reserveMinutes: 30 });
  R.setReserve(orgId, s1.id, camisa, null, 10);
  const m30 = await pickupOrder(1);
  const mm = (new Date(String((db.prepare("SELECT reserve_expires_at r FROM orders WHERE id=?").get(m30.json.orderId) as any).r).replace(" ", "T") + "Z").getTime() - Date.now()) / 60000;
  check("10.2 validade configurada (30 min) vale no pedido", m30.status === 200 && mm > 28 && mm < 32, `${mm}`);
  P.setSettings(orgId, { enabled: false });
  check("10.3 desligar a flag some com a opção na hora", (await j("/pickup")).json.enabled === false && (await pickupOrder(1)).status === 409);
  check("10.4 loja inexistente na vitrine → 404", (await j("/pickup", undefined, "nao-existe")).status === 404);

  // ── 11. Rotas de admin (rede inteira): dono ok; gerente restrito a loja leva 403 ───────────────────
  const http = await import("http");
  const { PermissionService: PS } = await import("../src/server/PermissionService.js");
  const retailRoutes = (await import("../src/server/routes/retailops.js")).default;
  PS.seedSystemProfiles(orgId);
  const gerenteProfile = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(orgId) as any).id;
  const mkUser = (name: string, role: string, profile: string | null) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status, role_profile_id) VALUES (?, ?, ?, ?, ?, 'active', ?)").run(id, orgId, name, `${name}@t.com`, role, profile); return id; };
  const dono = mkUser("Bruno", "owner", null), gerente = mkUser("Gabriel", "admin", gerenteProfile), atendente = mkUser("Ana", "agent", null);
  db.prepare("INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)").run(orgId, gerente, s1.id);
  const adminApp = express(); adminApp.use(express.json());
  adminApp.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, role, role_profile_id FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = orgId; req.user = { userId: row.id, role: row.role, role_profile_id: row.role_profile_id, organizationId: orgId }; }
    next();
  });
  adminApp.use("/api/retailops", retailRoutes);
  const adminServer = http.createServer(adminApp);
  const aport: number = await new Promise((r) => adminServer.listen(0, () => r((adminServer.address() as any).port)));
  const call = async (uid: string, method: string, url: string, body?: any) => {
    const r = await fetch(`http://127.0.0.1:${aport}/api/retailops${url}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const g = await call(dono, "GET", "/pickup");
  check("11.1 dono lê a configuração (flag, prazo, lojas)", g.status === 200 && typeof g.json.settings?.reserveMinutes === "number" && g.json.stores.length === 2, JSON.stringify(g.json));
  check("11.2 gerente restrito a loja NÃO acessa (403)", (await call(gerente, "GET", "/pickup")).status === 403);
  check("11.3 gerente restrito NÃO liga a retirada (403) e nada muda", (await call(gerente, "PUT", "/pickup/settings", { enabled: true })).status === 403 && P.settings(orgId).enabled === false);
  check("11.4 gerente restrito NÃO libera loja (403)", (await call(gerente, "PUT", "/pickup/store", { storeId: s2.id, enabled: true })).status === 403 && !(db.prepare("SELECT pickup_enabled p FROM retail_stores WHERE id=?").get(s2.id) as any).p);
  check("11.5 atendente NÃO acessa (403)", (await call(atendente, "GET", "/pickup")).status === 403);
  const on = await call(dono, "PUT", "/pickup/settings", { enabled: true, reserveMinutes: 45 });
  check("11.6 dono liga e define o prazo", on.status === 200 && on.json.settings.enabled === true && on.json.settings.reserveMinutes === 45, JSON.stringify(on.json));
  check("11.7 prazo inválido → 400 e nada muda", (await call(dono, "PUT", "/pickup/settings", { reserveMinutes: 3 })).status === 400 && P.settings(orgId).reserveMinutes === 45);
  const st = await call(dono, "PUT", "/pickup/store", { storeId: s2.id, enabled: true });
  check("11.8 dono libera a loja", st.status === 200 && (db.prepare("SELECT pickup_enabled p FROM retail_stores WHERE id=?").get(s2.id) as any).p === 1, JSON.stringify(st.json));
  check("11.9 loja de outra empresa → 404", (await call(dono, "PUT", "/pickup/store", { storeId: foreignStore.id, enabled: true })).status === 404);
  check("11.10 sem storeId → 400", (await call(dono, "PUT", "/pickup/store", { enabled: true })).status === 400);
  adminServer.close();

  server.close();
  console.log("\n=== Retirada na loja com reserva atômica (ADR-207 F3) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
