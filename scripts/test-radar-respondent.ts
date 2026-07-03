/**
 * TESTE — Radar: convite de respondente por link próprio (ADR-018)
 * ------------------------------------------------------------------
 * Cobre:
 *   - addRespondent() gera um token que RESOLVE via RadarRespondentService;
 *   - token errado/expirado/revogado NUNCA resolve;
 *   - saveAnswer() via token grava resposta com o respondent_id certo (não
 *     mistura com a resposta do dono da sessão, que tem respondent_id NULL)
 *     e sobe o status do convite de 'invited' para 'active' na 1ª resposta;
 *   - complete() marca o convite como 'completed';
 *   - respostas de respondentes DIFERENTES para a MESMA pergunta entram
 *     juntas na média do pilar (diagnóstico coletivo — comportamento
 *     documentado na ADR-018, não um bug);
 *   - sessão fora de draft/in_progress rejeita nova resposta de respondente
 *     (mesma guarda que já vale pro dono da sessão);
 *   - revogar um convite invalida o token na hora;
 *   - isolamento: token de uma sessão nunca alcança dado de outra organização.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-respondent
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-respondent-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-respondente-1234567890";

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
  const { RadarRespondentService } = await import("../src/server/RadarRespondentService.js");

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
  const session = RadarService.createSession(orgA, "owner_A", { templateId: template.id, companyName: "Empresa A LTDA" });
  const full = RadarService.getTemplateWithQuestions(orgA, template.id) as any;
  const q1 = full.questions[0];
  const q2 = full.questions[1];

  // ---- Convite gera token que resolve ----
  const invite = RadarService.addRespondent(orgA, session.id, "owner_A", { name: "Maria Silva", roleTitle: "Gerente Comercial" }) as any;
  check("addRespondent() devolve um inviteToken de 64 chars (32 bytes hex)", typeof invite.inviteToken === "string" && invite.inviteToken.length === 64);
  check("addRespondent() devolve inviteUrl no formato esperado", invite.inviteUrl === `/radar-ia/respond/${invite.inviteToken}`);
  check("Convite começa com status 'invited'", invite.respondent.status === "invited");

  const resolved = RadarRespondentService.getByToken(invite.inviteToken);
  check("Token do convite resolve via RadarRespondentService", resolved?.respondent?.id === invite.respondent.id);
  check("Contexto resolvido traz o template com as 18 perguntas", resolved?.template?.questions?.length === 18);
  check("Contexto resolvido traz o nome da empresa", resolved?.session?.companyName === "Empresa A LTDA");

  check("Token aleatório/errado não resolve nada", RadarRespondentService.getByToken("token-que-nao-existe") == null);
  check("Token vazio não resolve nada (nem lança)", RadarRespondentService.getByToken("") == null);

  // ---- Token expirado não resolve ----
  const expiredToken = "b".repeat(64);
  const expiredHash = createHash("sha256").update(expiredToken).digest("hex");
  db.prepare(
    `INSERT INTO radar_respondents (id, session_id, organization_id, name, status, invite_token_hash, invite_token_expires_at)
     VALUES (?, ?, ?, 'Expirado', 'invited', ?, datetime('now','-1 day'))`
  ).run(randomUUID(), session.id, orgA, expiredHash);
  check("Token expirado não resolve (mesmo com hash correto no banco)", RadarRespondentService.getByToken(expiredToken) == null);

  // ---- saveAnswer via token grava com respondent_id certo, sobe status pra 'active' ----
  RadarRespondentService.saveAnswer(invite.inviteToken, { questionId: q1.id, value: "3", comment: "conferido" });
  const afterFirstAnswer = RadarRespondentService.getByToken(invite.inviteToken);
  check("Status do convite sobe para 'active' na 1ª resposta", afterFirstAnswer.respondent.status === "active");
  check("Resposta aparece no contexto do respondente", afterFirstAnswer.answers.some((a: any) => a.question_id === q1.id));

  const answerRow = db.prepare(`SELECT respondent_id FROM radar_answers WHERE session_id = ? AND question_id = ?`).get(session.id, q1.id) as any;
  check("Resposta gravada com o respondent_id certo (não NULL)", answerRow.respondent_id === invite.respondent.id);

  // Dono da sessão responde a MESMA pergunta — deve ser uma linha SEPARADA (respondent_id NULL).
  RadarService.saveAnswer(orgA, session.id, "owner_A", { questionId: q1.id, value: "1" });
  const bothAnswers = db.prepare(`SELECT respondent_id FROM radar_answers WHERE session_id = ? AND question_id = ?`).all(session.id, q1.id) as any[];
  check("Dono da sessão e respondente têm respostas SEPARADAS pra mesma pergunta (não sobrescreve)", bothAnswers.length === 2, `linhas=${bothAnswers.length}`);

  // ---- Sessão fora de draft/in_progress rejeita nova resposta ----
  for (const q of full.questions) {
    if (!db.prepare(`SELECT 1 FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id IS NULL`).get(session.id, q.id)) {
      RadarService.saveAnswer(orgA, session.id, "owner_A", { questionId: q.id, value: "2" });
    }
  }
  RadarService.completeSession(orgA, session.id, "owner_A");
  let rejectedAfterComplete = false;
  try { RadarRespondentService.saveAnswer(invite.inviteToken, { questionId: q2.id, value: "2" }); }
  catch { rejectedAfterComplete = true; }
  check("Sessão já concluída rejeita nova resposta de respondente (mesma guarda do dono)", rejectedAfterComplete);

  // ---- complete() marca o convite (num segundo respondente, sessão ainda em progresso) ----
  const session2 = RadarService.createSession(orgA, "owner_A", { templateId: template.id, companyName: "Empresa A2" });
  const invite2 = RadarService.addRespondent(orgA, session2.id, "owner_A", { name: "João Souza" }) as any;
  const full2 = RadarService.getTemplateWithQuestions(orgA, template.id) as any;
  RadarRespondentService.saveAnswer(invite2.inviteToken, { questionId: full2.questions[0].id, value: "4" });
  const completedCtx = RadarRespondentService.complete(invite2.inviteToken);
  check("complete() marca o convite como 'completed'", completedCtx.respondent.status === "completed");

  // ---- Diagnóstico coletivo: 2 respondentes diferentes pra mesma sessão nova ----
  const session3 = RadarService.createSession(orgA, "owner_A", { templateId: template.id, companyName: "Empresa A3" });
  const full3 = RadarService.getTemplateWithQuestions(orgA, template.id) as any;
  const inviteX = RadarService.addRespondent(orgA, session3.id, "owner_A", { name: "Respondente X" }) as any;
  const inviteY = RadarService.addRespondent(orgA, session3.id, "owner_A", { name: "Respondente Y" }) as any;
  // X responde tudo no máximo, Y responde tudo no mínimo -> pilar deve terminar no MEIO (média), não em 0 nem 100.
  for (const q of full3.questions) {
    RadarRespondentService.saveAnswer(inviteX.inviteToken, { questionId: q.id, value: "4" });
    RadarRespondentService.saveAnswer(inviteY.inviteToken, { questionId: q.id, value: "0" });
  }
  RadarService.completeSession(orgA, session3.id, "owner_A");
  const collective = RadarService.getSession(orgA, session3.id) as any;
  check("Diagnóstico coletivo: pilar reflete a MÉDIA dos dois respondentes (nem 0 nem 100)",
    collective.overall_maturity_score != null && collective.overall_maturity_score > 40 && collective.overall_maturity_score < 60,
    `score=${collective.overall_maturity_score}`);

  // ---- Revogar invalida o token na hora ----
  const session4 = RadarService.createSession(orgA, "owner_A", { templateId: template.id, companyName: "Empresa A4" });
  const inviteRevoke = RadarService.addRespondent(orgA, session4.id, "owner_A", { name: "Respondente Z" }) as any;
  check("Token ainda resolve antes de revogar", RadarRespondentService.getByToken(inviteRevoke.inviteToken) != null);
  RadarService.revokeRespondent(orgA, session4.id, "owner_A", inviteRevoke.respondent.id);
  check("Token NÃO resolve mais depois de revogado", RadarRespondentService.getByToken(inviteRevoke.inviteToken) == null);
  let rejectedRevokedAnswer = false;
  try { RadarRespondentService.saveAnswer(inviteRevoke.inviteToken, { questionId: full3.questions[0].id, value: "2" }); }
  catch { rejectedRevokedAnswer = true; }
  check("Convite revogado rejeita nova resposta", rejectedRevokedAnswer);

  // ---- Isolamento: revogar/listar respondente de uma sessão de A não afeta B ----
  const sessionB = RadarService.createSession(orgB, "owner_B", { templateId: template.id, companyName: "Empresa B" });
  let rejectedCrossOrgRevoke = false;
  try { RadarService.revokeRespondent(orgB, sessionB.id, "owner_B", invite.respondent.id); }
  catch { /* respondente de A não existe na sessão de B -> "changes === 0" -> lança */ rejectedCrossOrgRevoke = true; }
  check("Organização B não consegue revogar respondente de sessão de A", rejectedCrossOrgRevoke);

  // ---- Auditoria ----
  const auditAdded = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_respondent_added'`).all(orgA) as any[];
  check("Cada convite gera evento radar_respondent_added", auditAdded.length >= 5, `eventos=${auditAdded.length}`);
  const auditRevoked = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_respondent_revoked'`).all(orgA) as any[];
  check("Revogação gera evento radar_respondent_revoked", auditRevoked.length === 1);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RADAR: CONVITE DE RESPONDENTE POR LINK PRÓPRIO");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 CONVITE DE RESPONDENTE CONFIRMADO.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste do respondente:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
