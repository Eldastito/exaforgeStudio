/**
 * TEST — Fatia 1.2 (ADR-153): middleware do server.ts consome EntitlementService.
 *
 * Cobre a nova porta ORG-level do EntitlementService (`isModuleAvailable`) que
 * o middleware do server.ts:436-450 usa, além de simular o middleware inteiro
 * pra provar que:
 *   1. Segmentos fora de MODULE_BY_ROUTE passam (core/infra).
 *   2. Módulo CORE nunca é barrado.
 *   3. Módulo do plano + ligado → allow.
 *   4. Módulo do plano mas fora de enabled_modules → 403 `module_disabled` +
 *      `reason=module_off` + `state=available_to_enable`.
 *   5. Módulo FORA do plano → 403 `module_disabled` + `reason=plan_ceiling` +
 *      `state=available_to_buy`.
 *   6. Add-on ativo abre o teto — módulo vira available (com enabled).
 *   7. PLAN_FREE_ADDONS (retail/retail_floor) fura o teto quando enabled.
 *   8. `enabled_modules == null` → módulo opcional bloqueia (mudança semântica
 *      confirmada, alinhada com ModuleService.isEnabled atual).
 *   9. Backward compat: `error: "module_disabled"` + `module` mantidos (extras
 *      novos são adicionais, não substituem).
 *  10. Isolamento cross-tenant: orgA `plan_ceiling` não afeta orgB.
 *  11. billing_status NÃO é checado aqui (política "manter visibilidade,
 *      bloquear escrita" fica com o read-only middleware do server.ts:359-378).
 *
 * Uso: npm run test:entitlement-middleware
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-entitlement-mw-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-entitlement-mw-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

/**
 * Reimplementa o middleware do server.ts:436-450 num closure puro, pra poder
 * testar sem subir Express. Se o server.ts mudar, esta função também precisa.
 */
