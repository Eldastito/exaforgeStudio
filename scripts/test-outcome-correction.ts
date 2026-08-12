/**
 * TEST — OutcomeCorrectionService: correção GOVERNADA de gaps (PRD 8 / ADR-165 F10).
 * DB-backed, det. Prova (§13, D6, RN-OA-9):
 *   - gap done_without_outcome (sinal aberto) → propõe ação corretiva GOVERNADA
 *     (awaiting_approval, nunca executa direto);
 *   - gap confirmation_timed_out → propõe reconfirmar/escalar;
 *   - idempotente (rodar 2× não duplica a correção da mesma correlação+tipo);
 *   - a ação corretiva NÃO é tratada como novo gap pelo Reconciler (anti-recursão);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:outcome-correction
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-corr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-corr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { OutcomeCorrectionService: CORR } = await import("../src/server/OutcomeCorrectionService.js");
  const { OutcomeReconcilerService: REC } = await import("../src/server/OutcomeReconcilerService.js");
  const ORG = "org-1", OTHER = "org-2";

  // Semeia uma ação done-sem-outcome e o sinal do gap (como a F6 publicaria).
  const mkGap = (actionId: string, signalId: string, type: string, cid: string, org = ORG, domain = "collection") => {
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, correlation_id, completed_at) VALUES (?,?,?,?,?,?,?,datetime('now','-1 hour'))")
      .run(actionId, org, domain, "send_reminder", "Cobrar Fulano", "done", cid);
    db.prepare("INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, source_entity_id, evidence_json, dedupe_key, status, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(signalId, org, "outcome_assurance", type, "attention", "fact", 1, "test", actionId, JSON.stringify({ actionId, title: "Cobrar Fulano" }), `dk-${signalId}`, "open", cid);
  };

  // ═══════════════ 1. done_without_outcome → propõe correção governada ═══════════════
  mkGap("a-1", "sig-1", "done_without_outcome", "cid-1");
  const r1 = CORR.proposeCorrections(ORG);
  check("1.1 propôs 1 correção", r1.proposed.length === 1);
  const act = r1.proposed[0];
  check("1.2 é ação corretiva de medição (actionType prefixado)", act.action_type === "outcome_correction:measure_outcome");
  check("1.3 GOVERNADA: nasce awaiting_approval, nunca done/executada (RN-OA-9)", act.status === "awaiting_approval");
  check("1.4 herda a correlação do gap", act.correlation_id === "cid-1");
  check("1.5 sem command_type (não dispara efeito externo)", !act.command_type);

  // ═══════════════ 2. confirmation_timed_out → propõe reconfirmar/escalar ═══════════════
  mkGap("a-2", "sig-2", "confirmation_timed_out", "cid-2");
  const r2 = CORR.proposeCorrections(ORG);
  check("2.1 propôs correção de reconfirmação", r2.proposed.some((a: any) => a.action_type === "outcome_correction:reconfirm_or_escalate" && a.correlation_id === "cid-2"));

  // ═══════════════ 3. idempotência (não duplica) ═══════════════
  const r3 = CORR.proposeCorrections(ORG);
  const openCorrections = db.prepare("SELECT COUNT(*) c FROM decision_actions WHERE organization_id=? AND action_type LIKE 'outcome_correction:%'").get(ORG).c;
  check("3.1 rerun não cria nova correção (já existe aberta)", r3.proposed.length === 0 && openCorrections === 2);

  // ═══════════════ 4. anti-recursão: a correção não é novo gap pro Reconciler ═══════════════
  // marca a ação corretiva como done (sem outcome) — o Reconciler NÃO deve sinalizar ELA.
  const corrId = db.prepare("SELECT id FROM decision_actions WHERE action_type='outcome_correction:measure_outcome' AND organization_id=?").get(ORG).id;
  db.prepare("UPDATE decision_actions SET status='done', completed_at=datetime('now','-1 hour') WHERE id=?").run(corrId);
  REC.reconcile(ORG);
  const signalOnCorrection = db.prepare("SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND domain='outcome_assurance' AND signal_type='done_without_outcome' AND source_entity_id=?").get(ORG, corrId).c;
  check("4.1 correção done-sem-outcome NÃO vira novo gap (anti-recursão)", signalOnCorrection === 0);

  // ═══════════════ 5. isolamento multi-tenant ═══════════════
  mkGap("b-1", "sig-b", "done_without_outcome", "cid-b", OTHER);
  const rB = CORR.proposeCorrections(ORG); // reconcilia gaps de org-1 — não deve tocar org-2
  check("5.1 proposeCorrections de org-1 não propõe pra org-2", !rB.proposed.some((a: any) => a.correlation_id === "cid-b"));
  const rB2 = CORR.proposeCorrections(OTHER);
  check("5.2 org-2 propõe a sua própria", rB2.proposed.length === 1 && rB2.proposed[0].correlation_id === "cid-b");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-correction: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
