/**
 * TEST — Margem de perda aceitável (ADR-114), indicador global.
 *
 * Uso: npm run test:loss-margin
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-loss-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-loss-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { LossMarginService: L } = await import("../src/server/LossMarginService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const period = new Date().toISOString().slice(0, 7);

  // Faturamento do mês: R$10.000 (core) + R$0 comigo.
  for (let i = 0; i < 10; i++) {
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(randomUUID(), orgId);
  }
  check("faturamento do mês = 10000", near(L.monthlyRevenue(orgId, period), 10000));

  // ===== 1. Define a margem aceitável =====
  const cfg = L.setConfig(orgId, 3, "faturamento");
  check("meta aceitável = 3%", cfg.acceptablePct === 3);

  // ===== 2. Lança perdas tipadas por driver =====
  L.recordLoss(orgId, { driver: "merma", amount: 120 });
  L.recordLoss(orgId, { driver: "quebra", amount: 80 });
  L.recordLoss(orgId, { driver: "desconto", amount: 100 });
  L.recordLoss(orgId, { driver: "hack" as any, amount: 50 }); // vira 'outro'
  check("driver inválido cai em 'outro'", L.lossesByDriver(orgId, period).byDriver.some((d) => d.driver === "outro" && d.amount === 50));
  check("perda inválida (0) é recusada", L.recordLoss(orgId, { driver: "merma", amount: 0 }).ok === false);

  // ===== 3. Resumo: 350 / 10000 = 3,5% → ACIMA da meta de 3% =====
  const s = L.monthlySummary(orgId, period);
  check("perda total = 350", near(s.lossAmount, 350));
  check("loss_pct = 3.5", near(s.lossPct, 3.5));
  check("status ACIMA da meta", s.status === "acima");
  check("decomposição por driver (merma no topo)", s.topDriver?.driver === "merma" && s.byDriver.length === 4);

  // ===== 4. Dentro da meta quando a perda cai =====
  L.setConfig(orgId, 5, "faturamento");
  check("com meta 5%: DENTRO", L.monthlySummary(orgId, period).status === "dentro");
  L.setConfig(orgId, 0, "faturamento");
  check("sem meta definida: 'sem_meta'", L.monthlySummary(orgId, period).status === "sem_meta");

  // ===== 5. Snapshot idempotente =====
  L.setConfig(orgId, 3, "faturamento");
  L.snapshotMonth(orgId, period);
  L.snapshotMonth(orgId, period);
  const snaps = (db.prepare("SELECT COUNT(*) c FROM loss_monthly_snapshots WHERE organization_id = ? AND period = ?").get(orgId, period) as any).c;
  check("snapshot idempotente (1 linha por mês)", snaps === 1);
  const snapRow = db.prepare("SELECT loss_pct, status FROM loss_monthly_snapshots WHERE organization_id = ? AND period = ?").get(orgId, period) as any;
  check("snapshot guarda o loss_pct e status", near(snapRow.loss_pct, 3.5) && snapRow.status === "acima");

  // ===== 6. Média histórica (a IA aprende) =====
  const avg = L.trailingAverage(orgId, 3);
  check("média histórica ≈ 3.5 (só o mês corrente tem faturamento)", near(avg, 3.5));
  check("histórico traz 6 meses", L.history(orgId, 6).length === 6);

  // ===== 7. Diagnóstico frugal (Fatia 3): atribui e sugere =====
  const dg = L.diagnosis(orgId, period);
  check("diagnóstico: driver dominante é merma", dg.dominant?.driver === "merma");
  check("diagnóstico: participação da merma ≈ 34.29%", near(dg.dominant?.share ?? 0, 34.29, 0.1));
  check("diagnóstico: traz sugestão pro dominante", typeof dg.dominant?.suggestion === "string" && dg.dominant!.suggestion.length > 10);
  check("diagnóstico: manchete cita 'acima'", /acima/.test(dg.headline));
  check("diagnóstico: manchete aponta onde concentra", /Concentra em/.test(dg.headline));
  check("diagnóstico: findings limitados ao top 3", dg.findings.length === 3);
  check("diagnóstico: gera próximos passos", dg.actions.length >= 1);
  check("diagnóstico: tendência estável vs média própria", dg.trend === "estavel");
  check("overview embute o diagnóstico", typeof L.overview(orgId).diagnosis?.headline === "string");
  // Sem meta: manchete pede pra cadastrar a margem.
  L.setConfig(orgId, 0, "faturamento");
  check("diagnóstico sem meta pede a margem", /margem de perda aceitável/i.test(L.diagnosis(orgId, period).headline));
  L.setConfig(orgId, 3, "faturamento");

  // ===== 8. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  const so = L.monthlySummary(other, period);
  check("isolamento: outra org sem perdas/faturamento", so.lossAmount === 0 && so.base === 0);
  const dgo = L.diagnosis(other, period);
  check("diagnóstico de org vazia: sem dominante", dgo.dominant === null);

  // --- Relatório ---
  console.log("\n=== TEST: Margem de perda aceitável (ADR-114) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Margem de perda OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
