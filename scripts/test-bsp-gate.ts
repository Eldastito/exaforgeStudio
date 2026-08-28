/**
 * TEST — BusinessSkillsPackService (Track C do PRD-PEL-01, F4 Gate).
 * DB-backed, determinístico. Prova:
 *   1. isSoftLaunch: lê BSP_SOFT_LAUNCH em runtime (default true);
 *   2. checkAccess: soft launch ON → sempre allowed;
 *   3. checkAccess: soft launch OFF → orgId vazio → missing_org;
 *   4. checkAccess: soft launch OFF + config null → default (todas ligadas);
 *   5. checkAccess: soft launch OFF + dimension desligada → dimension_disabled;
 *   6. checkAccess: soft launch OFF + enabled_dimensions vazio → dimension_disabled;
 *   7. checkAccess: soft launch OFF + dimension permitida → allowed;
 *   8. Combinações por dimensão (pricing/rfp/local_marketing);
 *   9. Isolamento multi-tenant no gate;
 *  10. Ligar/desligar dimensão em runtime.
 *
 * Uso: npm run test:bsp-gate
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bsp-gate-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bsp-gate-1234567890abcdef";
// Começa com soft launch ON (default explícito)
process.env.BSP_SOFT_LAUNCH = "1";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  await import("../src/server/db.js");
  const { BusinessSkillsPackService: BSP } =
    await import("../src/server/BusinessSkillsPackService.js");

  const ORG_A = "org-alpha-gate";
  const ORG_B = "org-beta-gate";

  // ═══════════════ 1. isSoftLaunch ═══════════════
  process.env.BSP_SOFT_LAUNCH = "1";
  check("1.1 BSP_SOFT_LAUNCH=1 → true", BSP.isSoftLaunch() === true);

  process.env.BSP_SOFT_LAUNCH = "true";
  check("1.2 BSP_SOFT_LAUNCH=true → true", BSP.isSoftLaunch() === true);

  process.env.BSP_SOFT_LAUNCH = "0";
  check("1.3 BSP_SOFT_LAUNCH=0 → false", BSP.isSoftLaunch() === false);

  process.env.BSP_SOFT_LAUNCH = "false";
  check("1.4 BSP_SOFT_LAUNCH=false → false", BSP.isSoftLaunch() === false);

  delete process.env.BSP_SOFT_LAUNCH;
  check("1.5 undefined → default true (bake-in)", BSP.isSoftLaunch() === true);

  // case-insensitive
  process.env.BSP_SOFT_LAUNCH = "FALSE";
  check("1.6 BSP_SOFT_LAUNCH=FALSE (case-insensitive) → false", BSP.isSoftLaunch() === false);

  // ═══════════════ 2. Soft launch ON → sempre allowed ═══════════════
  process.env.BSP_SOFT_LAUNCH = "1";
  const softA = BSP.checkAccess(ORG_A);
  check("2.1 soft ON + orgId → allowed=true", softA.allowed === true);
  check("2.2 soft ON → soft_launch=true", softA.soft_launch === true);
  check("2.3 soft ON + sem code", softA.code === undefined);

  const softNoOrg = BSP.checkAccess("");
  check("2.4 soft ON + orgId vazio → ainda allowed (bake-in)",
    softNoOrg.allowed === true);

  const softDim = BSP.checkAccess(ORG_A, "pricing");
  check("2.5 soft ON + dimension → allowed", softDim.allowed === true);

  // ═══════════════ 3. Soft launch OFF ═══════════════
  process.env.BSP_SOFT_LAUNCH = "0";

  const offNoOrg = BSP.checkAccess("");
  check("3.1 soft OFF + orgId vazio → missing_org",
    !offNoOrg.allowed && offNoOrg.code === "missing_org");
  check("3.2 soft OFF + orgId vazio → soft_launch=false",
    offNoOrg.soft_launch === false);

  // ═══════════════ 4. Config null → default (todas ligadas) ═══════════════
  const noConfig = BSP.checkAccess(ORG_A);
  check("4.1 soft OFF + config null → allowed (default: todas dims ligadas)",
    noConfig.allowed === true);

  const noConfigPricing = BSP.checkAccess(ORG_A, "pricing");
  check("4.2 soft OFF + config null + dim=pricing → allowed",
    noConfigPricing.allowed === true);

  const noConfigRfp = BSP.checkAccess(ORG_A, "rfp");
  check("4.3 soft OFF + config null + dim=rfp → allowed",
    noConfigRfp.allowed === true);

  const noConfigLM = BSP.checkAccess(ORG_A, "local_marketing");
  check("4.4 soft OFF + config null + dim=local_marketing → allowed",
    noConfigLM.allowed === true);

  // ═══════════════ 5. Dimension desligada ═══════════════
  BSP.updateOrgConfig(ORG_A, { enabled_dimensions: ["pricing"] });
  const denyRfp = BSP.checkAccess(ORG_A, "rfp");
  check("5.1 rfp desligado → allowed=false",
    denyRfp.allowed === false);
  check("5.2 rfp desligado → code=dimension_disabled",
    denyRfp.code === "dimension_disabled");
  check("5.3 rfp desligado → reason em PT-BR",
    typeof denyRfp.reason === "string" && denyRfp.reason.includes("rfp"));

  const denyLM = BSP.checkAccess(ORG_A, "local_marketing");
  check("5.4 local_marketing desligado → deny",
    !denyLM.allowed && denyLM.code === "dimension_disabled");

  const allowPricing = BSP.checkAccess(ORG_A, "pricing");
  check("5.5 pricing ainda ligado → allowed", allowPricing.allowed === true);

  // Sem dimension informada — allowed se qualquer uma ligada
  const anyOn = BSP.checkAccess(ORG_A);
  check("5.6 sem dimension informada + pelo menos 1 ligada → allowed",
    anyOn.allowed === true);

  // ═══════════════ 6. enabled_dimensions vazio ═══════════════
  BSP.updateOrgConfig(ORG_A, { enabled_dimensions: [] });
  const noneOn = BSP.checkAccess(ORG_A);
  check("6.1 enabled_dimensions vazio + sem dim → deny",
    !noneOn.allowed && noneOn.code === "dimension_disabled");

  const noneOnPricing = BSP.checkAccess(ORG_A, "pricing");
  check("6.2 enabled_dimensions vazio + dim=pricing → deny",
    !noneOnPricing.allowed && noneOnPricing.code === "dimension_disabled");

  // ═══════════════ 7. Todas as dimensões ligadas ═══════════════
  BSP.updateOrgConfig(ORG_A, {
    enabled_dimensions: ["pricing", "rfp", "local_marketing"],
  });
  check("7.1 todas ligadas + pricing → allowed",
    BSP.checkAccess(ORG_A, "pricing").allowed === true);
  check("7.2 todas ligadas + rfp → allowed",
    BSP.checkAccess(ORG_A, "rfp").allowed === true);
  check("7.3 todas ligadas + local_marketing → allowed",
    BSP.checkAccess(ORG_A, "local_marketing").allowed === true);
  check("7.4 todas ligadas + sem dim → allowed",
    BSP.checkAccess(ORG_A).allowed === true);

  // ═══════════════ 8. Combinação parcial ═══════════════
  BSP.updateOrgConfig(ORG_A, { enabled_dimensions: ["pricing", "rfp"] });
  check("8.1 [pricing,rfp] + pricing → allowed",
    BSP.checkAccess(ORG_A, "pricing").allowed === true);
  check("8.2 [pricing,rfp] + rfp → allowed",
    BSP.checkAccess(ORG_A, "rfp").allowed === true);
  check("8.3 [pricing,rfp] + local_marketing → deny",
    BSP.checkAccess(ORG_A, "local_marketing").allowed === false);

  // ═══════════════ 9. Isolamento multi-tenant ═══════════════
  BSP.updateOrgConfig(ORG_B, { enabled_dimensions: ["local_marketing"] });
  check("9.1 ORG_A: pricing allowed",
    BSP.checkAccess(ORG_A, "pricing").allowed === true);
  check("9.2 ORG_B: pricing deny",
    BSP.checkAccess(ORG_B, "pricing").allowed === false);
  check("9.3 ORG_A: local_marketing deny",
    BSP.checkAccess(ORG_A, "local_marketing").allowed === false);
  check("9.4 ORG_B: local_marketing allowed",
    BSP.checkAccess(ORG_B, "local_marketing").allowed === true);

  // ═══════════════ 10. Ligar/desligar em runtime ═══════════════
  BSP.updateOrgConfig(ORG_A, { enabled_dimensions: [] });
  check("10.1 dim removida → deny",
    BSP.checkAccess(ORG_A, "pricing").allowed === false);

  BSP.updateOrgConfig(ORG_A, { enabled_dimensions: ["pricing"] });
  check("10.2 dim adicionada → allowed imediatamente",
    BSP.checkAccess(ORG_A, "pricing").allowed === true);

  // ═══════════════ 11. Soft launch volta a ON limpa o gate ═══════════════
  process.env.BSP_SOFT_LAUNCH = "1";
  BSP.updateOrgConfig(ORG_A, { enabled_dimensions: [] });
  const backOn = BSP.checkAccess(ORG_A, "rfp");
  check("11.1 soft ON de novo → allowed mesmo com dims vazias",
    backOn.allowed === true && backOn.soft_launch === true);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
