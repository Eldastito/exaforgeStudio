/**
 * TESTE — Backlog Radar painel (ADR-025)
 * ----------------------------------------
 * Cobre os itens do pacote 2 do backlog (itens 13, 15, 17, 23; o item 01 —
 * toggle do módulo — descobriu-se JÁ resolvido por trabalho posterior, e este
 * teste comprova isso em vez de reimplementar):
 *   01. toggle do módulo Radar existe no SettingsView e o round-trip via
 *       ModuleService funciona;
 *   13. recalcular sessão (endpoint já existia; a tela agora chama — aqui
 *       valida-se o serviço que o botão usa);
 *   15. exclusão de evidência: remove a linha, desfaz o boost de confiança
 *       (0,90 -> patamar declarado correto), recalcula o score, audita;
 *   17. reenvio de convite: rotaciona o token (hash antigo morre), renova a
 *       validade, respeita status (revogado/concluído não reenviam) e valida
 *       canal antes de rotacionar;
 *   23. GET latest-score: null sem sessão pontuada; sessão awaiting_review
 *       aparece; rascunho nunca aparece; isolado por organização.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:backlog-radar-panel
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-backlog-radar-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-backlog-radar-1234567890";

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

  // ---- item 01: toggle do módulo Radar (comprovação de que JÁ existe) ----
  // A tela de Módulos passou a montar os toggles a partir do backend
  // (ModuleService.MODULE_META + /modules-overview) em vez de uma lista fixa no
  // frontend (ADR-092/093 Bloco A). O toggle do Radar existe se o módulo tem
  // metadados no catálogo do backend.
  check("Módulo 'radar' tem metadados no catálogo (toggle existe na tela de Módulos)", !!(ModuleService as any).MODULE_META?.radar?.label);

  const orgToggle = `org_toggle_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa Toggle', 'active')`).run(randomUUID(), orgToggle);
  ModuleService.setModules(orgToggle, ["catalogo"]);
  check("Módulo radar desligado -> isEnabled false", !ModuleService.isEnabled(orgToggle, "radar"));
  ModuleService.setModules(orgToggle, ["catalogo", "radar"]);
  check("Módulo radar ligado via setModules -> isEnabled true (round-trip do toggle)", ModuleService.isEnabled(orgToggle, "radar"));

  // ---- setup de sessão com respostas ----
  const orgA = seedOrg("A");
  const orgB = seedOrg("B");
  const template = (RadarService.listTemplates(orgA) as any[])[0];
  const session = RadarService.createSession(orgA, "actor_A", { templateId: template.id, companyName: "Empresa A LTDA" });
  const full = RadarService.getTemplateWithQuestions(orgA, template.id) as any;
  const scaleQuestions = full.questions.filter((q: any) => q.answer_type === "scale");
  const q1 = scaleQuestions[0];
  const q2 = scaleQuestions[1];

  RadarService.saveAnswer(orgA, session.id, "actor_A", { questionId: q1.id, value: "2" }); // sem comentário -> 0.60
  RadarService.saveAnswer(orgA, session.id, "actor_A", { questionId: q2.id, value: "3", comment: "temos rotina definida" }); // com comentário -> 0.75

  // ---- item 15: exclusão de evidência ----
  RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: q1.id, fileUrl: "/media/radar-evidence/a.png", fileName: "a.png" });
  RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: q2.id, fileUrl: "/media/radar-evidence/b.png", fileName: "b.png" });
  RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: q2.id, fileUrl: "/media/radar-evidence/c.png", fileName: "c.png" });

  const evList = RadarService.listEvidence(orgA, session.id) as any[];
  check("3 evidências anexadas no setup", evList.length === 3);
  const evQ1 = evList.find((e) => e.file_name === "a.png");
  const [evQ2a, evQ2b] = evList.filter((e) => e.file_name !== "a.png");

  // isolamento: org B não exclui evidência de org A
  let crossOrgRejected = false;
  try { RadarService.deleteEvidence(orgB, session.id, "actor_B", evQ1.id); } catch { crossOrgRejected = true; }
  check("Org B não exclui evidência de sessão da org A (isolamento)", crossOrgRejected);

  // excluir a única evidência de q1 -> confiança volta a 0,60 (sem comentário)
  const del1 = RadarService.deleteEvidence(orgA, session.id, "actor_A", evQ1.id);
  check("deleteEvidence devolve o file_url removido (para a rota apagar o arquivo)", del1.removedFileUrl === "/media/radar-evidence/a.png");
  const answersAfterDel1 = (RadarService.getSession(orgA, session.id) as any).answers;
  const a1 = answersAfterDel1.find((a: any) => a.question_id === q1.id);
  check("Última evidência excluída -> confiança volta ao patamar declarado 0,60 (sem comentário)", a1.confidence_multiplier === 0.6, `confidence=${a1.confidence_multiplier}`);

  // excluir UMA das duas evidências de q2 -> confiança PERMANECE 0,90
  RadarService.deleteEvidence(orgA, session.id, "actor_A", evQ2a.id);
  const a2mid = (RadarService.getSession(orgA, session.id) as any).answers.find((a: any) => a.question_id === q2.id);
  check("Com evidência restante, confiança permanece 0,90", a2mid.confidence_multiplier === 0.9, `confidence=${a2mid.confidence_multiplier}`);

  // excluir a última de q2 -> volta a 0,75 (tinha comentário)
  RadarService.deleteEvidence(orgA, session.id, "actor_A", evQ2b.id);
  const a2end = (RadarService.getSession(orgA, session.id) as any).answers.find((a: any) => a.question_id === q2.id);
  check("Última evidência excluída em resposta com comentário -> volta a 0,75", a2end.confidence_multiplier === 0.75, `confidence=${a2end.confidence_multiplier}`);

  const delEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_evidence_removed'`).all(orgA) as any[];
  check("Cada exclusão gera evento radar_evidence_removed", delEvent.length === 3, `eventos=${delEvent.length}`);

  let deleteMissingRejected = false;
  try { RadarService.deleteEvidence(orgA, session.id, "actor_A", evQ1.id); } catch { deleteMissingRejected = true; }
  check("Excluir evidência já excluída é rejeitado", deleteMissingRejected);

  // ---- item 17: reenvio de convite ----
  const added: any = RadarService.addRespondent(orgA, session.id, "actor_A", { name: "Maria Gestora", email: "maria@empresa.com" });
  const respondentId = added.respondent.id;
  const oldHash = (db.prepare(`SELECT invite_token_hash FROM radar_respondents WHERE id = ?`).get(respondentId) as any).invite_token_hash;

  const resent = await RadarService.resendInvite(orgA, session.id, "actor_A", respondentId, "link");
  const newHash = (db.prepare(`SELECT invite_token_hash FROM radar_respondents WHERE id = ?`).get(respondentId) as any).invite_token_hash;
  check("Reenvio rotaciona o token (hash muda)", newHash !== oldHash);
  check("Novo token bate com o novo hash (link novo funciona)", createHash("sha256").update(resent.inviteToken).digest("hex") === newHash);
  check("inviteUrl aponta para a rota pública de resposta", resent.inviteUrl.startsWith("/radar-ia/respond/"));
  const resendEvent = db.prepare(`SELECT * FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_respondent_invite_resent'`).get(orgA) as any;
  check("Reenvio gera evento radar_respondent_invite_resent", !!resendEvent);

  // canal inválido de propósito: email sem conexão Google — NÃO pode rotacionar o token
  const hashBeforeFail = newHash;
  let emailRejected = false;
  try { await RadarService.resendInvite(orgA, session.id, "actor_A", respondentId, "email"); } catch (e: any) { emailRejected = /Google/.test(e.message); }
  const hashAfterFail = (db.prepare(`SELECT invite_token_hash FROM radar_respondents WHERE id = ?`).get(respondentId) as any).invite_token_hash;
  check("E-mail sem conexão Google é rejeitado com mensagem clara", emailRejected);
  check("Falha de canal NÃO rotaciona o token (link atual continua válido)", hashAfterFail === hashBeforeFail);

  let whatsappRejected = false;
  try { await RadarService.resendInvite(orgA, session.id, "actor_A", respondentId, "whatsapp"); } catch (e: any) { whatsappRejected = /telefone/i.test(e.message); }
  check("WhatsApp sem telefone é rejeitado pedindo o telefone", whatsappRejected);

  RadarService.revokeRespondent(orgA, session.id, "actor_A", respondentId);
  let revokedRejected = false;
  try { await RadarService.resendInvite(orgA, session.id, "actor_A", respondentId, "link"); } catch { revokedRejected = true; }
  check("Convite revogado não pode ser reenviado", revokedRejected);

  let crossOrgResendRejected = false;
  try { await RadarService.resendInvite(orgB, session.id, "actor_B", respondentId, "link"); } catch { crossOrgResendRejected = true; }
  check("Org B não reenvia convite de sessão da org A (isolamento)", crossOrgResendRejected);

  // ---- item 23: latest-score ----
  check("Sem sessão pontuada -> { score: null }", RadarService.latestScore(orgB).score === null);
  check("Sessão em rascunho/andamento nunca aparece no latest-score", RadarService.latestScore(orgA).score === null);

  // responde tudo e conclui para ganhar score
  for (const q of scaleQuestions) {
    RadarService.saveAnswer(orgA, session.id, "actor_A", { questionId: q.id, value: "3" });
  }
  RadarService.completeSession(orgA, session.id, "actor_A");
  const latest = RadarService.latestScore(orgA);
  check("Sessão concluída (awaiting_review) aparece no latest-score com score numérico", typeof latest.score === "number" && latest.score! > 0, `score=${latest.score} status=${latest.status}`);
  check("latest-score devolve o sessionId certo", (latest as any).sessionId === session.id);
  check("latest-score da org B continua null (isolamento)", RadarService.latestScore(orgB).score === null);

  // ---- item 13: recalcular (o serviço que o novo botão da tela chama) ----
  const recalced = RadarService.recalculate(orgA, session.id, "actor_A") as any;
  check("Recalcular devolve a sessão com score (caminho do botão novo)", recalced.overall_maturity_score != null);
  let crossOrgRecalcRejected = false;
  try { RadarService.recalculate(orgB, session.id, "actor_B"); } catch { crossOrgRecalcRejected = true; }
  check("Org B não recalcula sessão da org A (isolamento)", crossOrgRecalcRejected);

  // ---- resultado ----
  console.log("\n=== Backlog Radar painel (ADR-025) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
