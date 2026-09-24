/**
 * TESTE — PerfMonitorService (instrumentação da instabilidade).
 * ----------------------------------------------------------------------------
 * Valida a lógica pura, sem subir o servidor:
 *   - request abaixo do limiar NÃO é registrada; acima É;
 *   - ring buffer não cresce sem limite (evict do mais antigo);
 *   - snapshot tem o formato esperado (thresholds, memória, recent);
 *   - kill-switch PERF_MONITOR_DISABLED faz recordRequest virar no-op.
 *
 * Uso:  npm run test:perf-monitor
 */
// Limiar baixo ANTES de importar (thresholds são lidos na construção do singleton).
process.env.PERF_SLOW_REQ_MS = "100";
delete process.env.PERF_MONITOR_DISABLED;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { PerfMonitor } = await import("../src/server/PerfMonitorService.js");

  // ── 1. Limiar de request ──
  PerfMonitor.recordRequest("GET", "/rapido", 50);   // abaixo → ignora
  PerfMonitor.recordRequest("GET", "/lento", 500);   // acima → registra
  let snap = PerfMonitor.snapshot();
  check("1.1 request rápida não é registrada", !snap.recent.some((e) => e.label.includes("/rapido")), JSON.stringify(snap.recent.slice(0, 3)));
  check("1.2 request lenta é registrada com ms", snap.recent.some((e) => e.label.includes("GET /lento") && e.ms === 500), JSON.stringify(snap.recent.slice(0, 3)));
  check("1.3 mais novo primeiro", snap.recent[0]?.label.includes("/lento"));

  // ── 2. Ring buffer não cresce sem limite (RING_MAX=120) ──
  for (let i = 0; i < 200; i++) PerfMonitor.recordRequest("POST", `/x/${i}`, 300);
  snap = PerfMonitor.snapshot();
  check("2.1 ring buffer limitado a 120", snap.recent.length === 120, `len=${snap.recent.length}`);
  check("2.2 mantém os mais recentes", snap.recent[0]?.label.includes("/x/199"), snap.recent[0]?.label);

  // ── 3. Formato do snapshot ──
  check("3.1 thresholds expostos", snap.thresholds.slowReqMs === 100 && typeof snap.thresholds.loopStallMs === "number");
  check("3.2 memória RSS em MB (número > 0)", typeof snap.memoryRssMb === "number" && snap.memoryRssMb > 0, String(snap.memoryRssMb));
  check("3.3 enabled=true sem kill-switch", snap.enabled === true);

  // ── 4. Kill-switch ──
  process.env.PERF_MONITOR_DISABLED = "1";
  const before = PerfMonitor.snapshot().recent.length;
  PerfMonitor.recordRequest("GET", "/deveria-ignorar", 999);
  const after = PerfMonitor.snapshot().recent.length;
  check("4.1 desligado: recordRequest é no-op", after === before, `before=${before} after=${after}`);
  check("4.2 snapshot reflete enabled=false", PerfMonitor.snapshot().enabled === false);
  delete process.env.PERF_MONITOR_DISABLED;

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} perf-monitor: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main();
