/**
 * TEST — Endurecimento transversal do PRD 8 (ADR-165 F13). DB-backed, det.
 *
 * Codifica como REGRESSÃO os guardrails RN-OA que atravessam todos os serviços de garantia —
 * se uma fatia futura regredir um deles, este teste quebra:
 *   - RN-OA-1 DONE≠RESULTADO — done sem outcome é gap, nunca "assured";
 *   - RN-OA-2 null≠zero — métrica sem done → null; resolver sem prova → unknown;
 *   - RN-OA-3 read-only — assess/evaluate NÃO mudam a FSM;
 *   - RN-OA-5 sem dupla contagem — event_key idempotente;
 *   - RN-OA-6 determinístico — resolver pergunta ao system-of-record (SQL);
 *   - RN-OA-9 correção governada — nasce awaiting_approval, nunca executada.
 *
 * Uso: npm run test:outcome-assurance-hardening
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oahard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oahard-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { OutcomeAssuranceService: OA } = await import("../src/server/OutcomeAssuranceService.js");
  const { OutcomeMeasurementService: OM } = await import("../src/server/OutcomeMeasurementService.js");
  const { OutcomeAssuranceMetricsService: MET } = await import("../src/server/OutcomeAssuranceMetricsService.js");
  const { BusinessOutcomeResolverRegistry: REG } = await import("../src/server/BusinessOutcomeResolver.js");
  const { OutcomeCorrectionService: CORR } = await import("../src/server/OutcomeCorrectionService.js");
  const { ProcessOutcomeContractService: POC } = await import("../src/server/ProcessOutcomeContractService.js");
  const ORG = "org-1";
  const now = Date.parse("2026-08-12T15:00:00Z");

  const mkAction = (id: string, status: string, cmd: string | null = null, payload: any = null, cid: string | null = null, completedAt: string | null = null) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, command_type, command_payload_json, correlation_id, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, ORG, "collection", "send_reminder", "T", status, cmd, payload != null ? JSON.stringify(payload) : null, cid, completedAt);

  // ═══════════════ RN-OA-1 — DONE ≠ RESULTADO ═══════════════
  mkAction("a-done", "done");
  const asDone = OA.assessAction(ORG, "a-done");
  check("RN-OA-1: done sem outcome → executed + gap, NUNCA assured", asDone.assuranceState === "executed" && asDone.gaps.includes("done_without_outcome"));

  // ═══════════════ RN-OA-2 — null ≠ zero ═══════════════
  check("RN-OA-2a: métrica sem done na janela → coverage null (não 0%)", MET.metrics("org-vazia", { now }).outcomeCoveragePct === null);
  mkAction("a-nolink", "done", "collection_send_reminder", {});
  check("RN-OA-2b: resolver sem prova no system-of-record → unknown", REG.resolve(ORG, db.prepare("SELECT * FROM decision_actions WHERE id='a-nolink'").get()).resolved === "unknown");

  // ═══════════════ RN-OA-3 — read-only (não muda a FSM) ═══════════════
  OA.assessAction(ORG, "a-done"); OA.assessCorrelation(ORG, "whatever");
  check("RN-OA-3a: assess não muda o status da ação", db.prepare("SELECT status FROM decision_actions WHERE id='a-done'").get().status === "done");
  // ProcessOutcomeContract: avaliar não muda o status da instância
  const defId = "def-h";
  db.prepare("INSERT INTO process_definitions (id, organization_id, process_type, name, version, success_conditions_json, steps_json) VALUES (?,?,?,?,?,?,?)")
    .run(defId, ORG, "pt-h", "P", 1, JSON.stringify({ op: "truthy", path: "paid" }), JSON.stringify([{ id: "s1", commandType: "noop" }]));
  db.prepare("INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, context_json) VALUES (?,?,?,?,?,?)")
    .run("inst-h", ORG, defId, "pt-h", "executing", JSON.stringify({ paid: true }));
  POC.evaluate(ORG, "inst-h");
  check("RN-OA-3b: evaluate do contrato não muda o status da instância", db.prepare("SELECT status FROM process_instances WHERE id='inst-h'").get().status === "executing");

  // ═══════════════ RN-OA-5 — sem dupla contagem (event_key idempotente) ═══════════════
  mkAction("a-ek", "done");
  OM.record(ORG, "a-ek", { revenueRecovered: 100, basis: "fact", eventKey: "ek-1" });
  OM.record(ORG, "a-ek", { revenueRecovered: 100, basis: "fact", eventKey: "ek-1" });
  check("RN-OA-5: event_key idempotente → 1 outcome (não dobra)", db.prepare("SELECT COUNT(*) c FROM action_outcomes WHERE action_id='a-ek'").get().c === 1);

  // ═══════════════ RN-OA-6 — determinístico (system-of-record) ═══════════════
  db.prepare("INSERT INTO receivables (id, organization_id, description, amount, due_date, status, received_at) VALUES (?,?,?,?,?,?,?)").run("r-paid", ORG, "F", 200, "2026-08-01", "received", "2026-08-05");
  mkAction("a-paid", "done", "collection_send_reminder", { receivableId: "r-paid" });
  const rr = REG.resolve(ORG, db.prepare("SELECT * FROM decision_actions WHERE id='a-paid'").get());
  check("RN-OA-6: resolver pergunta ao system-of-record (receivable pago → confirmed, basis system_of_record)", rr.resolved === "confirmed" && rr.basis === "system_of_record");

  // ═══════════════ RN-OA-9 — correção governada (nunca executa) ═══════════════
  mkAction("a-gap", "done", null, null, "cid-gap", new Date(now - 3600000).toISOString());
  db.prepare("INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, source_entity_id, evidence_json, dedupe_key, status, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("sig-gap", ORG, "outcome_assurance", "done_without_outcome", "attention", "fact", 1, "test", "a-gap", "{}", "dk-gap", "open", "cid-gap");
  const corr = CORR.proposeCorrections(ORG);
  check("RN-OA-9: correção nasce awaiting_approval, NUNCA executada", corr.proposed.length === 1 && corr.proposed[0].status === "awaiting_approval" && !corr.proposed[0].command_type);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-assurance-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
