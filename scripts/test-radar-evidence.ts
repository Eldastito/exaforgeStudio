/**
 * TESTE — Radar: evidência anexada a uma resposta (confiança 0,90) + bugfix
 * de retomada de sessão em andamento
 * ------------------------------------------------------------------
 * Cobre:
 *   - RadarService.getSession agora devolve `answers` (e `evidence`) — sem
 *     isso, reabrir uma sessão 'in_progress' sempre parecia "nada respondido
 *     ainda" para quem chama (RadarView.tsx calcula a 1ª pergunta sem
 *     resposta a partir desse array);
 *   - addEvidence() exige que a pergunta já tenha sido respondida;
 *   - anexar evidência sobe confidence_multiplier daquela resposta para 0,90
 *     (nunca para baixo — uma resposta já em 0,75 por comentário não regride);
 *   - anexar evidência DEPOIS da sessão concluída recalcula o score/confiança
 *     na hora (calculateAndPersist), refletindo no confidence_score agregado;
 *   - isolamento por organização (org B nunca lista/anexa evidência em
 *     sessão de org A) — mesmo padrão de todo o resto do módulo.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-evidence
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-evidence-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-evidencia-1234567890";

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
  const session = RadarService.createSession(orgA, "actor_A", { templateId: template.id, companyName: "Empresa A LTDA" });
  const full = RadarService.getTemplateWithQuestions(orgA, template.id) as any;
  const q1 = full.questions[0];
  const q2 = full.questions[1];

  // ---- Bugfix: getSession devolve answers (necessário pra retomar sessão) ----
  const beforeAnswering = RadarService.getSession(orgA, session.id) as any;
  check("getSession devolve o campo 'answers' (mesmo vazio)", Array.isArray(beforeAnswering.answers));
  check("getSession devolve o campo 'evidence' (mesmo vazio)", Array.isArray(beforeAnswering.evidence));

  RadarService.saveAnswer(orgA, session.id, "actor_A", { questionId: q1.id, value: "2" }); // sem comentário -> 0.60
  const afterOneAnswer = RadarService.getSession(orgA, session.id) as any;
  check("getSession reflete a resposta recém-salva (retomada funciona)",
    afterOneAnswer.answers.some((a: any) => a.question_id === q1.id), `answers=${afterOneAnswer.answers.length}`);
  const answerRow = afterOneAnswer.answers.find((a: any) => a.question_id === q1.id);
  check("Resposta sem comentário começa com confiança 0,60", answerRow.confidence_multiplier === 0.6, `confidence=${answerRow.confidence_multiplier}`);

  // ---- addEvidence exige resposta existente ----
  let rejectedNoAnswer = false;
  try { RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: q2.id, fileUrl: "/media/radar-evidence/x.png" }); }
  catch { rejectedNoAnswer = true; }
  check("addEvidence rejeita pergunta ainda não respondida", rejectedNoAnswer);

  // ---- addEvidence sobe a confiança para 0,90 ----
  const withEvidence = RadarService.addEvidence(orgA, session.id, "actor_A", {
    questionId: q1.id, fileUrl: "/media/radar-evidence/print1.png", fileName: "print1.png", mimeType: "image/png",
  }) as any;
  const answerAfterEvidence = withEvidence.answers.find((a: any) => a.question_id === q1.id);
  check("Anexar evidência sobe a confiança da resposta para 0,90", answerAfterEvidence.confidence_multiplier === 0.9, `confidence=${answerAfterEvidence.confidence_multiplier}`);
  check("Evidência aparece no array 'evidence' da sessão", withEvidence.evidence.some((e: any) => e.file_name === "print1.png"));

  // ---- Nunca regride: resposta com comentário (0.75) + evidência continua em 0.90, não cai ----
  RadarService.saveAnswer(orgA, session.id, "actor_A", { questionId: q2.id, value: "3", comment: "Temos processo documentado." }); // -> 0.75
  const q2Answer = (RadarService.getSession(orgA, session.id) as any).answers.find((a: any) => a.question_id === q2.id);
  check("Resposta com comentário fica em 0,75 antes da evidência", q2Answer.confidence_multiplier === 0.75);
  RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: q2.id, fileUrl: "/media/radar-evidence/print2.pdf", mimeType: "application/pdf" });
  const q2AfterEvidence = (RadarService.getSession(orgA, session.id) as any).answers.find((a: any) => a.question_id === q2.id);
  check("Comentário + evidência sobe para 0,90 (não fica em 0,75)", q2AfterEvidence.confidence_multiplier === 0.9);

  // Segunda evidência na mesma resposta não derruba nem some com a primeira.
  RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: q1.id, fileUrl: "/media/radar-evidence/print1b.png", fileName: "print1b.png" });
  const q1EvidenceCount = (RadarService.getSession(orgA, session.id) as any).evidence.filter((e: any) => e.answer_id === answerRow.id).length;
  check("Duas evidências na mesma resposta ficam as duas registradas (não substitui)", q1EvidenceCount === 2, `count=${q1EvidenceCount}`);

  // ---- Recalcula na hora quando a sessão já está concluída ----
  for (const q of full.questions.slice(2)) {
    RadarService.saveAnswer(orgA, session.id, "actor_A", { questionId: q.id, value: "1" });
  }
  const completed = RadarService.completeSession(orgA, session.id, "actor_A") as any;
  const confidenceBefore = completed.confidence_score;
  RadarService.addEvidence(orgA, session.id, "actor_A", { questionId: full.questions[2].id, fileUrl: "/media/radar-evidence/extra.png" });
  const afterLateEvidence = RadarService.getSession(orgA, session.id) as any;
  check("Anexar evidência DEPOIS de concluída recalcula o confidence_score na hora",
    afterLateEvidence.confidence_score > confidenceBefore, `antes=${confidenceBefore} depois=${afterLateEvidence.confidence_score}`);
  check("Status continua 'awaiting_review' (anexar evidência não muda status)", afterLateEvidence.status === "awaiting_review");

  // ---- Isolamento por organização ----
  let rejectedCrossOrgList = false;
  try { RadarService.listEvidence(orgB, session.id); } catch { rejectedCrossOrgList = true; }
  check("Organização B não lista evidência de sessão de A", rejectedCrossOrgList);

  let rejectedCrossOrgAdd = false;
  try { RadarService.addEvidence(orgB, session.id, "actor_B", { questionId: q1.id, fileUrl: "/media/radar-evidence/invasor.png" }); }
  catch { rejectedCrossOrgAdd = true; }
  check("Organização B não anexa evidência em sessão de A", rejectedCrossOrgAdd);

  // 4 evidências legítimas até aqui: print1, print2, print1b (as 3 de cima) + "extra" (pós-conclusão).
  const evidenceForA = RadarService.listEvidence(orgA, session.id) as any[];
  check("Nenhuma evidência 'vazou' de B para a sessão de A (continuam só as 4 legítimas)", evidenceForA.length === 4, `count=${evidenceForA.length}`);

  // ---- Auditoria ----
  const auditEvents = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_evidence_added'`).all(orgA) as any[];
  check("Cada evidência anexada gera evento radar_evidence_added", auditEvents.length === 4, `eventos=${auditEvents.length}`);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RADAR: EVIDÊNCIA E RETOMADA DE SESSÃO");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 EVIDÊNCIA E RETOMADA CONFIRMADAS.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de evidência:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
