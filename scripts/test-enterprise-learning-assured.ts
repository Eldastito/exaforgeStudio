/**
 * TEST — Enterprise Learning F1 (PRD 9 / ADR-166): idempotência de recordOutcome +
 * ligação OutcomeAssurance(assured)→PatternMemory. DB-backed, determinístico.
 *
 * Prova (§9/CA2, RN-EL-1..4/6/7):
 *   - recordOutcome grava ledger por-evento + procedência (source manual|assured);
 *   - mesmo event_key 2× é no-op (não dobra acted) — idempotência (achado (a) F0);
 *   - sem event_key ainda funciona (compat legado);
 *   - learnFromAction: só `assured` aprende forte (DONE ≠ exemplo); não-assured é ignorado;
 *   - só ação nascida de PADRÃO ensina (sinal com source_entity_type='business_pattern');
 *   - desfecho DETERMINÍSTICO do valor medido (fato): impacto < 0 → backfired, senão worked;
 *   - sweep é idempotente (rodar 2× não dobra); isolamento multi-tenant.
 *
 * Uso: npm run test:enterprise-learning-assured
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ela-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ela-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { PatternLearningFromAssuranceService: LRN } = await import("../src/server/PatternLearningFromAssuranceService.js");
  const ORG = "org-1", OTHER = "org-2";

  // habilita o motor nas duas orgs (a flag gateia orgsToLearn)
  for (const o of [ORG, OTHER]) db.prepare("INSERT OR IGNORE INTO organization_settings (organization_id, pattern_memory) VALUES (?, 1)").run(o);
  db.prepare("UPDATE organization_settings SET pattern_memory = 1 WHERE organization_id IN (?, ?)").run(ORG, OTHER);

  const mkPattern = (id: string, org = ORG, type = "stockout_risk", conf = 0.5) =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, "procurement", type, id + "-key", "padrão " + id, conf, "validated", 3);
  const mkSignal = (id: string, patternId: string | null, org = ORG) =>
    db.prepare("INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, source_entity_type, source_entity_id, evidence_json, dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, org, "procurement", "stockout_risk", "risk", "fact", 0.6, "PatternMemoryService", patternId ? "business_pattern" : "detector", patternId, "{}", "sig:" + id);
  const mkAction = (id: string, signalId: string | null, org = ORG, status = "done") =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, signal_id, domain, action_type, title, status, correlation_id, completed_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
      .run(id, org, signalId, "procurement", "reorder", "Repor", status, "corr:" + id);
  const mkConfirm = (actionId: string, org = ORG, status = "confirmed") =>
    db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, confirmed_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)")
      .run("cf-" + actionId, org, actionId, "manual", status);
  const mkOutcome = (actionId: string, realized: number, org = ORG, basis = "fact") =>
    db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method) VALUES (?,?,?,?,?,?,?)")
      .run("ao-" + actionId + "-" + Math.round(realized), org, actionId, realized, realized, basis, "manual");
  const stats = (org: string, type: string) => PM.typeStats(org, "procurement", type);
  const ledgerCount = (org: string, patternId: string) => (db.prepare("SELECT COUNT(*) c FROM business_pattern_outcomes WHERE organization_id=? AND pattern_id=?").get(org, patternId) as any).c;

  // ═══════════════ 1. recordOutcome: ledger + procedência ═══════════════
  mkPattern("p-manual", ORG, "manual_type");
  const r1 = PM.recordOutcome(ORG, "p-manual", { outcome: "worked", realizedImpact: 100 });
  check("1.1 recordOutcome ok + outcomeId", r1.ok === true && !!r1.outcomeId);
  check("1.2 grava linha no ledger", ledgerCount(ORG, "p-manual") === 1);
  const src1 = db.prepare("SELECT source FROM business_pattern_outcomes WHERE id=?").get(r1.outcomeId) as any;
  check("1.3 source default = manual", src1.source === "manual");
  check("1.4 acted incrementado", stats(ORG, "manual_type")!.acted === 1);

  // ═══════════════ 2. idempotência por event_key (achado (a) F0) ═══════════════
  mkPattern("p-idem", ORG, "idem_type");
  const e1 = PM.recordOutcome(ORG, "p-idem", { outcome: "worked", realizedImpact: 50, eventKey: "evt-1", source: "assured" });
  const e2 = PM.recordOutcome(ORG, "p-idem", { outcome: "worked", realizedImpact: 50, eventKey: "evt-1", source: "assured" });
  check("2.1 1ª grava (learned)", e1.ok === true && !e1.idempotent);
  check("2.2 2ª é no-op idempotente", e2.ok === true && e2.idempotent === true);
  check("2.3 acted NÃO dobra (fica 1)", stats(ORG, "idem_type")!.acted === 1);
  check("2.4 ledger tem só 1 linha", ledgerCount(ORG, "p-idem") === 1);
  check("2.5 source registrado = assured", (db.prepare("SELECT source FROM business_pattern_outcomes WHERE event_key='evt-1'").get() as any).source === "assured");

  // ═══════════════ 3. event_keys distintos contam separado ═══════════════
  PM.recordOutcome(ORG, "p-idem", { outcome: "no_effect", eventKey: "evt-2", source: "assured" });
  check("3.1 event_key novo conta (acted=2)", stats(ORG, "idem_type")!.acted === 2);

  // ═══════════════ 4. learnFromAction: só assured aprende (DONE ≠ exemplo, RN-EL-1) ═══════════════
  // 4a. ação assured, nascida de padrão → aprende worked
  mkPattern("p-a", ORG, "reorder");
  mkSignal("s-a", "p-a"); mkAction("a-a", "s-a"); mkConfirm("a-a"); mkOutcome("a-a", 300);
  const la = LRN.learnFromAction(ORG, "a-a");
  check("4.1 assured + de padrão → learned worked", la.ok && la.learned === true && la.outcome === "worked" && la.assuranceState === "assured");
  check("4.2 patternId correto", la.patternId === "p-a");
  check("4.3 stats do tipo reorder registrou 1", stats(ORG, "reorder")!.acted === 1 && stats(ORG, "reorder")!.worked === 1);

  // 4b. reprocessar a MESMA ação assured → idempotente (RN-EL-4)
  const laDup = LRN.learnFromAction(ORG, "a-a");
  check("4.4 reprocessa assured → idempotente (não dobra)", laDup.idempotent === true && stats(ORG, "reorder")!.acted === 1);

  // ═══════════════ 5. não-assured NÃO aprende ═══════════════
  // 5a. done, de padrão, mas SEM confirmação → só impact_measured, não assured
  mkPattern("p-b", ORG, "reorder_b");
  mkSignal("s-b", "p-b"); mkAction("a-b", "s-b"); mkOutcome("a-b", 100); // sem confirm
  const lb = LRN.learnFromAction(ORG, "a-b");
  check("5.1 sem confirmação → não aprende (nao_assured)", lb.learned === false && lb.reason === "nao_assured");
  check("5.2 stats reorder_b não criado", stats(ORG, "reorder_b") === null);

  // 5b. assured mas NÃO nascida de padrão (sinal de detector) → não aprende
  mkSignal("s-c", null); mkAction("a-c", "s-c"); mkConfirm("a-c"); mkOutcome("a-c", 100);
  const lc = LRN.learnFromAction(ORG, "a-c");
  check("5.3 assured mas sinal não-padrão → sinal_nao_veio_de_padrao", lc.learned === false && lc.reason === "sinal_nao_veio_de_padrao");

  // 5c. ação sem sinal de origem
  mkAction("a-d", null); mkConfirm("a-d"); mkOutcome("a-d", 100);
  const ld = LRN.learnFromAction(ORG, "a-d");
  check("5.4 sem sinal de origem → sem_sinal_de_origem", ld.learned === false && ld.reason === "sem_sinal_de_origem");

  // ═══════════════ 6. desfecho DETERMINÍSTICO do valor medido (RN-EL-3) ═══════════════
  mkPattern("p-neg", ORG, "reorder_neg");
  mkSignal("s-neg", "p-neg"); mkAction("a-neg", "s-neg"); mkConfirm("a-neg"); mkOutcome("a-neg", -200);
  const lneg = LRN.learnFromAction(ORG, "a-neg");
  check("6.1 impacto medido < 0 → backfired", lneg.learned === true && lneg.outcome === "backfired");
  check("6.2 stats reorder_neg backfired=1", stats(ORG, "reorder_neg")!.backfired === 1);

  // fato vs estimate: só fato conta o valor (RN-EL-6)
  mkPattern("p-est", ORG, "reorder_est");
  mkSignal("s-est", "p-est"); mkAction("a-est", "s-est"); mkConfirm("a-est");
  mkOutcome("a-est", 500, ORG, "estimate"); // estimate não deve dar valor realizado
  const lest = LRN.learnFromAction(ORG, "a-est");
  check("6.3 só estimate (sem fato) → realizedImpact 0 → worked", lest.learned === true && lest.outcome === "worked" && lest.realizedImpact === 0);

  // ═══════════════ 7. sweep idempotente ═══════════════
  const sw1 = LRN.sweep(ORG, { lookbackDays: 365 });
  check("7.1 sweep encontra ações assured de padrão", sw1.scanned >= 3 && sw1.assured >= 3);
  const actedBefore = stats(ORG, "reorder")!.acted;
  const sw2 = LRN.sweep(ORG, { lookbackDays: 365 });
  check("7.2 2º sweep não aprende de novo (idempotent>0, learned=0)", sw2.learned === 0 && sw2.idempotent >= 3);
  check("7.3 acted estável entre sweeps", stats(ORG, "reorder")!.acted === actedBefore);

  // ═══════════════ 8. isolamento multi-tenant (RN-EL-7) ═══════════════
  mkPattern("p-o", OTHER, "reorder"); mkSignal("s-o", "p-o", OTHER); mkAction("a-o", "s-o", OTHER); mkConfirm("a-o", OTHER); mkOutcome("a-o", 90, OTHER);
  // org-1 não deve aprender da ação da outra org
  const lcross = LRN.learnFromAction(ORG, "a-o");
  check("8.1 org-1 não enxerga ação da outra org", lcross.learned === false && lcross.reason === "acao_nao_encontrada");
  LRN.learnFromAction(OTHER, "a-o");
  const otherStats = stats(OTHER, "reorder");
  const org1Reorder = stats(ORG, "reorder")!.acted;
  check("8.2 aprendizado da OTHER isolado (não mistura com org-1)", otherStats!.acted === 1 && org1Reorder === actedBefore);

  // ═══════════════ 9. pattern ausente / inválido ═══════════════
  check("9.1 outcome inválido rejeitado", PM.recordOutcome(ORG, "p-manual", { outcome: "bogus" }).ok === false);
  check("9.2 padrão inexistente rejeitado", PM.recordOutcome(ORG, "ghost", { outcome: "worked" }).ok === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} enterprise-learning-assured: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
