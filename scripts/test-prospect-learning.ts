/**
 * TESTE — Prospect AI Fase D: memória de aprendizados (ADR-079)
 * --------------------------------------------------------------
 * Prova, offline e em banco temporário, que:
 *   - experimento vencedor grava aprendizado AUTOMATICAMENTE (com evidência e
 *     confiança derivada do z);
 *   - aprendizado novo do mesmo tipo/campanha SUPERSEDE o anterior;
 *   - registro manual, depreciação e isolamento por tenant (D4: sem global);
 *   - recommendNextAction devolve fallback determinístico sem IA disponível;
 *   - auditoria PROSPECT_LEARNING_*.
 *
 * Uso:  npm run test:prospect-learning
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prospect-learning-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-prospect-learning-1234567890";
delete process.env.OPENAI_API_KEY; // garante caminho offline/fallback

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");
  const { ProspectResearchService } = await import("../src/server/ProspectResearchService.js");
  const { ProspectExecutionService } = await import("../src/server/ProspectExecutionService.js");

  function seedOrg(tag: string, leads: number) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    const actorId = `user_${tag}`;
    const camp = ProspectService.createCampaign(orgId, { name: `Campanha ${tag}` }, actorId);
    const records = Array.from({ length: leads }, (_, i) => ({
      company: `Empresa ${tag}${i}`, domain: `e-${tag.toLowerCase()}${i}.com.br`, contactName: `C${i}`, phone: `5521${String(920000000 + i)}`,
    }));
    if (leads) ProspectService.importRecords(orgId, { campaignId: camp.id, sourceRef: `seed-${tag}`, records }, actorId);
    return { orgId, actorId, camp, accounts: ProspectService.listAccounts(orgId).reverse() };
  }
  const A = seedOrg("A", 20);
  const B = seedOrg("B", 0);

  // Experimento com vitória clara → aprendizado automático.
  async function runKeepExperiment(name: string, winners: number) {
    const exp = ProspectResearchService.createExperiment(A.orgId, {
      campaignId: A.camp.id, name, hypothesis: `${name}: dor específica responde mais`, sampleSize: 10,
      variants: [{ name: `${name}-A`, body: "Mensagem sobre dor específica" }, { name: `${name}-B`, body: "Mensagem genérica" }],
    }, A.actorId);
    ProspectResearchService.startExperiment(A.orgId, exp.id, A.actorId);
    const alloc: any[] = [];
    for (let i = 0; i < 20; i++) alloc.push({ ...ProspectResearchService.draftFromVariant(A.orgId, exp.id, A.accounts[i].id, undefined, A.actorId), accountId: A.accounts[i].id });
    for (const a of alloc) {
      ProspectService.setOutreachStatus(A.orgId, a.outreachId, "pending_approval", A.actorId);
      ProspectService.setOutreachStatus(A.orgId, a.outreachId, "approved", A.actorId);
      ProspectService.setOutreachStatus(A.orgId, a.outreachId, "sent", A.actorId);
    }
    const v1 = exp.variants[0].id;
    alloc.filter(a => a.variantId === v1).slice(0, winners).forEach(a => ProspectExecutionService.registerReply(A.orgId, a.accountId, { source: "test" }, A.actorId));
    return ProspectResearchService.completeExperiment(A.orgId, exp.id, A.actorId);
  }

  const done1 = await runKeepExperiment("Exp1", 7); // 7/10 vs 0/10 → keep
  check("Experimento 1 decidiu keep", done1.decision === "keep");
  let learnings = ProspectResearchService.listLearnings(A.orgId);
  check("Aprendizado gravado automaticamente na vitória", learnings.length === 1 && learnings[0].source_experiment_id === done1.id);
  check("Confiança derivada do z (>0,5)", learnings[0].confidence_score > 0.5);
  check("Evidência preservada (métricas + z)", JSON.parse(learnings[0].evidence_json).z > 1.96);

  // Limpa replied/outreach para o 2º experimento usar os mesmos leads sem
  // esbarrar no teto de tentativas (3/contato): novos contatos por conta.
  db.prepare("DELETE FROM prospect_outreach WHERE organization_id = ?").run(A.orgId);

  const done2 = await runKeepExperiment("Exp2", 8);
  check("Experimento 2 decidiu keep", done2.decision === "keep");
  learnings = ProspectResearchService.listLearnings(A.orgId);
  const all = ProspectResearchService.listLearnings(A.orgId, { includeDeprecated: true });
  check("Aprendizado novo SUPERSEDE o anterior (1 ativo, 2 no histórico)", learnings.length === 1 && all.length === 2 && learnings[0].source_experiment_id === done2.id);
  check("Anterior ficou deprecated (histórico preservado)", all.some(l => l.status === "deprecated" && l.source_experiment_id === done1.id));

  // Registro manual + depreciação.
  const manual = ProspectResearchService.recordLearning(A.orgId, { learningType: "timing", insight: "Manhã responde melhor que noite", confidence: 0.6 }, A.actorId);
  check("Aprendizado manual gravado", !!manual.id && manual.learning_type === "timing");
  check("Depreciar aprendizado funciona", ProspectResearchService.deprecateLearning(A.orgId, manual.id, A.actorId) === true);
  check("Depreciar de novo retorna false", ProspectResearchService.deprecateLearning(A.orgId, manual.id, A.actorId) === false);

  // Isolamento (D4: memória por tenant, sem global).
  check("Org B não vê aprendizados de A", ProspectResearchService.listLearnings(B.orgId).length === 0);
  check("Depreciar cross-tenant falha", ProspectResearchService.deprecateLearning(B.orgId, learnings[0].id, B.actorId) === false);

  // IA indisponível → fallback determinístico (nunca quebra).
  const rec = await ProspectResearchService.recommendNextAction(A.orgId);
  check("recommendNextAction devolve fallback sem IA", typeof rec.advice === "string" && rec.advice.length > 10);

  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  check("Auditoria PROSPECT_LEARNING_RECORDED", audited.includes("PROSPECT_LEARNING_RECORDED"));
  check("Auditoria PROSPECT_LEARNING_DEPRECATED", audited.includes("PROSPECT_LEARNING_DEPRECATED"));

  console.log("\n=== Prospect AI — memória de aprendizados (ADR-079, Fase D) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
