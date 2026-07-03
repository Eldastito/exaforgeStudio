/**
 * TESTE — Radar Fase 3: painel do consultor (cross-tenant) e respondentes
 * ------------------------------------------------------------------
 * Cobre:
 *   - RadarConsultantService enxerga sessões de VÁRIAS organizações ao mesmo
 *     tempo (cross-tenant DE PROPÓSITO — ver ADR-014). Isso só é seguro
 *     porque, em produção, o acesso a este serviço é feito exclusivamente
 *     através de rotas montadas atrás de requireMasterAdmin (server.ts);
 *     este teste cobre o SERVIÇO, a proteção de rota é testada por inspeção
 *     de código (mesmo padrão de /api/admin, sem teste automatizado próprio);
 *   - aprovar (`approve`) só funciona a partir de 'awaiting_review' —
 *     rejeita rascunho/sessão já aprovada;
 *   - nota do consultor (`saveNote`) persiste em next_action/consultant_user_id
 *     e cada ação gera evento em auth_audit_logs (namespace radar_*);
 *   - RadarService.addRespondent/listRespondents (uso pelo próprio tenant)
 *     respeita isolamento por organização, igual a qualquer outra tabela do
 *     Radar — organização A nunca lista/adiciona respondente numa sessão de B.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-consultant
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-consultant-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-consultor-1234567890";

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
  const { RadarConsultantService } = await import("../src/server/RadarConsultantService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    ModuleService.applyVertical(orgId, "outro");
    const mods = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgId) as any).enabled_modules);
    ModuleService.setModules(orgId, [...mods, "radar"]);
    return orgId;
  }

  function createSession(orgId: string, companyName: string) {
    const template = (RadarService.listTemplates(orgId) as any[])[0];
    return RadarService.createSession(orgId, "actor_" + orgId, { templateId: template.id, companyName });
  }

  function answerAll(sessionId: string, orgId: string, value: string) {
    const session = RadarService.getSession(orgId, sessionId) as any;
    const template = RadarService.getTemplateWithQuestions(orgId, session.template_id) as any;
    for (const q of template.questions) {
      RadarService.saveAnswer(orgId, sessionId, "actor_" + orgId, { questionId: q.id, value });
    }
  }

  const orgA = seedOrg("A");
  const orgB = seedOrg("B");

  const sessionA = createSession(orgA, "Empresa A LTDA");
  const sessionB = createSession(orgB, "Empresa B LTDA");
  answerAll(sessionA.id, orgA, "3");
  answerAll(sessionB.id, orgB, "1");
  RadarService.completeSession(orgA, sessionA.id, "actor_" + orgA);
  RadarService.completeSession(orgB, sessionB.id, "actor_" + orgB);

  // ---- Cross-tenant: o painel enxerga as DUAS organizações na mesma lista ----
  const allSessions = RadarConsultantService.listSessions() as any[];
  const orgsSeen = new Set(allSessions.map((s) => s.organization_id));
  check("Painel do consultor lista sessões de MAIS DE UMA organização", orgsSeen.has(orgA) && orgsSeen.has(orgB), `orgs=${[...orgsSeen].length}`);
  check("Cada sessão vem com o nome da empresa (org_business_name) via JOIN", allSessions.every((s) => !!s.org_business_name));

  const filtered = RadarConsultantService.listSessions({ status: "awaiting_review" }) as any[];
  check("Filtro por status funciona (só 'awaiting_review')", filtered.length === 2 && filtered.every((s) => s.status === "awaiting_review"));

  // ---- Detalhe cross-tenant: pilares, recomendações, respondentes, respostas ----
  const detailA = RadarConsultantService.getSession(sessionA.id) as any;
  check("Detalhe cross-tenant traz os 7 pilares", detailA.pillarScores?.length === 7);
  check("Detalhe cross-tenant traz recomendações", (detailA.recommendations?.length || 0) > 0);
  check("Detalhe cross-tenant traz as respostas com o título da pergunta", detailA.answers?.length > 0 && !!detailA.answers[0].question_title);

  // ---- approve() só a partir de 'awaiting_review' ----
  let rejectedDraft = false;
  const draftSession = createSession(orgA, "Empresa A - rascunho");
  try { RadarConsultantService.approve(draftSession.id, "consultor_1"); } catch { rejectedDraft = true; }
  check("Aprovar uma sessão 'draft' (não terminou o questionário) é rejeitado", rejectedDraft);

  const approved = RadarConsultantService.approve(sessionA.id, "consultor_1") as any;
  check("approve() muda o status para 'approved'", approved.status === "approved");
  check("approve() registra quem aprovou em consultant_user_id", approved.consultant_user_id === "consultor_1");

  let rejectedDouble = false;
  try { RadarConsultantService.approve(sessionA.id, "consultor_1"); } catch { rejectedDouble = true; }
  check("Aprovar de novo uma sessão já 'approved' é rejeitado (não é 'awaiting_review')", rejectedDouble);

  // ---- saveNote() ----
  const withNote = RadarConsultantService.saveNote(sessionB.id, "consultor_2", "Cliente com bom potencial de upsell em Vendas.") as any;
  check("saveNote() persiste em next_action", withNote.next_action === "Cliente com bom potencial de upsell em Vendas.");
  check("saveNote() registra consultant_user_id mesmo sem aprovar", withNote.consultant_user_id === "consultor_2");
  check("saveNote() NÃO muda o status (sessão B continua 'awaiting_review')", withNote.status === "awaiting_review");

  // ---- Auditoria: eventos do consultor ficam registrados na organização DO TENANT, não do consultor ----
  const auditA = db.prepare(`SELECT event_type, organization_id FROM auth_audit_logs WHERE organization_id = ? AND event_type LIKE 'radar_consultant%' ORDER BY created_at`).all(orgA) as any[];
  check("Evento radar_consultant_approved gravado na organização do TENANT (não do consultor)",
    auditA.some((e) => e.event_type === "radar_consultant_approved" && e.organization_id === orgA));
  const auditB = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_consultant_note_saved'`).all(orgB) as any[];
  check("Evento radar_consultant_note_saved gravado", auditB.length > 0);

  // ---- Respondentes (uso pelo próprio tenant, org-scoped) ----
  const emptyList = RadarService.listRespondents(orgA, sessionA.id) as any[];
  check("Sessão nova não tem respondente nenhum ainda", emptyList.length === 0);

  RadarService.addRespondent(orgA, sessionA.id, "actor_" + orgA, { name: "Maria Silva", roleTitle: "Gerente Comercial", area: "Vendas" });
  const listAfterAdd = RadarService.listRespondents(orgA, sessionA.id) as any[];
  check("addRespondent() adiciona e listRespondents() reflete", listAfterAdd.length === 1 && listAfterAdd[0].name === "Maria Silva");

  let rejectedNoName = false;
  try { RadarService.addRespondent(orgA, sessionA.id, "actor_" + orgA, { roleTitle: "Sem nome" }); } catch { rejectedNoName = true; }
  check("addRespondent() exige nome", rejectedNoName);

  // ---- Isolamento: organização B NUNCA acessa respondentes de sessão de A ----
  let rejectedCrossOrg = false;
  try { RadarService.listRespondents(orgB, sessionA.id); } catch { rejectedCrossOrg = true; }
  check("Organização B não consegue LISTAR respondentes de sessão de A", rejectedCrossOrg);

  let rejectedCrossOrgAdd = false;
  try { RadarService.addRespondent(orgB, sessionA.id, "actor_" + orgB, { name: "Invasor" }); } catch { rejectedCrossOrgAdd = true; }
  check("Organização B não consegue ADICIONAR respondente numa sessão de A", rejectedCrossOrgAdd);

  const stillOnlyOne = RadarService.listRespondents(orgA, sessionA.id) as any[];
  check("Nenhum respondente 'vazou' de B para a sessão de A", stillOnlyOne.length === 1);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RADAR FASE 3: PAINEL DO CONSULTOR E RESPONDENTES");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 PAINEL DO CONSULTOR E RESPONDENTES CONFIRMADOS.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste do painel do consultor:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
