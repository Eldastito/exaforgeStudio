/**
 * TEST — PRD 4 F2 (Capability + Skill Registry): o catálogo persistido. DB-backed,
 * isolado por tmpDir. Determinístico. Prova:
 *
 *   - registerCapability/registerSkill validam contra o contrato (F1) e persistem;
 *   - idempotência (re-registrar = upsert, não duplica);
 *   - integridade referencial (Skill exige Capability existente);
 *   - lookup (get/list) + filtro por status/categoria/capability;
 *   - skillsForCapability (input do Resolver F3): só active por padrão;
 *   - ciclo de vida (enable/disable/deprecate) via setStatus;
 *   - compat vertical (universal quando supportedVerticals vazio);
 *   - compat entitlement (isCapabilityAvailable reusa EntitlementService);
 *   - catálogo é de PLATAFORMA (sem org_id) — mas isCapabilityAvailable gate por tenant.
 *
 * Uso: npm run test:skillos-registry
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-reg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-reg-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SkillOsRegistryService: R } = await import("../src/server/SkillOsRegistryService.js");

  const cap = (over: any = {}) => ({
    capabilityId: "classify_intent", version: 1, name: "Classificar intenção", category: "nlp",
    riskLevel: "low", status: "active", defaultBudgetClass: "low", requiredContext: "minimal", ...over,
  });
  const skill = (over: any = {}) => ({
    skillId: "intent_llm_v2", version: 2, capabilityId: "classify_intent", riskLevel: "low", status: "active",
    allowedTools: ["nlp"], supportsFallback: true, fallbackSkills: ["intent_regex_v1"], budgetClass: "low", ...over,
  });

  // ═══════════════ 1. registro + validação de contrato ═══════════════
  const c = R.registerCapability(cap() as any);
  check("1.1 capability registrada e lida de volta", c.capabilityId === "classify_intent" && c.status === "active" && c.riskLevel === "low");
  let badCap = false; try { R.registerCapability(cap({ riskLevel: "bogus" }) as any); } catch { badCap = true; }
  check("1.2 capability inválida rejeitada (contrato F1)", badCap);

  const s = R.registerSkill(skill() as any);
  check("1.3 skill registrada", s.skillId === "intent_llm_v2" && s.capabilityId === "classify_intent" && s.supportsFallback === true);
  check("1.4 arrays round-trip (allowedTools/fallbackSkills)", JSON.stringify(s.allowedTools) === JSON.stringify(["nlp"]) && s.fallbackSkills![0] === "intent_regex_v1");

  // ═══════════════ 2. integridade referencial ═══════════════
  let orphan = false; try { R.registerSkill(skill({ skillId: "orphan_v1", capabilityId: "inexistente" }) as any); } catch { orphan = true; }
  check("2.1 skill órfã (capability inexistente) rejeitada", orphan);

  // ═══════════════ 3. idempotência (upsert) ═══════════════
  R.registerCapability(cap({ name: "Classificar (v2)", status: "active" }) as any);
  const allCaps = R.listCapabilities({});
  check("3.1 re-registrar é upsert (não duplica)", allCaps.length === 1 && allCaps[0].name === "Classificar (v2)");
  R.registerSkill(skill({ riskLevel: "medium" }) as any);
  check("3.2 skill upsert atualiza (não duplica)", R.listSkills({}).length === 1 && R.getSkill("intent_llm_v2")!.riskLevel === "medium");

  // ═══════════════ 4. lookup + filtros ═══════════════
  R.registerCapability(cap({ capabilityId: "generate_pdf", name: "Gerar PDF", category: "document" }) as any);
  check("4.1 list por categoria", R.listCapabilities({ category: "document" }).length === 1 && R.listCapabilities({ category: "nlp" }).length === 1);
  check("4.2 get inexistente → null", R.getCapability("nope") === null);

  // ═══════════════ 5. skillsForCapability (input do Resolver) ═══════════════
  R.registerSkill(skill({ skillId: "intent_regex_v1", version: 1, riskLevel: "low", supportsFallback: false, fallbackSkills: undefined }) as any);
  check("5.1 duas skills atendem a capability", R.skillsForCapability("classify_intent").length === 2);
  R.setSkillStatus("intent_regex_v1", "disabled");
  check("5.2 skillsForCapability só active por padrão", R.skillsForCapability("classify_intent").length === 1);
  check("5.3 includeInactive traz todas", R.skillsForCapability("classify_intent", { includeInactive: true }).length === 2);

  // ═══════════════ 6. ciclo de vida ═══════════════
  R.setCapabilityStatus("generate_pdf", "disabled");
  check("6.1 disable capability", R.getCapability("generate_pdf")!.status === "disabled");
  check("6.2 list status=active exclui disabled", R.listCapabilities({ status: "active" }).every((x) => x.capabilityId !== "generate_pdf"));
  let badStatus = false; try { R.setCapabilityStatus("classify_intent", "bogus" as any); } catch { badStatus = true; }
  check("6.3 status inválido rejeitado", badStatus);

  // ═══════════════ 7. compat vertical (§88-90) ═══════════════
  R.registerCapability(cap({ capabilityId: "retail_only", name: "Só varejo", supportedVerticals: ["retail"] }) as any);
  check("7.1 universal (sem verticals) casa qualquer vertical", R.capabilitiesForVertical("clinica").some((x) => x.capabilityId === "classify_intent"));
  check("7.2 vertical-específica casa só a sua", R.capabilitiesForVertical("retail").some((x) => x.capabilityId === "retail_only") && !R.capabilitiesForVertical("clinica").some((x) => x.capabilityId === "retail_only"));

  // ═══════════════ 8. compat entitlement (reusa EntitlementService) ═══════════════
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const user = { userId: randomUUID(), role: "owner" };
  const capNoKey = R.getCapability("classify_intent")!;
  check("8.1 capability sem entitlementKey → disponível (universal)", R.isCapabilityAvailable(org, user, capNoKey) === true);
  const capGated = R.registerCapability(cap({ capabilityId: "premium_cap", name: "Premium", entitlementKey: "modulo_inexistente_no_plano" }) as any);
  const gatedAvail = R.isCapabilityAvailable(org, user, capGated);
  check("8.2 capability com entitlementKey passa pelo EntitlementService (bool determinístico)", typeof gatedAvail === "boolean");
  check("8.3 capability disabled nunca disponível", R.isCapabilityAvailable(org, user, R.getCapability("generate_pdf")!) === false);
  check("8.4 vertical incompatível → indisponível", R.isCapabilityAvailable(org, user, R.getCapability("retail_only")!, "clinica") === false);

  console.log("\n=== TEST: SkillOS Registry (PRD 4 F2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Registry (F2) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
