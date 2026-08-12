/**
 * TEST — sweepTimeouts publica sinal de SLA de confirmação (PRD 8 / ADR-165 F7).
 * DB-backed, det. Prova (§13, gap de integração da auditoria):
 *   - confirmação pending vencida → sweepTimeouts marca timed_out E publica business_signal
 *     (domain outcome_assurance / confirmation_timed_out) que aparece em attention();
 *   - confirmação ainda no prazo → não fecha nem sinaliza;
 *   - idempotente (rodar 2× não duplica sinal);
 *   - sinal carrega correlationId/actionId da ação (rastreável);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:confirmation-timeout-signal
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cts-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cts-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { ConfirmationEngine: CE } = await import("../src/server/ConfirmationEngine.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkAction = (id: string, org = ORG) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id) VALUES (?,?,?,?,?,?,?)")
      .run(id, org, "collection", "send_reminder", "Cobrar", "approved", `cid-${id}`);
  const mkConf = (id: string, actionId: string, deadlineAt: string, org = ORG) =>
    db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, deadline_at) VALUES (?,?,?,?,?,?)")
      .run(id, org, actionId, "asaas_payment_webhook", "pending", deadlineAt);
  const signals = (org = ORG) => db.prepare("SELECT * FROM business_signals WHERE organization_id=? AND domain='outcome_assurance' AND signal_type='confirmation_timed_out'").all(org) as any[];
  const past = new Date(Date.now() - 3600_000).toISOString();   // 1h atrás (vencido)
  const future = new Date(Date.now() + 3600_000).toISOString(); // 1h à frente (no prazo)

  // ═══════════════ 1. vencida → timed_out + sinal ═══════════════
  mkAction("a-1"); mkConf("c-1", "a-1", past);
  const closed = CE.sweepTimeouts(ORG);
  check("1.1 sweepTimeouts fecha a vencida", closed === 1);
  check("1.2 confirmação virou timed_out", (db.prepare("SELECT status FROM action_confirmations WHERE id='c-1'").get() as any).status === "timed_out");
  const s1 = signals();
  check("1.3 publicou sinal confirmation_timed_out (attention)", s1.length === 1 && s1[0].source_entity_id === "c-1");
  check("1.4 sinal severity risk + basis fact", s1[0].severity === "risk" && s1[0].basis === "fact");
  check("1.5 sinal rastreável: correlationId + actionId no evidence", s1[0].correlation_id === "cid-a-1" && JSON.parse(s1[0].evidence_json).actionId === "a-1");

  // ═══════════════ 2. no prazo → nada ═══════════════
  mkAction("a-2"); mkConf("c-2", "a-2", future);
  CE.sweepTimeouts(ORG);
  check("2.1 confirmação no prazo não fecha", (db.prepare("SELECT status FROM action_confirmations WHERE id='c-2'").get() as any).status === "pending");
  check("2.2 sem sinal pra confirmação no prazo", !signals().some((s) => s.source_entity_id === "c-2"));

  // ═══════════════ 3. idempotência (rodar de novo não duplica) ═══════════════
  const before = signals().length;
  CE.sweepTimeouts(ORG); CE.sweepTimeouts(ORG);
  check("3.1 reruns não duplicam sinal (dedupeKey + já não está pending)", signals().length === before);

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  mkAction("b-1", OTHER); mkConf("d-1", "b-1", past, OTHER);
  CE.sweepTimeouts(ORG); // sweep de org-1 não deve tocar org-2
  check("4.1 sweep de org-1 não fecha confirmação de org-2", (db.prepare("SELECT status FROM action_confirmations WHERE id='d-1'").get() as any).status === "pending");
  check("4.2 sem sinal na outra org ainda", signals(OTHER).length === 0);
  CE.sweepTimeouts(OTHER);
  check("4.3 sweep de org-2 sinaliza a sua", signals(OTHER).length === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} confirmation-timeout-signal: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
