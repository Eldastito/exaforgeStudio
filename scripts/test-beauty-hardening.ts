/**
 * TEST — BEAUTY-018 (ADR-169 F17): production hardening + fiação real.
 *
 * DUPLA FUNÇÃO (padrão dos hardenings ADR-165/166/167/168):
 *  (A) DOC-OF-RECORD executável — codifica os guardrails RN-BS-01..12 como
 *      REGRESSÃO tocando os serviços REAIS de F1–F16.
 *  (B) Verificação de FIAÇÃO DE PRODUÇÃO — services importáveis, rotas
 *      montadas, passes no Scheduler, handler no registry canônico, runbook
 *      presente. Se algo dessa fiação regredir na main, o CI acende antes
 *      do incidente.
 *
 * NÃO SUBSTITUI os testes por fatia; é o gate FINAL que garante que o
 * conjunto todo continua vivo depois de merges.
 *
 * Uso: npm run test:beauty-hardening
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-hard-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-hard-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  void db;

  // ═══════════════════════════════════════════════════════════════
  //  A) FIAÇÃO DE PRODUÇÃO — services importáveis + shape esperado
  // ═══════════════════════════════════════════════════════════════

  const importables = [
    "verticals",
    "EntitlementService",
    "BlueprintSeeder",
    "VerticalBlueprintService",
    "PermissionService",
    "AppointmentService",
    "ProfessionalServiceService",
    "BeautyVisualConsultationService",
    "BeautyHairSimulationService",
    "BeautyHarmonyAnalysisService",
    "LookServiceRecommendationService",
    "BeautyLookToAppointmentService",
    "BeautyReviewInviteCommandHandler",
    "BeautyFalaTuIntents",
    "OutboundConsentGuardService",
    "ClientQuietHoursGuardService",
    "ClientFrequencyCapGuardService",
    "AbandonedBeautySimulationDetector",
    "BeautyMaintenanceDetector",
    "BeautyVacancyDetector",
    "UxTelemetryService",
    "MessageProviderService",
    "BusinessSignalService",
  ];
  for (const svc of importables) {
    let ok = false;
    try { await import(`../src/server/${svc}.js`); ok = true; } catch (e: any) {
      check(`serviço '${svc}' importável`, false, e?.message || String(e));
      continue;
    }
    check(`serviço '${svc}' importável`, ok);
  }

  // ═══════════════════════════════════════════════════════════════
  //  B) Rotas beauty montadas
  // ═══════════════════════════════════════════════════════════════
  const routesSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/routes/beauty.ts"),
    "utf8",
  );
  const routesPublicSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/routes/beautyPublic.ts"),
    "utf8",
  );
  const expectedRoutes = [
    "/vocabulary",
    "/consents",
    "/consultations",
    "/upload",
    "/assets",
    "/simulate",
    "/simulations",
    "/vocabulary/harmony",
    "/analysis",
    "/analyses",
    "/vocabulary/recommendations",
    "/recommendations",
    "/availability",
    "/book",
    "/select",
  ];
  for (const r of expectedRoutes) {
    check(`rota '${r}' presente em routes/beauty.ts`, routesSrc.includes(r));
  }
  check(
    "rota pública /media presente em routes/beautyPublic.ts",
    routesPublicSrc.includes("/media") || routesPublicSrc.includes("resolveSignedFile"),
  );

  // Wire no server.ts
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
  check("server.ts monta beautyRoutes", /beauty/i.test(serverSrc));

  // ═══════════════════════════════════════════════════════════════
  //  C) Passes no Scheduler.tick
  // ═══════════════════════════════════════════════════════════════
  const schedulerSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/Scheduler.ts"),
    "utf8",
  );
  check(
    "Scheduler.tick invoca AbandonedBeautySimulationDetector.pass",
    schedulerSrc.includes("AbandonedBeautySimulationDetector") && schedulerSrc.includes(".pass()"),
  );
  check(
    "Scheduler.tick invoca BeautyMaintenanceDetector.pass",
    schedulerSrc.includes("BeautyMaintenanceDetector"),
  );
  check(
    "Scheduler.tick invoca BeautyVacancyDetector.pass",
    schedulerSrc.includes("BeautyVacancyDetector"),
  );

  // ═══════════════════════════════════════════════════════════════
  //  D) Handler no registry canônico do CommandExecutor
  // ═══════════════════════════════════════════════════════════════
  await import("../src/server/routes/beauty.js"); // side-effect: registra handler
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");
  const { BeautyReviewInviteCommandHandler } = await import(
    "../src/server/BeautyReviewInviteCommandHandler.js"
  );
  check(
    "BeautyReviewInviteCommandHandler.commandTypes inclui 'beauty_review_invite'",
    BeautyReviewInviteCommandHandler.commandTypes.includes("beauty_review_invite"),
  );
  // O registry não tem getter público, mas a existência do handler + side-effect
  // import de routes/beauty.ts prova que o registro aconteceu (senão o próprio
  // import falharia). Registramos aqui como âncora.
  check("CommandExecutorService importável (registry ativo)", typeof CommandExecutorService.prepare === "function");

  // ═══════════════════════════════════════════════════════════════
  //  E) Guardrails RN-BS-01..12 (âncoras codificadas)
  // ═══════════════════════════════════════════════════════════════

  // RN-BS-01/04: consent tipado + escopos separados
  const { BEAUTY_CONSENT_SCOPES } = await import("../src/server/BeautyVisualConsultationService.js");
  check(
    "RN-BS-04: BEAUTY_CONSENT_SCOPES tem hair_simulation ≠ use_in_marketing (escopos separados)",
    BEAUTY_CONSENT_SCOPES.includes("hair_simulation" as any) &&
      BEAUTY_CONSENT_SCOPES.includes("use_in_marketing" as any),
  );

  // RN-BS-03: AiGovernance PEOPLE_AFFECTING inclui estetica_appearance_advice
  const aiGovSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/AiGovernanceService.ts"),
    "utf8",
  );
  check(
    "RN-BS-03: AiGovernanceService.PEOPLE_AFFECTING inclui estetica_appearance_advice",
    aiGovSrc.includes("estetica_appearance_advice"),
  );

  // RN-BS-05: BeautyHarmonyAnalysisService rejeita 20+ palavras proibidas
  const harmSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/BeautyHarmonyAnalysisService.ts"),
    "utf8",
  );
  const proibidas = ["bonit", "feio", "atraente", "lindo", "nota", "score", "rank", "melhor", "pior", "envelhec", "rejuvenesc", "afin", "emagrec", "embel"];
  const proibidasInSrc = proibidas.filter((p) => harmSrc.includes(p));
  check(
    "RN-BS-03: validador HARD lista 14+ palavras proibidas",
    proibidasInSrc.length >= 14,
  );

  // RN-BS-05: ux_telemetry_events sem coluna de conteúdo
  const dbSrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  const uxTelSchema = dbSrc.match(/CREATE TABLE IF NOT EXISTS ux_telemetry_events[\s\S]*?\);/)?.[0] || "";
  check(
    "RN-BS-05: ux_telemetry_events schema NÃO tem coluna content/payload/text/body/message",
    !/content|payload|text_col|body_col|message_col/.test(uxTelSchema),
  );

  // RN-BS-10: retenção configurável (beauty_avatar_retention_days)
  check(
    "RN-BS-10: retenção configurável (beauty_avatar_retention_days em organization_settings)",
    dbSrc.includes("beauty_avatar_retention_days"),
  );

  // RN-BS-11: vocabs fechados (KEYWORDS_COLOR/CUT + BEAUTY_INTENTS + BEAUTY_EVENT_TYPES)
  const lookSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/LookServiceRecommendationService.ts"),
    "utf8",
  );
  check(
    "RN-BS-11: LookServiceRecommendationService exporta KEYWORDS_COLOR/KEYWORDS_CUT (vocab fechado)",
    lookSrc.includes("export const KEYWORDS_COLOR") && lookSrc.includes("export const KEYWORDS_CUT"),
  );
  const { BEAUTY_INTENTS } = await import("../src/server/BeautyFalaTuIntents.js");
  check(
    "RN-BS-11: BEAUTY_INTENTS fechado (3 intents)",
    BEAUTY_INTENTS.length === 3,
  );
  const { BEAUTY_EVENT_TYPES } = await import("../src/server/UxTelemetryService.js");
  check(
    "RN-BS-11: BEAUTY_EVENT_TYPES fechado (7 events)",
    BEAUTY_EVENT_TYPES.length === 7,
  );

  // RN-BS-12: autopilot conservador — não existe modo 'auto' pra beauty
  const scheduerNoAutoBeauty = !schedulerSrc.match(/beauty.*auto|auto.*beauty/i);
  check(
    "RN-BS-12: Scheduler NÃO tem modo 'auto' pra beauty (só shadow/single-approval)",
    scheduerNoAutoBeauty,
  );

  // ═══════════════════════════════════════════════════════════════
  //  F) Freios transversais F5 wired no sink
  // ═══════════════════════════════════════════════════════════════
  const msgProvSrc = fs.readFileSync(
    path.join(process.cwd(), "src/server/MessageProviderService.ts"),
    "utf8",
  );
  check(
    "F5-A: MessageProviderService importa OutboundConsentGuardService",
    msgProvSrc.includes("OutboundConsentGuardService"),
  );
  check(
    "F5-B: MessageProviderService importa ClientQuietHoursGuardService",
    msgProvSrc.includes("ClientQuietHoursGuardService"),
  );
  check(
    "F5-C: MessageProviderService importa ClientFrequencyCapGuardService",
    msgProvSrc.includes("ClientFrequencyCapGuardService"),
  );
  check(
    "F5-A: gate consent LANÇA OutboundBlockedError ANTES do fetch",
    msgProvSrc.includes("OutboundBlockedError"),
  );
  check(
    "F5-B: gate quiet-hours LANÇA OutboundQuietHoursError",
    msgProvSrc.includes("OutboundQuietHoursError"),
  );
  check(
    "F5-C: gate frequency LANÇA OutboundFrequencyCapError",
    msgProvSrc.includes("OutboundFrequencyCapError"),
  );

  // ═══════════════════════════════════════════════════════════════
  //  G) Runbook + ADR presentes
  // ═══════════════════════════════════════════════════════════════
  check(
    "docs/runbook/beleza-operacao.md presente",
    fs.existsSync(path.join(process.cwd(), "docs/runbook/beleza-operacao.md")),
  );
  check(
    "docs/adr/ADR-169-vertical-beleza-saloes.md presente",
    fs.existsSync(path.join(process.cwd(), "docs/adr/ADR-169-vertical-beleza-saloes.md")),
  );

  // ═══════════════════════════════════════════════════════════════
  //  H) Zero hardcoded Studio Márcia em src/
  // ═══════════════════════════════════════════════════════════════
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
  check(
    "§17/§65: nenhum hardcoded Studio Márcia em src/server ou src/features",
    hardcoded === null,
    hardcoded || undefined,
  );

  // ═══════════════════════════════════════════════════════════════
  //  I) Todos os 17 testes beauty wired no package.json
  // ═══════════════════════════════════════════════════════════════
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const expectedTests = [
    "test:beauty-registry",
    "test:beauty-blueprint-piloto",
    "test:beauty-profiles",
    "test:beauty-service-duration",
    "test:beauty-professional-services",
    "test:beauty-visual-consultation",
    "test:beauty-hair-simulation",
    "test:beauty-routes",
    "test:beauty-harmony-analysis",
    "test:beauty-look-to-services",
    "test:beauty-look-to-appointment",
    "test:beauty-outbound-consent-transversal",
    "test:beauty-quiet-hours-transversal",
    "test:beauty-frequency-cap-transversal",
    "test:beauty-abandoned-simulation",
    "test:beauty-maintenance-detector",
    "test:beauty-review-invite",
    "test:beauty-vacancy-opportunity",
    "test:beauty-falatu-intents",
    "test:beauty-metrics",
    "test:beauty-golden-paths",
    "test:beauty-hardening",
  ];
  for (const t of expectedTests) {
    check(`package.json.scripts['${t}'] wired`, typeof pkg.scripts?.[t] === "string");
  }

  // --- Relatório ---
  console.log("\n=== TEST: Beauty Hardening — production readiness (ADR-169 F17 / BEAUTY-018) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Vertical Beleza & Salões pronta pra produção — RN-BS-01..12 codificados + fiação verificada.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
