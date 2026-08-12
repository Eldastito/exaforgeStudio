/**
 * TEST — Reputation Governed Resolution (PRD 5 / ADR-162 F9). DB-backed, det., isolado.
 * Prova (§28-29):
 *   - HANDLERS materiais pela cadeia governada (execute + G1/G2/G3):
 *     order_reship → tarefa de reexpedição referenciando o PEDIDO REAL;
 *     ticket_assign → atribui o TICKET REAL; contact_task → tarefa de follow-up;
 *   - NÃO INVENTA (RN-151): orderId/ticketId inexistente → recusa; overrides do operador
 *     preenchem os dados reais que a F6 não tinha;
 *   - governança: sem aprovação recusa (G3); comando não-resolução recusa; idempotência;
 *   - integração F6: recommend → order_reship → resolve executa; multi-tenant.
 *
 * Uso: npm run test:reputation-resolution
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-res-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-res-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationRecoveryService: REC } = await import("../src/server/ReputationRecoveryService.js");
  const { ReputationResolutionService: RES } = await import("../src/server/ReputationResolutionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = "org_res_A", B = "org_res_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  const mkOrder = (org: string, id: string, contact: string, status: string) =>
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, 100, '2026-08-10')`).run(id, org, contact, status);
  const mkTicket = (org: string, id: string, contact: string) =>
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'novo_lead')`).run(id, org, contact);
  enableOrg(A); enableOrg(B); mkContact(A, "C1"); mkOrder(A, "O1", "C1", "pendente"); mkTicket(A, "T1", "C1");

  let n = 0;
  const caseFor = (org: string, content: string, contact: string) => {
    const externalId = `RA-${++n}`;
    const sid = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating: 1, ratingScale: 5 }).signalId!;
    CASE.resolveCase(org, sid, { contactId: contact });
    return sid;
  };
  const propose = (org: string, sid: string, commandType: string, payload: any) => DA.propose(org, {
    signalId: sid, domain: "recovery", actionType: commandType, title: `Resolução ${commandType}`,
    commandType, commandPayload: payload,
  });
  const approve = (org: string, id: string) => DA.approve(org, id, "U1");
  const taskRow = (id: string) => db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
  const ticketRow = (id: string) => db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as any;

  const s1 = caseFor(A, "meu pedido não chegou", "C1");

  // ═══════════════ 1. order_reship → tarefa referenciando o pedido real ═══════════════
  const aReship = propose(A, s1, "order_reship", { orderId: "O1" }); approve(A, aReship.id);
  const rReship = await RES.resolve(A, aReship.id);
  check("1.1 reship cria tarefa (effect + externalRef)", rReship.result.effect === "reship_task_created" && !!rReship.result.externalRef);
  check("1.2 tarefa referencia o PEDIDO REAL O1", (() => { const t = taskRow(rReship.result.externalRef); return t && t.ref_label === "O1" && t.contact_id === "C1"; })());

  // ═══════════════ 2. NÃO inventa: pedido inexistente recusa ═══════════════
  const aBad = propose(A, s1, "order_reship", { orderId: "GHOST" }); approve(A, aBad.id);
  let reshipBad = false;
  try { await RES.resolve(A, aBad.id); } catch (e: any) { reshipBad = /não encontrado/.test(String(e?.message || e)); }
  check("2.1 pedido inventado → recusa (RN-151)", reshipBad);

  // ═══════════════ 3. ticket_assign com OVERRIDES do operador ═══════════════
  const aAssign = propose(A, s1, "ticket_assign", {}); approve(A, aAssign.id); // F6 não tinha ticketId
  const rAssign = await RES.resolve(A, aAssign.id, { ticketId: "T1", assignedTo: "U2", stage: "em_atendimento" });
  check("3.1 ticket_assign atribui o ticket real", rAssign.result.effect === "ticket_assigned");
  check("3.2 override do operador aplicado (assigned_to + stage)", (() => { const t = ticketRow("T1"); return t.assigned_to === "U2" && t.stage === "em_atendimento"; })());

  // ticket inexistente → recusa
  const aAssignBad = propose(A, s1, "ticket_assign", { ticketId: "GHOST" }); approve(A, aAssignBad.id);
  let assignBad = false;
  try { await RES.resolve(A, aAssignBad.id); } catch (e: any) { assignBad = /não encontrado/.test(String(e?.message || e)); }
  check("3.3 ticket inventado → recusa (RN-151)", assignBad);

  // ═══════════════ 4. contact_task → tarefa de follow-up ═══════════════
  const aCt = propose(A, s1, "contact_task", { contactId: "C1", title: "Ligar para o cliente" }); approve(A, aCt.id);
  const rCt = await RES.resolve(A, aCt.id);
  check("4.1 contact_task cria tarefa de follow-up", rCt.result.effect === "contact_task_created" && taskRow(rCt.result.externalRef)?.contact_id === "C1");

  // ═══════════════ 5. Governança ═══════════════
  const aNoApprove = propose(A, s1, "order_reship", { orderId: "O1" }); // não aprovada
  let notApproved = false;
  try { await RES.resolve(A, aNoApprove.id); } catch (e: any) { notApproved = /não aprovada|not_approved/i.test(String(e?.message || e)); }
  check("5.1 resolve sem aprovação recusado (G3)", notApproved);

  const aWrong = propose(A, s1, "whatsapp_send", { channelId: "x" }); approve(A, aWrong.id);
  let wrongType = false;
  try { await RES.resolve(A, aWrong.id); } catch (e: any) { wrongType = /não é uma resolução/.test(String(e?.message || e)); }
  check("5.2 comando não-resolução recusado", wrongType);

  let idemp = false;
  try { await RES.resolve(A, aReship.id); } catch (e: any) { idemp = /already_executed|idempot/i.test(String(e?.message || e)); }
  check("5.3 2º resolve da mesma ação barrado (idempotência)", idemp);

  // ═══════════════ 6. Integração F6 → resolve ═══════════════
  const s6 = caseFor(A, "meu pedido não chegou, atraso enorme", "C1"); // O1 pendente corrobora
  const plan = REC.recommend(A, s6);
  const reshipAction = plan!.recommendedActions.find((a: any) => a.actionType === "order_reship");
  approve(A, reshipAction!.actionId);
  const rInt = await RES.resolve(A, reshipAction!.actionId);
  check("6.1 F6 recommend → order_reship → resolve executa", rInt.result.effect === "reship_task_created");

  // ═══════════════ 7. multi-tenant ═══════════════
  let cross = false;
  try { await RES.resolve(B, aReship.id); } catch { cross = true; }
  check("7.1 resolve não cruza org", cross);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-resolution: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
