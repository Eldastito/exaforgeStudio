/**
 * TEST — CapacityEnvelopeService: Capacity Envelope (PRD 7 / ADR-164 F13).
 * DB-backed, det. Prova (§104-108, CA21, §59, RN-PRC):
 *   - sem teste de carga → current() honesto (awaiting_load_test, não inventa limite);
 *   - deriveEnvelope acha o joelho (maior rps com p95 ≤ SLO);
 *   - piso já fura o SLO → safeRps 0 (over_slo_at_min_load);
 *   - sem violação no range testado → no_knee_within_tested_range (aguenta AO MENOS o testado);
 *   - store/current persiste versionado (GLOBAL);
 *   - headroomVs calcula folga/utilização vs envelope;
 *   - determinismo.
 *
 * Uso: npm run test:capacity-envelope
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-env-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-env-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { CapacityEnvelopeService: ENV } = await import("../src/server/CapacityEnvelopeService.js");

  // ═══════════════ 1. sem teste de carga → honesto (§59) ═══════════════
  const c0 = ENV.current();
  check("1.1 current sem envelope → awaiting_load_test (não inventa)", c0.established === false && c0.reason === "awaiting_load_test");
  check("1.2 deriveEnvelope sem amostras → awaiting_load_test", ENV.deriveEnvelope([]).established === false);

  // ═══════════════ 2. joelho: p95 fura o SLO no 4º nível ═══════════════
  const samples = [
    { rps: 10, p95Ms: 120, errorRatePct: 0 },
    { rps: 25, p95Ms: 200, errorRatePct: 0 },
    { rps: 50, p95Ms: 420, errorRatePct: 0.2 },
    { rps: 100, p95Ms: 900, errorRatePct: 3 },   // fura SLO 500 → joelho aqui
  ];
  const e2 = ENV.deriveEnvelope(samples, { sloP95Ms: 500, maxErrorRatePct: 1, at: 0 });
  check("2.1 safeRps = último dentro do SLO (50)", e2.established === true && e2.safeRps === 50);
  check("2.2 joelho registrado em 100 rps", e2.knee && e2.knee.rps === 100 && e2.note === "knee_found");
  check("2.3 basis load_test + versionado (CA21)", e2.basis === "load_test" && e2.version === "v1");

  // ═══════════════ 3. piso já fura o SLO → safeRps 0 ═══════════════
  const e3 = ENV.deriveEnvelope([{ rps: 10, p95Ms: 800 }, { rps: 20, p95Ms: 1200 }], { sloP95Ms: 500, at: 0 });
  check("3.1 piso furando SLO → safeRps 0 + over_slo_at_min_load", e3.safeRps === 0 && e3.note === "over_slo_at_min_load");

  // ═══════════════ 4. sem violação no range → no_knee ═══════════════
  const e4 = ENV.deriveEnvelope([{ rps: 10, p95Ms: 100 }, { rps: 50, p95Ms: 300 }], { sloP95Ms: 500, at: 0 });
  check("4.1 tudo dentro do SLO → safeRps = maior testado, no_knee", e4.safeRps === 50 && e4.note === "no_knee_within_tested_range");

  // ═══════════════ 5. store/current versionado (GLOBAL) ═══════════════
  ENV.store(e2);
  const c1 = ENV.current();
  check("5.1 current lê o envelope persistido", c1.established === true && c1.safeRps === 50);

  // ═══════════════ 6. headroomVs ═══════════════
  const h = ENV.headroomVs(20);
  check("6.1 headroomVs: folga e utilização vs safeRps", h.available === true && h.headroomRps === 30 && h.utilizationPct === 40);

  // ═══════════════ 7. determinismo ═══════════════
  check("7.1 deriveEnvelope determinístico", JSON.stringify(ENV.deriveEnvelope(samples, { at: 0 })) === JSON.stringify(ENV.deriveEnvelope(samples, { at: 0 })));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} capacity-envelope: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
