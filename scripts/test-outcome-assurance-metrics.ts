/**
 * TEST — OutcomeAssuranceMetricsService: métricas de garantia (PRD 8 / ADR-165 F11).
 * DB-backed, det. Prova (§13, RN-004, RN-OA-2):
 *   - coverage/effect/assured derivados por query sobre done × outcome × confirmação;
 *   - openGaps agrega os sinais de outcome_assurance abertos por tipo;
 *   - sem ações done na janela → percentuais null (não inventa 0%);
 *   - janela (days) filtra por completed_at;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:outcome-assurance-metrics
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oam-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oam-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { OutcomeAssuranceMetricsService: M } = await import("../src/server/OutcomeAssuranceMetricsService.js");
  const ORG = "org-1", OTHER = "org-2";
  const now = Date.parse("2026-08-12T15:00:00Z");
  const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();

  const mkDone = (id: string, completedAt: string, org = ORG) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, completed_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, org, "collection", "send_reminder", "T", "done", completedAt);
  const mkOutcome = (id: string, actionId: string, org = ORG) =>
    db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, measurement_method, basis, realized_value) VALUES (?,?,?,?,?,?)").run(id, org, actionId, "derived", "fact", 10);
  const mkConf = (id: string, actionId: string, status: string, org = ORG) =>
    db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status) VALUES (?,?,?,?,?)").run(id, org, actionId, "manual", status);
  const mkGapSignal = (id: string, type: string, org = ORG) =>
    db.prepare("INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, evidence_json, dedupe_key, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, org, "outcome_assurance", type, "attention", "fact", 1, "test", "{}", `dk-${id}`, "open");

  // ═══════════════ 0. sem dados → percentuais null (não inventa) ═══════════════
  const m0 = M.metrics(ORG, { now });
  check("0.1 sem ações done → coverage null (RN-OA-2)", m0.available === true && m0.done === 0 && m0.outcomeCoveragePct === null);

  // ═══════════════ 1. 4 done: 3 medidas, 2 confirmadas+medidas (assured), 1 só confirmada ═══════════════
  mkDone("a-1", daysAgo(1)); mkOutcome("o-1", "a-1"); mkConf("c-1", "a-1", "confirmed"); // assured
  mkDone("a-2", daysAgo(2)); mkOutcome("o-2", "a-2"); mkConf("c-2", "a-2", "confirmed"); // assured
  mkDone("a-3", daysAgo(3)); mkOutcome("o-3", "a-3");                                     // medida, não confirmada
  mkDone("a-4", daysAgo(4)); mkConf("c-4", "a-4", "pending");                             // nem medida nem confirmada
  const m1 = M.metrics(ORG, { now });
  check("1.1 done = 4", m1.done === 4);
  check("1.2 coverage = 3/4 = 75%", m1.outcomeCoveragePct === 75);
  check("1.3 effectConfirmed = 2/4 = 50%", m1.effectConfirmedPct === 50);
  check("1.4 assured = 2/4 = 50%", m1.assuredPct === 50 && m1.counts.assured === 2);

  // ═══════════════ 2. openGaps agrega por tipo ═══════════════
  mkGapSignal("g-1", "done_without_outcome"); mkGapSignal("g-2", "done_without_outcome"); mkGapSignal("g-3", "confirmation_timed_out");
  const m2 = M.metrics(ORG, { now });
  check("2.1 openGaps por tipo", m2.openGaps.done_without_outcome === 2 && m2.openGaps.confirmation_timed_out === 1 && m2.openGapsTotal === 3);
  check("2.2 gapRatePct = 2/4 = 50%", m2.gapRatePct === 50);

  // ═══════════════ 3. janela (days) filtra por completed_at ═══════════════
  mkDone("a-old", daysAgo(60)); mkOutcome("o-old", "a-old"); // fora da janela de 30d
  const m3 = M.metrics(ORG, { now, days: 30 });
  check("3.1 ação de 60 dias atrás fora da janela de 30d", m3.done === 4);
  const m3b = M.metrics(ORG, { now, days: 90 });
  check("3.2 janela de 90d inclui a antiga", m3b.done === 5);

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  mkDone("b-1", daysAgo(1), OTHER); mkOutcome("ob-1", "b-1", OTHER);
  const mOther = M.metrics(OTHER, { now });
  check("4.1 outra org conta só as suas (done=1, coverage 100%)", mOther.done === 1 && mOther.outcomeCoveragePct === 100);
  check("4.2 org-1 não muda", M.metrics(ORG, { now }).done === 4);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-assurance-metrics: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
