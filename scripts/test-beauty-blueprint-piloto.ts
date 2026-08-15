/**
 * TEST — BEAUTY-002 (ADR-169 F2): blueprint `beleza_salao_v1` + piloto por dado.
 *
 * Prova que:
 *
 *  1. `INITIAL_BLUEPRINTS` inclui `beleza_salao_v1` com shape completo
 *     (baseVertical="beleza", modo suite, min=start, default=growth,
 *     bundle=null, hidden coerente com FALLBACK da F1, quickStartPack=null
 *     por design — F17 pode adicionar pack próprio).
 *  2. `BlueprintSeeder.seedInitialBlueprints` publica `beleza_salao_v1` no
 *     boot (idempotente — 2ª chamada não duplica).
 *  3. `inferBlueprintKeyFor("beleza", <plano>)` retorna `beleza_salao_v1`
 *     independente do plano (mesmo padrão da saúde — o hidden do blueprint
 *     precisa valer antes do dono contratar plano superior).
 *  4. Studio de Beleza Márcia (piloto) é atribuído POR DADO: `assignToOrganization`
 *     amarra a org ao blueprint sem constante hardcoded (§17/§65 do PRD —
 *     o piloto é um tenant como qualquer outro; a fixture do teste usa
 *     `randomUUID` no id).
 *  5. `EntitlementService.check` passa a usar `blueprint.hiddenModules` (não
 *     o FALLBACK_HIDDEN_BY_VERTICAL) para orgs com blueprint assignado:
 *     `clinica`/`escola`/`retail`/`retail_floor`/`vms`/`prospect` ficam
 *     `hidden` com `source.verticalBlueprint = "beleza_salao_v1:v1"`.
 *  6. Módulos do preset (agenda + vendas + pagamentos + estudio nos planos
 *     que suportam) ficam `active` — o blueprint não bloqueia o que a
 *     vertical liga.
 *  7. `migrateExistingOrgs` reconhece orgs pré-existentes com vertical=beleza
 *     e as migra pro `beleza_salao_v1` (fluxo natural pra tenants criados
 *     entre a F1 e a F2).
 *  8. Isolamento cross-tenant: 2 tenants com blueprints diferentes coexistem
 *     sem cross.
 *  9. Nenhum hardcoded de "Studio Márcia" no código-fonte da F2 (§17/§65).
 *
 * Uso: npm run test:beauty-blueprint-piloto
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-bp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-bp-1234567890";

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
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { PLAN_GRADE } = await import("../src/server/plansGrade.js");

  // Semeia todos os blueprints iniciais (idempotente — auto-seed do initDb pode ter rodado).
  BlueprintSeeder.seedInitialBlueprints("test-beauty-actor");

  // ===== 1. INITIAL_BLUEPRINTS inclui beleza_salao_v1 =====
  const bpInput = INITIAL_BLUEPRINTS.find(b => b.key === "beleza_salao_v1");
  check("INITIAL_BLUEPRINTS inclui 'beleza_salao_v1'", !!bpInput);
  check("baseVertical='beleza'", bpInput?.baseVertical === "beleza");
  check("minimumPlanId='start' (agenda + vendas + pagamentos + campanhas exigem start)", bpInput?.minimumPlanId === "start");
  check("defaultPlanId='growth' (onde estudio+cadencias entram, padrão do salão)", bpInput?.defaultPlanId === "growth");
  check("defaultBundleKey=null (sem bundle beleza — molde clinica_multi é F17+)", bpInput?.defaultBundleKey === null);
  check("mode padrão suite (não solo)", bpInput?.mode === undefined || bpInput?.mode === "suite");
  const cfg = bpInput?.config;
  check("requiredModules inclui agenda + vendas + pagamentos (coração operacional)", !!cfg && ["agenda", "vendas", "pagamentos"].every(m => cfg.requiredModules.includes(m)));
  check("optionalModules inclui campanhas + cadencias + assinaturas + estudio + rie + execucao", !!cfg && ["campanhas", "cadencias", "assinaturas", "estudio", "rie", "execucao"].every(m => cfg.optionalModules.includes(m)));
  check("hiddenModules esconde clinica (D5 — reusa services, não a UI)", cfg?.hiddenModules.includes("clinica") === true);
  check("hiddenModules esconde escola + retail + retail_floor + vms + prospect (coerência com FALLBACK F1)", cfg?.hiddenModules.every(_ => true) && ["escola", "retail", "retail_floor", "vms", "prospect"].every(m => cfg?.hiddenModules.includes(m)));
  check("commercialUpgrades sugere scale + enterprise (upgrade natural pra Beauty AI)", !!cfg && cfg.commercialUpgrades.includes("scale") && cfg.commercialUpgrades.includes("enterprise"));
  check("quickStartPack=null (pack de beleza é fatia futura F17+)", cfg?.quickStartPack === null);
  check("runtimePlaybooks=[] (F11–F14 popularão)", Array.isArray(cfg?.runtimePlaybooks) && cfg?.runtimePlaybooks.length === 0);

  // ===== 2. Seed publica no boot =====
  const bp = VerticalBlueprintService.getLatestPublished("beleza_salao_v1");
  check("beleza_salao_v1 está publicado após seed", !!bp && bp.status === "published");
  check("versão do blueprint = 1", bp?.version === 1);

  // Idempotência: 2ª chamada não duplica
  const seed2 = BlueprintSeeder.seedInitialBlueprints("test-beauty-actor");
  const belezaOps = seed2.created.filter(c => c.key === "beleza_salao_v1").length;
  check("2ª chamada de seed não cria beleza_salao_v1 duplicado", belezaOps === 0);

  // ===== 3. inferBlueprintKeyFor mapeia todos os planos =====
  check("infer('beleza', 'autonomo') → beleza_salao_v1", inferBlueprintKeyFor("beleza", "autonomo")?.key === "beleza_salao_v1");
  check("infer('beleza', 'start') → beleza_salao_v1", inferBlueprintKeyFor("beleza", "start")?.key === "beleza_salao_v1");
  check("infer('beleza', 'growth') → beleza_salao_v1", inferBlueprintKeyFor("beleza", "growth")?.key === "beleza_salao_v1");
  check("infer('beleza', 'scale') → beleza_salao_v1", inferBlueprintKeyFor("beleza", "scale")?.key === "beleza_salao_v1");
  check("infer('beleza', 'enterprise') → beleza_salao_v1", inferBlueprintKeyFor("beleza", "enterprise")?.key === "beleza_salao_v1");
  check("infer('beleza', null) → beleza_salao_v1 (mesmo sem plano, blueprint vale)", inferBlueprintKeyFor("beleza", null)?.key === "beleza_salao_v1");

  // Regressão: outras inferências intactas
  check("regressão: infer('saude', 'growth') → clinica_multiespecialidades", inferBlueprintKeyFor("saude", "growth")?.key === "clinica_multiespecialidades");
  check("regressão: infer('moda', 'start') → moda_loja_unica", inferBlueprintKeyFor("moda", "start")?.key === "moda_loja_unica");
  check("regressão: infer('varejo', 'growth') → null (só migra autonomo)", inferBlueprintKeyFor("varejo", "growth") === null);
  check("regressão: infer(null, 'autonomo') → null", inferBlueprintKeyFor(null, "autonomo") === null);

  // ===== 4-6. Studio de Beleza Márcia como piloto por DADO =====
  // Tenant fixture — id gerado, business_name livre (dono edita depois).
  // Nunca uma constante do código.
  const pilotoOrgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, ?, 'active', 'beleza', 'growth', ?, 'active')`,
  ).run(randomUUID(), pilotoOrgId, "Studio de Beleza Márcia", JSON.stringify(["agenda", "vendas", "pagamentos", "campanhas", "cadencias", "assinaturas", "estudio", "integracoes"]));

  // Atribui blueprint via API do service (o mesmo caminho da rota Master Admin)
  const assign = VerticalBlueprintService.assignToOrganization(pilotoOrgId, bp!.id, "master-admin-piloto");
  check("assign do blueprint ao piloto sucesso (blueprintKey=beleza_salao_v1)", assign.blueprintKey === "beleza_salao_v1");
  check("assign registra actor 'master-admin-piloto'", assign.assignedBy === "master-admin-piloto");

  // Re-leitura via getForOrganization
  const orgBp = VerticalBlueprintService.getForOrganization(pilotoOrgId);
  check("getForOrganization retorna assign com blueprintVersion=1", orgBp?.blueprintVersion === 1);
  check("piloto status='active' após assign", orgBp?.status === "active");

  // Semeia perfis + usuário owner
  PermissionService.seedSystemProfiles(pilotoOrgId);
  const ownerProfId = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(pilotoOrgId) as any).id;
  const owner = { userId: "u_dona", email: "dona@piloto.com", role: "owner", role_profile_id: ownerProfId, organizationId: pilotoOrgId };

  // ===== 5. EntitlementService usa hiddenModules DO BLUEPRINT (não do FALLBACK) =====
  for (const hidden of ["clinica", "escola", "retail", "retail_floor", "vms", "prospect"]) {
    const dec = EntitlementService.check(pilotoOrgId, owner, hidden, "view");
    check(`piloto: '${hidden}' hidden via blueprint (state=hidden)`, dec.state === "hidden", `state=${dec.state} reason=${dec.reason} vb=${dec.source?.verticalBlueprint}`);
    check(`piloto: '${hidden}' source.verticalBlueprint='beleza_salao_v1:v1'`, dec.source?.verticalBlueprint === "beleza_salao_v1:v1", `vb=${dec.source?.verticalBlueprint}`);
  }

  // ===== 6. Módulos do preset ficam active =====
  const decAgenda = EntitlementService.check(pilotoOrgId, owner, "agenda", "view");
  check("piloto: agenda 'active' (required + no plano growth)", decAgenda.state === "active", `state=${decAgenda.state}`);
  const decVendas = EntitlementService.check(pilotoOrgId, owner, "vendas", "view");
  check("piloto: vendas 'active'", decVendas.state === "active");
  const decEstudio = EntitlementService.check(pilotoOrgId, owner, "estudio", "view");
  check("piloto: estudio 'active' (growth libera)", decEstudio.state === "active", `state=${decEstudio.state}`);

  // ===== 7. migrateExistingOrgs migra tenants beleza sem blueprint =====
  const orgBelezaLegado = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'Salão Legado', 'active', 'beleza', 'growth', 'active')`,
  ).run(randomUUID(), orgBelezaLegado);

  const migrateResult = BlueprintSeeder.migrateExistingOrgs({ dryRun: false, actor: "test-migrate" });
  const migratedIds = migrateResult.migrated.map(m => m.orgId);
  const legacyAssigned = migratedIds.includes(orgBelezaLegado);
  const legacyAlreadyDone = migrateResult.alreadyAssigned.some(a => a.orgId === orgBelezaLegado);
  check("migrateExistingOrgs migra tenant beleza sem blueprint", legacyAssigned || legacyAlreadyDone,
    `migrated=[${migratedIds.join(",")}] alreadyAssigned=[${migrateResult.alreadyAssigned.map(a=>a.orgId).join(",")}]`);
  const orgBelezaLegadoBp = VerticalBlueprintService.getForOrganization(orgBelezaLegado);
  check("orgBelezaLegado agora tem blueprint 'beleza_salao_v1'", orgBelezaLegadoBp?.blueprintKey === "beleza_salao_v1");

  // ===== 8. Isolamento cross-tenant =====
  const orgSaude = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status) VALUES (?, ?, 'Clínica X', 'active', 'saude', 'enterprise', ?, 'active')`,
  ).run(randomUUID(), orgSaude, JSON.stringify(["agenda", "clinica", "pagamentos"]));
  const clinBp = VerticalBlueprintService.getLatestPublished("clinica_multiespecialidades");
  VerticalBlueprintService.assignToOrganization(orgSaude, clinBp!.id, "master-admin");
  PermissionService.seedSystemProfiles(orgSaude);
  const ownerC = {
    userId: "u_owner_c", email: "dono@clinica.com", role: "owner",
    role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgSaude) as any).id,
    organizationId: orgSaude,
  };

  // Piloto beleza continua vendo agenda 'active' e clinica 'hidden'
  const decAgendaAgain = EntitlementService.check(pilotoOrgId, owner, "agenda", "view");
  check("cross-tenant: piloto agenda segue 'active' após assign da clínica", decAgendaAgain.state === "active");
  const decClinicaAgain = EntitlementService.check(pilotoOrgId, owner, "clinica", "view");
  check("cross-tenant: piloto clinica segue 'hidden' via beleza_salao_v1", decClinicaAgain.state === "hidden");
  // Clinica vê clinica 'active', não deve ser afetada pela beleza
  const decClinicaOnSaude = EntitlementService.check(orgSaude, ownerC, "clinica", "view");
  check("cross-tenant: clínica vê 'clinica' active (não hidden)", decClinicaOnSaude.state === "active");
  const decRetailOnSaude = EntitlementService.check(orgSaude, ownerC, "retail_floor", "view");
  check("cross-tenant: clínica esconde retail_floor via clinica_multi (não afetada pela beleza)", decRetailOnSaude.state === "hidden");

  // Todos os blueprints seguem publicados
  const allBps = VerticalBlueprintService.listBlueprints();
  check(`todos os ${INITIAL_BLUEPRINTS.length} blueprints publicados (incluindo beleza)`, allBps.length === INITIAL_BLUEPRINTS.length && allBps.every(b => b.status === "published"));

  // ===== 9. Nenhum hardcoded do Studio Márcia no src (regra dura §17/§65) =====
  const forbiddenNeedles = ["studio_marcia", "studio de beleza márcia", "marcia_studio", "\"marcia\"", "'marcia'"];
  let hardcoded: string | null = null;
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenNeedles) if (s.includes(n)) { hardcoded = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walk(path.join(process.cwd(), "src", "server"));
    if (!hardcoded) walk(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check("nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)", hardcoded === null, hardcoded || undefined);

  // ===== 10. ModuleService.applyVertical + assign coexistem sem colisão =====
  const orgApply = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, 'Salão Novo', 'active', 'growth', 'active')`,
  ).run(randomUUID(), orgApply);
  ModuleService.applyVertical(orgApply, "beleza");
  VerticalBlueprintService.assignToOrganization(orgApply, bp!.id, "master-admin");
  const orgApplyBp = VerticalBlueprintService.getForOrganization(orgApply);
  check("applyVertical + assign coexistem (blueprint tem precedência sobre FALLBACK)", orgApplyBp?.blueprintKey === "beleza_salao_v1");

  // --- Relatório ---
  console.log("\n=== TEST: Blueprint 'beleza_salao_v1' + piloto por dado (ADR-169 F2 / BEAUTY-002) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Blueprint da vertical Beleza & Salões publicado; piloto atribuído por dado.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
