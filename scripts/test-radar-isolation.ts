/**
 * TESTE DE ISOLAMENTO — ZappFlow Radar de Execução IA (Fase 1)
 * ------------------------------------------------------------------
 * Mesmo espírito de scripts/test-tenant-isolation.ts, focado no módulo novo:
 *   - sessão/respostas/scores do Radar nunca cruzam entre organizações;
 *   - o módulo 'radar' nasce DESLIGADO por padrão (opt-in), inclusive para a
 *     vertical genérica "outro" — nenhuma organização "ganha" o módulo sozinha;
 *   - o motor de score é determinístico (mesmas respostas => mesmo resultado);
 *   - "não sei" nunca vira "0" e a confiança da resposta reflete a evidência
 *     disponível (PRD §6.3/§7.4);
 *   - toda ação relevante gera evento em auth_audit_logs (namespace radar_*).
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-isolation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-isolation-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-isolamento-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RadarService } = await import("../src/server/RadarService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    ModuleService.applyVertical(orgId, "outro"); // vertical mais permissiva do catálogo
    return orgId;
  }

  const orgA = seedOrg("A");
  const orgB = seedOrg("B");

  // 1) 'radar' nasce desligado mesmo na vertical "outro" (opt-in explícito).
  check("Módulo 'radar' desligado por padrão (vertical 'outro')", ModuleService.isEnabled(orgA, "radar") === false);

  // Ativa só para A (simula o admin ligando o piloto em Configurações › Módulos).
  const orgRowA = db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgA) as any;
  const modsA = JSON.parse(orgRowA.enabled_modules as string);
  ModuleService.setModules(orgA, [...modsA, "radar"]);
  check("Módulo 'radar' liga por ativação explícita (só A)",
    ModuleService.isEnabled(orgA, "radar") === true && ModuleService.isEnabled(orgB, "radar") === false);

  // 2) Template global semeado no boot está disponível para ambas as orgs.
  const templatesA = RadarService.listTemplates(orgA) as any[];
  check("Template padrão semeado e visível (global)", templatesA.length > 0, `templates=${templatesA.length}`);
  const template = RadarService.getTemplateWithQuestions(orgA, templatesA[0].id) as any;
  check("Template tem as 18 perguntas do diagnóstico rápido", template.questions.length === 18, `perguntas=${template.questions.length}`);

  // 3) Cria sessão em A e responde todas as perguntas com a melhor opção (score 4).
  const sessionA = RadarService.createSession(orgA, "user_a", { templateId: template.id, companyName: "Empresa A" });
  check("Sessão criada pertence à organização A", sessionA.organization_id === orgA);

  for (const q of template.questions) {
    RadarService.saveAnswer(orgA, sessionA.id, "user_a", { questionId: q.id, value: "4", comment: "evidência: relatório mensal" });
  }
  const recalculated = RadarService.recalculate(orgA, sessionA.id, "user_a");
  check("Score geral calculado com todas as respostas no topo (~100)",
    recalculated.overall_maturity_score != null && recalculated.overall_maturity_score >= 99,
    `score=${recalculated.overall_maturity_score}`);
  check("Nível de maturidade = 'inteligente' no topo da escala", recalculated.maturity_level === "inteligente");
  check("7 pilares pontuados", recalculated.pillarScores.length === 7, `pilares=${recalculated.pillarScores.length}`);
  check("Confiança alta quando toda resposta tem comentário/evidência (~0.75)",
    recalculated.confidence_score != null && Math.abs(recalculated.confidence_score - 0.75) < 0.01,
    `confidence=${recalculated.confidence_score}`);
  check("Recomendações determinísticas foram geradas", recalculated.recommendations.length === 12,
    `recomendações=${recalculated.recommendations.length}`);

  // 4) Determinismo: recalcular de novo sem mudar respostas dá o MESMO resultado.
  const recalculatedAgain = RadarService.recalculate(orgA, sessionA.id, "user_a");
  check("Recalcular sem mudar respostas é determinístico (mesmo score)",
    recalculatedAgain.overall_maturity_score === recalculated.overall_maturity_score);

  // 5) "Não sei" nunca vira "0" e reduz a confiança.
  const q1 = template.questions[0];
  RadarService.saveAnswer(orgA, sessionA.id, "user_a", { questionId: q1.id, isNotKnown: true });
  const afterNotKnown = RadarService.recalculate(orgA, sessionA.id, "user_a");
  check("Score cai (não zera) quando uma resposta vira 'não sei'",
    afterNotKnown.overall_maturity_score! < recalculated.overall_maturity_score! && afterNotKnown.overall_maturity_score! > 50,
    `score=${afterNotKnown.overall_maturity_score}`);

  // 6) Sessão de B não enxerga nada de A (cross-tenant).
  const sessionB = RadarService.createSession(orgB, "user_b", { templateId: template.id, companyName: "Empresa B" });
  check("B lendo a sessão de A retorna null (RadarService.getSession bloqueia cross-tenant)",
    RadarService.getSession(orgB, sessionA.id) == null);
  const sessionsB = RadarService.listSessions(orgB) as any[];
  check("Listagem de sessões de B não inclui a sessão de A",
    sessionsB.some((s) => s.id === sessionB.id) && !sessionsB.some((s) => s.id === sessionA.id));

  const rawAnswersB = db.prepare(`SELECT id FROM radar_answers WHERE session_id = ?`).all(sessionA.id) as any[];
  const rawAnswersBOwn = db.prepare(`SELECT id FROM radar_answers WHERE organization_id = ?`).all(orgB) as any[];
  check("Respostas de A não aparecem quando filtradas por organization_id de B",
    rawAnswersB.length > 0 && rawAnswersBOwn.length === 0);

  // 7) Toda ação relevante ficou registrada em auth_audit_logs (namespace radar_*).
  const auditEvents = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type LIKE 'radar_%'`).all(orgA) as any[];
  const eventTypes = new Set(auditEvents.map((e) => e.event_type));
  check("Auditoria registrou radar_session_created", eventTypes.has("radar_session_created"));
  check("Auditoria registrou radar_score_calculated", eventTypes.has("radar_score_calculated"));
  check("Auditoria registrou radar_recommendation_generated", eventTypes.has("radar_recommendation_generated"));

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE DE ISOLAMENTO — RADAR DE EXECUÇÃO IA");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0
    ? "  🔒 ISOLAMENTO E DETERMINISMO CONFIRMADOS.\n"
    : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de isolamento do Radar:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
