/**
 * TEST — Creative Experiment Engine (PRD 11 / ADR-168 F6). DB-backed, determinístico.
 * Prova: variantes → mede taxa de engajamento (social_post_metrics por variant_key) →
 * decide campeão via twoProportionZ REUSADO de ProspectResearchService (§37); amostra mínima
 * (RN-CG-07); campeão/desafiante; NÃO executa (RN-CG-08); engajamento é PROXY (RN-CG-01);
 * isolamento multi-tenant.
 *
 * Uso: npm run test:creative-experiment
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cexp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cexp-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");

  const orgA = `org_ce_${randomUUID().slice(0, 8)}`;
  const orgB = `org_ce_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  }
  // Helper: insere metrics de um post ligado a uma variante.
  const post = (org: string, variantKey: string, impressions: number, engagement: number) => {
    db.prepare(
      `INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, impressions, analytics_available, variant_key)
       VALUES (?, ?, 'instagram', ?, '2026-08-13T12:00:00Z', ?, 0, 0, 0, ?, 1, ?)`
    ).run(randomUUID(), org, randomUUID(), engagement, impressions, variantKey);
  };

  // ── 1. Schema ──
  const cols = (db.prepare(`PRAGMA table_info(social_post_metrics)`).all() as any[]).map((c) => c.name);
  check("1.1 social_post_metrics.variant_key", cols.includes("variant_key"));
  check("1.2 tabela creative_experiments", !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='creative_experiments'`).get());
  check("1.3 tabela creative_experiment_variants", !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='creative_experiment_variants'`).get());

  // ── 2. Create + validações ──
  const exp = EXP.create(orgA, "u", { hypothesis: "Ângulo de benefício engaja mais", variants: [{ variantKey: "s1:A", label: "Benefício" }, { variantKey: "s1:B", label: "Tendência" }] });
  check("2.1 experimento criado com 2 variantes", exp.variantKeys.length === 2);
  let threwH = false, threwV = false;
  try { EXP.create(orgA, "u", { hypothesis: "", variants: [{ variantKey: "x" }, { variantKey: "y" }] }); } catch { threwH = true; }
  try { EXP.create(orgA, "u", { hypothesis: "h", variants: [{ variantKey: "x" }] }); } catch { threwV = true; }
  check("2.2 hipótese vazia rejeitada", threwH);
  check("2.3 <2 variantes rejeitado", threwV);

  // ── 3. Sem métrica → insufficient_data (RN-CG-07), experimento segue running ──
  const d0 = EXP.decide(orgA, exp.id);
  check("3.1 sem dados → insufficient_data", d0.decision === "insufficient_data");
  check("3.2 mede rate null sem impressões", d0.measurements.every((m: any) => m.rate === null));
  check("3.3 experimento segue running (não fecha no ruído)", d0.status === "running");

  // ── 4. Amostra abaixo do mínimo (min_sample 100) → insufficient_data ──
  post(orgA, "s1:A", 50, 20); post(orgA, "s1:B", 50, 10);
  const dLow = EXP.decide(orgA, exp.id);
  check("4.1 impressões < min_sample → insufficient_data", dLow.decision === "insufficient_data");

  // ── 5. Amostra suficiente + vencedor claro → winner + campeão (não executa) ──
  post(orgA, "s1:A", 950, 280);  // A total: 1000 imp, 300 eng = 30%
  post(orgA, "s1:B", 950, 190);  // B total: 1000 imp, 200 eng = 20%
  const dWin = EXP.decide(orgA, exp.id, "u");
  check("5.1 vencedor declarado", dWin.decision === "winner" && dWin.winnerVariantKey === "s1:A");
  check("5.2 z ≥ confiança", (dWin.z || 0) >= 1.96);
  check("5.3 experimento fechado", dWin.status === "completed");
  check("5.4 razão marca engajamento como PROXY (RN-CG-01)", /PROXY|F9/.test(dWin.reason));
  const got = EXP.get(orgA, exp.id);
  const champ = got.variants.find((v: any) => v.variantKey === "s1:A");
  const loser = got.variants.find((v: any) => v.variantKey === "s1:B");
  check("5.5 campeão marcado", champ.isChampion === 1 && loser.isChampion === 0);
  // RN-CG-08: decidir não publica nada (não há decision_action criada pelo experimento).
  check("5.6 não executa (sem ação de publicação criada)", (db.prepare(`SELECT COUNT(*) AS n FROM decision_actions WHERE organization_id = ?`).get(orgA) as any).n === 0);

  // ── 6. Diferença não significativa → inconclusive ──
  const exp2 = EXP.create(orgA, "u", { hypothesis: "empate", variants: [{ variantKey: "s2:A" }, { variantKey: "s2:B" }] });
  post(orgA, "s2:A", 1000, 260); // 26%
  post(orgA, "s2:B", 1000, 250); // 25%
  const dInc = EXP.decide(orgA, exp2.id);
  check("6.1 diferença pequena → inconclusive", dInc.decision === "inconclusive" && dInc.winnerVariantKey === null);
  check("6.2 z < confiança", Math.abs(dInc.z || 0) < 1.96);

  // ── 7. Isolamento multi-tenant ──
  check("7.1 org B não vê experimentos de A", EXP.list(orgB).length === 0);
  check("7.2 get cruzado null", EXP.get(orgB, exp.id) === null);
  post(orgB, "s1:A", 1000, 500); // engajamento de B não conta pro experimento de A
  const reA = EXP.measure(orgA, exp.id).find((m: any) => m.variantKey === "s1:A")!;
  check("7.3 métrica de B não vaza pro experimento de A", reA.engagement === 300 && reA.impressions === 1000);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} creative-experiment: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