function simulateMiddleware(EntitlementService: any, ModuleService: any) {
  return function mw(req: any): { statusCode: number; body: any } {
    const seg = (req.path || "").split("/")[1];
    const mod = ModuleService.MODULE_BY_ROUTE[seg];
    if (!mod) return { statusCode: 200, body: { passed: true } };
    if (!req.organizationId) return { statusCode: 200, body: { passed: true } };
    const dec = EntitlementService.isModuleAvailable(req.organizationId, mod);
    if (dec.available) return { statusCode: 200, body: { passed: true } };
    return { statusCode: 403, body: { error: "module_disabled", module: mod, reason: dec.reason, state: dec.state } };
  };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { AddonService } = await import("../src/server/AddonService.js");

  // ── Setup 2 orgs ──
  const orgV = `org_${randomUUID().slice(0, 8)}`;  // peixaria (varejo, autonomo)
  const orgC = `org_${randomUUID().slice(0, 8)}`;  // clinica (saude, enterprise)
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Peixaria', 'active', 'varejo', 'autonomo', ?, 'active')`)
    .run(randomUUID(), orgV, JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]));
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Clinica Multi', 'active', 'saude', 'enterprise', ?, 'active')`)
    .run(randomUUID(), orgC, JSON.stringify(["agenda", "clinica", "pagamentos", "cadencias"]));

  const mw = simulateMiddleware(EntitlementService, ModuleService);

  // ===== 1. Segmento fora de MODULE_BY_ROUTE (core/infra) → passa =====
  const rMe = mw({ path: "/auth/me", organizationId: orgV });
  check("segmento fora do mapa (/auth/me) → passa", rMe.statusCode === 200);
  const rInfra = mw({ path: "/analytics/settings", organizationId: orgV });
  check("segmento não mapeado (/analytics/settings) → passa", rInfra.statusCode === 200);

  // ===== 2. Sem organizationId no request → passa (auth cuida antes) =====
  const rNoOrg = mw({ path: "/products/list" });
  check("sem organizationId → passa (auth barra antes)", rNoOrg.statusCode === 200);

  // ===== 3. Módulo do plano + ligado → allow =====
  const rCatalogo = mw({ path: "/products", organizationId: orgV });
  check("peixaria: /products (catalogo ligado) → allow", rCatalogo.statusCode === 200);

  // ===== 4. Módulo do plano mas fora de enabled_modules → module_off =====
  const rAgenda = mw({ path: "/appointments", organizationId: orgV });
  check("peixaria: /appointments (agenda no plano mas não ligada) → 403", rAgenda.statusCode === 403);
  check("peixaria: /appointments reason=module_off", rAgenda.body.reason === "module_off");
  check("peixaria: /appointments state=available_to_enable", rAgenda.body.state === "available_to_enable");
  check("peixaria: /appointments backward-compat error='module_disabled'", rAgenda.body.error === "module_disabled");
  check("peixaria: /appointments backward-compat module='agenda'", rAgenda.body.module === "agenda");

  // ===== 5. Módulo FORA do plano → plan_ceiling =====
  const rCadencias = mw({ path: "/cadences", organizationId: orgV });
  check("peixaria (autonomo): /cadences (fora do plano) → 403", rCadencias.statusCode === 403);
  check("peixaria: /cadences reason=plan_ceiling", rCadencias.body.reason === "plan_ceiling");
  check("peixaria: /cadences state=available_to_buy", rCadencias.body.state === "available_to_buy");
  check("peixaria: /cadences module='cadencias'", rCadencias.body.module === "cadencias");

  // Módulo fora do plano + fora do enabled_modules → plan_ceiling (plano é a razão mais restritiva)
  const rClinica = mw({ path: "/clinic", organizationId: orgV });
  check("peixaria: /clinic fora do plano → plan_ceiling", rClinica.body.reason === "plan_ceiling");

  // ===== 6. Add-on ativo abre o teto =====
  db.prepare(`UPDATE organization_settings SET plan_id = 'start' WHERE organization_id = ?`).run(orgV);
  const currentEnabled = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgV) as any).enabled_modules);
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`).run(JSON.stringify([...currentEnabled, "reservas"]), orgV);
  AddonService.contract(orgV, "reservas");
  const rReservas = mw({ path: "/reservations", organizationId: orgV });
  check("start + add-on reservas ativo + enabled → allow", rReservas.statusCode === 200);
  // Cancelamento tira o add-on
  AddonService.cancel(orgV, "reservas");
  const rReservasSem = mw({ path: "/reservations", organizationId: orgV });
  check("start sem add-on reservas → 403 (plan_ceiling)", rReservasSem.statusCode === 403 && rReservasSem.body.reason === "plan_ceiling");
  db.prepare(`UPDATE organization_settings SET plan_id = 'autonomo' WHERE organization_id = ?`).run(orgV);

  // ===== 7. PLAN_FREE_ADDONS: retail/retail_floor furam o teto quando enabled =====
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`)
    .run(JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos", "retail"]), orgV);
  const rRetail = mw({ path: "/retailops", organizationId: orgV });
  check("peixaria (autonomo) + retail em enabled_modules → allow (PLAN_FREE_ADDONS)", rRetail.statusCode === 200);
  // Sem estar em enabled_modules, mesmo sendo free-addon, não passa
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`)
    .run(JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]), orgV);
  const rRetailOff = mw({ path: "/retailops", organizationId: orgV });
  check("retail fora de enabled_modules → 403", rRetailOff.statusCode === 403);

  // ===== 8. enabled_modules == null → bloqueia opcional (mesmo comportamento atual do ModuleService.isEnabled) =====
  db.prepare(`UPDATE organization_settings SET enabled_modules = NULL WHERE organization_id = ?`).run(orgV);
  const rNullEm = mw({ path: "/products", organizationId: orgV });
  check("enabled_modules=NULL → módulo opcional bloqueia (semântica atual)", rNullEm.statusCode === 403);
  check("enabled_modules=NULL → reason=module_off", rNullEm.body.reason === "module_off");
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`)
    .run(JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]), orgV);

  // ===== 9. billing_status blocked NÃO afeta este gate (respeita ADR-091 §leitura preservada) =====
  db.prepare(`UPDATE organization_settings SET billing_status = 'blocked' WHERE organization_id = ?`).run(orgV);
  const rBlockedRead = mw({ path: "/products", organizationId: orgV });
  check("billing=blocked: /products (catalogo ligado) SEGUE passando (não é aqui que bloqueia)", rBlockedRead.statusCode === 200);
  db.prepare(`UPDATE organization_settings SET billing_status = 'active' WHERE organization_id = ?`).run(orgV);

  // ===== 10. Isolamento cross-tenant =====
  const rClinicaEmClinica = mw({ path: "/clinic", organizationId: orgC });
  check("clinica em enterprise+ligada: /clinic → allow", rClinicaEmClinica.statusCode === 200);
  const rCatalogoEmClinica = mw({ path: "/products", organizationId: orgC });
  check("clinica: /products (catalogo NÃO ligado, enterprise cobre) → 403 module_off", rCatalogoEmClinica.statusCode === 403 && rCatalogoEmClinica.body.reason === "module_off");

  // Mexer na orgV não afeta orgC
  const rClinicaAindaOk = mw({ path: "/clinic", organizationId: orgC });
  check("orgC intacto após batalhas em orgV", rClinicaAindaOk.statusCode === 200);

  // ===== 11. CORE modules sempre allowed (mesmo em orgs incompletas) =====
  const orgVirgin = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Virgin', 'active')`).run(randomUUID(), orgVirgin);
  // Segmento não mapeado (core não está em MODULE_BY_ROUTE) → passa
  const rCoreSeg = mw({ path: "/contacts", organizationId: orgVirgin });
  check("orgVirgin sem nada: /contacts (não gateado — core) → passa", rCoreSeg.statusCode === 200);
  const rProductsVirgin = mw({ path: "/products", organizationId: orgVirgin });
  // Sem vertical + sem plan_id, catalogo bloqueia (plano cortesia = todos os limites 0, mas modules pode ser null)
  // Este teste documenta o comportamento — orgs sem plano/vertical ficam bloqueadas até applyVertical rodar.
  check("orgVirgin sem plano: /products bloqueia", rProductsVirgin.statusCode === 403);

  // ===== 12. EntitlementService.isModuleAvailable direto (não via middleware) =====
  const isModCore = EntitlementService.isModuleAvailable(orgV, "atendimento");
  check("isModuleAvailable(core) devolve available + reason=core_module", isModCore.available && isModCore.reason === "core_module");
  const isModOff = EntitlementService.isModuleAvailable(orgV, "agenda");
  check("isModuleAvailable(agenda desligada) → available=false + reason=module_off", !isModOff.available && isModOff.reason === "module_off");
  const isModPlan = EntitlementService.isModuleAvailable(orgV, "cadencias");
  check("isModuleAvailable(cadencias fora do plano) → reason=plan_ceiling + state=available_to_buy",
    !isModPlan.available && isModPlan.reason === "plan_ceiling" && isModPlan.state === "available_to_buy");

  // ===== Resultado =====
  console.log("\n=== Entitlement Middleware (F1.2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
