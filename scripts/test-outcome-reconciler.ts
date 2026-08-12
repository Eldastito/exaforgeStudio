/**
 * TEST — OutcomeReconcilerService: done-sem-outcome → sinal (PRD 8 / ADR-165 F6, achado (b)).
 * DB-backed, det. Prova (§13, RN-OA-1/2/3):
 *   - ação done sem outcome, fora da janela de graça → publica business_signal (aparece em attention);
 *   - dentro da graça → NÃO sinaliza (medição é assíncrona, RN-OA-2);
 *   - ação done COM outcome → não sinaliza;
 *   - idempotente (rodar 2× não duplica sinal);
 *   - quando o outcome chega depois → RESOLVE o sinal (recuperou);
 *   - RN-OA-3: não muda o status da ação;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:outcome-reconciler
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-recon-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-recon-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { OutcomeReconcilerService: REC } = await import("../src/server/OutcomeReconcilerService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const ORG = "org-1", OTHER = "org-2";
  const now = Date.parse("2026-08-12T15:00:00Z");
  const MIN = 60000;

  const mkAction = (id: string, status: string, completedAt: string | null, org = ORG) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, completed_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, org, "collection", "send_reminder", "Cobrar", status, completedAt);
  const mkOutcome = (id: string, actionId: string, org = ORG) =>
    db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, measurement_method, basis, realized_value) VALUES (?,?,?,?,?,?)")
      .run(id, org, actionId, "derived", "fact", 100);
  const openSignals = (org = ORG) => db.prepare("SELECT * FROM business_signals WHERE organization_id=? AND domain='outcome_assurance' AND status='open'").all(org) as any[];
  const dedupe = (actionId: string) => `outcome_assurance:done_without_outcome:${actionId}`;

  // ═══════════════ 1. done sem outcome, fora da graça → sinaliza ═══════════════
  mkAction("a-gap", "done", new Date(now - 30 * MIN).toISOString()); // 30min atrás > graça 15min
  const r1 = REC.reconcile(ORG, { now });
  check("1.1 sinaliza 1 gap", r1.flagged === 1);
  check("1.2 sinal aparece em business_signals (attention)", openSignals().some((s) => s.source_entity_id === "a-gap" && s.signal_type === "done_without_outcome"));
  check("1.3 sinal tem severity attention + basis fact", (() => { const s = openSignals().find((x) => x.source_entity_id === "a-gap"); return s && s.severity === "attention" && s.basis === "fact"; })());

  // ═══════════════ 2. dentro da janela de graça → NÃO sinaliza (RN-OA-2) ═══════════════
  mkAction("a-fresh", "done", new Date(now - 5 * MIN).toISOString()); // 5min < graça
  const r2 = REC.reconcile(ORG, { now });
  check("2.1 ação recém-done não é acusada (graça)", !openSignals().some((s) => s.source_entity_id === "a-fresh"));

  // ═══════════════ 3. done COM outcome → não sinaliza ═══════════════
  mkAction("a-ok", "done", new Date(now - 30 * MIN).toISOString()); mkOutcome("o-ok", "a-ok");
  REC.reconcile(ORG, { now });
  check("3.1 done com outcome → sem sinal", !openSignals().some((s) => s.source_entity_id === "a-ok"));

  // ═══════════════ 4. idempotência (rodar 2× não duplica) ═══════════════
  const before = openSignals().length;
  REC.reconcile(ORG, { now }); REC.reconcile(ORG, { now });
  check("4.1 reruns não duplicam sinal (dedupeKey)", openSignals().length === before);

  // ═══════════════ 5. outcome chega depois → resolve o sinal (recuperou) ═══════════════
  mkOutcome("o-late", "a-gap");                 // medição atrasada chega
  const r5 = REC.reconcile(ORG, { now });
  check("5.1 outcome tardio → resolve o sinal", r5.resolved >= 1 && !openSignals().some((s) => s.source_entity_id === "a-gap"));
  check("5.2 sinal foi marcado resolved (não deletado — histórico)", (db.prepare("SELECT status FROM business_signals WHERE dedupe_key=?").get(dedupe("a-gap")) as any).status === "resolved");

  // ═══════════════ 6. RN-OA-3: não muda o status da ação ═══════════════
  check("6.1 status da ação intacto (read-only sobre a FSM)", (db.prepare("SELECT status FROM decision_actions WHERE id='a-fresh'").get() as any).status === "done");

  // ═══════════════ 7. isolamento multi-tenant ═══════════════
  mkAction("b-gap", "done", new Date(now - 30 * MIN).toISOString(), OTHER);
  REC.reconcile(ORG, { now }); // reconcilia org-1 — não deve tocar org-2
  check("7.1 reconcile de org-1 não sinaliza ação de org-2", openSignals(OTHER).length === 0);
  const rOther = REC.reconcile(OTHER, { now });
  check("7.2 reconcile de org-2 sinaliza a sua própria", rOther.flagged === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-reconciler: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
