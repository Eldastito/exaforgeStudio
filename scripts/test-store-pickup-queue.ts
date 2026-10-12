/**
 * TESTE — Fila "separar agora" da retirada na loja (ADR-207 F4).
 *
 * Sobe a vitrine pública + as rotas de Retail Ops REAIS e prova:
 *  - pedido de retirada NÃO pago não entra na fila (fica em "aguardando pagamento") e não dá pra separar;
 *  - ao PAGAR nasce UM sinal "separar agora" na loja certa (idempotente, sem dinheiro);
 *  - etapas só avançam (separado → pronto → retirado), repetir é no-op, voltar é recusado;
 *  - separado leva o pedido a em_preparo, retirado a entregue, SEM baixar o estoque duas vezes;
 *  - o sinal fecha ao separar/retirar/cancelar; pedido cancelado/encerrado não avança;
 *  - recorte de loja do gerente (fila e avanço), isolamento entre empresas, fila sem dinheiro;
 *  - pedido que não é de retirada nunca gera o sinal.
 *
 * Uso: npm run test:store-pickup-queue
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pickup-queue-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pickup-queue-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const retailRoutes = (await import("../src/server/routes/retailops.js")).default;
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService: R } = await import("../src/server/RetailOnlineReserveService.js");
  const { StorePickupService: P } = await import("../src/server/StorePickupService.js");
  const { StorePickupQueueService: Q } = await import("../src/server/StorePickupQueueService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { PermissionService: PS } = await import("../src/server/PermissionService.js");

  const orgId = randomUUID(), otherOrg = randomUUID();
  for (const [id, slug] of [[orgId, "toulon"], [otherOrg, "outra"]] as const) {
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(id, slug.toUpperCase());
    db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, ?, 1, ?)`).run(id, slug, `Loja ${slug}`);
  }
  const camisa = randomUUID(), calca = randomUUID();
  for (const [id, name] of [[camisa, "Camisa Polo"], [calca, "Calça Jeans"]] as const) {
    db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active, stock_control_enabled) VALUES (?, ?, ?, 'product', 100, 1, 1)`).run(id, orgId, name);
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, NULL, 10, 0)`).run(randomUUID(), orgId, id);
  }
  const s1 = RetailStoreService.create(orgId, { name: "Toulon 1079", code: "10" });
  const s2 = RetailStoreService.create(orgId, { name: "Toulon Centro", code: "20" });
  R.setEnabled(orgId, true);
  P.setSettings(orgId, { enabled: true });
  P.setStore(orgId, s1.id, true); P.setStore(orgId, s2.id, true);
  for (const s of [s1, s2]) for (const p of [camisa, calca]) R.setReserve(orgId, s.id, p, null, 20);
  const stock = (p: string) => (db.prepare("SELECT quantity_available a FROM inventory_items WHERE product_service_id = ?").get(p) as any).a as number;

  // usuários: dono, gerente restrito à loja 1, dono de OUTRA empresa
  PS.seedSystemProfiles(orgId);
  const gerenteProfile = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(orgId) as any).id;
  const mkUser = (org: string, name: string, role: string, profile: string | null) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status, role_profile_id) VALUES (?, ?, ?, ?, ?, 'active', ?)").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role, profile); return id; };
  const dono = mkUser(orgId, "Bruno", "owner", null), gerente = mkUser(orgId, "Gabriel", "admin", gerenteProfile), donoOutra = mkUser(otherOrg, "Zé", "owner", null);
  db.prepare("INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)").run(orgId, gerente, s1.id);

  const app = express(); app.use(express.json());
  app.use("/api/public", storefrontPublic);
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role, role_profile_id FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, role_profile_id: row.role_profile_id, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/retailops", retailRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const url = `http://127.0.0.1:${port}/api`;
  const order = async (body: any) => { const r = await fetch(`${url}/public/store/toulon/order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };
  const pickup = (storeId: string, product = camisa, qty = 1, customer: any = { name: "Maria Souza", phone: "11988887777" }) =>
    order({ items: [{ productId: product, quantity: qty }], fulfillment: "pickup", pickupStoreId: storeId, customer });
  const call = async (uid: string, method: string, p: string, body?: any) => {
    const r = await fetch(`${url}/retailops${p}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const signals = (orderId: string) => db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").all(orgId, `pickup.separate|${orderId}`) as any[];
  const row = (id: string) => db.prepare("SELECT status, pickup_status, pickup_status_by FROM orders WHERE id = ?").get(id) as any;

  // ── 1. Não pago: fora da fila, sem sinal, não separa ──────────────────────
  const a = await pickup(s1.id);
  check("1.1 pedido de retirada criado", a.status === 200 && !!a.json.orderId, JSON.stringify(a.json));
  const q1 = await call(dono, "GET", "/pickup/queue");
  check("1.2 não pago NÃO entra na fila de separar", q1.status === 200 && q1.json.queue.length === 0);
  check("1.3 aparece em 'aguardando pagamento' com a validade da reserva", q1.json.awaitingPayment.length === 1 && q1.json.awaitingPayment[0].orderId === a.json.orderId && !!q1.json.awaitingPayment[0].reserveExpiresAt && q1.json.awaitingPayment[0].stage === null);
  check("1.4 não pago não gera sinal", signals(a.json.orderId).length === 0);
  const un = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "separado" });
  check("1.5 separar pedido NÃO pago → 409 pedido_nao_pago", un.status === 409 && un.json.error === "pedido_nao_pago" && row(a.json.orderId).pickup_status === null);

  // ── 2. Pagou → um sinal 'separar agora' na loja certa ─────────────────────
  OrdersService.updateStatus(orgId, a.json.orderId, "pago");
  const sg = signals(a.json.orderId);
  check("2.1 pagar gera UM sinal aberto", sg.length === 1 && sg[0].status === "open" && sg[0].signal_type === "pickup_separate_now");
  check("2.2 sinal aponta a loja da retirada e o pedido", sg[0].source_entity_type === "retail_store" && sg[0].source_entity_id === s1.id && sg[0].subject_type === "order" && sg[0].subject_id === a.json.orderId);
  const ev = JSON.parse(sg[0].evidence_json);
  check("2.3 sinal traz as peças a separar", ev.items?.[0]?.name === "Camisa Polo" && ev.items[0].quantity === 1 && ev.store === "Toulon 1079");
  check("2.4 sinal sem dinheiro (impacto nulo, sem preço/total)", sg[0].impact_amount === null && !/total|price|preço|valor|R\$/i.test(sg[0].evidence_json));
  OrdersService.updateStatus(orgId, a.json.orderId, "pago");
  check("2.5 repetir 'pago' não duplica o sinal", signals(a.json.orderId).length === 1);
  check("2.6 baixa de estoque feita UMA vez no pagamento (10 → 9)", stock(camisa) === 9);

  // ── 3. Fila e etapas ──────────────────────────────────────────────────────
  const q2 = await call(dono, "GET", "/pickup/queue");
  const item = q2.json.queue[0];
  check("3.1 pago entra na fila como 'a_separar' com cliente e peças", q2.json.queue.length === 1 && item.stage === "a_separar" && item.customer.name === "Maria Souza" && item.customer.phone === "11988887777" && item.items[0].name === "Camisa Polo" && item.storeName === "Toulon 1079");
  check("3.2 a fila NÃO carrega dinheiro", !/total|price|amount|valor|unit_price/i.test(JSON.stringify(q2.json)));
  const bad0 = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "a_separar" });
  check("3.3 etapa 'a_separar' ou desconhecida é recusada", bad0.status === 409 && bad0.json.error === "etapa_invalida" && (await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "xpto" })).status === 409);
  const sep = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "separado" });
  check("3.4 separado: ok, pedido vai a em_preparo, autor registrado", sep.status === 200 && sep.json.stage === "separado" && sep.json.changed === true && row(a.json.orderId).status === "em_preparo" && row(a.json.orderId).pickup_status_by === dono);
  check("3.5 separar fecha o alerta 'separar agora'", signals(a.json.orderId)[0].status === "resolved");
  const again = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "separado" });
  check("3.6 repetir a mesma etapa é no-op", again.status === 200 && again.json.changed === false);
  const pr = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "pronto" });
  check("3.7 pronto", pr.status === 200 && pr.json.stage === "pronto" && (await call(dono, "GET", "/pickup/queue")).json.queue[0].stage === "pronto");
  const back = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "separado" });
  check("3.8 etapa NÃO volta (409 etapa_nao_volta)", back.status === 409 && back.json.error === "etapa_nao_volta" && row(a.json.orderId).pickup_status === "pronto");
  const out = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "retirado" });
  check("3.9 retirado: pedido vai a entregue e sai da fila ativa", out.status === 200 && row(a.json.orderId).status === "entregue" && (await call(dono, "GET", "/pickup/queue")).json.queue.length === 0);
  check("3.10 com includeDone o retirado aparece", (await call(dono, "GET", "/pickup/queue?includeDone=1")).json.queue.some((x: any) => x.orderId === a.json.orderId && x.stage === "retirado"));
  check("3.11 retirar NÃO baixa o estoque de novo (segue 9)", stock(camisa) === 9);
  const post = await call(dono, "POST", `/pickup/orders/${a.json.orderId}/advance`, { to: "pronto" });
  check("3.12 pedido já entregue não avança (409 pedido_encerrado)", post.status === 409 && post.json.error === "pedido_encerrado");
  const audit = db.prepare("SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'STORE_PICKUP_STAGE' AND target_user_id = ?").get(orgId, a.json.orderId) as any;
  check("3.13 cada avanço fica no audit (3)", audit?.c === 3, JSON.stringify(audit));

  // ── 4. Cancelamento fecha o alerta e trava o avanço ───────────────────────
  const c = await pickup(s1.id, calca);
  OrdersService.updateStatus(orgId, c.json.orderId, "pago");
  check("4.1 novo pago → novo sinal aberto", signals(c.json.orderId)[0]?.status === "open");
  OrdersService.updateStatus(orgId, c.json.orderId, "cancelado");
  check("4.2 cancelar fecha o sinal", signals(c.json.orderId)[0].status === "resolved");
  const dead = await call(dono, "POST", `/pickup/orders/${c.json.orderId}/advance`, { to: "separado" });
  check("4.3 pedido cancelado não avança (409)", dead.status === 409 && dead.json.error === "pedido_encerrado");

  // ── 5. Pedido que NÃO é de retirada nunca gera sinal ──────────────────────
  const d = await order({ items: [{ productId: camisa, quantity: 1 }] });
  OrdersService.updateStatus(orgId, d.json.orderId, "pago");
  check("5.1 entrega paga não gera 'separar agora'", signals(d.json.orderId).length === 0);
  const nd = await call(dono, "POST", `/pickup/orders/${d.json.orderId}/advance`, { to: "separado" });
  check("5.2 entrega não entra no fluxo de retirada (404)", nd.status === 404);

  // ── 6. Recorte de loja do gerente + isolamento entre empresas ─────────────
  const e1 = await pickup(s1.id), e2 = await pickup(s2.id, camisa, 1, { name: "João Lima" });
  OrdersService.updateStatus(orgId, e1.json.orderId, "pago"); OrdersService.updateStatus(orgId, e2.json.orderId, "pago");
  const owner = await call(dono, "GET", "/pickup/queue");
  check("6.1 dono vê as duas lojas", owner.json.queue.map((x: any) => x.orderId).sort().join() === [e1.json.orderId, e2.json.orderId].sort().join());
  const mgr = await call(gerente, "GET", "/pickup/queue");
  check("6.2 gerente restrito vê SÓ a loja dele", mgr.status === 200 && mgr.json.queue.length === 1 && mgr.json.queue[0].orderId === e1.json.orderId);
  check("6.3 gerente pedindo a fila da outra loja → 403", (await call(gerente, "GET", `/pickup/queue?storeId=${s2.id}`)).status === 403);
  check("6.4 gerente NÃO avança pedido de outra loja (403) e nada muda", (await call(gerente, "POST", `/pickup/orders/${e2.json.orderId}/advance`, { to: "separado" })).status === 403 && row(e2.json.orderId).pickup_status === null);
  check("6.5 gerente avança pedido da loja dele", (await call(gerente, "POST", `/pickup/orders/${e1.json.orderId}/advance`, { to: "separado" })).status === 200 && row(e1.json.orderId).pickup_status === "separado");
  check("6.6 dono de OUTRA empresa não vê a fila daqui", (await call(donoOutra, "GET", "/pickup/queue")).json.queue.length === 0);
  const cross = await call(donoOutra, "POST", `/pickup/orders/${e2.json.orderId}/advance`, { to: "pronto" });
  check("6.7 dono de OUTRA empresa não avança pedido daqui (404) e nada muda", cross.status === 404 && row(e2.json.orderId).pickup_status === null);
  check("6.8 service isola por empresa (advance com outro orgId falha)", Q.advance(otherOrg, e2.json.orderId, "pronto").ok === false && row(e2.json.orderId).pickup_status === null);

  server.close();
  console.log("\n=== Fila 'separar agora' da retirada na loja (ADR-207 F4) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
