/**
 * TEST — learningPrior no DecisionEngine (PRD 9 / ADR-166 F5). DB-backed, determinístico.
 *
 * Prova (§9, CA11-14, RN-EL-2/3/8):
 *   - decisão consome o historicalEvidence (F4) como prior de aprendizado;
 *   - ASSIMÉTRICO: prior 'cautionary' sobe proceed → proceed_with_caution;
 *   - NUNCA relaxa: prior 'supportive' não rebaixa uma postura já cautelosa;
 *   - NUNCA toca hold_for_human (L4 é do humano);
 *   - explicável: o porquê lista os padrões assegurados que pesaram;
 *   - learningDomain filtra; sem aprendizado → prior neutro, postura intacta.
 *
 * Uso: npm run test:learning-prior
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lpr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-lpr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PatternMemoryService: PM } = await import("../src/server/PatternMemoryService.js");
  const { DecisionEngine: DE } = await import("../src/server/DecisionEngine.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare("INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')").run(randomUUID(), id); return id; };
  const mkPattern = (org: string, id: string, type: string, domain = "procurement") =>
    db.prepare("INSERT INTO business_patterns (id, organization_id, domain, pattern_type, pattern_key, description, confidence, status, occurrences) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, org, domain, type, id + "-k", "aprendi " + type, 0.6, "validated", 3);
  const asr = (org: string, pid: string, outcome: string, key: string) => PM.recordOutcome(org, pid, { outcome, eventKey: key, source: "assured" });

  // decisão L3 (150k BRL, severity risk) SEM riscos altos → base 'proceed'
  const bigDecision = { title: "Comprar estoque", decisionType: "purchase", impactAmount: 150000, impactUnit: "BRL", severity: "risk", learningDomain: "procurement" };

  // ═══════════════ 1. sem aprendizado → prior neutro, postura intacta ═══════════════
  const orgA = mkOrg();
  const a1 = DE.analyze(orgA, bigDecision);
  check("1.1 L3 dispara análise profunda", a1.level === "L3" && a1.skipped === false);
  check("1.2 sem aprendizado → learningPrior.applied false", a1.learningPrior.applied === false);
  check("1.3 base sem riscos altos → proceed", a1.recommendation.stance === "proceed" && a1.recommendation.learning === null);

  // ═══════════════ 2. prior 'cautionary' sobe proceed → proceed_with_caution ═══════════════
  const orgB = mkOrg();
  mkPattern(orgB, "p-bad", "reorder_bad");
  asr(orgB, "p-bad", "backfired", "b1"); asr(orgB, "p-bad", "backfired", "b2"); // weakened + suggestedRefutation
  const b1 = DE.analyze(orgB, bigDecision);
  check("2.1 prior cautionary aplicado", b1.learningPrior.applied === true && b1.learningPrior.direction === "cautionary");
  check("2.2 sobe proceed → proceed_with_caution", b1.recommendation.stance === "proceed_with_caution" && b1.recommendation.learning.changedStance === true);
  check("2.3 explicável: why cita o aprendizado", b1.recommendation.why.some((w: string) => /Aprendizado assegurado/.test(w)));

  // ═══════════════ 3. prior 'supportive' NÃO relaxa postura cautelosa (assimetria) ═══════════════
  const orgC = mkOrg();
  mkPattern(orgC, "p-good", "reorder_good");
  asr(orgC, "p-good", "worked", "g1"); asr(orgC, "p-good", "worked", "g2"); // reinforced
  // decisão com premissa frágil + valor esperado sem fato → redTeam gera red flag 'risk' → base cautelosa
  const weakDecision = { ...bigDecision, expectedValue: 50000, premises: [{ label: "demanda alta", basis: "estimate" as const }] };
  const c1 = DE.analyze(orgC, weakDecision);
  check("3.1 prior supportive", c1.learningPrior.applied === true && c1.learningPrior.direction === "supportive");
  check("3.2 base cautelosa por premissa frágil", c1.redTeam.challenges.some((x: any) => x.severity === "risk"));
  check("3.3 supportive NÃO relaxa (segue proceed_with_caution)", c1.recommendation.stance === "proceed_with_caution" && c1.recommendation.learning.changedStance === false);

  // ═══════════════ 4. NUNCA toca hold_for_human (L4) ═══════════════
  const orgD = mkOrg();
  mkPattern(orgD, "p-bad-d", "reorder_bad");
  asr(orgD, "p-bad-d", "backfired", "d1"); asr(orgD, "p-bad-d", "backfired", "d2");
  const l4Decision = { title: "Decisão crítica", decisionType: "purchase", severity: "critical", override: true, impactAmount: 90000, impactUnit: "BRL", learningDomain: "procurement" } as any;
  const d1 = DE.analyze(orgD, l4Decision);
  check("4.1 L4 → hold_for_human", d1.level === "L4" && d1.recommendation.stance === "hold_for_human");
  check("4.2 prior cautionary NÃO altera o hold_for_human", d1.recommendation.learning.changedStance === false && d1.recommendation.stance === "hold_for_human");

  // ═══════════════ 5. learningDomain filtra ═══════════════
  const orgE = mkOrg();
  mkPattern(orgE, "p-fin", "cash_gap", "finance");
  asr(orgE, "p-fin", "backfired", "e1"); asr(orgE, "p-fin", "backfired", "e2");
  // decisão pede aprendizado de 'procurement', mas o padrão ruim é de 'finance' → não aplica
  const e1 = DE.analyze(orgE, bigDecision);
  check("5.1 domínio diferente → prior não aplica", e1.learningPrior.applied === false && e1.recommendation.stance === "proceed");
  // sem filtro de domínio → considera todos e aplica cautela
  const e2 = DE.analyze(orgE, { ...bigDecision, learningDomain: undefined });
  check("5.2 sem filtro → considera o aprendizado de finance", e2.learningPrior.applied === true && e2.recommendation.stance === "proceed_with_caution");

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  check("6.1 orgA (sem padrão) segue sem prior mesmo após outras orgs aprenderem", DE.analyze(orgA, bigDecision).learningPrior.applied === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} learning-prior: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
