/**
 * TEST — HttpMetricsCollector: SLI de aplicação (PRD 7 / ADR-164 F3). Puro, determinístico.
 * Prova (§14-15, §99, RN-PRC-3/5/6):
 *   - normalização de rota colapsa ids (num/uuid/hex/token) → baixa cardinalidade, sem PII;
 *   - snapshot deriva p50/p95/p99/max (NÃO média — §15), rps, taxa de erro 5xx/4xx por classe;
 *   - rotas mais lentas por p95; janela filtra amostras antigas;
 *   - sem amostra → available:false/no_data (RN-PRC-6); buffer bounded (memória, RN-PRC-3).
 *
 * Uso: npm run test:http-metrics
 */
process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-hm-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { HttpMetricsCollector: HM } = await import("../src/server/HttpMetricsCollector.js");
  HM.reset();

  // ═══════════════ 1. normalização de rota (cardinalidade, RN-PRC-5) ═══════════════
  check("1.1 id numérico → :id", HM.normalizeRoute("GET", "/api/actions/123/card") === "GET /api/actions/:id/card");
  check("1.2 uuid → :id", HM.normalizeRoute("post", "/api/orgs/3f2504e0-4f89-41d3-9a0c-0305e82c3301/x") === "POST /api/orgs/:id/x");
  check("1.3 token longo → :id", HM.normalizeRoute("GET", "/api/files/AbCdEf0123456789ABCdef/download") === "GET /api/files/:id/download");
  check("1.4 querystring removida + rota estática preservada", HM.normalizeRoute("GET", "/api/ux/executing?x=1") === "GET /api/ux/executing");
  check("1.5 3 ids diferentes → MESMA chave (baixa cardinalidade)", HM.normalizeRoute("GET", "/a/1") === HM.normalizeRoute("GET", "/a/2"));

  // ═══════════════ 2. percentis (NÃO média, §15) ═══════════════
  const now = 1_700_000_000_000;
  for (let i = 1; i <= 100; i++) HM.record({ method: "GET", route: "GET /api/x", status: 200, durationMs: i, at: now - 1000 });
  const s = HM.snapshot({ now, windowMs: 5 * 60 * 1000 });
  check("2.1 available + 100 amostras", s.available === true && s.sampleCount === 100);
  check("2.2 p50/p95/p99/max corretos", s.latencyMs!.p50 === 50 && s.latencyMs!.p95 === 95 && s.latencyMs!.p99 === 99 && s.latencyMs!.max === 100);
  check("2.3 rps derivado da janela", s.rps > 0);

  // ═══════════════ 3. taxa de erro por classe ═══════════════
  HM.reset();
  for (let i = 0; i < 7; i++) HM.record({ method: "GET", route: "GET /api/y", status: 200, durationMs: 10, at: now });
  for (let i = 0; i < 2; i++) HM.record({ method: "GET", route: "GET /api/y", status: 500, durationMs: 10, at: now });
  HM.record({ method: "GET", route: "GET /api/y", status: 404, durationMs: 10, at: now });
  const e = HM.snapshot({ now });
  check("3.1 errorRate 5xx = 20%", e.errorRatePct === 20);
  check("3.2 clientErrorRate 4xx = 10%", e.clientErrorRatePct === 10);
  check("3.3 byStatusClass {2xx:7,4xx:1,5xx:2}", e.byStatusClass["2xx"] === 7 && e.byStatusClass["4xx"] === 1 && e.byStatusClass["5xx"] === 2);

  // ═══════════════ 4. rotas mais lentas (p95 por rota) ═══════════════
  HM.reset();
  for (let i = 0; i < 5; i++) HM.record({ method: "GET", route: "GET /fast", status: 200, durationMs: 5, at: now });
  for (let i = 0; i < 5; i++) HM.record({ method: "GET", route: "GET /slow", status: 200, durationMs: 900, at: now });
  const sr = HM.snapshot({ now }).slowestRoutes;
  check("4.1 rota mais lenta é /slow no topo", sr[0].route === "GET /slow" && sr[0].p95Ms >= 900 && sr[0].count === 5);

  // ═══════════════ 5. janela filtra amostras antigas ═══════════════
  HM.reset();
  HM.record({ method: "GET", route: "GET /z", status: 200, durationMs: 10, at: now });               // dentro
  HM.record({ method: "GET", route: "GET /z", status: 200, durationMs: 10, at: now - 10 * 60 * 1000 }); // 10min atrás (fora da janela 5min)
  const w = HM.snapshot({ now, windowMs: 5 * 60 * 1000 });
  check("5.1 só a amostra dentro da janela conta", w.sampleCount === 1);

  // ═══════════════ 6. sem amostra → honesto (RN-PRC-6) ═══════════════
  HM.reset();
  const empty = HM.snapshot({ now });
  check("6.1 available:false + no_data (não inventa)", empty.available === false && empty.reason === "no_data" && empty.latencyMs === null);

  // ═══════════════ 7. buffer bounded (memória, RN-PRC-3) ═══════════════
  HM.reset(); HM.setMaxSamples(50);
  for (let i = 0; i < 200; i++) HM.record({ method: "GET", route: "GET /b", status: 200, durationMs: 1, at: now });
  check("7.1 ring buffer nunca passa do teto", HM.size() === 50);

  HM.reset();

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} http-metrics: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
