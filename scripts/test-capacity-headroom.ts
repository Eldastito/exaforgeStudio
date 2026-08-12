/**
 * TEST — CapacityHeadroomService: headroom por recurso + zonas (PRD 7 / ADR-164 F7).
 * DB-backed, det. Prova (§25-27, §59, RN-PRC-6):
 *   - zoneOf classifica por modelo por-recurso (§26 — cada recurso, seus limiares);
 *   - snapshot dá value/zona/headroom pro que o Node mede (mem %, load/core), com runtime injetado;
 *   - recurso que exige provider de host → not_available (honesto, não inventa);
 *   - trend vem do baseline da F6; sem histórico → insufficient_history (§59);
 *   - firstBottleneck = pior zona.
 *
 * Uso: npm run test:capacity-headroom
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cap-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { CapacityHeadroomService: CAP } = await import("../src/server/CapacityHeadroomService.js");
  const { PlatformBaselineService: PB } = await import("../src/server/PlatformBaselineService.js");
  const now = Date.parse("2026-08-12T15:00:00Z");

  // ═══════════════ 1. zoneOf puro (§26/§27) ═══════════════
  const t = { observe: 70, plan: 80, act: 88, critical: 94 };
  check("1.1 <observe → HEALTHY", CAP.zoneOf(50, t) === "HEALTHY");
  check("1.2 observe..plan → OBSERVE", CAP.zoneOf(75, t) === "OBSERVE");
  check("1.3 plan..act → PLAN", CAP.zoneOf(84, t) === "PLAN");
  check("1.4 act..critical → ACT", CAP.zoneOf(90, t) === "ACT");
  check("1.5 >=critical → CRITICAL", CAP.zoneOf(96, t) === "CRITICAL");

  // ═══════════════ 2. snapshot com runtime injetado (determinismo) ═══════════════
  const s = CAP.snapshot({ now, runtime: { memUsedPct: 82, load1m: 3.2, cpuCount: 4 } });
  const mem = s.resources.find((r: any) => r.resource === "host.mem_used_pct");
  const cpu = s.resources.find((r: any) => r.resource === "host.load_per_core");
  check("2.1 memória 82% → PLAN + headroom até critical", mem.available === true && mem.zone === "PLAN" && mem.headroomToCritical === 12 && mem.provisional === true);
  check("2.2 load 3.2/4 cores = 0.8/core → OBSERVE", cpu.available === true && cpu.value === 0.8 && cpu.zone === "OBSERVE");
  check("2.3 firstBottleneck = memória (pior zona)", s.firstBottleneck === "host.mem_used_pct");

  // ═══════════════ 3. recurso de host → not_available honesto ═══════════════
  const disk = s.resources.find((r: any) => r.resource === "disk.used_pct");
  check("3.1 disco → not_available + requires_host_provider", !!disk && disk.available === false && disk.zone === "NOT_AVAILABLE" && disk.reason === "requires_host_provider");

  // ═══════════════ 4. trend sem baseline → insufficient_history (§59) ═══════════════
  check("4.1 sem histórico → trend insufficient_history", mem.trend.state === "insufficient_history");

  // ═══════════════ 5. trend com baseline da F6 → rising quando acima do p95 ═══════════════
  const day = 86400000;
  const opMem = (pct: number) => ({ operational: { application: { available: false }, runtime: { rssBytes: 1, eventLoopLagMs: 0, load1m: 0.1, hostMemUsedPct: pct }, dependencies: { queue: { pending: 0 }, database: { probeLatencyMs: 0.1 } } } });
  for (let d = 1; d <= 15; d++) PB.capture({ at: now - d * day, op: opMem(40 + (d % 2)) }); // baseline ~40%
  const s2 = CAP.snapshot({ now, runtime: { memUsedPct: 82, load1m: 0.1, cpuCount: 4 } });
  const mem2 = s2.resources.find((r: any) => r.resource === "host.mem_used_pct");
  check("5.1 valor atual (82%) muito acima do baseline (~40%) → rising_above_p95", mem2.trend.state === "rising_above_p95" && typeof mem2.trend.baselineP95 === "number");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} capacity-headroom: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
