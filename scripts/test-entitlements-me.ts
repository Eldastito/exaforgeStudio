/**
 * TEST — Fatia 1.3 (ADR-153): resposta de GET /api/entitlements/me.
 *
 * Cobre o payload da rota (backend) que o useStore.loadEntitlements consome
 * como fonte única. Roda o handler diretamente (sem Express) pra validar:
 *   1. `entitlements` mapa contém CORE + OPTIONAL.
 *   2. `meta.isMasterAdmin` reflete o email do user.
 *   3. `meta.hasProfile` reflete se o user tem role_profile_id.
 *   4. `meta.falatuEnabled` reflete a flag da org.
 *   5. `meta.vertical` + `meta.planId` + `meta.defaultLandingView` vêm da org.
 *   6. `meta.permissions` traz o mapa módulo→nível RBAC.
 *   7. Cross-tenant: mudanças em orgA não vazam pra orgB.
 *   8. `entitlements[k].state === 'active'` para módulo ligado + coberto.
 *   9. `entitlements[k].state === 'available_to_enable'` para módulo do plano não ligado.
 *  10. `entitlements[k].state === 'available_to_buy'` para módulo com upgrade.
 *  11. `entitlements[k].state === 'hidden'` para módulo escondido por vertical.
 *
 * Uso: npm run test:entitlements-me
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ent-me-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-ent-me-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

// Simula o handler de GET /api/entitlements/me sem subir Express.
function simulateMeHandler(EntitlementService: any, PermissionService: any, FalaTuService: any, MASTER_ADMIN_EMAIL: string, db: any) {
  return function handler(orgId: string, user: any): any {
    const map = EntitlementService.overview(orgId, user);
    const org = db.prepare(
      `SELECT vertical, plan_id, default_landing_view FROM organization_settings WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) || {};
    const meta = {
      isMasterAdmin: !!(user.email && user.email === MASTER_ADMIN_EMAIL),
      hasProfile: PermissionService.hasProfile(orgId, user),
      falatuEnabled: FalaTuService.orgEnabled(orgId),
      vertical: org.vertical || null,
      planId: org.plan_id || null,
      defaultLandingView: org.default_landing_view || null,
      permissions: PermissionService.permissionMap(orgId, user),
    };
    return { entitlements: map, meta };
  };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { MASTER_ADMIN_EMAIL } = await import("../src/server/config/secret.js");

  const orgV = `org_${randomUUID().slice(0, 8)}`;
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, default_landing_view) VALUES (?, ?, 'Peixaria Ana', 'active', 'varejo', 'autonomo', ?, 'active', 'kanban')`)
    .run(randomUUID(), orgV, JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]));
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Clinica', 'active', 'saude', 'enterprise', ?, 'active')`)
    .run(randomUUID(), orgC, JSON.stringify(["agenda", "clinica", "pagamentos"]));

  PermissionService.seedSystemProfiles(orgV);
  const ownerProf = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgV) as any).id;
  const owner = { userId: "u1", email: "dono@peixaria.com", role: "owner", role_profile_id: ownerProf, organizationId: orgV };
  const legacyOwner = { userId: "u2", email: "leg@peixaria.com", role: "owner", organizationId: orgV }; // sem role_profile_id
  const master = { userId: "u0", email: MASTER_ADMIN_EMAIL, role: "owner", organizationId: orgV };

  const handler = simulateMeHandler(EntitlementService, PermissionService, FalaTuService, MASTER_ADMIN_EMAIL, db);

  // ===== 1. entitlements + meta =====
  const res1 = handler(orgV, owner);
  check("payload tem `entitlements`", typeof res1.entitlements === "object" && res1.entitlements !== null);
  check("payload tem `meta`", typeof res1.meta === "object" && res1.meta !== null);
  check("entitlements inclui core 'atendimento'", res1.entitlements.atendimento != null);
  check("entitlements inclui optional 'catalogo'", res1.entitlements.catalogo != null);

  // ===== 2. meta.isMasterAdmin =====
  check("meta.isMasterAdmin = false para owner comum", res1.meta.isMasterAdmin === false);
  const resMaster = handler(orgV, master);
  check("meta.isMasterAdmin = true para MASTER_ADMIN_EMAIL", resMaster.meta.isMasterAdmin === true);

  // ===== 3. meta.hasProfile =====
  check("meta.hasProfile = true para owner com role_profile_id", res1.meta.hasProfile === true);
  const resLegacy = handler(orgV, legacyOwner);
  check("meta.hasProfile = false para legacy (sem role_profile_id)", resLegacy.meta.hasProfile === false);

  // ===== 4. meta.falatuEnabled =====
  check("meta.falatuEnabled = false por default", res1.meta.falatuEnabled === false);
  FalaTuService.setOrgEnabled(orgV, true);
  const resFalatu = handler(orgV, owner);
  check("meta.falatuEnabled = true após setOrgEnabled(true)", resFalatu.meta.falatuEnabled === true);
  FalaTuService.setOrgEnabled(orgV, false);

  // ===== 5. meta contexto da org =====
  check("meta.vertical = 'varejo'", res1.meta.vertical === "varejo");
  check("meta.planId = 'autonomo'", res1.meta.planId === "autonomo");
  check("meta.defaultLandingView = 'kanban'", res1.meta.defaultLandingView === "kanban");

  // ===== 6. meta.permissions =====
  check("meta.permissions é objeto (mapa módulo→nível)", typeof res1.meta.permissions === "object");
  check("meta.permissions.catalogo = 'full' pra owner", res1.meta.permissions.catalogo === "full");

  // ===== 7. Cross-tenant =====
  const resC = handler(orgC, { userId: "u3", email: "dono@clinica.com", role: "owner", organizationId: orgC });
  check("orgC meta.vertical = 'saude'", resC.meta.vertical === "saude");
  check("orgC meta.planId = 'enterprise'", resC.meta.planId === "enterprise");
  check("orgV NÃO herda enterprise (isolamento)", res1.meta.planId === "autonomo");

  // ===== 8. state = 'active' para módulo ligado + coberto =====
  check("catalogo.state = 'active' (ligado + no plano)", res1.entitlements.catalogo.state === "active");

  // ===== 9. state = 'available_to_enable' para módulo do plano não ligado =====
  check("agenda.state = 'available_to_enable' (no plano mas não ligado)", res1.entitlements.agenda.state === "available_to_enable");

  // ===== 10. state = 'available_to_buy' para módulo com upgrade coerente =====
  check("cadencias.state = 'available_to_buy' (fora do plano, tem upgrade)", res1.entitlements.cadencias.state === "available_to_buy");
  check("cadencias.upgradeTargetPlan = 'growth'", res1.entitlements.cadencias.upgradeTargetPlan === "growth");

  // ===== 11. state = 'hidden' para módulo escondido por vertical =====
  check("clinica.state = 'hidden' na peixaria (varejo)", res1.entitlements.clinica.state === "hidden");
  check("escola.state = 'hidden' na peixaria (varejo)", res1.entitlements.escola.state === "hidden");

  // ===== 12. Master admin vê tudo =====
  check("master admin: clinica NÃO é hidden (bypass)", resMaster.entitlements.clinica.state !== "hidden");

  // ===== Resultado =====
  console.log("\n=== GET /api/entitlements/me — meta + entitlements (F1.3) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
