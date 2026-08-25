/**
 * TEST — MissionMetricsService (ADR-189 F20). KPIs do piloto derivados por query (RN-004),
 * honestos (null sem denominador — nunca inventa taxa). Cobre contagens, taxa de conclusão
 * (exclui cancelada), ação governada pelo fio, breakdowns, confiança média e isolamento.
 *
 * Uso: npm run test:mission-metrics
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mmet-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mmet-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { MissionRuntimeService: RT } = await import("../src/server/MissionRuntimeService.js");
  const { MissionMetricsService: MET } = await import("../src/server/MissionMetricsService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, mission_layer_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', 'autonomo', '[]', 'active', 1)`).run(randomUUID(), A);

  // ── 1. Org vazia → honesto (0 e nulls, nunca 0%) ──
  const empty = MET.metrics(A);
  check("1.1 vazio: total 0, taxas null (não inventa)", empty.total === 0 && empty.achievedRatePct === null && empty.governedActionRatePct === null && empty.avgConfidence === null && empty.enabled === true);

  // ── 2. Missões em vários estados + confiança ──
  const m1 = M.create(A, { title: "Concluída", targetMetric: "revenue", targetValue: 10000, targetUnit: "BRL", confidence: 0.8 });
  const m2 = M.create(A, { title: "Falhou", targetMetric: "revenue", targetValue: 5000, targetUnit: "BRL", confidence: 0.4 });
  const m3 = M.create(A, { title: "Cancelada" });
  const m4 = M.create(A, { title: "Em andamento", source: "system_proposed" });
  M.setStatus(A, m1.id, "achieved");
  M.setStatus(A, m2.id, "failed");
  M.setStatus(A, m3.id, "cancelled");
  M.setStatus(A, m4.id, "running");

  const met = MET.metrics(A);
  check("2.1 total = 4", met.total === 4);
  check("2.2 byStatus (achieved/failed/cancelled/running = 1 cada)", met.byStatus.achieved === 1 && met.byStatus.failed === 1 && met.byStatus.cancelled === 1 && met.byStatus.running === 1);
  check("2.3 inFlight = 1 (só running); achieved/failed/cancelled não contam", met.inFlight === 1 && met.achieved === 1 && met.failed === 1 && met.cancelled === 1);
  check("2.4 achievedRatePct = 50 (1 de 2 terminais; cancelada FORA do denominador)", met.achievedRatePct === 50);
  check("2.5 avgConfidence = 0.6 (só as que declararam)", met.avgConfidence === 0.6);
  check("2.6 bySource (user 3, system_proposed 1)", met.bySource.user === 3 && met.bySource.system_proposed === 1);
  check("2.7 byAutonomy (off = 4, nasce off)", met.byAutonomy.off === 4);

  // ── 3. Ação governada pelo fio (correlation mission:<id>) ──
  M.setAutonomy(A, m4.id, "suggest");
  RT.proposeAction(A, m4.id, { domain: "collection", actionType: "mission_outreach", title: "Ativar base" });
  const met2 = MET.metrics(A);
  check("3.1 withGovernedAction = 1", met2.withGovernedAction === 1);
  check("3.2 governedActionRatePct = 25 (1 de 4)", met2.governedActionRatePct === 25);

  // ── 4. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), B);
  const metB = MET.metrics(B);
  check("4.1 isolamento (B zerado, taxas null)", metB.total === 0 && metB.withGovernedAction === 0 && metB.achievedRatePct === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-metrics: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
