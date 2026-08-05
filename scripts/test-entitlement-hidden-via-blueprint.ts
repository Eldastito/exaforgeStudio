/**
 * TEST — Fatia 1.4 (ADR-153): `hidden` real via blueprint.hiddenModules.
 *
 * Substitui o `HIDDEN_BY_VERTICAL` estático da F1.1 pelo
 * `blueprint.config.hiddenModules` quando a org tem blueprint assignado
 * (F3.2). Fallback pro mapa estático quando não tem — protege orgs em
 * transição.
 *
 * Cobre:
 *   1. Org SEM blueprint: fallback estático continua funcionando.
 *   2. Org COM blueprint: `hidden` vem do config.hiddenModules dele.
 *   3. Blueprint esconde módulos DIFERENTES do fallback estático.
 *   4. `source.verticalBlueprint` populado com "<key>:v<version>" quando
 *      blueprint assignado; null quando não.
 *   5. Mudar de blueprint muda `hidden` imediatamente (sem cache).
 *   6. `overview` pre-resolve blueprint UMA vez (test verifica shape).
 *   7. Master admin bypass ainda funciona.
 *   8. Cross-tenant: orgA com blueprint não afeta orgB sem blueprint.
 *   9. Órfão: blueprint referenciado foi deletado — cai no fallback estático.
 *  10. Regressão: state=hidden quando plano NÃO cobre e blueprint esconde
 *      (mesmo comportamento do F1.1).
 *  11. Regressão: state=available_to_buy quando plano NÃO cobre mas blueprint
 *      NÃO esconde (ex.: peixaria (varejo autonomo) blueprint peixaria_v1 NÃO
 *      esconde 'compras' — vira available_to_buy).
 *  12. reason='hidden_by_vertical' preservado (public API — frontend switch).
 *
 * Uso: npm run test:entitlement-hidden-via-blueprint
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-hidden-bp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-hidden-bp-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  // Aguarda seed automático (dynamic import) do initDb.
  await new Promise((r) => setTimeout(r, 200));

  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { BlueprintSeeder } = await import("../src/server/BlueprintSeeder.js");
  const { MASTER_ADMIN_EMAIL } = await import("../src/server/config/secret.js");

  // Garante blueprints seedados
  BlueprintSeeder.seedInitialBlueprints("test-actor");

  // ── Setup 3 orgs ──
  const orgPeixaria = `org_${randomUUID().slice(0, 8)}`; // varejo, autonomo — vai receber peixaria_balcao_peso
  const orgLegacy = `org_${randomUUID().slice(0, 8)}`;   // varejo, autonomo — SEM blueprint (fallback estático)
  const orgClinica = `org_${randomUUID().slice(0, 8)}`;  // saude — vai receber clinica_multi

  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Peixaria', 'active', 'varejo', 'autonomo', ?, 'active')`)
    .run(randomUUID(), orgPeixaria, JSON.stringify(["catalogo", "vendas", "copiloto", "pagamentos"]));
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Legacy', 'active', 'varejo', 'autonomo', ?, 'active')`)
    .run(randomUUID(), orgLegacy, JSON.stringify(["catalogo", "vendas", "copiloto"]));
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Clínica Multi', 'active', 'saude', 'enterprise', ?, 'active')`)
    .run(randomUUID(), orgClinica, JSON.stringify(["agenda", "clinica", "pagamentos"]));

  PermissionService.seedSystemProfiles(orgPeixaria);
  PermissionService.seedSystemProfiles(orgLegacy);
  PermissionService.seedSystemProfiles(orgClinica);

  const owner = (orgId: string) => ({
    userId: `u_${orgId}`, email: `dono@${orgId}.com`, role: "owner",
    role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgId) as any).id,
    organizationId: orgId,
  });
  const master = { userId: "u0", email: MASTER_ADMIN_EMAIL, role: "owner", organizationId: orgPeixaria };

  // Assign blueprints
  const bpPeixaria = VerticalBlueprintService.getLatestPublished("peixaria_balcao_peso")!;
  const bpClinica = VerticalBlueprintService.getLatestPublished("clinica_multiespecialidades")!;
  VerticalBlueprintService.assignToOrganization(orgPeixaria, bpPeixaria.id, "test");
  VerticalBlueprintService.assignToOrganization(orgClinica, bpClinica.id, "test");

  // ===== 1. Org SEM blueprint: fallback estático =====
  // Legacy é varejo autonomo → FALLBACK_HIDDEN_BY_VERTICAL['varejo'] = ['clinica', 'escola']
  const legacyClinica = EntitlementService.check(orgLegacy, owner(orgLegacy), "clinica", "view");
  check("legacy (sem blueprint): clinica state=hidden (fallback estático)", legacyClinica.state === "hidden");
  check("legacy: clinica reason=hidden_by_vertical", legacyClinica.reason === "hidden_by_vertical");
  check("legacy: source.verticalBlueprint = null (sem blueprint)", legacyClinica.source.verticalBlueprint === null);

  // ===== 2. Org COM blueprint: hidden vem do blueprint =====
  const peixariaClinica = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "clinica", "view");
  check("peixaria (blueprint): clinica state=hidden (blueprint.hiddenModules)", peixariaClinica.state === "hidden");
  check("peixaria: source.verticalBlueprint = 'peixaria_balcao_peso:v1'",
    peixariaClinica.source.verticalBlueprint === "peixaria_balcao_peso:v1");

  // peixaria_balcao_peso_v1 ESCONDE: clinica, escola, retail_floor, vms, prospect
  const peixariaRetailFloor = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "retail_floor", "view");
  check("peixaria: retail_floor hidden (blueprint esconde — não fallback)", peixariaRetailFloor.state === "hidden");
  const peixariaVms = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "vms", "view");
  check("peixaria: vms hidden", peixariaVms.state === "hidden");

  // ===== 3. Blueprint esconde DIFERENTE do fallback =====
  // Fallback varejo esconde: ['clinica', 'escola']. Blueprint peixaria esconde
  // MAIS: ['clinica', 'escola', 'retail_floor', 'vms', 'prospect']. Fatia F1.4
  // exercita a divergência: um módulo (vms) escondido pelo blueprint peixaria
  // NÃO é escondido pelo fallback varejo. `vms` está em ENTERPRISE.modules →
  // legacy (autonomo) vira `available_to_buy` (upgrade eligible p/ enterprise).
  const legacyVms = EntitlementService.check(orgLegacy, owner(orgLegacy), "vms", "view");
  check("legacy (sem blueprint): vms NÃO é hidden (fallback varejo não esconde)", legacyVms.state !== "hidden");
  check("legacy (sem blueprint): vms state=available_to_buy (upgrade p/ enterprise)", legacyVms.state === "available_to_buy");
  check("legacy (sem blueprint): vms upgradeTargetPlan=enterprise", legacyVms.upgradeTargetPlan === "enterprise");

  // ===== 4. source.verticalBlueprint no formato correto =====
  const clinicaAgenda = EntitlementService.check(orgClinica, owner(orgClinica), "agenda", "view");
  check("clinica: source.verticalBlueprint = 'clinica_multiespecialidades:v1'",
    clinicaAgenda.source.verticalBlueprint === "clinica_multiespecialidades:v1");

  // ===== 5. Mudar de blueprint muda hidden imediatamente =====
  // Trocar orgPeixaria pra clinica blueprint (absurdo, mas testa)
  VerticalBlueprintService.assignToOrganization(orgPeixaria, bpClinica.id, "test");
  const peixariaAgoraClinica = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "retail_floor", "view");
  // Clinica esconde retail_floor E retail E loja E escola — retail_floor ainda escondido, mas por outro motivo agora
  check("mudou blueprint: retail_floor continua hidden (clinica também esconde)", peixariaAgoraClinica.state === "hidden");
  check("mudou blueprint: source.verticalBlueprint mudou pra clinica", peixariaAgoraClinica.source.verticalBlueprint === "clinica_multiespecialidades:v1");
  // clinica NÃO esconde vms (é optional dela) — então deve virar available_to_buy ou active se ligado
  const peixariaAgoraVms = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "vms", "view");
  check("mudou pra clinica: vms NÃO mais hidden (clinica tem vms em optional)", peixariaAgoraVms.state !== "hidden");
  // Reverte
  VerticalBlueprintService.assignToOrganization(orgPeixaria, bpPeixaria.id, "test");

  // ===== 6. Overview pré-resolve blueprint uma vez =====
  const overview = EntitlementService.overview(orgPeixaria, owner(orgPeixaria));
  check("overview inclui clinica com state=hidden", overview.clinica?.state === "hidden");
  check("overview.clinica.source.verticalBlueprint preenchido", overview.clinica?.source.verticalBlueprint === "peixaria_balcao_peso:v1");
  // Todos os itens do overview devem ter o mesmo verticalBlueprint (ctx foi compartilhado)
  const allSameBlueprint = Object.values(overview).every((d: any) => d.source.verticalBlueprint === "peixaria_balcao_peso:v1");
  check("overview: TODOS os itens têm o mesmo verticalBlueprint (ctx compartilhado)", allSameBlueprint);

  // ===== 7. Master admin bypass ainda funciona =====
  const masterClinicaEmPeixaria = EntitlementService.check(orgPeixaria, master, "clinica", "view");
  check("master: clinica em peixaria = allowed (bypass, apesar de blueprint esconder)", masterClinicaEmPeixaria.allowed);
  check("master: state NÃO é hidden", masterClinicaEmPeixaria.state !== "hidden");
  check("master: reason = master_admin", masterClinicaEmPeixaria.reason === "master_admin");

  // ===== 8. Cross-tenant =====
  const clinicaClinica = EntitlementService.check(orgClinica, owner(orgClinica), "clinica", "use");
  check("clinica (blueprint clinica, plan enterprise): clinica.state=active", clinicaClinica.state === "active");
  // orgLegacy (sem blueprint) continua com fallback varejo
  const legacyClinicaAinda = EntitlementService.check(orgLegacy, owner(orgLegacy), "clinica", "view");
  check("legacy intacto após ações em outras orgs: clinica hidden", legacyClinicaAinda.state === "hidden");

  // ===== 9. Blueprint órfão (deletado direto do DB) → fallback estático =====
  const orgOrfa = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Órfã', 'active', 'servicos', 'autonomo', ?, 'active')`)
    .run(randomUUID(), orgOrfa, JSON.stringify(["catalogo", "copiloto"]));
  PermissionService.seedSystemProfiles(orgOrfa);
  // Insere organization_blueprints apontando pra blueprint inexistente
  db.prepare(`INSERT INTO organization_blueprints (organization_id, blueprint_id, blueprint_key, blueprint_version, assigned_by) VALUES (?, 'bp_inexistente', 'orfao', 99, 'test')`)
    .run(orgOrfa);
  const orfaClinica = EntitlementService.check(orgOrfa, owner(orgOrfa), "clinica", "view");
  check("órfã (blueprint deletado): cai no fallback (servicos esconde clinica)", orfaClinica.state === "hidden");
  check("órfã: source.verticalBlueprint = null (blueprint não achado)", orfaClinica.source.verticalBlueprint === null);

  // ===== 10. Regressão: hidden respeita 'plano NÃO cobre' =====
  // peixaria (autonomo) + clinica no blueprint hidden + autonomo NÃO cobre clinica = hidden
  const peixariaClinica2 = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "clinica", "view");
  check("peixaria: clinica hidden (blueprint esconde E plano não cobre)", peixariaClinica2.state === "hidden");

  // Se o plano PASSAR a cobrir, deixa de ser hidden (available_to_enable) —
  // documenta o comportamento: hidden só se NÃO coberto (§7 do PRD).
  db.prepare(`UPDATE organization_settings SET plan_id = 'enterprise' WHERE organization_id = ?`).run(orgPeixaria);
  const peixariaClinicaEnt = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "clinica", "view");
  check("peixaria em enterprise: clinica NÃO é mais hidden (plano cobre)", peixariaClinicaEnt.state !== "hidden");
  db.prepare(`UPDATE organization_settings SET plan_id = 'autonomo' WHERE organization_id = ?`).run(orgPeixaria);

  // ===== 11. Regressão: available_to_buy quando plano não cobre + NÃO hidden =====
  // orgLegacy (varejo, autonomo, sem blueprint) — 'cadencias' não está no plano autonomo,
  // não está no fallback varejo (fallback esconde só clinica + escola), tem upgrade (start/growth) → available_to_buy
  const legacyCadencias = EntitlementService.check(orgLegacy, owner(orgLegacy), "cadencias", "view");
  check("legacy: cadencias fora do plano e não hidden → available_to_buy", legacyCadencias.state === "available_to_buy");

  // ===== 12. reason='hidden_by_vertical' preservado =====
  const anyHidden = EntitlementService.check(orgPeixaria, owner(orgPeixaria), "escola", "view");
  check("reason='hidden_by_vertical' preservado (backward compat público)", anyHidden.reason === "hidden_by_vertical");

  // ===== Resultado =====
  console.log("\n=== EntitlementService hidden via Blueprint (F1.4) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
