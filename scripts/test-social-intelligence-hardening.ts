/**
 * TEST — Production Readiness / Wiring (PRD 10 / ADR-167 F18). FECHA o ADR-167.
 * Guarda de PRODUÇÃO: verifica que a fiação da espinha social (F1–F17) está INTACTA —
 * serviços importáveis, rota `/social` montada, passes no Scheduler, todos os testes de
 * regressão wired, runbook presente. Se alguém remover um elo por acidente, a CI pega.
 *
 * Uso: npm run test:social-intelligence-hardening
 */
import fs from "fs"; import path from "path";
const ROOT = process.cwd();   // os testes rodam da raiz do repo

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

async function main() {
  // ═══════════════ 1. serviços da espinha social importáveis ═══════════════
  const SERVICES = [
    "SocialChannelProvider", "SocialConnectionService", "InstagramChannelProvider",
    "SocialAnalyticsService", "CompetitiveIntelligenceProvider", "CompetitiveIntelligenceService",
    "VerticalSocialIntelligenceService", "OpportunityMatchingService", "StudioBriefService",
    "CreativeVariantService", "EditorialCalendarService", "SocialPublishCommandHandler",
    "GovernedPublishService", "SocialAttributionService", "CreativeLearningService",
    "SocialProactivityService", "SocialEntitlementService",
  ];
  for (const s of SERVICES) {
    let ok = false;
    try { const m = await import(`../src/server/${s}.js`); ok = !!(m as any)[s] || !!(m as any).default; } catch { ok = false; }
    check(`serviço importável: ${s}`, ok);
  }

  // ═══════════════ 2. rota /social montada + rotas-chave presentes ═══════════════
  const server = read("server.ts");
  check("rota /social montada em server.ts", /protectedApi\.use\("\/social", socialRoutes\)/.test(server) && /routes\/social\.js/.test(server));
  const socialRoutes = read("src/server/routes/social.ts");
  for (const r of ["/connections", "/analytics/:channel/sync", "/opportunities/match", "/studio/brief/:signalId", "/studio/variants/:signalId", "/studio/calendar", "/publish", "/attribution/resolve", "/creative-learning/sweep", "/proactive", "/entitlement"]) {
    check(`rota presente: ${r}`, socialRoutes.includes(`"${r}"`) || socialRoutes.includes(`'${r}'`));
  }

  // ═══════════════ 3. passes no Scheduler.tick (§42 — sem 2º Scheduler) ═══════════════
  const sched = read("src/server/Scheduler.ts");
  for (const p of ["SocialAnalyticsService", "OpportunityMatchingService", "SocialAttributionService", "CreativeLearningService"]) {
    check(`passe no Scheduler.tick: ${p}.pass()`, new RegExp(`${p}\\.pass\\(\\)`).test(sched));
  }

  // ═══════════════ 4. governança: publicação é comando registrado ═══════════════
  const handler = read("src/server/SocialPublishCommandHandler.ts");
  check("SocialPublishCommandHandler registra 'social_publish' no executor", /commandTypes:\s*\["social_publish"\]/.test(handler) && /CommandExecutorService\.registerHandler\(SocialPublishCommandHandler\)/.test(handler));
  check("ConfirmationEngine conhece 'social_publish'", read("src/server/ConfirmationEngine.ts").includes(`"social_publish"`));

  // ═══════════════ 5. todos os testes de regressão wired (CI matrix deriva daqui) ═══════════════
  const pkg = JSON.parse(read("package.json"));
  const TESTS = [
    "social-channel-contract", "social-connection-hub", "social-provider-instagram",
    "social-analytics-sync", "competitive-intelligence", "vertical-social-intelligence",
    "opportunity-matching", "studio-brief", "creative-variants", "editorial-calendar",
    "governed-publishing", "social-attribution", "creative-learning", "social-proactivity",
    "social-entitlement", "social-hardening", "social-golden-paths",
  ];
  for (const t of TESTS) check(`test wired: test:${t}`, typeof pkg.scripts[`test:${t}`] === "string");

  // ═══════════════ 6. runbook presente ═══════════════
  check("runbook social presente", fs.existsSync(path.join(ROOT, "docs/runbook/social-intelligence-operacao.md")));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-intelligence-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
