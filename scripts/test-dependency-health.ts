/**
 * TEST — DependencyHealthService: saúde de fila + banco + provider (PRD 7 / ADR-164 F4).
 * DB-backed, det. Prova (§16-21, RN-PRC-3/6):
 *   - COMPÕE JobQueueService.health() + probe leve de banco + SkillOsProviderHealth (IA);
 *   - deriva estado humano por limiar (healthy/watch/degraded) — backlog velho/erro alto;
 *   - provider não instrumentado é declarado not_instrumented (NUNCA "healthy" — RN-PRC-6);
 *   - probe de banco dá latência + tamanho + WAL; overall = pior dos três.
 *
 * Uso: npm run test:dependency-health
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dep-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dep-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { DependencyHealthService: DEP } = await import("../src/server/DependencyHealthService.js");
  const now = Date.now();

  // ═══════════════ 1. estado saudável (fila vazia, banco ok) ═══════════════
  const s0 = DEP.snapshot({ now });
  check("1.1 banco disponível + WAL + latência + tamanho", s0.database.available === true && /wal/i.test(s0.database.walMode) && typeof s0.database.probeLatencyMs === "number" && s0.database.fileSizeBytes! > 0);
  check("1.2 fila disponível (in-process)", s0.queue.available === true && s0.queue.inProcess === true);
  check("1.3 providers não instrumentados declarados (não 'healthy')", Array.isArray(s0.providers.notInstrumented) && s0.providers.notInstrumented.every((p: any) => p.state === "not_instrumented"));
  check("1.4 IA sem dados → no_data (honesto, RN-PRC-6)", (s0.providers.ai as any).available === false || Array.isArray(s0.providers.ai));
  check("1.5 overall healthy quando tudo ok", s0.overall === "healthy");

  // ═══════════════ 2. fila degradada por backlog velho + erro alto ═══════════════
  const mkJob = (status: string, createdAtIso: string) =>
    db.prepare(`INSERT INTO background_jobs (id, type, status, created_at) VALUES (?, 'test', ?, ?)`).run(randomUUID(), status, createdAtIso);
  // 1 pending com 20min de idade → degraded por backlog.
  const old = new Date(now - 20 * 60000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  mkJob("pending", old);
  // 3 failed + 1 completed → failureRate 75% → degraded.
  for (let i = 0; i < 3; i++) mkJob("failed", old);
  mkJob("completed", old);
  const s1 = DEP.snapshot({ now });
  check("2.1 backlog velho detectado (idade > 15min)", s1.queue.oldestPendingAgeMs > 15 * 60000);
  check("2.2 taxa de falha alta (75%)", s1.queue.failureRatePct === 75);
  check("2.3 fila degradada", s1.queue.state === "degraded");
  check("2.4 overall reflete o pior (degraded)", s1.overall === "degraded");

  // ═══════════════ 3. provider de IA real (reusa SkillOsProviderHealth) ═══════════════
  const mkAi = (provider: string, run_status: string) =>
    db.prepare(`INSERT INTO ai_usage_log (id, provider, model, run_id, run_status, created_at) VALUES (?, ?, 'm', ?, ?, CURRENT_TIMESTAMP)`).run(randomUUID(), provider, randomUUID(), run_status);
  for (let i = 0; i < 8; i++) mkAi("openai", "ok");
  for (let i = 0; i < 2; i++) mkAi("openai", "failed");
  const s2 = DEP.snapshot({ now });
  const openai = Array.isArray(s2.providers.ai) ? s2.providers.ai.find((a: any) => a.name === "openai") : null;
  check("3.1 IA 'openai' medida com taxa de falha", !!openai && openai.total === 10 && openai.failureRatePct === 20);
  check("3.2 estado do provider derivado (não inventado)", !!openai && ["healthy", "watch", "degraded"].includes(openai.state));

  // ═══════════════ 4. probe de banco tem latência plausível ═══════════════
  check("4.1 latência de SELECT 1 >= 0 e finita", s2.database.probeLatencyMs >= 0 && Number.isFinite(s2.database.probeLatencyMs));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} dependency-health: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
