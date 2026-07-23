/**
 * TESTE — Prospect AI Fase C: Research Engine (ADR-079)
 * ------------------------------------------------------
 * Prova, offline e em banco temporário, as três regras invioláveis do motor:
 *   1. ORÇAMENTO FIXO: não decide antes de fechar a amostra (anti-espiada);
 *      alocação round-robin respeita o teto por variante.
 *   2. Decisão DETERMINÍSTICA: diferença clara → keep + champion; diferença
 *      pequena → inconclusive (o default). IA não participa da decisão.
 *   3. Champion/challenger: vencedora vira is_champion; perdedora aposenta.
 * Mais: isolamento multi-tenant, eventos experiment.* e auditoria.
 *
 * Uso:  npm run test:prospect-research
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prospect-research-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-prospect-research-1234567890";

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
      company: `Empresa ${tag}${i}`, domain: `emp-${tag.toLowerCase()}${i}.com.br`,
      contactName: `Contato ${i}`, phone: `5521${String(910000000 + i)}`,
    }));
    ProspectService.importRecords(orgId, { campaignId: camp.id, sourceRef: `seed-${tag}`, records }, actorId);
    const accounts = ProspectService.listAccounts(orgId).reverse(); // ordem estável
    return { orgId, actorId, camp, accounts };
  }

  const A = seedOrg("A", 44);
  const B = seedOrg("B", 2);

  // ---- 1. Criação: validações do orçamento e das variantes ----
  let threw = "";
  try { ProspectResearchService.createExperiment(A.orgId, { name: "X", sampleSize: 5, variants: [{ body: "a" }, { body: "b" }] }, A.actorId); } catch (e: any) { threw = e.message; }
  check("Amostra abaixo do mínimo é recusada", threw.includes("mínima"));
  threw = "";
  try { ProspectResearchService.createExperiment(A.orgId, { name: "X", sampleSize: 10, variants: [{ body: "só uma" }] }, A.actorId); } catch (e: any) { threw = e.message; }
  check("Menos de 2 variantes é recusado", threw.includes("2 variantes"));

  const exp = ProspectResearchService.createExperiment(A.orgId, {
    campaignId: A.camp.id, name: "Dor específica vs genérica", hypothesis: "Mensagem sobre perda de agendamento responde mais",
    successMetric: "response_rate", sampleSize: 10,
    variants: [{ name: "A — dor específica", body: "Vi que clínicas perdem pacientes por falta de follow-up. Posso mostrar como evitar?" },
               { name: "B — genérica", body: "Temos uma solução de automação para sua clínica. Podemos conversar?" }],
  }, A.actorId);
  check("Experimento criado com 2 variantes", exp.variants.length === 2 && exp.status === "draft");

  // Alocar antes de iniciar é recusado.
  threw = "";
  try { ProspectResearchService.draftFromVariant(A.orgId, exp.id, A.accounts[0].id, undefined, A.actorId); } catch (e: any) { threw = e.message; }
  check("Alocação exige experimento em execução", threw.includes("Inicie"));
  ProspectResearchService.startExperiment(A.orgId, exp.id, A.actorId);

  // ---- 2. Alocação round-robin com teto por variante ----
  const allocated: { outreachId: string; variantId: string; accountId: string }[] = [];
  for (let i = 0; i < 20; i++) {
    const contact = (ProspectService.getAccount(A.orgId, A.accounts[i].id).contacts || [])[0];
    const d = ProspectResearchService.draftFromVariant(A.orgId, exp.id, A.accounts[i].id, contact?.id, A.actorId);
    allocated.push({ ...d, accountId: A.accounts[i].id });
  }
  const perVariant = new Map<string, number>();
  allocated.forEach(a => perVariant.set(a.variantId, (perVariant.get(a.variantId) || 0) + 1));
  check("Round-robin: 10 leads por variante", [...perVariant.values()].every(n => n === 10));
  threw = "";
  try { ProspectResearchService.draftFromVariant(A.orgId, exp.id, A.accounts[20].id, undefined, A.actorId); } catch (e: any) { threw = e.message; }
  check("21º lead é recusado (orçamento fechado)", threw.includes("Orçamento"));

  // ---- 3. Anti-espiada: completar antes de enviar tudo é recusado ----
  threw = "";
  try { await ProspectResearchService.completeExperiment(A.orgId, exp.id, A.actorId); } catch (e: any) { threw = e.message; }
  check("Decidir antes do orçamento fechar é recusado", threw.includes("espiar"));

  // Envia tudo (fluxo de aprovação da Fase A; envio marcado via transição).
  for (const a of allocated) {
    ProspectService.setOutreachStatus(A.orgId, a.outreachId, "pending_approval", A.actorId);
    ProspectService.setOutreachStatus(A.orgId, a.outreachId, "approved", A.actorId, "aderente ao ICP (teste)");
    ProspectService.setOutreachStatus(A.orgId, a.outreachId, "sent", A.actorId);
  }

  // Respostas simuladas: variante 1 → 6/10; variante 2 → 1/10.
  const [v1, v2] = exp.variants.map((v: any) => v.id);
  const byVariant = (vid: string) => allocated.filter(a => a.variantId === vid);
  byVariant(v1).slice(0, 6).forEach(a => ProspectExecutionService.registerReply(A.orgId, a.accountId, { source: "test" }, A.actorId));
  byVariant(v2).slice(0, 1).forEach(a => ProspectExecutionService.registerReply(A.orgId, a.accountId, { source: "test" }, A.actorId));

  // ---- 4. Decisão keep + champion ----
  const done = await ProspectResearchService.completeExperiment(A.orgId, exp.id, A.actorId);
  check("Decisão keep com diferença clara (6/10 vs 1/10)", done.decision === "keep" && done.winner_variant_id === v1);
  const champ = db.prepare("SELECT is_champion, status FROM prospect_message_variants WHERE id = ?").get(v1) as any;
  const loser = db.prepare("SELECT is_champion, status FROM prospect_message_variants WHERE id = ?").get(v2) as any;
  check("Vencedora virou champion da campanha", champ.is_champion === 1 && champ.status === "active");
  check("Perdedora foi aposentada", loser.is_champion === 0 && loser.status === "retired");
  check("Snapshot de resultados gravado (2 variantes)", done.results.length === 2 && done.results.some((r: any) => r.result_status === "keep"));
  const evTypes = db.prepare("SELECT event_type FROM prospect_events WHERE organization_id = ? AND event_type LIKE 'experiment%'").all(A.orgId).map((r: any) => r.event_type);
  check("Eventos experiment.completed + winner_found", evTypes.includes("experiment.completed") && evTypes.includes("experiment.winner_found"));

  // ---- 5. Diferença pequena → inconclusive (o default) ----
  const exp2 = ProspectResearchService.createExperiment(A.orgId, {
    campaignId: A.camp.id, name: "Teste inconclusivo", sampleSize: 10,
    variants: [{ name: "C", body: "Mensagem C" }, { name: "D", body: "Mensagem D" }],
  }, A.actorId);
  ProspectResearchService.startExperiment(A.orgId, exp2.id, A.actorId);
  const alloc2: { outreachId: string; variantId: string; accountId: string }[] = [];
  for (let i = 20; i < 40; i++) {
    const d = ProspectResearchService.draftFromVariant(A.orgId, exp2.id, A.accounts[i].id, undefined, A.actorId);
    alloc2.push({ ...d, accountId: A.accounts[i].id });
  }
  for (const a of alloc2) {
    ProspectService.setOutreachStatus(A.orgId, a.outreachId, "pending_approval", A.actorId);
    ProspectService.setOutreachStatus(A.orgId, a.outreachId, "approved", A.actorId, "aderente ao ICP (teste)");
    ProspectService.setOutreachStatus(A.orgId, a.outreachId, "sent", A.actorId);
  }
  const [v3, v4] = exp2.variants.map((v: any) => v.id);
  alloc2.filter(a => a.variantId === v3).slice(0, 3).forEach(a => ProspectExecutionService.registerReply(A.orgId, a.accountId, { source: "test" }, A.actorId));
  alloc2.filter(a => a.variantId === v4).slice(0, 2).forEach(a => ProspectExecutionService.registerReply(A.orgId, a.accountId, { source: "test" }, A.actorId));
  const done2 = await ProspectResearchService.completeExperiment(A.orgId, exp2.id, A.actorId);
  check("3/10 vs 2/10 → inconclusive (default)", done2.decision === "inconclusive" && !done2.winner_variant_id);
  const champStill = db.prepare("SELECT is_champion FROM prospect_message_variants WHERE id = ?").get(v1) as any;
  check("Inconclusivo NÃO mexe no champion vigente", champStill.is_champion === 1);

  // ---- 6. Isolamento multi-tenant + auditoria ----
  check("Org B não vê experimentos de A", ProspectResearchService.listExperiments(B.orgId).length === 0);
  check("Experimento de A não abre com orgId de B", ProspectResearchService.getExperiment(B.orgId, exp.id) === null);
  threw = "";
  try { ProspectResearchService.draftFromVariant(B.orgId, exp.id, B.accounts[0].id, undefined, B.actorId); } catch (e: any) { threw = e.message; }
  check("Alocação cross-tenant falha", threw.includes("não encontrado"));
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  for (const ev of ["PROSPECT_EXPERIMENT_CREATED", "PROSPECT_EXPERIMENT_STARTED", "PROSPECT_EXPERIMENT_DECISION"]) {
    check(`Auditoria registrou ${ev}`, audited.includes(ev));
  }

  // ---- 7. Dashboard + ponte com o RIC (Fase E) ----
  const dash = ProspectResearchService.dashboard(A.orgId);
  check("Dashboard agrega envios e respostas reais", dash.messagesSent === 40 && dash.responses === 12 && dash.responseRate > 0.29);
  check("Dashboard expõe mensagem champion", dash.championMessage && dash.championMessage.name.includes("dor específica"));
  check("Dashboard: leads e campanhas contados", dash.leadsTotal === 44 && dash.campaignsActive >= 1);
  const ric = ProspectResearchService.ricSummary(A.orgId);
  check("Resumo do RIC traz champion e taxa", ric.championMessage && ric.responseRate === dash.responseRate);
  check("Dashboard da org B vem zerado (isolamento)", ProspectResearchService.dashboard(B.orgId).messagesSent === 0);

  console.log("\n=== Prospect AI — Research Engine (ADR-079, Fase C) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
