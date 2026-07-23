/**
 * TESTE — Prospect AI: isolamento multi-tenant + guardrails LGPD (ADR-079, Fase A)
 * --------------------------------------------------------------------------------
 * Prova, offline e em banco temporário, que:
 *   - ICPs, campanhas, contas, fila de aprovação e atribuição NUNCA cruzam tenants;
 *   - opt-out de contato e bloqueio de conta impedem aprovação/envio de abordagem,
 *     mesmo para rascunhos criados ANTES do opt-out/bloqueio;
 *   - o limite de tentativas de contato (anti-spam) é aplicado no envio;
 *   - as mutações de conformidade geram evento em auth_audit_logs, escopado por org.
 *
 * Uso:  npm run test:prospect-isolation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

// IMPORTANTE: aponta o banco para um diretório TEMPORÁRIO antes de importar o db.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prospect-isolation-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-prospect-isolamento-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
function expectThrow(name: string, fn: () => any, contains: string) {
  try { fn(); check(name, false, "não lançou erro"); }
  catch (e: any) { check(name, String(e?.message || e).includes(contains), String(e?.message || e)); }
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");

  // ---- Semeia 2 organizações isoladas, cada uma com ICP + campanha + leads ----
  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    const actorId = `user_${tag}`;
    const icp = ProspectService.createIcp(orgId, { name: `ICP ${tag}`, vertical: "servicos", criteria: { dor: "teste" } }, actorId);
    const camp = ProspectService.createCampaign(orgId, { name: `Campanha ${tag}`, icpId: icp.id }, actorId);
    const imp = ProspectService.importRecords(orgId, {
      campaignId: camp.id,
      sourceRef: `csv-${tag}`,
      records: [
        { company: `Alfa ${tag}`, domain: `alfa-${tag}.com.br`, city: "Rio de Janeiro", state: "RJ", contactName: `Contato ${tag}`, email: `contato@alfa-${tag}.com.br`, phone: `55219${tag === "A" ? "1" : "2"}0000000` },
        { company: `Beta ${tag}`, city: "Niterói", state: "RJ" },
      ],
    }, actorId);
    const accounts = ProspectService.listAccounts(orgId);
    return { orgId, actorId, icp, camp, imp, accounts };
  }

  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 1. Isolamento de leitura ----
  check("A só vê os próprios ICPs", ProspectService.listIcps(A.orgId).every((i: any) => i.organization_id === A.orgId) && ProspectService.listIcps(A.orgId).length === 1);
  check("A só vê as próprias campanhas", ProspectService.listCampaigns(A.orgId).every((c: any) => c.organization_id === A.orgId) && ProspectService.listCampaigns(A.orgId).length === 1);
  check("A só vê as próprias contas", A.accounts.length === 2 && A.accounts.every((a: any) => a.organization_id === A.orgId));
  check("ICP de B não abre com orgId de A", ProspectService.getIcp(A.orgId, B.icp.id) === null);
  check("Conta de B não abre com orgId de A", ProspectService.getAccount(A.orgId, B.accounts[0].id) === null);
  check("Fila de aprovação de A vazia (nada cruzou)", ProspectService.listApprovalQueue(A.orgId).length === 0);

  // ---- 2. Isolamento de escrita: mutação cross-tenant falha ou não altera ----
  check("Status de conta de B não muda via orgId de A", ProspectService.updateAccountStatus(A.orgId, B.accounts[0].id, "qualified") === false);
  const bAccount = ProspectService.getAccount(B.orgId, B.accounts[0].id);
  check("Conta de B permaneceu intacta", bAccount.account_status === "discovered");
  expectThrow("Opt-out em contato de B via orgId de A falha", () => ProspectService.setContactOptOut(A.orgId, B.accounts[0].id, bAccount.contacts[0].id, true), "não encontrado");

  // ---- 3. Guardrails LGPD no fluxo de abordagem (org A) ----
  const accA = ProspectService.listAccounts(A.orgId).find((a: any) => a.display_name.startsWith("Alfa"))!;
  const contactA = (ProspectService.getAccount(A.orgId, accA.id).contacts || [])[0];
  check("Conta A tem contato importado", !!contactA);

  // Rascunho inserido direto (composeOutreach chama LLM; teste é offline).
  function insertOutreach(status: string): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_outreach (id, organization_id, campaign_id, prospect_account_id, contact_id, channel, subject, body, evidence_snapshot, status) VALUES (?, ?, ?, ?, ?, 'email', 'Assunto', 'Corpo', '{}', ?)`)
      .run(id, A.orgId, A.camp.id, accA.id, contactA.id, status);
    return id;
  }

  // 3a. Opt-out bloqueia aprovação (rascunho criado ANTES do opt-out).
  const o1 = insertOutreach("pending_approval");
  ProspectService.setContactOptOut(A.orgId, accA.id, contactA.id, true, A.actorId);
  expectThrow("Contato em opt-out não pode ser aprovado", () => ProspectService.setOutreachStatus(A.orgId, o1, "approved", A.actorId, "aderente ao ICP (teste)"), "opt-out");
  ProspectService.setContactOptOut(A.orgId, accA.id, contactA.id, false, A.actorId);
  ProspectService.setOutreachStatus(A.orgId, o1, "approved", A.actorId, "aderente ao ICP (teste)");
  ProspectService.setOutreachStatus(A.orgId, o1, "sent", A.actorId);
  check("Fluxo normal aprova e envia após revogar opt-out", true);

  // 3b. Limite de tentativas por contato: com 3 envios, o 4º é recusado.
  insertOutreach("sent"); insertOutreach("sent"); // + o1 enviado = 3
  const o2 = insertOutreach("approved");
  expectThrow("4º envio ao mesmo contato é recusado (anti-spam)", () => ProspectService.setOutreachStatus(A.orgId, o2, "sent", A.actorId), "Limite");

  // 3c. Bloqueio da conta impede aprovação de qualquer abordagem.
  const o3 = insertOutreach("pending_approval");
  ProspectService.setAccountBlocked(A.orgId, accA.id, true, A.actorId);
  expectThrow("Conta bloqueada não pode ter abordagem aprovada", () => ProspectService.setOutreachStatus(A.orgId, o3, "approved", A.actorId, "aderente ao ICP (teste)"), "bloqueada");
  ProspectService.setAccountBlocked(A.orgId, accA.id, false, A.actorId);

  // ---- 4. Auditoria: eventos gravados e escopados por organização ----
  const eventsA = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ?`).all(A.orgId).map((r: any) => r.event_type);
  for (const ev of ["PROSPECT_LEADS_IMPORTED", "PROSPECT_CONTACT_OPTOUT", "PROSPECT_CONTACT_OPTOUT_REVOKED", "PROSPECT_ACCOUNT_BLOCKED", "PROSPECT_ACCOUNT_UNBLOCKED", "PROSPECT_OUTREACH_STATUS"]) {
    check(`Auditoria registrou ${ev} para a org A`, eventsA.includes(ev));
  }
  const crossAudit = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type LIKE 'PROSPECT_%' AND event_type NOT IN ('PROSPECT_LEADS_IMPORTED')`).get(B.orgId) as any;
  check("Eventos de conformidade de A não vazaram para B", Number(crossAudit?.n || 0) === 0);

  // ---- Relatório ----
  console.log("\n=== Prospect AI — isolamento + LGPD (ADR-079, Fase A) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
