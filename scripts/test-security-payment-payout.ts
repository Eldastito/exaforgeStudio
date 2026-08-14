/**
 * TEST — Protecao do DESTINO do pagamento (SEC-F19). DB-backed, deterministico.
 *
 * A auditoria mostrou que PUT /api/payments/settings (grava chave PIX / token do gateway =
 * onde o dinheiro cai) e POST /webhook-secret NAO tinham trava de dono — um funcionario
 * (agent) podia trocar a chave pela conta dele e desviar os pagamentos. E o GET expunha a
 * chave PIX a qualquer papel. Aqui provamos que:
 *   - PUT /settings e POST /webhook-secret respondem 403 para agent e passam para owner;
 *   - GET /settings REDIGE a chave PIX para agent e MOSTRA para owner.
 *
 * Uso: npm run test:security-payment-payout
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sec-pay-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-pay-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function findRoute(router: any, method: string, routePath: string): any {
  for (const layer of router.stack || []) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) return layer.route;
  }
  return null;
}
function runGuard(route: any, user: any): { code: number | null; nexted: boolean } {
  let code: number | null = null; let nexted = false;
  const req: any = { user, organizationId: "org_pay", params: {}, query: {}, method: "PUT", path: route.path, body: {} };
  const res: any = { status(c: number) { code = c; return this; }, json() { return this; } };
  route.stack[0].handle(req, res, () => { nexted = true; });
  return { code, nexted };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const paymentsRouter = (await import("../src/server/routes/payments.js")).default as any;

  const agent = { userId: "u_agent", organizationId: "org_pay", role: "agent" };
  const owner = { userId: "u_owner", organizationId: "org_pay", role: "owner" };
  const admin = { userId: "u_admin", organizationId: "org_pay", role: "admin" };

  // 1. PUT /settings e POST /webhook-secret: 403 para agent, passa para owner/admin.
  for (const [m, p] of [["put", "/settings"], ["post", "/webhook-secret"]] as [string, string][]) {
    const route = findRoute(paymentsRouter, m, p);
    check(`rota ${m.toUpperCase()} ${p} existe`, !!route);
    if (!route) continue;
    check(`${p} agent -> 403`, (() => { const r = runGuard(route, agent); return r.code === 403 && !r.nexted; })());
    check(`${p} owner -> passa`, (() => { const r = runGuard(route, owner); return r.nexted && r.code === null; })());
    check(`${p} admin -> passa`, (() => { const r = runGuard(route, admin); return r.nexted && r.code === null; })());
  }

  // 2. GET /settings: redige a chave PIX para agent; mostra para owner.
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pay_enabled, pay_pix_key, pay_pix_name) VALUES (?, 'org_pay', 'Loja', 'active', 1, 'chave-pix-secreta@loja.com', 'Loja LTDA')`).run(`os-org_pay`);
  const getRoute = findRoute(paymentsRouter, "get", "/settings");
  check("GET /settings existe", !!getRoute);
  const callGet = (user: any): any => {
    let payload: any = null;
    const req: any = { user, organizationId: "org_pay", query: {}, method: "GET", path: "/settings", body: {} };
    const res: any = { status() { return this; }, json(b: any) { payload = b; return this; } };
    getRoute.stack[getRoute.stack.length - 1].handle(req, res, () => {});
    return payload;
  };
  const agentView = callGet(agent);
  check("agent: chave PIX redigida (vazia)", agentView && agentView.pixKey === "" && agentView.pixName === "");
  check("agent: ainda ve o status (enabled) e hasPixKey", agentView && agentView.enabled === true && agentView.hasPixKey === true);
  const ownerView = callGet(owner);
  check("owner: chave PIX visivel", ownerView && ownerView.pixKey === "chave-pix-secreta@loja.com");
  // NUNCA expoe segredo do gateway (so booleanos), para nenhum papel.
  check("nenhum papel recebe token do gateway em claro", !("gatewayToken" in (ownerView || {})) && !("pay_gateway_token" in (ownerView || {})));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log("  x " + r.name);
  console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-payment-payout: " + passed + "/" + results.length + " checks");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
