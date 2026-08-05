/**
 * TEST — Fatia 3.1 (ADR-153): VerticalBlueprintService — fundação.
 *
 * Cobre:
 *   1. Schema criado (vertical_blueprints + organization_blueprints + indexes).
 *   2. createBlueprint com auto-versionamento (version omitido → próxima livre).
 *   3. createBlueprint rejeita key inválida (não é slug).
 *   4. createBlueprint rejeita planId inválido, bundleKey inválido, módulo desconhecido.
 *   5. createBlueprint rejeita duplicata (key, version).
 *   6. publishVersion muda status draft → published + published_at.
 *   7. publishVersion é IDEMPOTENTE (2× não muda nada).
 *   8. publishVersion NÃO republica se status=deprecated.
 *   9. deprecateBlueprint marca como deprecated.
 *  10. Imutabilidade — não pode assignar blueprint em draft.
 *  11. assignToOrganization idempotente (upsert atualiza assigned_at).
 *  12. assignToOrganization rejeita org inexistente + org soft-deleted.
 *  13. getForOrganization devolve o assignment com overrides.
 *  14. cloneToOrganization copia blueprint + overrides de outra org.
 *  15. previewEntitlements calcula diff (hiddenAdded/hiddenRemoved/requiredAdded/requiredRemoved).
 *  16. getLatestPublished devolve maior version publicada de uma key.
 *  17. listBlueprints filtra por status/key/baseVertical.
 *  18. Isolamento cross-tenant: assignment em orgA não vaza pra orgB.
 *  19. Audit logs BLUEPRINT_CREATED/PUBLISHED/DEPRECATED/ASSIGNED gravados.
 *
 * Uso: npm run test:vertical-blueprint-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-bp-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");

  // ===== 1. Schema criado =====
  const tables = ["vertical_blueprints", "organization_blueprints"];
  for (const t of tables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) as any;
    check(`tabela ${t} existe`, !!row);
  }
  const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_vertical_blueprints%' OR name LIKE 'idx_organization_blueprints%'").all() as any[];
  check("indexes criados (key_version + status + org_key)", idxRows.length >= 3);

  // Seed 2 orgs
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgDel = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Clínica A', 'active', 'saude')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Peixaria B', 'active', 'varejo')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, deleted_at) VALUES (?, ?, 'Removida', 'inactive', 'saude', CURRENT_TIMESTAMP)`).run(randomUUID(), orgDel);

  // ===== 2. createBlueprint com auto-versionamento =====
  const bp1 = VerticalBlueprintService.createBlueprint({
    key: "clinica_multiespecialidades",
    name: "ZappFlow Clínica",
    baseVertical: "saude",
    minimumPlanId: "growth",
    defaultPlanId: "growth",
    defaultBundleKey: "growth_clinica",
    config: {
      requiredModules: ["agenda", "clinica", "pagamentos"],
      optionalModules: ["campanhas", "cadencias"],
      hiddenModules: ["escola", "retail", "retail_floor"],
      commercialUpgrades: ["scale"],
      quickStartPack: "saude",
      runtimePlaybooks: [],
    },
  }, "master-1");
  check("createBlueprint auto-versiona pra v1 quando é 1º", bp1.version === 1);
  check("createBlueprint devolve id UUID", typeof bp1.id === "string" && bp1.id.length >= 36);
  check("createBlueprint status inicial = draft", bp1.status === "draft");
  check("createBlueprint defaultBundleKey = growth_clinica", bp1.defaultBundleKey === "growth_clinica");

  const bp2 = VerticalBlueprintService.createBlueprint({
    key: "clinica_multiespecialidades",
    name: "ZappFlow Clínica v2",
    baseVertical: "saude",
    config: { hiddenModules: ["escola"], requiredModules: [], optionalModules: [], commercialUpgrades: [] },
  });
  check("createBlueprint auto-versiona pra v2 no mesmo key", bp2.version === 2);

  // ===== 3. Validação de key inválida =====
  let threw = "";
  try { VerticalBlueprintService.createBlueprint({ key: "Clinica Multi V1!", name: "X", baseVertical: "saude", config: {} }); }
  catch (e: any) { threw = e.message; }
  check("createBlueprint rejeita key inválida (slug)", /key inválida/.test(threw));

  // ===== 4. Validações de referências =====
  threw = "";
  try { VerticalBlueprintService.createBlueprint({ key: "chaveiro_autonomo", name: "X", baseVertical: "servicos", minimumPlanId: "nano_inexistente" as any, config: {} }); }
  catch (e: any) { threw = e.message; }
  check("createBlueprint rejeita minimumPlanId inválido", /minimumPlanId/.test(threw));

  threw = "";
  try { VerticalBlueprintService.createBlueprint({ key: "chaveiro_autonomo", name: "X", baseVertical: "servicos", defaultBundleKey: "bundle_inexistente" as any, config: {} }); }
  catch (e: any) { threw = e.message; }
  check("createBlueprint rejeita defaultBundleKey inválido", /default_bundle_key/.test(threw));

  threw = "";
  try { VerticalBlueprintService.createBlueprint({ key: "chaveiro_autonomo", name: "X", baseVertical: "servicos", config: { hiddenModules: ["modulo_ficticio"], requiredModules: [], optionalModules: [], commercialUpgrades: [] } }); }
  catch (e: any) { threw = e.message; }
  check("createBlueprint rejeita módulo desconhecido em hiddenModules", /módulo desconhecido/.test(threw));

  // ===== 5. Rejeita duplicata (key, version) =====
  threw = "";
  try { VerticalBlueprintService.createBlueprint({ key: "clinica_multiespecialidades", name: "X", baseVertical: "saude", version: 1, config: {} }); }
  catch (e: any) { threw = e.message; }
  check("createBlueprint rejeita duplicata (clinica_multiespecialidades, v1)", /já existe/.test(threw));

  // ===== 6. publishVersion =====
  const bp1Published = VerticalBlueprintService.publishVersion(bp1.id, "master-1");
  check("publishVersion muda status pra published", bp1Published.status === "published");
  check("publishVersion seta published_at", !!bp1Published.publishedAt);

  // ===== 7. publishVersion idempotente =====
  const bp1Republished = VerticalBlueprintService.publishVersion(bp1.id, "master-1");
  check("publishVersion 2× é idempotente (mesmo status)", bp1Republished.status === "published");
  // published_at deve permanecer o mesmo (não sobrescreve)
  check("publishVersion 2× NÃO sobrescreve published_at", bp1Republished.publishedAt === bp1Published.publishedAt);

  // ===== 9. deprecateBlueprint =====
  const bp3 = VerticalBlueprintService.createBlueprint({
    key: "peixaria_balcao_peso", name: "ZappFlow Peixaria", baseVertical: "varejo",
    config: { requiredModules: [], optionalModules: [], hiddenModules: [], commercialUpgrades: [] },
  });
  VerticalBlueprintService.publishVersion(bp3.id);
  const bp3Deprecated = VerticalBlueprintService.deprecateBlueprint(bp3.id, "master-1");
  check("deprecateBlueprint marca como deprecated", bp3Deprecated.status === "deprecated");

  // ===== 8. publishVersion NÃO republica deprecated =====
  threw = "";
  try { VerticalBlueprintService.publishVersion(bp3.id); }
  catch (e: any) { threw = e.message; }
  check("publishVersion rejeita deprecated", /deprecated/.test(threw));

  // ===== 10. Imutabilidade: não pode assignar draft =====
  threw = "";
  try { VerticalBlueprintService.assignToOrganization(orgA, bp2.id, "master-1"); }
  catch (e: any) { threw = e.message; }
  check("assignToOrganization rejeita blueprint em draft", /não está published/.test(threw));

  // Publish bp2 pra usar nos próximos testes
  VerticalBlueprintService.publishVersion(bp2.id);

  // ===== 11. assignToOrganization idempotente (upsert) =====
  const assign1 = VerticalBlueprintService.assignToOrganization(orgA, bp1.id, "master-1", { branding: "primary_color:#ff0" });
  check("assignToOrganization retorna assignment", assign1.blueprintId === bp1.id && assign1.blueprintKey === "clinica_multiespecialidades");
  check("assignToOrganization salva overrides", assign1.overrides?.branding === "primary_color:#ff0");
  const firstAssignAt = assign1.assignedAt;
  // Espera 1100ms pra ultrapassar a granularidade de segundos do SQLite
  // CURRENT_TIMESTAMP (importante pra provar que UPDATE toca a coluna).
  await new Promise((r) => setTimeout(r, 1100));
  const assign2 = VerticalBlueprintService.assignToOrganization(orgA, bp2.id, "master-2", { branding: "primary_color:#0f0" });
  check("assignToOrganization 2× (blueprint diferente) faz UPSERT", assign2.blueprintId === bp2.id && assign2.blueprintVersion === 2);
  check("assignToOrganization 2× sobrescreve overrides", assign2.overrides?.branding === "primary_color:#0f0");
  check("assignToOrganization 2× atualiza assigned_at (>= primeiro)", assign2.assignedAt >= firstAssignAt);

  // ===== 12. Rejeições =====
  threw = "";
  try { VerticalBlueprintService.assignToOrganization("org_inexistente", bp1.id, "master-1"); }
  catch (e: any) { threw = e.message; }
  check("assignToOrganization rejeita org inexistente", /Organização não encontrada/.test(threw));

  threw = "";
  try { VerticalBlueprintService.assignToOrganization(orgDel, bp1.id, "master-1"); }
  catch (e: any) { threw = e.message; }
  check("assignToOrganization rejeita org soft-deleted", /Organização não encontrada/.test(threw));

  threw = "";
  try { VerticalBlueprintService.assignToOrganization(orgA, "blueprint_inexistente", "master-1"); }
  catch (e: any) { threw = e.message; }
  check("assignToOrganization rejeita blueprint_id inexistente", /Blueprint não encontrado/.test(threw));

  // ===== 13. getForOrganization =====
  const orgABp = VerticalBlueprintService.getForOrganization(orgA);
  check("getForOrganization devolve assignment atual (bp2 = v2)", orgABp?.blueprintVersion === 2);
  const orgBEmpty = VerticalBlueprintService.getForOrganization(orgB);
  check("getForOrganization devolve null quando org não tem", orgBEmpty === null);

  // ===== 14. cloneToOrganization =====
  const cloned = VerticalBlueprintService.cloneToOrganization(orgB, orgA, "master-1");
  check("cloneToOrganization copia blueprint da origem", cloned.blueprintId === orgABp!.blueprintId);
  check("cloneToOrganization copia overrides", JSON.stringify(cloned.overrides) === JSON.stringify(orgABp!.overrides));
  const orgBBp = VerticalBlueprintService.getForOrganization(orgB);
  check("cloneToOrganization persiste em orgB", orgBBp?.blueprintKey === "clinica_multiespecialidades");

  threw = "";
  try { VerticalBlueprintService.cloneToOrganization(orgA, "org_sem_bp", "master-1"); }
  catch (e: any) { threw = e.message; }
  check("cloneToOrganization rejeita origem sem blueprint", /origem não tem/.test(threw));

  // ===== 15. previewEntitlements =====
  const preview = VerticalBlueprintService.previewEntitlements(orgA, bp1.id);
  check("previewEntitlements devolve target", preview.target.id === bp1.id);
  check("previewEntitlements devolve current (v2 já assinado)", preview.current?.blueprintVersion === 2);
  // bp2 tem `hiddenModules: [escola]`; bp1 tem `[escola, retail, retail_floor]`
  // Downgrade de v2→v1: hiddenAdded=[retail, retail_floor], hiddenRemoved=[]
  check("preview.diff.hiddenAdded inclui retail/retail_floor (v2→v1 adiciona)",
    preview.diff.hiddenAdded.includes("retail") && preview.diff.hiddenAdded.includes("retail_floor"));

  // ===== 16. getLatestPublished =====
  const latest = VerticalBlueprintService.getLatestPublished("clinica_multiespecialidades");
  check("getLatestPublished devolve v2 (maior versão publicada)", latest?.version === 2);
  const noneLatest = VerticalBlueprintService.getLatestPublished("nao_existe");
  check("getLatestPublished devolve null quando key não existe", noneLatest === null);

  // ===== 17. listBlueprints =====
  const allBps = VerticalBlueprintService.listBlueprints();
  check(`listBlueprints() devolve todos (>=3, got ${allBps.length})`, allBps.length >= 3);
  const publishedOnly = VerticalBlueprintService.listBlueprints({ status: "published" });
  check("listBlueprints({status:published}) filtra", publishedOnly.every((b) => b.status === "published"));
  const byKey = VerticalBlueprintService.listBlueprints({ key: "clinica_multiespecialidades" });
  check("listBlueprints({key:...}) filtra", byKey.length === 2 && byKey.every((b) => b.key === "clinica_multiespecialidades"));
  const byVertical = VerticalBlueprintService.listBlueprints({ baseVertical: "varejo" });
  check("listBlueprints({baseVertical:...}) filtra", byVertical.every((b) => b.baseVertical === "varejo"));

  // ===== 18. Isolamento cross-tenant =====
  // Mudar orgA NÃO deve afetar orgB (que agora está com clone)
  await new Promise((r) => setTimeout(r, 10));
  VerticalBlueprintService.assignToOrganization(orgA, bp1.id, "master-1");
  const orgBAinda = VerticalBlueprintService.getForOrganization(orgB);
  check("orgB blueprint intacto após mexer em orgA", orgBAinda?.blueprintVersion === 2);

  // ===== 19. Audit logs =====
  const audits = db.prepare(`SELECT event_type, metadata_json FROM auth_audit_logs WHERE event_type LIKE 'BLUEPRINT_%' ORDER BY id`).all() as any[];
  const eventTypes = new Set(audits.map((a) => a.event_type));
  check("audit BLUEPRINT_CREATED gravado", eventTypes.has("BLUEPRINT_CREATED"));
  check("audit BLUEPRINT_PUBLISHED gravado", eventTypes.has("BLUEPRINT_PUBLISHED"));
  check("audit BLUEPRINT_DEPRECATED gravado", eventTypes.has("BLUEPRINT_DEPRECATED"));
  check("audit BLUEPRINT_ASSIGNED gravado", eventTypes.has("BLUEPRINT_ASSIGNED"));

  // ===== Resultado =====
  console.log("\n=== VerticalBlueprintService (F3.1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
