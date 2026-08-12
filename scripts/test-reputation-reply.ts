/**
 * TEST — Reputation Governed Reply (PRD 5 / ADR-162 F8). DB-backed, det., isolado.
 * Prova (§29, §25/§61):
 *   - cadeia governada: draft (awaiting_approval) → approve (humano) → publish (execute,
 *     guardas G1/G2/G3) → provider → confirmação;
 *   - GROUNDING (RN-CRR-3): resposta com afirmação factual CORROBORADA por fato interno
 *     publica; afirmação SEM lastro ("reembolso realizado" sem evidência) → NÃO publica;
 *     resposta empática (sem claim factual) passa;
 *   - DEGRADAÇÃO (§6): provider sem config → manual_required (não finge publicação);
 *   - IDEMPOTÊNCIA (§30): 2º publish da mesma ação é barrado pelo executor;
 *   - guarda: publish sem aprovação é recusado;
 *   - confirmação de fechamento armada (§11.10) no publish; multi-tenant.
 *
 * Uso: npm run test:reputation-reply
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-reply-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-reply-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationReplyService: REPLY } = await import("../src/server/ReputationReplyService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = "org_reply_A", B = "org_reply_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  const mkOrder = (org: string, id: string, contact: string, status: string) =>
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, 100, '2026-08-10')`).run(id, org, contact, status);
  enableOrg(A); enableOrg(B); mkContact(A, "C1"); mkOrder(A, "O1", "C1", "pendente");

  let n = 0;
  const caseFor = (org: string, content: string, contact: string) => {
    const externalId = `RA-${++n}`;
    const out = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating: 1, ratingScale: 5 });
    const sid = out.signalId!;
    CASE.resolveCase(org, sid, { contactId: contact });
    return sid;
  };
  const approve = (org: string, actionId: string) => DA.approve(org, actionId, "U1");
  const confRow = (actionId: string) => db.prepare(`SELECT * FROM action_confirmations WHERE action_id = ?`).get(actionId) as any;
  const execDone = (actionId: string) => db.prepare(`SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND mode = 'execute' AND status = 'done'`).get(actionId) as any;
  const groundedClaim = (sourceId: string) => [{ statement: `Registro ${sourceId}`, responseType: "fact", evidence: [{ sourceType: "SYSTEM_OF_RECORD", sourceId, service: "orders" }] }] as any;

  // ═══════════════ 1. GROUNDED → publica ═══════════════
  const s1 = caseFor(A, "meu pedido não chegou, atraso enorme", "C1");
  const d1 = REPLY.draft(A, s1, { content: "Já reenviamos seu pedido, acompanhe o rastreio.", provider: "stub", claims: groundedClaim("O1") })!;
  check("1.1 draft cria ação awaiting_approval", d1.action.status === "awaiting_approval");
  check("1.2 grounding prévio = grounded (cita fato O1)", d1.grounding.status === "grounded");
  approve(A, d1.action.id);
  const pub1 = await REPLY.publish(A, d1.action.id);
  check("1.3 publica (effect published + externalRef)", pub1.result.effect === "reputation_reply_published" && !!pub1.result.externalRef);
  check("1.4 confirmação de fechamento armada (§11.10)", (() => { const c = confRow(d1.action.id); return c && c.status === "pending" && c.confirmation_method === "reputation_reply" && !!c.external_ref; })());
  check("1.5 execução registrada (mode execute done)", execDone(d1.action.id).n === 1);

  // ═══════════════ 2. UNGROUNDED → NÃO publica (RN-CRR-3) ═══════════════
  const s2 = caseFor(A, "quero reembolso", "C1");
  const d2 = REPLY.draft(A, s2, { content: "Reembolso já realizado.", provider: "stub", claims: groundedClaim("GHOST") })!;
  check("2.1 grounding prévio = unsupported (cita fato inexistente)", d2.grounding.status === "unsupported");
  approve(A, d2.action.id);
  let blocked = false, msg = "";
  try { await REPLY.publish(A, d2.action.id); } catch (e: any) { blocked = true; msg = String(e?.message || e); }
  check("2.2 publish BLOQUEADO por afirmação sem lastro", blocked && /unsupported_claim/.test(msg));
  check("2.3 nada publicado: sem confirmação armada", !confRow(d2.action.id));
  check("2.4 ação segue 'approved' (pode corrigir e republicar)", DA.get(A, d2.action.id).status === "approved" && execDone(d2.action.id).n === 0);

  // ═══════════════ 3. Resposta empática (sem claim) → publica ═══════════════
  const s3 = caseFor(A, "péssimo atendimento", "C1");
  const d3 = REPLY.draft(A, s3, { content: "Sentimos muito pelo ocorrido, vamos verificar internamente.", provider: "stub", claims: [] })!;
  check("3.1 sem claim factual → grounding 'skipped'", d3.grounding.status === "skipped");
  approve(A, d3.action.id);
  check("3.2 empática publica", (await REPLY.publish(A, d3.action.id)).result.effect === "reputation_reply_published");

  // ═══════════════ 4. IDEMPOTÊNCIA (§30) — 2º publish barrado ═══════════════
  let idemp = false;
  try { await REPLY.publish(A, d1.action.id); } catch (e: any) { idemp = /already_executed|idempot/i.test(String(e?.message || e)); }
  check("4.1 2º publish da mesma ação é recusado", idemp);

  // ═══════════════ 5. DEGRADAÇÃO (§6) — provider sem config → manual_required ═══════════════
  const s5 = caseFor(A, "não chegou meu pedido", "C1");
  const d5 = REPLY.draft(A, s5, { content: "Vamos verificar.", provider: "reclame_aqui" })!; // não configurado
  approve(A, d5.action.id);
  const pub5 = await REPLY.publish(A, d5.action.id);
  check("5.1 provider sem config → manual_required (não finge)", pub5.result.effect === "reputation_reply_manual_required" && pub5.result.externalRef === null);
  check("5.2 manual_required não arma confirmação", !confRow(d5.action.id));

  // ═══════════════ 6. Guarda: publish sem aprovação recusado ═══════════════
  const s6 = caseFor(A, "atraso na entrega", "C1");
  const d6 = REPLY.draft(A, s6, { content: "Verificando.", provider: "stub" })!;
  let notApproved = false;
  try { await REPLY.publish(A, d6.action.id); } catch (e: any) { notApproved = /não aprovada|not_approved/i.test(String(e?.message || e)); }
  check("6.1 publish sem aprovação recusado (G3)", notApproved);

  // ═══════════════ 7. multi-tenant ═══════════════
  check("7.1 draft não cruza org", REPLY.draft(B, s1, { content: "x", provider: "stub" }) === null);
  let crossPub = false;
  try { await REPLY.publish(B, d1.action.id); } catch { crossPub = true; }
  check("7.2 publish não cruza org", crossPub);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-reply: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
