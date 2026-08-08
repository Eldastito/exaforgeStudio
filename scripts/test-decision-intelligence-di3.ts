/**
 * TEST — Decision Intelligence DI-3 (aditivo sobre ADR-136/152).
 * Métricas do loop fechado (DecisionMetricsService), DERIVADAS por query:
 * valor protegido, acurácia de previsão, materialização de risco, aceitação de
 * recomendações e cache hit-rate do Evidence Layer. Determinístico, sem chave
 * de IA. Isolado por org.
 *
 * Uso: npm run test:decision-intelligence-di3
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di3-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di3-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionMetricsService: M } = await import("../src/server/DecisionMetricsService.js");
  const { DecisionRiskService: R } = await import("../src/server/DecisionRiskService.js");
  const { EvidencePackageService: EP } = await import("../src/server/EvidencePackageService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ── action_outcomes: valor protegido + esperado×realizado ────────────────
  const mkOutcome = (o: any) => db.prepare(`INSERT INTO action_outcomes (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method, loss_prevented, cost_avoided, revenue_recovered, time_saved_minutes) VALUES (?, ?, ?, ?, ?, 'fact', 'manual', ?, ?, ?, ?)`).run(randomUUID(), orgA, randomUUID(), o.e, o.r, o.lp, o.ca, o.rr, o.ts);
  mkOutcome({ e: 1000, r: 900, lp: 500, ca: 200, rr: 300, ts: 60 });  // accuracy 0.9
  mkOutcome({ e: 2000, r: 2000, lp: 0, ca: 100, rr: 0, ts: 0 });      // accuracy 1.0

  // ── decision_risks: 3 previstos, 1 materializado ─────────────────────────
  const rec = R.record(orgA, { decisionId: "dec_x", source: "premortem", risks: [
    { description: "r1", probability: "high", severity: "risk", dedupeKey: "m:r1", leadingIndicator: "x", threshold: "y", mitigation: "z" },
    { description: "r2", probability: "medium", severity: "attention", dedupeKey: "m:r2" },
    { description: "r3", probability: "medium", severity: "attention", dedupeKey: "m:r3" },
  ] });
  R.materialize(orgA, rec.ids[0]);

  // ── decision_actions da IA: 2 aceitas + 1 rejeitada ──────────────────────
  const mkAction = (status: string) => db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, created_by) VALUES (?, ?, 'finance', 'create_task', 'x', ?, 'ai')`).run(randomUUID(), orgA, status);
  mkAction("done"); mkAction("approved"); mkAction("rejected"); mkAction("cancelled");

  // ── evidence_cache_events: 1 miss + 1 hit (cache ligado) ─────────────────
  db.prepare("UPDATE organization_settings SET evidence_layer_enabled = 1 WHERE organization_id = ?").run(orgA);
  EP.build(orgA);   // miss (grava hit=0)
  EP.build(orgA);   // hit  (grava hit=1)

  const m = M.summary(orgA, { days: 365 });

  check("valor protegido: prejuízo evitado somado", m.valueProtected.lossPrevented === 500);
  check("valor protegido: custo evitado somado (200+100)", m.valueProtected.costAvoided === 300);
  check("valor protegido: receita recuperada somada", m.valueProtected.revenueRecovered === 300);
  check("valor protegido: total = prejuízo + custo evitado", m.valueProtected.protectedTotal === 800);
  check("valor protegido: minutos economizados", m.valueProtected.timeSavedMinutes === 60);
  check("acurácia de previsão = média (0.9, 1.0) = 0.95", m.predictionAccuracy.score === 0.95 && m.predictionAccuracy.samples === 2);
  check("materialização: total 3, materializado 1", m.riskMaterialization.total === 3 && m.riskMaterialization.materialized === 1);
  check("materialização: taxa 1/3 ≈ 0.33", m.riskMaterialization.rate === 0.33);
  check("aceitação: 2 aceitas / 1 rejeitada", m.recommendationAcceptance.accepted === 2 && m.recommendationAcceptance.rejected === 1);
  check("aceitação: taxa 2/3 ≈ 0.67 (cancelada não conta)", m.recommendationAcceptance.rate === 0.67);
  check("cache: 1 hit + 1 miss → hitRate 0.5", m.evidenceCache.hits === 1 && m.evidenceCache.misses === 1 && m.evidenceCache.hitRate === 0.5);

  // ── janela: fora do intervalo não conta ──────────────────────────────────
  db.prepare("UPDATE action_outcomes SET measured_at = datetime('now','-400 days') WHERE organization_id = ?").run(orgA);
  const mWin = M.summary(orgA, { days: 365 });
  check("janela: outcomes antigos saem da soma", mWin.valueProtected.protectedTotal === 0 && mWin.predictionAccuracy.score === null);

  // ── isolamento ───────────────────────────────────────────────────────────
  const mB = M.summary(mkOrg(), { days: 365 });
  check("isolamento: outra org zera valor protegido", mB.valueProtected.protectedTotal === 0);
  check("isolamento: outra org acurácia null", mB.predictionAccuracy.score === null && mB.predictionAccuracy.samples === 0);
  check("isolamento: outra org cache null", mB.evidenceCache.hitRate === null);
  check("isolamento: outra org sem riscos/recomendações", mB.riskMaterialization.total === 0 && mB.recommendationAcceptance.rate === null);

  console.log("\n=== TEST: Decision Intelligence DI-3 (ADR-136/152 aditivo) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-3 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
