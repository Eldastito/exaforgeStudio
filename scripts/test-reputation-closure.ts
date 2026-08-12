/**
 * TEST — Reputation Réplica + Closure (PRD 5 / ADR-162 F10). DB-backed, det., isolado.
 * Prova (§31, §11.10):
 *   - RÉPLICA (§31): syncReplies grava a resposta do CONSUMIDOR no caso (cercada §11),
 *     deduped; réplica nova de consumidor num caso FECHADO REABRE o caso (mesmo caso);
 *   - FECHAMENTO (§11.10): close('resolved') resolve o sinal e CONFIRMA a reputation_reply
 *     armada na F8 → a ação de resposta fecha em 'done' com outcome;
 *   - close('not_resolved') reconhece o sinal e DISPENSA a pendência;
 *   - multi-tenant.
 *
 * Uso: npm run test:reputation-closure
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-clo-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-clo-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const tick = () => new Promise((r) => setTimeout(r, 40));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationReplyService: REPLY } = await import("../src/server/ReputationReplyService.js");
  const { ReputationClosureService: CLOSE } = await import("../src/server/ReputationClosureService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { ConfirmationEngine: CONF } = await import("../src/server/ConfirmationEngine.js");

  const A = "org_clo_A", B = "org_clo_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  enableOrg(A); enableOrg(B); mkContact(A, "CA"); mkContact(B, "CB");
  const contactOf: Record<string, string> = { [A]: "CA", [B]: "CB" };

  // ingere com externalId dado (RA-1002 tem réplicas no stub); re-sujeita ao contato.
  const caseWith = (org: string, externalId: string, content: string) => {
    const sid = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating: 1, ratingScale: 5 }).signalId!;
    CASE.resolveCase(org, sid, { contactId: contactOf[org] });
    return sid;
  };
  const evOf = (sid: string) => { const r = db.prepare(`SELECT evidence_json e FROM business_signals WHERE id = ?`).get(sid) as any; try { return JSON.parse(r.e || "{}"); } catch { return {}; } };
  const statusOf = (sid: string) => (db.prepare(`SELECT status FROM business_signals WHERE id = ?`).get(sid) as any).status;

  // ═══════════════ 1. RÉPLICA do consumidor gravada + deduped ═══════════════
  const sRep = caseWith(A, "RA-1002", "cobrança em duplicidade, quero estorno");
  const r1 = await CLOSE.syncReplies(A, sRep, { provider: "stub" });
  check("1.1 réplica do consumidor detectada", r1!.newConsumerReplies.length === 1 && /estorno/.test(r1!.newConsumerReplies[0].content));
  check("1.2 conteúdo cercado (untrusted), benigno não-suspeito", r1!.newConsumerReplies[0].content.includes("untrusted_external_data") && r1!.newConsumerReplies[0].suspicious === false);
  check("1.3 grava as respostas no caso (empresa + consumidor)", (evOf(sRep).replies || []).length === 2);
  const r1b = await CLOSE.syncReplies(A, sRep, { provider: "stub" });
  check("1.4 idempotente: re-sync não duplica", r1b!.newConsumerReplies.length === 0 && (evOf(sRep).replies || []).length === 2);

  // ═══════════════ 2. Réplica nova num caso FECHADO REABRE (§31) ═══════════════
  const sReopen = caseWith(B, "RA-1002", "cobrança em duplicidade");
  CLOSE.close(B, sReopen, { resolution: "resolved" });      // fecha
  check("2.1 caso fechado (resolved)", statusOf(sReopen) === "resolved");
  const r2 = await CLOSE.syncReplies(B, sReopen, { provider: "stub" }); // consumidor havia dado réplica
  check("2.2 réplica nova do consumidor REABRE o caso", r2!.reopened === true && statusOf(sReopen) === "open");

  // ═══════════════ 3. FECHAMENTO confirma a resposta da F8 (§11.10) ═══════════════
  const sReply = caseWith(A, "RA-9001", "meu pedido não chegou");
  const d = REPLY.draft(A, sReply, { content: "Sentimos muito, vamos verificar e retornar.", provider: "stub" })!;
  DA.approve(A, d.action.id, "U1");
  await REPLY.publish(A, d.action.id); // F8 publica + arma confirmação
  check("3.1 pré: confirmação da resposta pendente", CONF.getForAction(A, d.action.id)?.status === "pending");
  const cl = CLOSE.close(A, sReply, { resolution: "resolved", actorId: "U1", note: "cliente satisfeito" })!;
  check("3.2 close resolve o sinal", statusOf(sReply) === "resolved");
  check("3.3 close CONFIRMA a resposta (loop §11.10)", cl.confirmed.includes(d.action.id) && CONF.getForAction(A, d.action.id)?.status === "confirmed");
  await tick();
  check("3.4 a ação de resposta fecha em 'done' (outcome registrado)", DA.get(A, d.action.id).status === "done");

  // ═══════════════ 4. not_resolved reconhece + dispensa a pendência ═══════════════
  const sNR = caseWith(A, "RA-9002", "atendimento péssimo");
  const d2 = REPLY.draft(A, sNR, { content: "Estamos verificando.", provider: "stub" })!;
  DA.approve(A, d2.action.id, "U1");
  await REPLY.publish(A, d2.action.id);
  const cl2 = CLOSE.close(A, sNR, { resolution: "not_resolved", actorId: "U1" })!;
  check("4.1 not_resolved reconhece o sinal", statusOf(sNR) === "acknowledged");
  check("4.2 dispensa a confirmação pendente", cl2.dismissed.includes(d2.action.id) && CONF.getForAction(A, d2.action.id)?.status === "dismissed");

  // ═══════════════ 5. multi-tenant ═══════════════
  check("5.1 close não cruza org", CLOSE.close(B, sReply, { resolution: "resolved" }) === null);
  check("5.2 syncReplies não cruza org", (await CLOSE.syncReplies(B, sReply, { provider: "stub" })) === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-closure: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
