/**
 * TEST — Reputation Recovery Playbook (PRD 5 / ADR-162 F6). DB-backed, det., isolado.
 * Prova (§22-24):
 *   - investigação → ações RECOMENDADAS no ledger governado (domain 'recovery'),
 *     SEM efeito externo (só propose);
 *   - estratégia por grounding: GROUNDED → remediação material (reship) + contato;
 *     ALEGAÇÃO sem lastro → contato primeiro (+ handoff se sério), conditional=true;
 *     HIGH-RISK → só internal_handoff (RN-CRR-4, nada público/financeiro autônomo);
 *   - FINANCEIRO nunca auto-aprova (refund → awaiting_approval por padrão); com banda
 *     de autonomia 'deny' vira BLOQUEADO (RN-159-1), não erro;
 *   - reship referencia o PEDIDO REAL (fato), refund não inventa valor (amount=null);
 *   - correlação preservada (ação herda correlation_id do sinal, ADR-158);
 *   - idempotente (re-recomendar reusa, não duplica);
 *   - multi-tenant + not_found.
 *
 * Uso: npm run test:reputation-recovery
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-rec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-rec-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationRecoveryService: REC } = await import("../src/server/ReputationRecoveryService.js");
  const { ApprovalPolicyService: POL } = await import("../src/server/ApprovalPolicyService.js");

  const A = "org_rec_A", B = "org_rec_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  const mkOrder = (org: string, id: string, contact: string, status: string) =>
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, 100, '2026-08-10')`).run(id, org, contact, status);
  enableOrg(A); enableOrg(B);
  for (const c of ["C1", "C2", "C3", "C5"]) mkContact(A, c);

  let n = 0;
  const caseFor = (org: string, content: string, contact: string, rating: number) => {
    const externalId = `RA-${++n}`;
    const out = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating, ratingScale: 5 });
    const sid = out.signalId!;
    CASE.resolveCase(org, sid, { contactId: contact });
    return sid;
  };
  const findAction = (plan: any, type: string) => plan.recommendedActions.find((a: any) => a.actionType === type);
  const actionRow = (id: string) => db.prepare(`SELECT * FROM decision_actions WHERE id = ?`).get(id) as any;
  const countActions = (sid: string) => (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ? AND signal_id = ?`).get(A, sid) as any).n;

  // ═══════════════ 1. GROUNDED delivery → remediação material + contato ═══════════════
  mkOrder(A, "O1", "C1", "pendente");
  const s1 = caseFor(A, "meu pedido não chegou, atraso enorme", "C1", 1);
  const p1 = REC.recommend(A, s1)!;
  check("1.1 estratégia grounded_remediation", p1.strategy === "grounded_remediation" && p1.corroborated === true);
  const reship = findAction(p1, "order_reship");
  check("1.2 recomenda order_reship", !!reship);
  check("1.3 reship referencia o PEDIDO REAL (fato, não inventado)", actionRow(reship.actionId).command_payload_json.includes("O1"));
  check("1.4 reship exige aprovação (não auto-executa)", reship.status === "awaiting_approval");
  check("1.5 inclui contato privado", !!findAction(p1, "customer_private_message"));
  check("1.6 ação herda correlation_id do sinal (ADR-158)", actionRow(reship.actionId).correlation_id === (db.prepare(`SELECT correlation_id c FROM business_signals WHERE id=?`).get(s1) as any).c);
  check("1.7 sem efeito externo: nenhuma ação 'done'", p1.recommendedActions.every((a: any) => a.status !== "done"));

  // ═══════════════ 2. ALEGAÇÃO sem lastro → contato primeiro (+handoff sério) ═══════════════
  const s2 = caseFor(A, "meu pedido não chegou até hoje", "C2", 1); // C2 sem pedido
  const p2 = REC.recommend(A, s2)!;
  check("2.1 estratégia claim_outreach", p2.strategy === "claim_outreach" && p2.corroborated === false);
  check("2.2 lidera com contato privado (conditional)", findAction(p2, "customer_private_message")?.conditional === true);
  check("2.3 sério sem lastro → inclui apuração humana", !!findAction(p2, "internal_handoff"));
  check("2.4 NÃO recomenda remediação material sem lastro", !findAction(p2, "order_reship") && !findAction(p2, "refund"));

  // ═══════════════ 3. HIGH-RISK → só handoff (RN-CRR-4) ═══════════════
  const s3 = caseFor(A, "isso é um golpe, não reconheço essa compra", "C1", 3);
  const p3 = REC.recommend(A, s3)!;
  check("3.1 estratégia high_risk_handoff", p3.strategy === "high_risk_handoff" && p3.highRisk === true);
  check("3.2 só internal_handoff", p3.recommendedActions.length === 1 && p3.recommendedActions[0].actionType === "internal_handoff");
  check("3.3 nada público/financeiro autônomo", !findAction(p3, "refund") && !findAction(p3, "customer_private_message"));

  // ═══════════════ 4. FINANCEIRO nunca auto-aprova (refund → awaiting_approval) ═══════════════
  mkOrder(A, "O3", "C3", "reembolso");
  const s4 = caseFor(A, "quero meu reembolso, o estorno não caiu", "C3", 2);
  const p4 = REC.recommend(A, s4)!;
  const refund = findAction(p4, "refund");
  check("4.1 recomenda refund", !!refund);
  check("4.2 refund NÃO auto-aprova (requer aprovação)", refund.status === "awaiting_approval" && refund.status !== "approved");
  check("4.3 refund não inventa valor (amount=null, expected_impact null)", actionRow(refund.actionId).command_payload_json.includes("\"amount\":null") && actionRow(refund.actionId).expected_impact === null);

  // ═══════════════ 5. Banda de autonomia 'deny' → refund BLOQUEADO (não erro) ═══════════════
  POL.setBands(A, "recovery", "refund", [{ upTo: null, state: "deny" }]);
  mkOrder(A, "O5", "C5", "reembolso");
  const s5 = caseFor(A, "cadê meu reembolso, quero o estorno", "C5", 2);
  const p5 = REC.recommend(A, s5)!;
  const refund5 = findAction(p5, "refund");
  check("5.1 refund bloqueado pela banda deny (RN-159-1)", refund5.status === "blocked" && refund5.blocked === true && refund5.actionId === null);
  check("5.2 bloqueio não derruba o plano (contato segue recomendado)", !!findAction(p5, "customer_private_message"));

  // ═══════════════ 6. Idempotente (re-recomendar reusa, não duplica) ═══════════════
  const before = countActions(s1);
  const p1b = REC.recommend(A, s1)!;
  check("6.1 re-recomendar reusa a ação aberta", findAction(p1b, "order_reship").status === "reused");
  check("6.2 não duplica no ledger", countActions(s1) === before);

  // ═══════════════ 7. multi-tenant + not_found ═══════════════
  check("7.1 não cruza org", REC.recommend(B, s1) === null);
  check("7.2 signal inexistente → null", REC.recommend(A, "nope") === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-recovery: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
