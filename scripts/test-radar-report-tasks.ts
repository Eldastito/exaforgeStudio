/**
 * TESTE — Radar Fase 4/5: relatório em PDF, ponte com Tarefas, lembrete de
 * reavaliação
 * ------------------------------------------------------------------
 * Cobre:
 *   - generateReport() funciona MESMO SEM OPENAI_API_KEY configurada (a
 *     narrativa por IA é best-effort — o PDF sai igual, só sem essa seção);
 *   - generateReport() rejeita sessão ainda sem score calculado;
 *   - createTasksFromRecommendations() só cria tarefa para recomendações de
 *     prioridade 'alta', é IDEMPOTENTE (clicar duas vezes não duplica) e
 *     isola por organização (ref_label não colide entre orgs diferentes);
 *   - reassessmentReminderPass() só notifica sessão concluída há 90+ dias, e
 *     é IDEMPOTENTE via dedupeKey (rodar duas vezes não duplica a notificação);
 *   - toda ação relevante gera evento em auth_audit_logs.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-report-tasks
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-report-tasks-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-relatorio-1234567890";
delete process.env.OPENAI_API_KEY; // confirma que o relatório funciona sem IA configurada

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
    ModuleService.applyVertical(orgId, "outro");
    const mods = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgId) as any).enabled_modules);
    ModuleService.setModules(orgId, [...mods, "radar"]);
    return orgId;
  }

  const orgA = seedOrg("A");
  const orgB = seedOrg("B");
  const template = (RadarService.listTemplates(orgA) as any[])[0];

  // 'receita' fraco + todo o resto forte -> businessImpact alto (o pilar
  // ruim é justamente o que os casos de uso de maior prioridade do catálogo
  // miram) SEM penalizar prontidão/alinhamento/governança -- é a combinação
  // que de fato produz recomendações de prioridade 'alta' no motor real
  // (RadarScoringEngine). Responder tudo igual (só "4" ou só "0") nunca
  // chega em 'alta': ou o impacto de negócio fica zerado (tudo "4"), ou a
  // prontidão/governança também caem junto (tudo "0") e cancelam o ganho.
  function completeSession(orgId: string, weakReceita: boolean) {
    const session = RadarService.createSession(orgId, `actor_${orgId}`, { templateId: template.id, companyName: `Empresa ${orgId}` });
    const full = RadarService.getTemplateWithQuestions(orgId, template.id) as any;
    for (const q of full.questions) {
      const value = weakReceita && q.pillar === "receita" ? "0" : "4";
      RadarService.saveAnswer(orgId, session.id, `actor_${orgId}`, { questionId: q.id, value, comment: "evidência" });
    }
    return RadarService.completeSession(orgId, session.id, `actor_${orgId}`) as any;
  }

  // ---- Relatório: sessão sem score calculado é rejeitada ----
  const draftSession = RadarService.createSession(orgA, "actor_A", { templateId: template.id, companyName: "Rascunho" });
  let rejectedDraftReport = false;
  try { await RadarService.generateReport(orgA, draftSession.id, "actor_A"); } catch { rejectedDraftReport = true; }
  check("generateReport() rejeita sessão sem score calculado", rejectedDraftReport);

  // ---- Sessão A: 'receita' fraco, resto forte -> pelo menos 1 recomendação 'alta' ----
  const sessionA = completeSession(orgA, true);
  check("Sessão A concluída com score alto", (sessionA.overall_maturity_score || 0) >= 80, `score=${sessionA.overall_maturity_score}`);
  check("Sessão A tem pelo menos 1 recomendação de prioridade 'alta'", sessionA.recommendations.some((r: any) => r.priority_band === "alta"));

  // ---- Relatório funciona SEM OpenAI configurada (narrativa é best-effort) ----
  const report = await RadarService.generateReport(orgA, sessionA.id, "actor_A");
  check("generateReport() funciona sem OPENAI_API_KEY configurada", !!report.url, `url=${report.url}`);
  check("generateReport() sinaliza hasNarrative=false quando a IA não está configurada", report.hasNarrative === false);
  const reportFileName = report.url.split("/").pop();
  const reportFilePath = path.join(tmpDir, "media", "reports", reportFileName || "");
  check("PDF foi realmente escrito em disco (não só a URL devolvida)", fs.existsSync(reportFilePath) && fs.statSync(reportFilePath).size > 0, reportFilePath);

  const auditReport = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_report_generated'`).all(orgA) as any[];
  check("Evento radar_report_generated gravado", auditReport.length === 1);

  // ---- Ponte com Tarefas: só recomendações 'alta', idempotente ----
  const before = RadarService.createTasksFromRecommendations(orgA, sessionA.id, "actor_A");
  check("createTasksFromRecommendations() cria pelo menos 1 tarefa (score alto -> recomendação de prioridade alta existe)", before.created > 0, `created=${before.created}`);
  const allTasksAfterFirst = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ?`).get(orgA) as any;
  check("Tarefas criadas têm source='radar'", (db.prepare(`SELECT source FROM tasks WHERE organization_id = ? LIMIT 1`).get(orgA) as any)?.source === "radar");
  check("Tarefas criadas têm prioridade 'alta'", (db.prepare(`SELECT priority FROM tasks WHERE organization_id = ? LIMIT 1`).get(orgA) as any)?.priority === "alta");

  const second = RadarService.createTasksFromRecommendations(orgA, sessionA.id, "actor_A");
  check("Rodar de novo NÃO cria tarefas duplicadas (idempotente)", second.created === 0 && second.skipped === before.created, `created=${second.created} skipped=${second.skipped}`);
  const allTasksAfterSecond = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ?`).get(orgA) as any;
  check("Contagem total de tarefas não mudou na segunda chamada", allTasksAfterFirst.c === allTasksAfterSecond.c);

  // ---- Isolamento: sessão B, mesmo template, não colide com tarefas de A ----
  const sessionB = completeSession(orgB, true);
  const tasksB = RadarService.createTasksFromRecommendations(orgB, sessionB.id, "actor_B");
  check("Organização B cria suas PRÓPRIAS tarefas sem colidir com A (ref_label inclui sessionId)", tasksB.created > 0, `created=${tasksB.created}`);
  const crossCheck = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ? AND ref_label LIKE ?`).get(orgA, `%${sessionB.id}%`) as any;
  check("Nenhuma tarefa da sessão de B vazou para a organização A", crossCheck.c === 0);

  // ---- Sessão sem recomendação 'alta' (tudo forte, impacto de negócio zerado): createTasks não quebra, só cria 0 ----
  const orgC = seedOrg("C");
  const sessionC = completeSession(orgC, false);
  const tasksC = RadarService.createTasksFromRecommendations(orgC, sessionC.id, "actor_C");
  check("Sessão sem recomendação 'alta' não quebra (pode criar 0 tarefas)", tasksC.created >= 0);

  const auditTasks = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_tasks_created'`).all(orgA) as any[];
  check("Evento radar_tasks_created gravado a cada chamada (mesmo quando created=0)", auditTasks.length === 2);

  // ---- Lembrete de reavaliação: só sessão concluída há 90+ dias ----
  // Sessão A foi concluída "agora" (completed_at = CURRENT_TIMESTAMP) -> não deve notificar ainda.
  const passTooSoon = RadarService.reassessmentReminderPass();
  const notifTooSoon = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE organization_id = ? AND title LIKE '%reavaliar%'`).get(orgA) as any;
  check("Sessão concluída HOJE não gera lembrete de reavaliação ainda", notifTooSoon.c === 0, `checked=${passTooSoon.checked}`);

  // Simula uma sessão concluída há 120 dias.
  db.prepare(`UPDATE radar_sessions SET completed_at = datetime('now', '-120 days') WHERE id = ?`).run(sessionA.id);
  RadarService.reassessmentReminderPass();
  const notifAfter120 = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE organization_id = ? AND title LIKE '%reavaliar%'`).get(orgA) as any;
  check("Sessão concluída há 120 dias gera exatamente 1 lembrete de reavaliação", notifAfter120.c === 1, `count=${notifAfter120.c}`);

  // Roda de novo (mesma hora do Scheduler.tick rodando de novo) -> não duplica (dedupeKey).
  RadarService.reassessmentReminderPass();
  const notifAfterSecondPass = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE organization_id = ? AND title LIKE '%reavaliar%'`).get(orgA) as any;
  check("Rodar o passe de novo NÃO duplica a notificação (dedupeKey)", notifAfterSecondPass.c === 1);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RADAR FASE 4/5: RELATÓRIO, TAREFAS, REAVALIAÇÃO");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 RELATÓRIO, PONTE COM TAREFAS E REAVALIAÇÃO CONFIRMADOS.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de relatório/tarefas:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
