/**
 * TEST — NodeHostTelemetryProvider (PRD 7 / ADR-164 F2, fatia processo/runtime).
 * DB-backed, det. Prova (§12 Camadas 1-2, RN-PRC-3/6):
 *   - métricas de processo/host que o Node lê direto → available:true + valor + observedAt;
 *   - o que o Node NÃO vê (disco/rede/swap/limite de container) → available:false +
 *     requires_host_provider (honesto, não inventa — RN-PRC-6);
 *   - queryRange → available:false/no_history (não fabrica histórico — RN-PRC-3);
 *   - integra com a fachada da F1 (register + setActiveProvider → PlatformTelemetryService);
 *   - health available:true.
 *
 * Uso: npm run test:node-host-telemetry
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-nht-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-nht-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await import("../src/server/db.js");
  const { PlatformTelemetryService: TEL } = await import("../src/server/PlatformTelemetryService.js");
  const { NodeHostTelemetryProvider } = await import("../src/server/NodeHostTelemetryProvider.js");
  TEL.resetProviders();

  const p = new NodeHostTelemetryProvider(() => "2026-08-12T12:00:00Z");
  await sleep(60); // deixa o monitor de event-loop coletar amostras

  // ═══════════════ 1. métricas reais suportadas (processo + host visível) ═══════════════
  const rss = p.queryMetric({ metric: "proc.mem.rss" });
  check("1.1 proc.mem.rss disponível + valor + proveniência", rss.available === true && typeof rss.value === "number" && rss.value! > 0 && rss.source === "node_host" && rss.observedAt === "2026-08-12T12:00:00Z");
  const heap = p.queryMetric({ metric: "proc.mem.heapUsed" });
  check("1.2 proc.mem.heapUsed disponível", heap.available === true && heap.value! > 0);
  const up = p.queryMetric({ metric: "proc.uptime.s" });
  check("1.3 proc.uptime.s disponível (>=0)", up.available === true && up.value! >= 0);
  const memTotal = p.queryMetric({ metric: "host.mem.total" });
  check("1.4 host.mem.total disponível", memTotal.available === true && memTotal.value! > 0);
  const load1 = p.queryMetric({ metric: "host.load.1m" });
  check("1.5 host.load.1m disponível (>=0)", load1.available === true && load1.value! >= 0);
  const cpuCount = p.queryMetric({ metric: "host.cpu.count" });
  check("1.6 host.cpu.count disponível (>=1)", cpuCount.available === true && cpuCount.value! >= 1);
  const usedPct = p.queryMetric({ metric: "host.mem.usedPct" });
  check("1.7 host.mem.usedPct entre 0 e 100", usedPct.available === true && usedPct.value! >= 0 && usedPct.value! <= 100);
  // event-loop lag: tolerante — disponível com número OU indisponível warming_up.
  const eld = p.queryMetric({ metric: "proc.eventloop.lag.ms" });
  check("1.8 event-loop lag bem-formado (num OU warming_up)", (eld.available === true && typeof eld.value === "number") || (eld.available === false && eld.reason === "warming_up"));

  // ═══════════════ 2. host/infra NÃO visível ao Node → honesto ═══════════════
  for (const m of ["host.disk.used", "host.net.rx", "host.swap.used", "container.cpu.limit"]) {
    const r = p.queryMetric({ metric: m });
    check(`2.x ${m} → available:false + requires_host_provider`, r.available === false && r.reason === "requires_host_provider" && r.value === null);
  }

  // ═══════════════ 3. queryRange não fabrica histórico (RN-PRC-3) ═══════════════
  const rg = p.queryRange({ metric: "proc.mem.rss", from: "a", to: "b" });
  check("3.1 queryRange → available:false + no_history", rg.available === false && rg.reason === "no_history" && rg.points.length === 0);

  // ═══════════════ 4. health + supported ═══════════════
  check("4.1 health available:true (processo sempre legível)", p.health().available === true && p.health().source === "node_host");
  check("4.2 supported() lista as métricas de processo/host", p.supported().includes("proc.mem.rss") && p.supported().includes("host.load.1m"));

  // ═══════════════ 5. integra com a fachada da F1 ═══════════════
  TEL.setEnabled(true);
  TEL.register(p);
  TEL.setActiveProvider("node_host");
  const viaFacade = TEL.queryMetric({ metric: "proc.mem.rss" });
  check("5.1 fachada roteia pro provider node_host", viaFacade.available === true && viaFacade.source === "node_host" && viaFacade.value! > 0);
  check("5.2 providerHealth reflete o provider ativo", TEL.providerHealth().activeProvider === "node_host" && TEL.providerHealth().available === true && TEL.providerHealth().enabled === true);
  // desligar volta ao Null honesto (guardrail da F1 preservado)
  TEL.setEnabled(false);
  check("5.3 flag OFF → volta ao Null (available:false)", TEL.queryMetric({ metric: "proc.mem.rss" }).available === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} node-host-telemetry: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
