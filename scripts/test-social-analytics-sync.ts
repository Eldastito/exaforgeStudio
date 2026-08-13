/**
 * TEST — Social Analytics Ingestion (PRD 10 / ADR-167 F4). DB-backed, determinístico
 * (usa o StubSocialChannelProvider — sem rede). Prova (RN-SI-08/12, §42):
 *   - sync puxa posts+analytics do provider e PERSISTE (upsert idempotente);
 *   - reingestão NÃO duplica (UNIQUE(org,channel,post_external_id));
 *   - métrica ausente vira NULL, nunca 0 (SP-2 do stub tem comments/shares null);
 *   - summary agrega por query; sem analytics → total null (não 0);
 *   - degradação honesta: provider desconectado (IG sem canal) → degraded, 0 gravados;
 *   - `pass()` só pega conexões habilitadas de provider REAL (pula stub);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:social-analytics-sync
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-social-an-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-social-an-123";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");

  const A = "org_an_A", B = "org_an_B";

  // ═══════════════ 1. sync via stub → persiste posts + analytics ═══════════════
  const r1 = await AN.sync(A, "stub");
  check("1.1 sync grava os 2 posts do stub", r1.synced === 2 && !r1.degraded);
  check("1.2 ambos vieram com analytics disponível", r1.withAnalytics === 2);
  const posts = AN.list(A, "stub");
  check("1.3 persistiu 2 posts", posts.length === 2);
  const sp1 = posts.find((p: any) => p.post_external_id === "SP-1");
  const sp2 = posts.find((p: any) => p.post_external_id === "SP-2");
  check("1.4 SP-1 métricas cheias (impressions=1200)", sp1?.impressions === 1200 && sp1?.likes === 84);
  check("1.5 SP-2 métrica ausente = NULL, nunca 0 (RN-SI-12)", sp2?.comments === null && sp2?.shares === null && sp2?.saves === null);
  check("1.6 SP-2 tem o que o feed dá (reach=500) mesmo com nulls", sp2?.reach === 500);

  // ═══════════════ 2. idempotência (RN-SI-08) ═══════════════
  const r2 = await AN.sync(A, "stub");
  check("2.1 reingestão NÃO duplica (upsert)", AN.list(A, "stub").length === 2);
  check("2.2 sync repetido reporta os mesmos 2", r2.synced === 2);

  // ═══════════════ 3. summary agregado (por query, null honesto) ═══════════════
  const sum = AN.summary(A, "stub");
  check("3.1 posts=2, comAnalytics=2", sum.posts === 2 && sum.postsWithAnalytics === 2);
  check("3.2 totalImpressions soma só o que existe (1200+640)", sum.totalImpressions === 1840);
  // org sem nenhum post → total DESCONHECIDO (null), não 0.
  const emptySum = AN.summary(A, "youtube");
  check("3.3 sem post → total null (não 0)", emptySum.posts === 0 && emptySum.totalImpressions === null);

  // ═══════════════ 4. degradação honesta: provider desconectado ═══════════════
  // instagram + provider='instagram' SEM canal OAuth (channels) → não conectado.
  SC.setConfig(A, "instagram", {}, { provider: "instagram", enabled: true });
  const rDeg = await AN.sync(A, "instagram");
  check("4.1 IG desconectado → degraded, 0 gravados (não inventa)", rDeg.degraded === true && rDeg.synced === 0);
  check("4.2 nada persistido pro canal degradado", AN.list(A, "instagram").length === 0);

  // ═══════════════ 5. pass() só pega provider REAL habilitado (pula stub) ═══════════════
  // conexão stub habilitada NÃO deve ser puxada pelo pass (só shadow/teste).
  SC.setConfig(B, "instagram", {}, { provider: "stub", enabled: true });
  await AN.pass();  // não lança; IG(A) degrada sem rede, stub(B) é ignorado
  check("5.1 pass() não cria linha pro stub habilitado (B)", AN.list(B, "instagram").length === 0);
  check("5.2 pass() completou sem gravar pro IG desconectado (A)", AN.list(A, "instagram").length === 0);

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  await AN.sync(B, "stub");
  check("6.1 B tem seus próprios posts", AN.list(B, "stub").length === 2);
  const aIds = new Set(AN.list(A, "stub").map((p: any) => p.post_external_id));
  check("6.2 A vê só os seus (2), B não vaza pra A", aIds.size === 2);
  const crossA = db.prepare(`SELECT COUNT(*) n FROM social_post_metrics WHERE organization_id = ?`).get(A) as any;
  check("6.3 contagem de A isolada (2 stub, IG degradado não gravou)", crossA.n === 2);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-analytics-sync: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
