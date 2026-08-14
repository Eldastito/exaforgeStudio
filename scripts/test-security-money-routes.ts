/**
 * TEST — Money route gating (SEC-F13 / achado FE3, RN-CG-06 / §73). DB-backed, determinístico.
 *
 * A varredura de frontend (FE3) mostrou custo/margem/lucro ABSOLUTOS renderizados na UI sem o
 * front aplicar papel — e a auditoria de backend confirmou GETs que devolviam esses valores SEM
 * gate server-side (o gate cosmético do cliente não é segurança). Esta fatia fecha isso:
 *   - relatórios financeiros puros → `requireRole("owner","admin")` (403 pra agent);
 *   - catálogo (`GET /api/products`) segue aberto a qualquer papel, mas o CUSTO é redigido.
 *
 * Prova, sobre os routers REAIS:
 *   1. cada GET de relatório financeiro tem o guard owner/admin (agent → 403; owner → passa);
 *   2. `GET /api/products` NÃO é bloqueado (vendedor lê a lista), mas `avg_cost`/`suggested_price`
 *      vêm nulos pra quem não é owner/admin, e completos pra owner;
 *   3. o predicado `canSeeProductCost` classifica papéis corretamente.
 *
 * Uso: npm run test:security-money-routes
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-money-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-money-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Localiza a rota (method+path) no stack do router Express.
function findRoute(router: any, method: string, routePath: string): any {
  for (const layer of router.stack || []) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) return layer.route;
  }
  return null;
}
// Roda o PRIMEIRO handler da rota (o guard, quando existe) com um req/res falso.
function runGuard(route: any, user: any): { code: number | null; nexted: boolean } {
  let code: number | null = null; let nexted = false;
  const req: any = { user, organizationId: "org_x", params: {}, query: {}, method: "GET", path: route.path, body: {} };
  const res: any = { status(c: number) { code = c; return this; }, json() { return this; }, send() { return this; }, setHeader() {} };
  route.stack[0].handle(req, res, () => { nexted = true; });
  return { code, nexted };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const productsRouter = (await import("../src/server/routes/products.js")).default as any;
  const retailopsRouter = (await import("../src/server/routes/retailops.js")).default as any;
  const { canSeeProductCost } = await import("../src/server/routes/products.js");

  const agent = { userId: "u_agent", organizationId: "org_x", role: "agent" };
  const owner = { userId: "u_owner", organizationId: "org_x", role: "owner" };
  const admin = { userId: "u_admin", organizationId: "org_x", role: "admin" };

  // ── 1. Relatórios financeiros: guard owner/admin (agent → 403; owner → passa) ──
  const gated: Array<[any, string, string]> = [
    [productsRouter, "get", "/sales-analytics"],
    [productsRouter, "get", "/sales-analytics/csv"],
    [retailopsRouter, "get", "/stores/:id/costs"],
    [retailopsRouter, "get", "/stores/:id/variable-costs"],
    [retailopsRouter, "get", "/stores/:id/result"],
    [retailopsRouter, "get", "/stores-result"],
    [retailopsRouter, "get", "/pricing/products"],
  ];
  for (const [router, method, p] of gated) {
    const route = findRoute(router, method, p);
    check(`rota ${p} existe`, !!route);
    if (!route) continue;
    const a = runGuard(route, agent);
    check(`${p} → agent 403 (não passa)`, a.code === 403 && !a.nexted);
    const o = runGuard(route, owner);
    check(`${p} → owner passa (guard next, sem 403)`, o.nexted === true && o.code === null);
  }

  // ── 2. Catálogo: aberto a agent, mas custo redigido ──
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-org_x`, "org_x");
  const pid = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, 'org_x', 'product', 'Camiseta', 100, 1, 1)`).run(pid);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, 'org_x', ?, 5, 42)`).run(randomUUID(), pid);

  const listRoute = findRoute(productsRouter, "get", "/");
  check("GET /api/products existe", !!listRoute);
  const callList = (user: any): any[] => {
    let payload: any = [];
    const req: any = { user, organizationId: "org_x", query: {}, method: "GET", path: "/", body: {} };
    const res: any = { status() { return this; }, json(b: any) { payload = b; return this; }, setHeader() {}, send() { return this; } };
    // último handler = o próprio handler da rota (GET / não é gated)
    listRoute.stack[listRoute.stack.length - 1].handle(req, res, () => {});
    return payload;
  };
  // agent NÃO é bloqueado (a lista responde) e o custo vem nulo
  const agentList = callList(agent);
  check("agent recebe a lista (não bloqueado)", Array.isArray(agentList) && agentList.length === 1);
  check("agent: avg_cost redigido (null)", agentList[0]?.avg_cost === null);
  check("agent: suggested_price redigido (null)", agentList[0]?.suggested_price === null);
  check("agent: campos de venda preservados", agentList[0]?.name === "Camiseta" && agentList[0]?.sellable === 5);
  // owner vê o custo
  const ownerList = callList(owner);
  check("owner: avg_cost visível (42)", ownerList[0]?.avg_cost === 42);
  check("owner: suggested_price calculado (> 0)", typeof ownerList[0]?.suggested_price === "number" && ownerList[0].suggested_price > 0);

  // ── 3. Predicado de papel ──
  check("canSeeProductCost(owner) = true", canSeeProductCost(owner) === true);
  check("canSeeProductCost(admin) = true", canSeeProductCost(admin) === true);
  check("canSeeProductCost(agent) = false", canSeeProductCost(agent) === false);
  check("canSeeProductCost(null) = false", canSeeProductCost(null) === false);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-money-routes: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
