/**
 * TEST — Reputation × Fala Tu (Approval + Smart Inbox + Thread + Internal Handoff)
 * (PRD 5 / ADR-162 F7). DB-backed, determinístico, isolado.
 * Prova:
 *   - REUSO (§36): o caso (sinal F2 + ações recovery F6, mesma cadeia) aparece
 *     de graça na SMART INBOX (risco + precisa-aprovação), no APPROVAL CENTER e na
 *     THREAD (sinal→decisão) — sem superfície nova;
 *   - HANDOFF (§33): resumo DETERMINÍSTICO do caso postado como nota ancorada ao
 *     correlation_id → cai na caixa interna do destinatário e vira estágio 'nota'
 *     na thread; high-risk é marcado no resumo (RN-CRR-4);
 *   - caseView (§36) compõe thread + aprovações pendentes do caso;
 *   - multi-tenant + not_found.
 *
 * Uso: npm run test:reputation-falatu
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-ft-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-ft-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationRecoveryService: REC } = await import("../src/server/ReputationRecoveryService.js");
  const { ReputationHandoffService: HANDOFF } = await import("../src/server/ReputationHandoffService.js");
  const { SmartInboxService: INBOX } = await import("../src/server/SmartInboxService.js");
  const { FalaTuApprovalService: APPROVAL } = await import("../src/server/FalaTuApprovalService.js");
  const { FalaTuThreadService: THREAD } = await import("../src/server/FalaTuThreadService.js");
  const { InternalChatService: CHAT } = await import("../src/server/InternalChatService.js");

  const A = "org_ft_A", B = "org_ft_B";
  const user = { userId: "U1", role: "owner" };
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  const mkOrder = (org: string, id: string, contact: string, status: string) =>
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, 100, '2026-08-10')`).run(id, org, contact, status);
  enableOrg(A); enableOrg(B); mkContact(A, "C1");

  let n = 0;
  const caseFor = (org: string, content: string, contact: string, rating: number) => {
    const externalId = `RA-${++n}`;
    const out = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating, ratingScale: 5 });
    const sid = out.signalId!;
    CASE.resolveCase(org, sid, { contactId: contact });
    return sid;
  };
  const corrOf = (sid: string) => (db.prepare(`SELECT correlation_id c FROM business_signals WHERE id = ?`).get(sid) as any).c;

  // Caso corroborado (delivery + pedido pendente) → gera recovery (reship + contato).
  mkOrder(A, "O1", "C1", "pendente");
  const s1 = caseFor(A, "meu pedido não chegou, atraso enorme", "C1", 1);
  REC.recommend(A, s1);
  const cid = corrOf(s1);

  // ═══════════════ 1. SMART INBOX (reuso, §36) ═══════════════
  const inbox = INBOX.build(A, user);
  check("1.1 sinal de reputação aparece em RISCO", inbox.categories.risk.some((i: any) => i.domain === "reputation"));
  check("1.2 ações de recovery aparecem em PRECISA-APROVAÇÃO", inbox.categories.needsApproval.filter((i: any) => i.domain === "recovery").length >= 2);
  check("1.3 item de recovery carrega o correlation_id do caso", inbox.categories.needsApproval.some((i: any) => i.correlationId === cid));

  // ═══════════════ 2. APPROVAL CENTER (reuso) ═══════════════
  const pend = APPROVAL.pending(A, user);
  check("2.1 aprovações pendentes do caso listadas", pend.items.filter((i: any) => i.correlationId === cid && i.domain === "recovery").length >= 2);
  check("2.2 card traz o 'porquê' da aprovação", pend.items.every((i: any) => typeof i.why === "string" && i.why.length > 0));

  // ═══════════════ 3. THREAD (reuso, §51-52) ═══════════════
  const t0 = THREAD.thread(A, user, cid);
  check("3.1 thread tem estágio 'sinal'", t0.events.some((e: any) => e.stage === "sinal"));
  check("3.2 thread tem estágio 'decisao' (ações recovery)", t0.events.some((e: any) => e.stage === "decisao"));

  // ═══════════════ 4. INTERNAL HANDOFF (§33 — a novidade da F7) ═══════════════
  const sum = HANDOFF.buildSummary(A, s1)!;
  check("4.1 resumo determinístico traz categoria + recomendação", /Reputação · delivery/.test(sum.summary) && /Recomenda/.test(sum.summary));
  const ho = HANDOFF.handoff(A, "U1", s1, { toUserId: "U2", note: "assume aí, por favor" })!;
  check("4.2 handoff cria nota ancorada ao caso", ho.note && ho.correlationId === cid);
  check("4.3 nota cai na caixa interna do destinatário (U2)", CHAT.inbox(A, "U2").total === 1);
  const t1 = THREAD.thread(A, { userId: "U2" }, cid);
  check("4.4 nota vira estágio 'nota' na thread do destinatário", t1.events.some((e: any) => e.stage === "nota"));
  const hoBroadcast = HANDOFF.handoff(A, "U1", s1, {})!; // nota do caso (broadcast)
  check("4.5 handoff broadcast (to NULL) visível a qualquer um na thread", THREAD.thread(A, { userId: "U9" }, cid).events.some((e: any) => e.stage === "nota"));
  check("4.6 handoff não age (nenhum efeito externo, só a nota)", !!hoBroadcast.note);

  // high-risk marcado no resumo
  const sHR = caseFor(A, "isso é um golpe, não reconheço essa compra", "C1", 3);
  check("4.7 resumo de high-risk marca ALTO RISCO (RN-CRR-4)", /ALTO RISCO/.test(HANDOFF.buildSummary(A, sHR)!.summary));

  // ═══════════════ 5. caseView (§36) ═══════════════
  const view = HANDOFF.caseView(A, user, s1)!;
  check("5.1 caseView compõe thread + aprovações pendentes do caso", view.correlationId === cid && view.thread.events.length > 0 && view.pendingApprovals.length >= 2);

  // ═══════════════ 6. multi-tenant + not_found ═══════════════
  check("6.1 buildSummary não cruza org", HANDOFF.buildSummary(B, s1) === null);
  check("6.2 handoff não cruza org", HANDOFF.handoff(B, "U1", s1, {}) === null);
  check("6.3 caseView não cruza org", HANDOFF.caseView(B, user, s1) === null);
  check("6.4 signal inexistente → null", HANDOFF.handoff(A, "U1", "nope", {}) === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-falatu: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
