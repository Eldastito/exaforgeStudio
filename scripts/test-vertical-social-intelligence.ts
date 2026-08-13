/**
 * TEST — Vertical Social Intelligence (PRD 10 / ADR-167 F6). DB-backed, determinístico.
 * Prova (§42, RN-EI-4, REUTILIZAR): consolida SEM motor/cache/budget novos —
 *   - EXTERNO: lê o pool COMPARTILHADO via ResearchBrokerService (opt-in + freshness +
 *     cache L2/L3), NUNCA pesquisa; procedência (evidenceMode) exposta; tópico sem
 *     entrada fresca → available:false honesto;
 *   - PRÓPRIO: desempenho de posts da org via SocialAnalyticsService (F4); sem histórico
 *     → own null (não inventa);
 *   - broker desligado → externo opt_out honesto; caveats explicam as lacunas;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:vertical-social-intelligence
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vsi-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vsi-12345";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { VerticalSocialIntelligenceService: VSI } = await import("../src/server/VerticalSocialIntelligenceService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");

  const A = "org_vsi_A", B = "org_vsi_B";
  const master = { userId: "master-1", organizationId: null };
  const enableExternal = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET external_intelligence_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  enableExternal(A);
  // B fica com o padrão (external desligado) — organization_settings sem a flag.
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run("os-B", B);

  // Semeia o COMPARTILHADO (fresco) pra 2 dos 3 tópicos default; 'formatos' fica ausente.
  await VI.runResearch(master, { vertical: "moda", topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
  await VI.runResearch(master, { vertical: "moda", topic: "tendências", ttlDays: 7 }, { providerName: "stub" });
  // Semeia analytics PRÓPRIOS da org A no canal 'stub'.
  await AN.sync(A, "stub");

  // ═══════════════ 1. consolidação completa (externo + próprio) ═══════════════
  const view = VSI.assemble(A, { vertical: "moda", channel: "stub" });
  check("1.1 brokerEnabled true", view.brokerEnabled === true);
  const byTopic = Object.fromEntries(view.external.map((e: any) => [e.topic, e]));
  check("1.2 concorrência disponível do pool compartilhado (F5)", byTopic["concorrência"]?.available === true);
  check("1.3 tendências disponível", byTopic["tendências"]?.available === true);
  check("1.4 formatos ausente → available:false honesto", byTopic["formatos"]?.available === false && !!byTopic["formatos"]?.reason);
  check("1.5 procedência exposta (evidenceMode model_knowledge — stub)", byTopic["concorrência"]?.evidenceMode === "model_knowledge");
  check("1.6 freshness (validUntil) presente no item fresco", !!byTopic["concorrência"]?.validUntil && view.freshness.anyFresh === true);
  check("1.7 cacheLevel/source presente (reusa cache L2/L3)", !!byTopic["concorrência"]?.source);

  // próprio (F4)
  check("1.8 own presente com summary da própria conta", view.own !== null && view.own?.summary?.posts === 2);
  check("1.9 own.topPosts lista os posts próprios", Array.isArray(view.own?.topPosts) && (view.own?.topPosts.length || 0) === 2);
  check("1.10 caveat model_knowledge_only (sem fonte viva)", view.caveats.includes("external_model_knowledge_only"));

  // ═══════════════ 2. broker desligado → externo opt_out honesto ═══════════════
  const viewB = VSI.assemble(B, { vertical: "moda", channel: "stub" });
  check("2.1 brokerEnabled false", viewB.brokerEnabled === false);
  check("2.2 todo tópico externo indisponível (opt_out)", viewB.external.every((e: any) => e.available === false));
  check("2.3 caveat external_intelligence_off + no_fresh", viewB.caveats.includes("external_intelligence_off") && viewB.caveats.includes("no_fresh_external_intelligence"));

  // ═══════════════ 3. sem analytics próprios → own null honesto ═══════════════
  const viewNoOwn = VSI.assemble(A, { vertical: "moda", channel: "youtube" });
  check("3.1 own null quando o canal não tem histórico (não inventa)", viewNoOwn.own === null);
  check("3.2 caveat no_own_analytics", viewNoOwn.caveats.includes("no_own_analytics"));

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  await AN.sync(B, "stub");
  const viewBOwn = VSI.assemble(B, { vertical: "moda", channel: "stub" });
  check("4.1 B vê seus próprios posts (2), não os de A", viewBOwn.own?.summary?.posts === 2);
  check("4.2 tópicos customizados respeitados", (() => { const v = VSI.assemble(A, { vertical: "moda", channel: "stub", topics: ["concorrência"] }); return v.external.length === 1 && v.external[0].topic === "concorrência"; })());

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} vertical-social-intelligence: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
