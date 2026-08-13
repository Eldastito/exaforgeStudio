/**
 * TEST — Creative Variants (PRD 10 / ADR-167 F9). DB-backed, determinístico.
 * Prova (§42, RN-SI-02): mesmo briefing → variantes A/B/C DIVERGENTES.
 *   - deriva 3 variantes com ângulos DISTINTOS (não 3 cópias);
 *   - cada briefingText é único e pronto p/ StudioService.generate (grounded no brief);
 *   - variantKey estável `{signalId}:{label}` + correlationId propagado (fio ADR-158);
 *   - procedência (evidenceMode) preservada; determinismo (mesma saída);
 *   - not-found → null; isolamento multi-tenant.
 *
 * Uso: npm run test:creative-variants
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-variants-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-variants-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CreativeVariantService: CV } = await import("../src/server/CreativeVariantService.js");
  const { OpportunityMatchingService: OM } = await import("../src/server/OpportunityMatchingService.js");
  const { StudioBriefService: SB } = await import("../src/server/StudioBriefService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");

  const A = "org_cv_A", B = "org_cv_B";
  const master = { userId: "master-1", organizationId: null };
  const setup = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET vertical='moda', external_intelligence_enabled=1 WHERE organization_id = ?`).run(org);
  };
  setup(A); setup(B);
  await VI.runResearch(master, { vertical: "moda", topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
  await AN.sync(A, "stub");
  OM.match(A, { channel: "stub", publish: true });
  const signalId = SB.listOpportunities(A)[0].signalId;

  // ═══════════════ 1. deriva 3 variantes divergentes ═══════════════
  const set = CV.variants(A, signalId);
  check("1.1 3 variantes A/B/C", set?.count === 3 && set?.variants.map((v: any) => v.label).join("") === "ABC");
  const texts = set!.variants.map((v: any) => v.briefingText);
  check("1.2 briefingTexts distintos (divergência real, não cópia)", new Set(texts).size === 3);
  const angles = set!.variants.map((v: any) => v.angleName);
  check("1.3 ângulos distintos", new Set(angles).size === 3);
  check("1.4 cada variante grounded (herda tópico do brief)", set!.variants.every((v: any) => v.briefingText.includes("concorrência")));

  // ═══════════════ 2. identidade estável + fio ADR-158 ═══════════════
  check("2.1 variantKey estável {signalId}:{label}", set!.variants.some((v: any) => v.variantKey === `${signalId}:A`));
  check("2.2 correlationId propagado em todas", set!.variants.every((v: any) => !!v.correlationId && v.correlationId === set!.correlationId));
  check("2.3 procedência (evidenceMode) preservada", set!.variants.every((v: any) => v.evidenceMode === "model_knowledge"));
  check("2.4 formato sugerido por variante (B usa story)", set!.variants.find((v: any) => v.label === "B")?.suggestedFormat === "story");

  // ═══════════════ 3. determinismo ═══════════════
  const set2 = CV.variants(A, signalId);
  check("3.1 mesma entrada → mesma saída", JSON.stringify(set) === JSON.stringify(set2));

  // ═══════════════ 4. not-found + isolamento ═══════════════
  check("4.1 signalId inexistente → null", CV.variants(A, "nope") === null);
  check("4.2 org B não deriva variantes do sinal de A", CV.variants(B, signalId) === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} creative-variants: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
