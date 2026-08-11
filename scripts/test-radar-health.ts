/**
 * TEST — PRD 2 F12.1 (§94-98, CA16): Radar health. Observabilidade OPERACIONAL
 * do Radar pra o admin, DERIVADA POR QUERY (RN-004) sobre `business_signals` —
 * sem tabela nova, sem contador mutável.
 *
 * Prova (determinístico):
 *   - org vazia → overall ok, sem detectores;
 *   - volume: contagens por status/severidade/domínio;
 *   - freshness (§96): detector que parou de emitir (>staleHours) vira stale/watch;
 *   - storm (§53/CA15): detector com volume recente muito acima da própria média → degraded;
 *   - calibração (F11 reusada): detector majoritariamente descartado → poor → degraded;
 *   - status geral agrega (degraded>watch>ok);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:radar-health
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-health-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-radar-health-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { RadarHealthService: RH } = await import("../src/server/RadarHealthService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const pub = (org: string, svc: string, key: string, extra: any = {}) => BS.publish(org, { domain: extra.domain || "sales", signalType: extra.signalType || "x", severity: extra.severity || "attention", basis: "fact", confidence: 0.9, sourceService: svc, evidence: {}, dedupeKey: key });
  const age = (org: string, id: string, expr: string) => db.prepare(`UPDATE business_signals SET detected_at = datetime('now', ?) WHERE id = ? AND organization_id = ?`).run(expr, id, org);

  // ===== 1. Org vazia =====
  const empty = mkOrg();
  const e = RH.overview(empty);
  check("1.1 org vazia → overall ok, sem detectores, total 0", e.overall === "ok" && e.detectors.length === 0 && e.totals.total === 0);

  const org = mkOrg();

  // ===== 2. Volume por status/severidade/domínio =====
  const s1 = pub(org, "DetGood", "g1", { severity: "risk", domain: "finance" });
  const s2 = pub(org, "DetGood", "g2", { severity: "attention", domain: "sales" });
  BS.acknowledge(org, s2.id);
  const s3 = pub(org, "DetGood", "g3", { severity: "info", domain: "sales" });
  BS.resolve(org, s3.id);
  const ov = RH.overview(org);
  check("2.1 volume por status (open/acknowledged/resolved)", ov.totals.byStatus.open === 1 && ov.totals.byStatus.acknowledged === 1 && ov.totals.byStatus.resolved === 1);
  check("2.2 volume por severidade", ov.totals.bySeverity.risk === 1 && ov.totals.bySeverity.attention === 1 && ov.totals.bySeverity.info === 1);
  check("2.3 volume por domínio", ov.totals.byDomain.finance === 1 && ov.totals.byDomain.sales === 2);
  const good = ov.detectors.find((d: any) => d.detector === "DetGood");
  check("2.4 DetGood recente → não stale, calibração ok, status ok", good && good.stale === false && good.status === "ok" && good.stormRisk === false);

  // ===== 3. Freshness — detector que parou (§96) =====
  const st = pub(org, "DetStale", "st1", { domain: "clinic" });
  age(org, st.id, "-100 hours"); // > staleHours default (72h)
  const ov3 = RH.overview(org);
  const stale = ov3.detectors.find((d: any) => d.detector === "DetStale");
  check("3.1 DetStale (100h sem emitir) → stale + status watch", stale.stale === true && stale.ageHours > 72 && stale.status === "watch");
  check("3.2 detectorSummary conta o stale", ov3.detectorSummary.stale === 1);

  // ===== 4. Storm — volume recente anômalo (§53/CA15) =====
  const orgStorm = mkOrg();
  for (let i = 0; i < 8; i++) pub(orgStorm, "DetStorm", `s${i}`, { signalType: `t${i}` }); // 8 recentes, história curta
  const ovS = RH.overview(orgStorm);
  const storm = ovS.detectors.find((d: any) => d.detector === "DetStorm");
  check("4.1 DetStorm (8 sinais na janela vs média ~0) → stormRisk + degraded", storm.stormRisk === true && storm.status === "degraded");
  check("4.2 overall degraded quando há storm", ovS.overall === "degraded" && ovS.detectorSummary.storm === 1);

  // ===== 5. Calibração ruim (F11 reusada) → degraded =====
  const orgCal = mkOrg();
  const poor = Array.from({ length: 10 }, (_, i) => pub(orgCal, "DetPoor", `p${i}`));
  poor.forEach((s) => BS.dismiss(orgCal, s.id, "incorrect")); // 100% descartado falso → poor
  const ovC = RH.overview(orgCal);
  const dp = ovC.detectors.find((d: any) => d.detector === "DetPoor");
  check("5.1 DetPoor 100% descartado → calibração poor + degraded", dp.calibration === "poor" && dp.dismissalRate === 1 && dp.status === "degraded");

  // ===== 6. Status geral agrega =====
  check("6.1 org só com detector ok → overall ok", (() => { const o = mkOrg(); pub(o, "OnlyOk", "ok1"); return RH.overview(o).overall === "ok"; })());

  // ===== 7. Isolamento =====
  check("7.1 org B isolada (não vê detectores de A)", RH.overview(mkOrg()).detectors.length === 0);

  console.log("\n=== TEST: Radar Health F12.1 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Radar Health F12.1 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
