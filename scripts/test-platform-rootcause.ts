/**
 * TEST — PlatformRootCauseService: correlação de causa provável (PRD 7 / ADR-164 F9).
 * DB-backed, det. Prova (§86-92, §35, RN-PRC-6, CA8):
 *   - sem anomalia → hipóteses vazias (não inventa causa);
 *   - p95 alto + banco lento → hipótese db_contention (correlação, não veredito);
 *   - p95 alto + load alto → hipótese cpu_saturation;
 *   - anomalia sem regra → unexplainedDeviations (não força causa);
 *   - deployCorrelation declarado not_available (CA8 honesto);
 *   - determinismo.
 *
 * Uso: npm run test:platform-rootcause
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PlatformRootCauseService: RC } = await import("../src/server/PlatformRootCauseService.js");
  const now = Date.parse("2026-08-12T15:00:00Z");
  const DAY = 86400000;

  const ins = db.prepare(`INSERT INTO platform_health_snapshots (id, captured_at, metric, value, dow, hour) VALUES (?, ?, ?, ?, ?, ?)`);
  let idc = 0;
  // Semeia baseline estável (>=8 amostras) e injeta 1 valor recente anômalo (spike).
  const seedSeries = (metric: string, baseVal: number, spikeVal: number) => {
    for (let d = 12; d >= 1; d--) ins.run(`rc-${idc++}`, new Date(now - d * DAY).toISOString(), metric, baseVal + (d % 2 === 0 ? 0.5 : -0.5), 0, 12);
    ins.run(`rc-${idc++}`, new Date(now).toISOString(), metric, spikeVal, 0, 12); // mais recente = anômalo
  };

  // ═══════════════ 1. sem anomalia → hipóteses vazias ═══════════════
  const r0 = RC.analyze({ now });
  check("1.1 sem dados → 0 hipóteses, 0 anomalias", r0.hypotheses.length === 0 && r0.anomaliesConsidered === 0);
  check("1.2 deployCorrelation not_available (CA8)", r0.deployCorrelation.available === false && r0.deployCorrelation.reason === "no_deploy_telemetry");

  // ═══════════════ 2. p95 alto + banco lento → db_contention ═══════════════
  seedSeries("app.p95", 200, 900);        // spike enorme vs ~200
  seedSeries("db.probe_ms", 5, 40);        // spike vs ~5
  const r1 = RC.analyze({ now });
  const db1 = r1.hypotheses.find((h: any) => h.cause === "db_contention");
  check("2.1 hipótese db_contention presente", !!db1);
  check("2.2 basis correlation (hipótese §35), não veredito", db1 && db1.basis === "correlation" && /não causa comprovada/i.test(db1.note));
  check("2.3 evidência inclui app.p95 e db.probe_ms", db1 && db1.evidence.length === 2 && db1.evidence.some((e: any) => e.metric === "app.p95") && db1.evidence.some((e: any) => e.metric === "db.probe_ms"));

  // ═══════════════ 3. p95 + load → cpu_saturation (nova análise isolada) ═══════════════
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rc2-"));
  // reusa mesmo db (append) — adiciona load anômalo; p95 já é anômalo
  seedSeries("host.load1m", 0.4, 3.5);
  const r2 = RC.analyze({ now });
  check("3.1 hipótese cpu_saturation presente (p95+load)", !!r2.hypotheses.find((h: any) => h.cause === "cpu_saturation"));

  // ═══════════════ 4. anomalia sem regra → unexplained ═══════════════
  // proc.rss sozinho tem regra (memory_growth); use uma métrica que não casa nenhuma "all":
  // queue.pending SEM error_rate anômalo → não casa queue_backpressure → unexplained
  seedSeries("queue.pending", 2, 400);
  const r3 = RC.analyze({ now });
  const hasQueueHyp = r3.hypotheses.some((h: any) => h.evidence?.some((e: any) => e.metric === "queue.pending"));
  const queueUnexplained = r3.unexplainedDeviations.some((u: any) => u.metric === "queue.pending");
  check("4.1 queue.pending sozinho → unexplainedDeviations (não força causa)", !hasQueueHyp && queueUnexplained);

  // ═══════════════ 5. determinismo ═══════════════
  const a = RC.analyze({ now }); const b = RC.analyze({ now });
  check("5.1 mesmo now → mesmo resultado", JSON.stringify(a) === JSON.stringify(b));
  fs.rmSync(tmp2, { recursive: true, force: true });

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} platform-rootcause: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
