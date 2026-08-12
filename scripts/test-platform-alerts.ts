/**
 * TEST — PlatformAlertService: alertas de plataforma com anti-spam (PRD 7 / ADR-164 F12).
 * DB-backed, det. Prova (§99, CA17, RN-PRC):
 *   - raise cria evento novo (shouldNotify=true na 1ª vez);
 *   - reincidência dentro da janela → NÃO renotifica (anti-spam), bumpa occurrences;
 *   - reincidência após a janela → renotifica;
 *   - GLOBAL (sem organization_id na tabela);
 *   - resolveByDedupe fecha; listOpen reflete;
 *   - refresh(recomendações): alta vira evento; sumir → auto-resolve (recuperou);
 *   - determinismo (now injetado).
 *
 * Uso: npm run test:platform-alerts
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alert-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-alert-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { PlatformAlertService: AL } = await import("../src/server/PlatformAlertService.js");
  const t0 = Date.parse("2026-08-12T15:00:00Z");
  const HOUR = 3600000;

  // ═══════════════ 1. GLOBAL — tabela sem organization_id ═══════════════
  const cols = (db.prepare(`PRAGMA table_info(platform_health_events)`).all() as any[]).map((c) => c.name);
  check("1.1 platform_health_events existe e é GLOBAL (sem organization_id)", cols.length > 0 && !cols.includes("organization_id"));
  check("1.2 dedupe_key é UNIQUE (anti-duplicação)", (db.prepare(`SELECT sql FROM sqlite_master WHERE name='platform_health_events'`).get() as any).sql.includes("dedupe_key TEXT NOT NULL UNIQUE"));

  // ═══════════════ 2. raise novo → notifica ═══════════════
  const r1 = AL.raise({ eventType: "anomaly", severity: "warning", dedupeKey: "mem_high", title: "Memória alta", detail: { z: 3.2 }, now: t0 });
  check("2.1 evento novo → created + shouldNotify", r1.created === true && r1.shouldNotify === true && r1.event.occurrences === 1);

  // ═══════════════ 3. reincidência dentro da janela → NÃO renotifica (anti-spam) ═══════════════
  const r2 = AL.raise({ eventType: "anomaly", severity: "warning", dedupeKey: "mem_high", title: "Memória alta", now: t0 + 1 * HOUR });
  check("3.1 reincidência <6h → não renotifica, bumpa occurrences", r2.created === false && r2.shouldNotify === false && r2.event.occurrences === 2);

  // ═══════════════ 4. reincidência após a janela → renotifica ═══════════════
  const r3 = AL.raise({ eventType: "anomaly", severity: "critical", dedupeKey: "mem_high", title: "Memória crítica", now: t0 + 7 * HOUR });
  check("4.1 reincidência >6h → renotifica de novo", r3.created === false && r3.shouldNotify === true && r3.event.occurrences === 3);
  check("4.2 severidade atualizada na reincidência", r3.event.severity === "critical");

  // ═══════════════ 5. listOpen + resolve ═══════════════
  check("5.1 listOpen mostra o evento aberto", AL.listOpen().some((e: any) => e.dedupe_key === "mem_high"));
  check("5.2 resolveByDedupe fecha", AL.resolveByDedupe("mem_high", t0 + 8 * HOUR) === true);
  check("5.3 após resolver → não está mais em listOpen", !AL.listOpen().some((e: any) => e.dedupe_key === "mem_high"));
  check("5.4 resolver de novo → idempotente (false)", AL.resolveByDedupe("mem_high", t0 + 9 * HOUR) === false);

  // ═══════════════ 6. refresh(recomendações): alta vira evento; sumir → auto-resolve ═══════════════
  const recsHigh = [{ id: "headroom:host.mem_used_pct", priority: "alta", title: "Memória em CRITICAL", action: "Investigar", confidence: "alta", evidence: [] },
                    { id: "forecast:host.load1m", priority: "média", title: "CPU", action: "x", confidence: "média", evidence: [] }];
  const f1 = AL.refresh({ now: t0 + 10 * HOUR, recommendations: recsHigh });
  check("6.1 refresh: só a ALTA vira evento", f1.raised === 1 && AL.listOpen().some((e: any) => e.dedupe_key === "rec:headroom:host.mem_used_pct"));
  const f2 = AL.refresh({ now: t0 + 11 * HOUR, recommendations: [] }); // recomendação sumiu → recuperou
  check("6.2 refresh sem a alta → auto-resolve (recuperou)", f2.resolved === 1 && !AL.listOpen().some((e: any) => e.dedupe_key === "rec:headroom:host.mem_used_pct"));

  // ═══════════════ 7. determinismo de leitura ═══════════════
  AL.raise({ eventType: "anomaly", severity: "info", dedupeKey: "det_key", title: "x", now: t0 });
  check("7.1 listOpen estável entre chamadas", JSON.stringify(AL.listOpen()) === JSON.stringify(AL.listOpen()));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} platform-alerts: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
