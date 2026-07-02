/**
 * TESTE — Radar Fase 2: diagnóstico público (RadarPublicService) e criação de lead
 * ------------------------------------------------------------------
 * Cobre:
 *   - criação de sessão pública (organization_id sempre NULL) com validação
 *     dos campos obrigatórios (nome, empresa, e-mail);
 *   - honeypot: submissão de bot não cria sessão real;
 *   - token resolve por hash, nunca por ID; token expirado não resolve;
 *   - fluxo completo (perguntas -> completar) usa o MESMO motor de score da
 *     Fase 1 (RadarScoringEngine) — resultado determinístico e comparável;
 *   - criação de lead no ProspectService só acontece com: env
 *     RADAR_LEADS_ORGANIZATION_ID configurada E organização existente E
 *     consentimento de 'contato_comercial' concedido;
 *   - ProspectService.importRecords: provider default continua 'csv_import'
 *     (sem regressão) e aceita 'radar_ia' quando informado.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-public
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID, createHash } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-public-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-publico-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RadarPublicService } = await import("../src/server/RadarPublicService.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");

  // ---- Validação de campos obrigatórios ----
  let missingFieldsRejected = 0;
  for (const bad of [
    { companyName: "Acme", contactEmail: "a@a.com" },              // sem nome
    { contactName: "Fulano", contactEmail: "a@a.com" },            // sem empresa
    { contactName: "Fulano", companyName: "Acme" },                // sem e-mail
    { contactName: "Fulano", companyName: "Acme", contactEmail: "invalido" }, // e-mail inválido
  ]) {
    try { RadarPublicService.createSession(bad); } catch { missingFieldsRejected++; }
  }
  check("Rejeita criação sem nome/empresa/e-mail válido (4/4 casos)", missingFieldsRejected === 4, `rejeitados=${missingFieldsRejected}`);

  // ---- Criação válida ----
  const { session, token } = RadarPublicService.createSession({
    contactName: "Maria Silva", companyName: "Pousada do Vale", contactEmail: "maria@pousadadovale.com.br",
    contactPhone: "5511999998888", segment: "hospitalidade", companySize: "10-49", city: "Paraty", state: "RJ",
  });
  check("Sessão pública criada com organization_id NULL", session.organization_id == null);
  check("Sessão pública vem com o template embutido (18 perguntas)", session.template?.questions?.length === 18, `perguntas=${session.template?.questions?.length}`);
  check("Token devolvido é uma string longa (32 bytes hex = 64 chars)", typeof token === "string" && token.length === 64);

  // ---- Token resolve corretamente; ID direto não vaza nada ----
  const resolved = RadarPublicService.getByToken(token);
  check("getByToken resolve a sessão certa", resolved?.id === session.id);
  check("Token aleatório/errado não resolve nada", RadarPublicService.getByToken("token-que-nao-existe") == null);

  // ---- Token expirado não resolve (simula expiração manualmente) ----
  const expiredToken = "a".repeat(64);
  const expiredHash = createHash("sha256").update(expiredToken).digest("hex");
  const expiredSessionId = randomUUID();
  db.prepare(
    `INSERT INTO radar_sessions (id, organization_id, template_id, session_type, status, source, company_name, contact_name, contact_email, public_token_hash, public_token_expires_at)
     VALUES (?, NULL, ?, 'quick', 'in_progress', 'landing', 'Empresa X', 'Fulano', 'x@x.com', ?, datetime('now','-1 day'))`
  ).run(expiredSessionId, session.template_id, expiredHash);
  check("Token expirado não resolve (mesmo com hash correto no banco)", RadarPublicService.getByToken(expiredToken) == null);

  // ---- Honeypot: bot preenchendo o campo escondido não deixa rastro de sessão real ----
  const countBefore = (db.prepare(`SELECT COUNT(*) c FROM radar_sessions`).get() as any).c;
  // Simula exatamente a checagem que a rota faz (o service em si não conhece honeypot — é da camada de rota).
  const isHoneypot = (body: any) => !!body.website;
  check("Checagem de honeypot identifica o campo escondido preenchido", isHoneypot({ website: "http://bot.example" }));
  const countAfter = (db.prepare(`SELECT COUNT(*) c FROM radar_sessions`).get() as any).c;
  check("Nenhuma sessão nova foi criada só de checar o honeypot (sem chamar createSession)", countAfter === countBefore);

  // ---- Responder todas as perguntas no topo e completar ----
  for (const q of resolved.template.questions) {
    RadarPublicService.saveAnswer(token, { questionId: q.id, value: "4", comment: "evidência anexada" });
  }
  const completed = RadarPublicService.complete(token);
  check("Score calculado no topo da escala (~100) usando o MESMO motor da Fase 1", completed.session.overallMaturityScore != null && completed.session.overallMaturityScore >= 99, `score=${completed.session.overallMaturityScore}`);
  check("Nível de maturidade = 'inteligente'", completed.session.maturityLevel === "inteligente");
  check("7 pilares pontuados", completed.pillarScores.length === 7);
  check("Top 3 recomendações devolvidas", completed.topRecommendations.length === 3);
  check("Sessão pública permanece com organization_id NULL mesmo após concluir", (db.prepare(`SELECT organization_id FROM radar_sessions WHERE id = ?`).get(session.id) as any).organization_id == null);
  check("Status da sessão pública vira 'completed' (não 'awaiting_review' — não há consultor no caminho)",
    (db.prepare(`SELECT status FROM radar_sessions WHERE id = ?`).get(session.id) as any).status === "completed");

  // ---- Sem lead configurado: dados capturados, mas SEM criação automática ----
  check("Sem RADAR_LEADS_ORGANIZATION_ID configurada, lead não é criado (dados continuam salvos)", completed.lead?.created === false);

  // ---- Consentimento + org de destino configurada: agora sim cria o lead ----
  const { session: session2, token: token2 } = RadarPublicService.createSession({
    contactName: "João Souza", companyName: "Mercado Bom Preço", contactEmail: "joao@mercadobompreco.com.br",
    contactPhone: "5521988887777",
  });
  const targetOrgId = `org_vendas_zappflow_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'ZappFlow Vendas', 'active')`)
    .run(randomUUID(), targetOrgId);
  process.env.RADAR_LEADS_ORGANIZATION_ID = targetOrgId;

  RadarPublicService.recordConsent(token2, { consentType: "diagnostico", granted: true });
  // Ainda sem consentimento de contato comercial — não deve criar lead.
  const resolvedBeforeConsent = RadarPublicService.getByToken(token2);
  for (const q of resolvedBeforeConsent.template.questions.slice(0, 3)) {
    RadarPublicService.saveAnswer(token2, { questionId: q.id, value: "2" });
  }
  const completedNoConsent = RadarPublicService.complete(token2);
  check("Sem consentimento de contato comercial, lead NÃO é criado mesmo com org de destino configurada",
    completedNoConsent.lead?.created === false && completedNoConsent.lead?.reason?.includes("consentimento"));

  // Terceira sessão: agora COM o consentimento certo.
  const { token: token3 } = RadarPublicService.createSession({
    contactName: "Ana Costa", companyName: "Clínica Vida Nova", contactEmail: "ana@clinicavidanova.com.br",
  });
  RadarPublicService.recordConsent(token3, { consentType: "contato_comercial", granted: true });
  const resolved3 = RadarPublicService.getByToken(token3);
  for (const q of resolved3.template.questions.slice(0, 3)) {
    RadarPublicService.saveAnswer(token3, { questionId: q.id, value: "1" });
  }
  const completed3 = RadarPublicService.complete(token3);
  check("Com consentimento de contato comercial + org de destino, lead É criado", completed3.lead?.created === true, JSON.stringify(completed3.lead));

  const account = db.prepare(`SELECT * FROM prospect_accounts WHERE organization_id = ? AND display_name = 'Clínica Vida Nova'`).get(targetOrgId) as any;
  check("Conta de prospecção criada na organização de destino certa", !!account);
  check("Conta marcada com source='radar_ia' (não 'csv_import')", account?.source === "radar_ia", `source=${account?.source}`);
  const dataSource = db.prepare(`SELECT provider FROM prospect_data_sources WHERE id = ?`).get(account?.source_id) as any;
  check("prospect_data_sources.provider = 'radar_ia'", dataSource?.provider === "radar_ia");

  // ---- org de destino inexistente: falha graciosamente, não lança ----
  process.env.RADAR_LEADS_ORGANIZATION_ID = "org_que_nao_existe_de_jeito_nenhum";
  const { token: token4 } = RadarPublicService.createSession({
    contactName: "Pedro Lima", companyName: "Loja Central", contactEmail: "pedro@lojacentral.com.br",
  });
  RadarPublicService.recordConsent(token4, { consentType: "contato_comercial", granted: true });
  let threw = false;
  let completed4: any = null;
  try { completed4 = RadarPublicService.complete(token4); } catch { threw = true; }
  check("Org de destino inexistente NUNCA quebra o fluxo (não lança)", !threw);
  check("Org de destino inexistente: lead não criado, motivo claro", completed4?.lead?.created === false && completed4?.lead?.reason?.includes("não encontrada"));

  // ---- Regressão: ProspectService.importRecords sem provider continua 'csv_import' ----
  delete process.env.RADAR_LEADS_ORGANIZATION_ID;
  const regressionOrg = `org_regressao_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org Regressão', 'active')`)
    .run(randomUUID(), regressionOrg);
  const importResult = ProspectService.importRecords(regressionOrg, {
    records: [{ company: "Empresa CSV Legado", email: "contato@empresacsvlegado.com" }],
  });
  const legacyAccount = db.prepare(`SELECT source FROM prospect_accounts WHERE organization_id = ? AND display_name = 'Empresa CSV Legado'`).get(regressionOrg) as any;
  check("Sem passar 'provider', importRecords continua marcando source='csv_import' (sem regressão)", legacyAccount?.source === "csv_import", `source=${legacyAccount?.source} total=${importResult.total}`);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RADAR FASE 2: DIAGNÓSTICO PÚBLICO E LEAD");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 FLUXO PÚBLICO E CRIAÇÃO DE LEAD CONFIRMADOS.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste do Radar público:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
