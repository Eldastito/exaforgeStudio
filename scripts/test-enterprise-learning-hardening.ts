/**
 * TEST — Enterprise Learning HARDENING (PRD 9 / ADR-166 F14). DB-backed, determinístico.
 *
 * Codifica os GUARDRAILS RN-EL/RN-EI como REGRESSÃO TRANSVERSAL (o mesmo papel do
 * test:outcome-assurance-hardening no PRD 8). Se qualquer fatia futura violar um
 * invariante do PRD 9, ESTE teste quebra:
 *   RN-EL-1 DONE ≠ EXEMPLO — só `assured` aprende forte;
 *   RN-EL-4 idempotência — mesmo event_key não dobra;
 *   RN-EL-5 null ≠ zero — sem prova → null, nunca 0;
 *   RN-EL-6 fact/estimate/assured nunca somados — recorte assured separado do misto;
 *   RN-EL-8 prior ASSIMÉTRICO — só adiciona cautela, nunca relaxa nem toca hold_for_human;
 *   RN-EL-7 isolamento — cross-tenant proibido;
 *   RN-EI-1/6 model_knowledge ≠ live + grounding — live sem fonte bloqueia;
 *   RN-EI-2 anonimização — nome do tenant vazado bloqueia;
 *   motor ÚNICO — o ledger business_pattern_outcomes é a fonte única do aprendizado.
 *
 * Uso: npm run test:enterprise-learning-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-elh-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-elh-123456";
delete process.env.EXTERNAL_RESEARCH_SEARCH_URL;

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { LearningEpisodeService: LEP } = await import("../src/server/LearningEpisodeService.js");
  const { DecisionEngine: DE } = await import("../src/server/DecisionEngine.js");
  const { ResearchCuratorService: CUR } = await import("../src/server/ResearchCuratorService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { StubResearchProvider, LiveSearchResearchProvider } = await import("../src/server/ExternalResearchProvider.js");

  const ORG = "org-1", OTHER = "org-2";
  const mkP = (org: string, id: string, type: string) => db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)").run(id, org, "procurement", type, id + "-k", "p", 0.5, "validated", 3);

  // ── RN-EL-4 idempotência ──
  mkP(ORG, "p-idem", "t_idem");
  PM.recordOutcome(ORG, "p-idem", { outcome: "worked", eventKey: "k1", source: "assured" });
  PM.recordOutcome(ORG, "p-idem", { outcome: "worked", eventKey: "k1", source: "assured" });
  check("RN-EL-4 mesmo event_key não dobra acted", PM.typeStats(ORG, "procurement", "t_idem")!.acted === 1);

  // ── RN-EL-1 DONE ≠ exemplo + RN-EL-5 null ≠ zero + RN-EL-6 recorte separado ──
  mkP(ORG, "p-mix", "t_mix");
  PM.recordOutcome(ORG, "p-mix", { outcome: "backfired", eventKey: "man", source: "manual" }); // manual não é prova forte
  const sMix = PM.assuredStats(ORG, "procurement", "t_mix");
  check("RN-EL-5 sem assured → assuredEffectiveness null (não 0)", sMix.assuredEffectiveness === null);
  check("RN-EL-1/6 misto ≠ assured (manual não vira prova forte)", PM.typeStats(ORG, "procurement", "t_mix")!.acted === 1 && sMix.assuredActed === 0);

  // ── RN-EL-8 prior ASSIMÉTRICO (só adiciona cautela; nunca relaxa; nunca toca hold_for_human) ──
  // Org DEDICADO: só um padrão com prova assegurada CONTRÁRIA (isola o efeito do prior).
  const ORG3 = "org-3";
  mkP(ORG3, "p-bad", "reorder_bad");
  PM.recordOutcome(ORG3, "p-bad", { outcome: "backfired", eventKey: "b1", source: "assured" });
  PM.recordOutcome(ORG3, "p-bad", { outcome: "backfired", eventKey: "b2", source: "assured" });
  const big = { title: "Compra", decisionType: "purchase", impactAmount: 150000, impactUnit: "BRL", severity: "risk", learningDomain: "procurement" };
  const proceed = DE.analyze(ORG3, big);
  check("RN-EL-8 prior cautionary sobe proceed→proceed_with_caution", proceed.recommendation.stance === "proceed_with_caution" && proceed.recommendation.learning.changedStance === true);
  const l4 = DE.analyze(ORG3, { ...big, severity: "critical", override: true } as any);
  check("RN-EL-8 nunca toca hold_for_human (L4)", l4.recommendation.stance === "hold_for_human" && l4.recommendation.learning.changedStance === false);

  // ── RN-EL-7 isolamento cross-tenant ──
  mkP(OTHER, "p-o", "t_idem"); PM.recordOutcome(OTHER, "p-o", { outcome: "worked", eventKey: "o1", source: "assured" });
  check("RN-EL-7 aprendizado da OTHER não vaza pro ORG", LEP.episode(ORG, "p-o").found === false && PM.assuredStats(ORG, "procurement", "t_idem").assuredActed === 1);

  // ── RN-EI-1/6 model_knowledge ≠ live + grounding ──
  const stub = new StubResearchProvider().research({ vertical: "padaria", topic: "insumos", query: "x" });
  check("RN-EI-1 stub é model_knowledge (não live)", stub.evidenceMode === "model_knowledge");
  const live = await new LiveSearchResearchProvider().research({ vertical: "padaria", topic: "insumos", query: "x" });
  check("RN-EI-6 live sem vendor cai em model_knowledge (não inventa fonte)", live.evidenceMode === "model_knowledge" && live.sourceEvidence.length === 0);
  const ungrounded = CUR.assessQuality({ content: { summary: "s", drivers: ["a"] }, confidence: 0.6, evidenceMode: "live", sourceEvidence: [] });
  check("RN-EI-5 GROUNDING: live sem fonte é bloqueado", ungrounded.ok === false && ungrounded.reasons.includes("ungrounded_live"));

  // ── RN-EI-2 anonimização (nome do tenant vazado bloqueia) ──
  db.prepare("INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,'active')").run(randomUUID(), "org-tenant", "Padaria Segredo Ltda");
  let threw = false;
  try { VI.publish({ userId: "u", organizationId: "org-tenant" }, { vertical: "padaria", topic: "x", content: { summary: "A Padaria Segredo Ltda vaza aqui." }, sources: [], confidence: 0.6, provider: "stub" }); } catch (e: any) { threw = /anonymize_violation/.test(String(e?.message)); }
  check("RN-EI-2 nome do tenant no compartilhado → bloqueia", threw === true);

  // ── motor ÚNICO: o ledger é a fonte única do aprendizado (F1) ──
  const hasLedger = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='business_pattern_outcomes'").get() as any);
  check("motor único: ledger business_pattern_outcomes existe (fonte única)", !!hasLedger);
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_business_pattern_outcomes_event_key'").get() as any);
  check("idempotência é dura: índice UNIQUE parcial por event_key existe", !!idx);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} enterprise-learning-hardening: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
