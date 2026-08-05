/**
 * TEST — Fatia 3.2 (ADR-153): BlueprintSeeder (seed inicial + migração).
 *
 * Cobre:
 *   1. seedInitialBlueprints cria os N esperados na 1ª chamada (5 iniciais +
 *      ADR-154 F2.1 adiciona falatu_solo → 6 total; conta é derivada de
 *      INITIAL_BLUEPRINTS.length pra não regredir a cada seed novo).
 *   2. Seed 2× é IDEMPOTENTE (não duplica).
 *   3. Cada blueprint tem shape correto (baseVertical/hidden/plan/bundle).
 *   4. Todos os 5 blueprints saem em status `published`.
 *   5. clinica_multiespecialidades tem defaultBundleKey='growth_clinica'.
 *   6. inferBlueprintKeyFor mapeia cada caso do PRD §10.
 *   7. Casos ambíguos (vertical=null, plan=null, food, hospitalidade) → null.
 *   8. migrateExistingOrgs(dryRun=true) NÃO grava mas planeja.
 *   9. migrateExistingOrgs(dryRun=false) grava.
 *  10. Orgs já assignadas: alreadyAssigned (não sobrescreve).
 *  11. Orgs sem inferência: skipped com razão.
 *  12. Migração é idempotente (2× não move nada — todas viram alreadyAssigned).
 *  13. Isolamento cross-tenant.
 *  14. Cada blueprint respeita minimumPlan válido em PLAN_GRADE.
 *  15. hiddenModules NÃO inclui core.
 *  16. runtimePlaybooks é array (mesmo vazio).
 *
 * Uso: npm run test:blueprint-seeder
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seeder-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-seeder-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  // Aguarda o dynamic import de BlueprintSeeder do initDb rodar (async).
  await new Promise((r) => setTimeout(r, 200));

  const { BlueprintSeeder, INITIAL_BLUEPRINTS, inferBlueprintKeyFor } = await import("../src/server/BlueprintSeeder.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");

  // ===== 1-4. Seed inicial =====
  const expectedCount = INITIAL_BLUEPRINTS.length; // derivado do array — não regride ao adicionar novos
  const seedResult1 = BlueprintSeeder.seedInitialBlueprints("test-actor");
  const totalOps1 = seedResult1.created.length + seedResult1.published.length + seedResult1.skipped.length;
  check(`1ª chamada de seed toca todos os ${expectedCount} blueprints (created+published+skipped >= ${expectedCount})`, totalOps1 >= expectedCount);

  const allBps = VerticalBlueprintService.listBlueprints();
  check(`seed produz ${expectedCount} blueprints (got ${allBps.length})`, allBps.length === expectedCount);
  const expectedKeys = new Set(INITIAL_BLUEPRINTS.map((b) => b.key));
  const actualKeys = new Set(allBps.map((b) => b.key));
  for (const key of expectedKeys) {
    check(`seed inclui blueprint '${key}'`, actualKeys.has(key));
  }
  const allPublished = allBps.every((b) => b.status === "published");
  check(`todos os ${expectedCount} blueprints publicados após seed`, allPublished);

  // ===== 5. clinica com defaultBundleKey =====
  const clinica = allBps.find((b) => b.key === "clinica_multiespecialidades");
  check("clinica_multiespecialidades tem defaultBundleKey='growth_clinica'", clinica?.defaultBundleKey === "growth_clinica");
  check("clinica_multiespecialidades minimumPlanId='growth'", clinica?.minimumPlanId === "growth");
  check("clinica_multiespecialidades esconde retail_floor", clinica?.config.hiddenModules.includes("retail_floor") === true);
  check("clinica_multiespecialidades esconde loja", clinica?.config.hiddenModules.includes("loja") === true);
  check("clinica_multiespecialidades esconde escola", clinica?.config.hiddenModules.includes("escola") === true);
  check("clinica_multiespecialidades requer 'clinica' + 'agenda'",
    clinica?.config.requiredModules.includes("clinica") === true && clinica?.config.requiredModules.includes("agenda") === true);

  // ===== 2. Seed 2× idempotente =====
  const seedResult2 = BlueprintSeeder.seedInitialBlueprints("test-actor");
  check("2ª chamada de seed não cria novo (created.length === 0)", seedResult2.created.length === 0);
  check(`2ª chamada de seed todos vão pra skipped ou já-published (${expectedCount})`, seedResult2.skipped.length + seedResult2.published.length === expectedCount);
  const allBpsAfter = VerticalBlueprintService.listBlueprints();
  check(`ainda ${expectedCount} blueprints (não duplicou — got ${allBpsAfter.length})`, allBpsAfter.length === expectedCount);

  // ===== 6. inferBlueprintKeyFor =====
  check("saude+autonomo → clinica_multiespecialidades", inferBlueprintKeyFor("saude", "autonomo")?.key === "clinica_multiespecialidades");
  check("saude+growth → clinica_multiespecialidades", inferBlueprintKeyFor("saude", "growth")?.key === "clinica_multiespecialidades");
  check("saude+enterprise → clinica_multiespecialidades", inferBlueprintKeyFor("saude", "enterprise")?.key === "clinica_multiespecialidades");
  check("moda+start → moda_loja_unica", inferBlueprintKeyFor("moda", "start")?.key === "moda_loja_unica");
  check("moda+scale → moda_rede_lojas", inferBlueprintKeyFor("moda", "scale")?.key === "moda_rede_lojas");
  check("moda+enterprise → moda_rede_lojas", inferBlueprintKeyFor("moda", "enterprise")?.key === "moda_rede_lojas");
  check("varejo+autonomo → peixaria_balcao_peso", inferBlueprintKeyFor("varejo", "autonomo")?.key === "peixaria_balcao_peso");
  check("servicos+autonomo → chaveiro_autonomo", inferBlueprintKeyFor("servicos", "autonomo")?.key === "chaveiro_autonomo");

  // ===== 7. Casos ambíguos =====
  check("vertical=null → null (sem inferência)", inferBlueprintKeyFor(null, "autonomo") === null);
  check("plan=null + vertical=varejo → null (só migra autonomo)", inferBlueprintKeyFor("varejo", null) === null);
  check("food+autonomo → null (sem blueprint específico)", inferBlueprintKeyFor("food", "autonomo") === null);
  check("hospitalidade+start → null", inferBlueprintKeyFor("hospitalidade", "start") === null);
  check("varejo+growth → null (só migra autonomo)", inferBlueprintKeyFor("varejo", "growth") === null);
  check("servicos+start → null (só migra autonomo)", inferBlueprintKeyFor("servicos", "start") === null);

  // ===== Setup: 6 orgs pra testar migração =====
  const orgClin = `org_${randomUUID().slice(0, 8)}`;      // saude → clinica
  const orgToulon = `org_${randomUUID().slice(0, 8)}`;    // moda enterprise → moda_rede
  const orgModaP = `org_${randomUUID().slice(0, 8)}`;     // moda start → moda_loja_unica
  const orgPeixaria = `org_${randomUUID().slice(0, 8)}`;  // varejo autonomo → peixaria
  const orgChav = `org_${randomUUID().slice(0, 8)}`;      // servicos autonomo → chaveiro
  const orgFood = `org_${randomUUID().slice(0, 8)}`;      // food → skipped
  const orgSemVert = `org_${randomUUID().slice(0, 8)}`;   // sem vertical → skipped
  const orgDel = `org_${randomUUID().slice(0, 8)}`;       // soft-deleted → NÃO aparece

  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'Clínica Alfa', 'active', 'saude', 'enterprise')`).run(randomUUID(), orgClin);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'TOULON', 'active', 'moda', 'enterprise')`).run(randomUUID(), orgToulon);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'Moda Loja', 'active', 'moda', 'start')`).run(randomUUID(), orgModaP);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'Peixaria', 'active', 'varejo', 'autonomo')`).run(randomUUID(), orgPeixaria);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'Chaveiro', 'active', 'servicos', 'autonomo')`).run(randomUUID(), orgChav);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'Restaurante', 'active', 'food', 'start')`).run(randomUUID(), orgFood);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'Sem vertical', 'active', NULL, 'autonomo')`).run(randomUUID(), orgSemVert);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, deleted_at) VALUES (?, ?, 'Deletada', 'inactive', 'saude', 'growth', CURRENT_TIMESTAMP)`).run(randomUUID(), orgDel);

  // ===== 8. dryRun =====
  const dry = BlueprintSeeder.migrateExistingOrgs({ dryRun: true, actor: "test" });
  check("dryRun planeja migrar 5 orgs (clinica, toulon, moda_p, peixaria, chav)", dry.migrated.length === 5);
  check("dryRun skipped inclui food + sem-vertical", dry.skipped.length === 2);
  check("dryRun não incluiu org soft-deleted", !dry.migrated.some((m) => m.orgId === orgDel) && !dry.skipped.some((s) => s.orgId === orgDel));
  check("dryRun errors == 0", dry.errors.length === 0);
  check("dryRun alreadyAssigned == 0 (nenhuma migrada ainda)", dry.alreadyAssigned.length === 0);
  // Verifica que NADA foi gravado
  const assignsAfterDry = db.prepare(`SELECT COUNT(*) c FROM organization_blueprints`).get() as any;
  check("dryRun não grava (0 rows em organization_blueprints)", assignsAfterDry.c === 0);

  // ===== 9. apply =====
  const applied = BlueprintSeeder.migrateExistingOrgs({ dryRun: false, actor: "test" });
  check("apply migra 5 orgs", applied.migrated.length === 5);
  check("apply grava rows", (db.prepare(`SELECT COUNT(*) c FROM organization_blueprints`).get() as any).c === 5);

  // Verifica cada assignment
  const bpOrgClin = VerticalBlueprintService.getForOrganization(orgClin);
  check("orgClin migrada pra clinica_multiespecialidades", bpOrgClin?.blueprintKey === "clinica_multiespecialidades");
  const bpToulon = VerticalBlueprintService.getForOrganization(orgToulon);
  check("orgToulon migrada pra moda_rede_lojas", bpToulon?.blueprintKey === "moda_rede_lojas");
  const bpModaP = VerticalBlueprintService.getForOrganization(orgModaP);
  check("orgModaP migrada pra moda_loja_unica", bpModaP?.blueprintKey === "moda_loja_unica");
  const bpPeixaria = VerticalBlueprintService.getForOrganization(orgPeixaria);
  check("orgPeixaria migrada pra peixaria_balcao_peso", bpPeixaria?.blueprintKey === "peixaria_balcao_peso");
  const bpChav = VerticalBlueprintService.getForOrganization(orgChav);
  check("orgChav migrada pra chaveiro_autonomo", bpChav?.blueprintKey === "chaveiro_autonomo");

  // ===== 10. alreadyAssigned =====
  const applied2 = BlueprintSeeder.migrateExistingOrgs({ dryRun: false, actor: "test" });
  check("2ª migração todas viram alreadyAssigned", applied2.alreadyAssigned.length === 5);
  check("2ª migração NÃO migrou nada", applied2.migrated.length === 0);
  check("2ª migração NÃO adicionou row", (db.prepare(`SELECT COUNT(*) c FROM organization_blueprints`).get() as any).c === 5);

  // ===== 11. skipped detalhes =====
  const skippedFood = applied.skipped.find((s) => s.orgId === orgFood);
  check("skipped food inclui razão explicativa", !!skippedFood && /vertical=food|sem inferência/i.test(skippedFood.reason));
  const skippedSem = applied.skipped.find((s) => s.orgId === orgSemVert);
  check("skipped sem-vertical inclui razão", !!skippedSem);

  // ===== 12. Isolamento cross-tenant — mudar orgClin não afeta outras =====
  const bp2 = VerticalBlueprintService.getBlueprintByKeyVersion("chaveiro_autonomo", 1);
  VerticalBlueprintService.assignToOrganization(orgClin, bp2!.id, "test");
  const orgToulonStill = VerticalBlueprintService.getForOrganization(orgToulon);
  check("orgToulon intacto após re-assign de orgClin", orgToulonStill?.blueprintKey === "moda_rede_lojas");

  // ===== 14. Cada blueprint tem minimumPlan válido =====
  const validPlans = new Set(PLAN_GRADE.map((p) => p.id));
  for (const bp of allBps) {
    if (bp.minimumPlanId) {
      check(`blueprint ${bp.key}: minimumPlanId '${bp.minimumPlanId}' válido`, validPlans.has(bp.minimumPlanId));
    }
    if (bp.defaultPlanId) {
      check(`blueprint ${bp.key}: defaultPlanId '${bp.defaultPlanId}' válido`, validPlans.has(bp.defaultPlanId));
    }
  }

  // ===== 15. hiddenModules NÃO inclui core =====
  const core = new Set(["atendimento", "contatos", "relatorios", "configuracoes"]);
  for (const bp of allBps) {
    const hiddenCore = bp.config.hiddenModules.filter((m) => core.has(m));
    check(`blueprint ${bp.key}: hiddenModules NÃO inclui CORE`, hiddenCore.length === 0);
  }

  // ===== 16. runtimePlaybooks é array =====
  for (const bp of allBps) {
    check(`blueprint ${bp.key}: runtimePlaybooks é array`, Array.isArray(bp.config.runtimePlaybooks));
  }

  // ===== Resultado =====
  console.log("\n=== BlueprintSeeder (F3.2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
