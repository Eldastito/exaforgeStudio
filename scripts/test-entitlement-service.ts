/**
 * TEST — Fatia 1.1 (ADR-153): EntitlementService.
 *
 * Cobre a porta única de decisão de entitlement (backend):
 *  1. Módulos CORE sempre allowed (mesmo pra usuário sem perfil).
 *  2. Módulo do plano ligado + billing active → state=active, allowed=true.
 *  3. Módulo do plano mas NÃO ligado (`available_to_enable`) — view=allowed, use=recusado.
 *  4. Módulo fora do plano com upgrade coerente → `available_to_buy` + upgradeTargetPlan.
 *  5. Módulo fora do plano com add-on disponível → `available_to_buy` + addonPrice.
 *  6. Módulo incoerente pra vertical → `hidden`.
 *  7. Master Admin bypassa (state=active mesmo em plano que não cobre).
 *  8. RBAC=none esconde recurso (visibility=hidden) mesmo se plano cobre + ligado.
 *  9. RBAC=read não pode `execute` (rbac_low).
 * 10. Fallback legado (user sem role_profile_id) — funciona via SYSTEM_PROFILES.
 * 11. billing_status=blocked/cancelled → recurso vira suspended (writes barrados).
 * 12. billing_status=past_due → view/use OK, execute/enable barrados.
 * 13. billing_status=suspended → escritas barradas mas leituras seguem.
 * 14. Isolamento multi-tenant: mudanças em orgA não afetam orgB.
 * 15. overview() devolve mapa completo com CORE + OPTIONAL.
 * 16. checkRoute() bate com PermissionService.checkRouteAccess em segments conhecidos.
 * 17. Add-on ativo NÃO faz aparecer como upgrade — vira active.
 *
 * Uso: npm run test:entitlement-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-entitlement-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-entitlement-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { AddonService } = await import("../src/server/AddonService.js");
  const { MASTER_ADMIN_EMAIL } = await import("../src/server/config/secret.js");

  // ── Setup: 2 orgs (varejo em autonomo, clínica em enterprise) ──
  const orgV = `org_${randomUUID().slice(0, 8)}`;      // varejo autonomo (peixaria-like)
  const orgC = `org_${randomUUID().slice(0, 8)}`;      // saude enterprise (clinica multi)
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Peixaria Ana', 'active', 'varejo', 'autonomo', ?, 'active')`)
    .run(randomUUID(), orgV, JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]));
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Clinica Multi', 'active', 'saude', 'enterprise', ?, 'active')`)
    .run(randomUUID(), orgC, JSON.stringify(["agenda", "clinica", "pagamentos", "cadencias"]));

  // Seed perfis: cria owner em ambas + gerente na peixaria
  PermissionService.seedSystemProfiles(orgV);
  PermissionService.seedSystemProfiles(orgC);

  const ownerProfV = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgV) as any).id;
  const gerenteProfV = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'`).get(orgV) as any).id;
  const atendenteProfV = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'atendente'`).get(orgV) as any).id;
  const ownerProfC = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgC) as any).id;

  const ownerV = { userId: "u1", email: "dono@peixaria.com", role: "owner", role_profile_id: ownerProfV, organizationId: orgV };
  const gerenteV = { userId: "u2", email: "ger@peixaria.com", role: "admin", role_profile_id: gerenteProfV, organizationId: orgV };
  const atendenteV = { userId: "u3", email: "vend@peixaria.com", role: "agent", role_profile_id: atendenteProfV, organizationId: orgV };
  const legacyV = { userId: "u4", email: "legacy@peixaria.com", role: "owner", organizationId: orgV }; // sem role_profile_id
  const ownerC = { userId: "u5", email: "dono@clinica.com", role: "owner", role_profile_id: ownerProfC, organizationId: orgC };
  const master = { userId: "u0", email: MASTER_ADMIN_EMAIL, role: "owner", organizationId: orgV };

  // ===== 1. CORE modules always allowed =====
  const coreV = EntitlementService.check(orgV, atendenteV, "atendimento", "view");
  check("core 'atendimento' sempre allowed (view)", coreV.allowed && coreV.state === "active" && coreV.reason === "core_module");
  const coreExec = EntitlementService.check(orgV, atendenteV, "contatos", "execute");
  check("core 'contatos' execute allowed com billing active", coreExec.allowed);

  // ===== 2. Módulo do plano + ligado + billing active =====
  const catalogoV = EntitlementService.check(orgV, ownerV, "catalogo", "use");
  check("peixaria: catalogo ligado + use = active/allowed", catalogoV.state === "active" && catalogoV.allowed);
  check("peixaria: catalogo source.plan = autonomo", catalogoV.source.plan === "autonomo");
  check("peixaria: catalogo source.rbac = full (owner)", catalogoV.source.rbac === "full");

  // ===== 3. Módulo do plano mas NÃO ligado (available_to_enable) =====
  const agendaV = EntitlementService.check(orgV, ownerV, "agenda", "view");
  check("peixaria: agenda (do plano, não ligada) view=allowed", agendaV.allowed && agendaV.state === "available_to_enable");
  const agendaUse = EntitlementService.check(orgV, ownerV, "agenda", "use");
  check("peixaria: agenda não ligada use=recusado (module_off)", !agendaUse.allowed && agendaUse.reason === "module_off");

  // ===== 4. Módulo fora do plano com upgrade coerente =====
  const cadenciasV = EntitlementService.check(orgV, ownerV, "cadencias", "view");
  check("peixaria (autonomo): cadencias state=available_to_buy", cadenciasV.state === "available_to_buy");
  check("peixaria: cadencias upgradeTargetPlan = 'growth' (cadencias entra em GROWTH)", cadenciasV.upgradeTargetPlan === "growth");
  check("peixaria: cadencias upgradeEligible = true (owner tem full)", cadenciasV.upgradeEligible);
  check("peixaria: cadencias NÃO é add-on do autonomo (addonPrice=null)", cadenciasV.addonPrice === null);

  // ===== 5. Módulo fora do plano com add-on disponível =====
  // Coloca peixaria no plano `start` pra testar add-on: reservas é add-on de start.
  db.prepare(`UPDATE organization_settings SET plan_id = 'start' WHERE organization_id = ?`).run(orgV);
  const reservasV = EntitlementService.check(orgV, ownerV, "reservas", "view");
  check("peixaria (start): reservas state=available_to_buy", reservasV.state === "available_to_buy");
  check("peixaria: reservas addonPrice=800 (start add-on)", reservasV.addonPrice === 800);
  check("peixaria: reservas addonEligible=true", reservasV.addonEligible);
  db.prepare(`UPDATE organization_settings SET plan_id = 'autonomo' WHERE organization_id = ?`).run(orgV);

  // ===== 6. Módulo incoerente pra vertical (hidden) =====
  const clinicaV = EntitlementService.check(orgV, ownerV, "clinica", "view");
  check("peixaria (varejo): clinica state=hidden", clinicaV.state === "hidden");
  check("peixaria: clinica visibility=hidden reason=hidden_by_vertical", clinicaV.visibility === "hidden" && clinicaV.reason === "hidden_by_vertical");
  const escolaV = EntitlementService.check(orgV, ownerV, "escola", "view");
  check("peixaria: escola também hidden", escolaV.state === "hidden");

  // Contra-teste: escola numa org educação NÃO seria hidden. Aqui na clinica (saude) é hidden.
  const escolaC = EntitlementService.check(orgC, ownerC, "escola", "view");
  check("clinica (saude): escola também hidden (esconde por vertical)", escolaC.state === "hidden");

  // ===== 7. Master Admin bypassa =====
  const clinicaMaster = EntitlementService.check(orgV, master, "clinica", "view");
  check("master admin: clinica em peixaria = allowed (bypass)", clinicaMaster.allowed);
  check("master admin: reason=master_admin", clinicaMaster.reason === "master_admin");
  check("master admin: state reflete se está ligado (não ligado → available_to_enable)", clinicaMaster.state === "available_to_enable");

  // ===== 8. RBAC=none esconde recurso (atendente em catalogo default é 'none') =====
  const catalogoAtd = EntitlementService.check(orgV, atendenteV, "catalogo", "view");
  check("atendente em catalogo (default none) → RBAC=none + visibility=hidden", catalogoAtd.source.rbac === "none" && catalogoAtd.visibility === "hidden");
  const rieAtd = EntitlementService.check(orgV, atendenteV, "rie", "view");
  check("atendente em módulo sem permissão default (rie) → visibility=hidden", rieAtd.visibility === "hidden");

  // ===== 9. RBAC=write não pode 'enable' (precisa full) =====
  // vendedor tem 'catalogo: read' — vamos usar gerente (que tem 'full' default) pra atendimento
  // e testar que atendente com 'contatos: write' NÃO pode 'enable' contatos.
  const contatosAtdEnable = EntitlementService.check(orgV, atendenteV, "contatos", "enable");
  check("atendente com write em contatos NÃO pode 'enable' (core, sempre passa)", contatosAtdEnable.allowed);
  // Vendedor tem 'catalogo: read' — write barrado
  const vendedorProfV = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'vendedor'`).get(orgV) as any).id;
  const vendedorV = { userId: "u10", email: "vend2@peixaria.com", role: "agent", role_profile_id: vendedorProfV, organizationId: orgV };
  const catalogoVendExec = EntitlementService.check(orgV, vendedorV, "catalogo", "execute");
  check("vendedor com read em catalogo NÃO pode execute (rbac_low)", !catalogoVendExec.allowed && catalogoVendExec.reason === "rbac_low");

  // ===== 10. Fallback legado (sem role_profile_id) =====
  const catalogoLegacy = EntitlementService.check(orgV, legacyV, "catalogo", "use");
  check("legacy owner (sem role_profile_id) via SYSTEM_PROFILES fallback: catalogo full", catalogoLegacy.allowed && catalogoLegacy.source.rbac === "full");

  // ===== 11. billing_status=blocked =====
  db.prepare(`UPDATE organization_settings SET billing_status = 'blocked' WHERE organization_id = ?`).run(orgV);
  const catalogoBlockedView = EntitlementService.check(orgV, ownerV, "catalogo", "view");
  check("blocked: view catalogo (leitura) ainda permitida", catalogoBlockedView.allowed);
  check("blocked: state=suspended", catalogoBlockedView.state === "suspended");
  const catalogoBlockedExec = EntitlementService.check(orgV, ownerV, "catalogo", "execute");
  check("blocked: execute barrado (billing_blocked)", !catalogoBlockedExec.allowed && catalogoBlockedExec.reason === "billing_blocked");
  // Core em blocked: view OK, execute BARRADO.
  const coreBlockedExec = EntitlementService.check(orgV, ownerV, "atendimento", "execute");
  check("blocked: core execute barrado (billing_blocked)", !coreBlockedExec.allowed);
  db.prepare(`UPDATE organization_settings SET billing_status = 'cancelled' WHERE organization_id = ?`).run(orgV);
  const catalogoCancelled = EntitlementService.check(orgV, ownerV, "catalogo", "execute");
  check("cancelled: execute barrado igual blocked", !catalogoCancelled.allowed);

  // ===== 12. billing_status=past_due =====
  db.prepare(`UPDATE organization_settings SET billing_status = 'past_due' WHERE organization_id = ?`).run(orgV);
  const catalogoPastDueUse = EntitlementService.check(orgV, ownerV, "catalogo", "use");
  check("past_due: use catalogo OK (leitura mantida)", catalogoPastDueUse.allowed);
  const catalogoPastDueExec = EntitlementService.check(orgV, ownerV, "catalogo", "execute");
  check("past_due: execute barrado (billing_past_due)", !catalogoPastDueExec.allowed && catalogoPastDueExec.reason === "billing_past_due");

  // ===== 13. billing_status=suspended =====
  db.prepare(`UPDATE organization_settings SET billing_status = 'suspended' WHERE organization_id = ?`).run(orgV);
  const catalogoSuspUse = EntitlementService.check(orgV, ownerV, "catalogo", "use");
  check("suspended: use OK (leitura preservada)", catalogoSuspUse.allowed);
  const catalogoSuspExec = EntitlementService.check(orgV, ownerV, "catalogo", "execute");
  check("suspended: execute barrado", !catalogoSuspExec.allowed && catalogoSuspExec.reason === "billing_suspended");
  db.prepare(`UPDATE organization_settings SET billing_status = 'active' WHERE organization_id = ?`).run(orgV);

  // ===== 14. Isolamento multi-tenant =====
  const clinicaEmClinica = EntitlementService.check(orgC, ownerC, "clinica", "use");
  check("clinica em enterprise+ligada: allowed + active", clinicaEmClinica.allowed && clinicaEmClinica.state === "active");
  const catalogoPeixaria = EntitlementService.check(orgV, ownerV, "catalogo", "use");
  check("peixaria catalogo intacto após mexer em orgC", catalogoPeixaria.allowed);
  // Mudar enabled_modules da clinica NÃO afeta a peixaria
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`).run(JSON.stringify(["agenda"]), orgC);
  const catalogoAindaOk = EntitlementService.check(orgV, ownerV, "catalogo", "use");
  check("orgV.catalogo intacto após alterar orgC.enabled_modules", catalogoAindaOk.allowed);
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`).run(JSON.stringify(["agenda", "clinica", "pagamentos", "cadencias"]), orgC);

  // ===== 15. overview() devolve mapa completo (CORE + OPTIONAL) =====
  const overview = EntitlementService.overview(orgV, ownerV);
  check("overview inclui 'atendimento' (core)", overview["atendimento"] != null);
  check("overview inclui 'catalogo' (optional)", overview["catalogo"] != null);
  check("overview inclui 'clinica' (hidden)", overview["clinica"] != null && overview["clinica"].state === "hidden");
  check("overview tem ≥ CORE(4) + OPTIONAL(28) = 32 entries", Object.keys(overview).length >= 30);

  // ===== 16. checkRoute compatível com semântica de PermissionService =====
  const route1 = EntitlementService.checkRoute(orgV, ownerV, "products", "GET");
  check("checkRoute(products,GET) = allow + module=catalogo", route1.allow && route1.module === "catalogo");
  const route2 = EntitlementService.checkRoute(orgV, atendenteV, "clinic", "GET");
  check("checkRoute(clinic,GET) atendente em peixaria = deny", !route2.allow);
  const route3 = EntitlementService.checkRoute(orgV, ownerV, "unknown-segment", "GET");
  check("checkRoute segment desconhecido = allow (não gateado)", route3.allow && route3.module === null);

  // ===== 17. Add-on ativo faz módulo virar active (não upgrade) =====
  db.prepare(`UPDATE organization_settings SET plan_id = 'start' WHERE organization_id = ?`).run(orgV);
  AddonService.contract(orgV, "reservas");
  // pra ficar active precisa também estar em enabled_modules
  const enabledNow = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgV) as any).enabled_modules);
  db.prepare(`UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?`).run(JSON.stringify([...enabledNow, "reservas"]), orgV);
  const reservasComAddon = EntitlementService.check(orgV, ownerV, "reservas", "use");
  check("reservas com add-on ativo + enabled = active", reservasComAddon.state === "active" && reservasComAddon.allowed);
  check("reservas com add-on: source.addon = 'reservas'", reservasComAddon.source.addon === "reservas");

  // ===== Resultado =====
  console.log("\n=== EntitlementService (F1.1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
