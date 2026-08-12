/**
 * TEST — CapacityRecommendationService: recomendação advisória (PRD 7 / ADR-164 F10).
 * Injeção pura (headroom/forecast/rootCause) → det. Prova (§75-79, CA15/CA16, D6, RN-PRC-1):
 *   - sem sinal → all_clear (não inventa urgência);
 *   - recurso em CRITICAL → recomendação alta, explicável, requiresHuman/autoExecuted:false;
 *   - forecast se aproximando com confiança média+ → recomendação; confiança baixa → ignorada (RN-PRC-1);
 *   - hipótese de causa → recomendação "investigar antes de agir";
 *   - ordenação por prioridade + disclaimer advisório sempre presente.
 *
 * Uso: npm run test:capacity-recommendation
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rec-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { CapacityRecommendationService: REC } = await import("../src/server/CapacityRecommendationService.js");
  const now = Date.parse("2026-08-12T15:00:00Z");

  // ═══════════════ 1. sem sinal → all_clear ═══════════════
  const empty = REC.recommend({ now,
    headroom: { resources: [{ resource: "host.mem_used_pct", label: "Memória", available: true, zone: "HEALTHY", value: 40, unit: "%", headroomToCritical: 54 }] },
    forecast: { forecasts: [] }, rootCause: { hypotheses: [] } });
  check("1.1 tudo saudável → all_clear, 0 recs", empty.note === "all_clear" && empty.recommendations.length === 0);
  check("1.2 disclaimer advisório sempre presente (CA16/D6)", /nunca redimensiona/i.test(empty.disclaimer));

  // ═══════════════ 2. recurso em CRITICAL → recomendação alta, nunca executa ═══════════════
  const crit = REC.recommend({ now,
    headroom: { resources: [{ resource: "host.mem_used_pct", label: "Memória do host", available: true, zone: "CRITICAL", value: 96, unit: "%", headroomToCritical: -2 }] },
    forecast: { forecasts: [] }, rootCause: { hypotheses: [] } });
  const r = crit.recommendations[0];
  check("2.1 CRITICAL → recomendação prioridade alta", r && r.priority === "alta");
  check("2.2 recomendação é advisória e NUNCA executa (D6/CA16)", r && r.requiresHuman === true && r.autoExecuted === false && r.basis === "advisory");
  check("2.3 explicável — cita a evidência (CA15)", r && Array.isArray(r.evidence) && r.evidence[0].source === "headroom" && r.evidence[0].zone === "CRITICAL");

  // ═══════════════ 3. forecast: confiança média → recomenda; baixa → ignora (RN-PRC-1) ═══════════════
  const fc = REC.recommend({ now, headroom: { resources: [] },
    forecast: { forecasts: [
      { available: true, metric: "host.load1m", label: "CPU", unit: "load", confidence: "alta", targetCrossing: { approaching: true, daysToTarget: 5, target: 2.0, crossingAt: "2026-08-17T15:00:00Z" } },
      { available: true, metric: "db.probe_ms", label: "Banco", unit: "ms", confidence: "baixa", targetCrossing: { approaching: true, daysToTarget: 3, target: 50, crossingAt: "2026-08-15T15:00:00Z" } },
    ] }, rootCause: { hypotheses: [] } });
  check("3.1 forecast confiança alta se aproximando → recomendação", fc.recommendations.some((x: any) => x.id === "forecast:host.load1m"));
  check("3.2 daysToTarget<=7 → prioridade alta", fc.recommendations.find((x: any) => x.id === "forecast:host.load1m")?.priority === "alta");
  check("3.3 confiança baixa → NÃO recomenda (RN-PRC-1, não age em pico/ruído)", !fc.recommendations.some((x: any) => x.id === "forecast:db.probe_ms"));

  // ═══════════════ 4. causa provável → investigar antes de agir ═══════════════
  const rc = REC.recommend({ now, headroom: { resources: [] }, forecast: { forecasts: [] },
    rootCause: { hypotheses: [{ cause: "db_contention", label: "Contenção no banco", hint: "Investigar queries lentas.", confidence: "média-alta", note: "Correlação, não causa comprovada — confirmar com investigação.", evidence: [{ metric: "app.p95" }, { metric: "db.probe_ms" }] }] } });
  const h = rc.recommendations[0];
  check("4.1 hipótese → recomendação de investigação", h && h.id === "rootcause:db_contention" && /investigar/i.test(h.action));
  check("4.2 causa é hipótese → confiança conservadora (não alta)", h && h.confidence !== "alta");

  // ═══════════════ 5. ordenação por prioridade ═══════════════
  const mix = REC.recommend({ now,
    headroom: { resources: [{ resource: "host.mem_used_pct", label: "Mem", available: true, zone: "CRITICAL", value: 96, unit: "%", headroomToCritical: -2 }] },
    forecast: { forecasts: [{ available: true, metric: "host.load1m", label: "CPU", unit: "load", confidence: "média", targetCrossing: { approaching: true, daysToTarget: 45, target: 2.0, crossingAt: "2026-09-26T15:00:00Z" } }] },
    rootCause: { hypotheses: [] } });
  check("5.1 primeira rec é a de maior prioridade (alta antes de baixa)", mix.recommendations[0].priority === "alta");
  check("5.2 summary conta por prioridade", mix.summary.alta === 1 && mix.summary.baixa === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} capacity-recommendation: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
