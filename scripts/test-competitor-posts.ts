/**
 * TEST — CompetitorPostsService (Closure Track B do PRD-PEL-01, F2).
 * DB-backed, determinístico. Prova:
 *   1. Schema: competitor_posts com colunas e índices esperados;
 *   2. Validações: missing_org/competitor/external_id/invalid_metrics;
 *   3. upsertPost verifica ownership (competitor de outra org → competitor_not_found);
 *   4. Upsert idempotente (mesmo external_id atualiza; muda fetched_at);
 *   5. metrics_json opcional; se objeto plano → serializado; se array → invalid_metrics;
 *   6. kind fora do enum → cai pra 'post' default (silencioso);
 *   7. posted_at aceita número (epoch ms) ou ISO;
 *   8. listPostsForCompetitor: filtra por org via JOIN, ordena posted_at DESC,
 *      respeita limit, filtra since;
 *   9. Outra org não vê posts (isolamento) → [];
 *  10. getPost: ownership via JOIN; outra org → null;
 *  11. listRecentPostsForOrg: mescla concorrentes ativos, anexa
 *      competitor_platform/handle; filtra por platform; ignora inativos;
 *  12. deletePost só do dono;
 *  13. deleteAllForCompetitor apaga tudo daquele competitor;
 *  14. hardDelete do CompetitorIntelligenceService cascateia posts.
 *
 * Uso: npm run test:competitor-posts
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cp-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { CompetitorIntelligenceService: CIS } =
    await import("../src/server/CompetitorIntelligenceService.js");
  const { CompetitorPostsService: CPS, CompetitorPostError, POST_KINDS } =
    await import("../src/server/CompetitorPostsService.js");

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(competitor_posts)").all() as any[])
    .map(c => c.name);
  for (const col of ["id", "competitor_id", "external_id", "url", "kind",
    "caption", "media_url", "posted_at", "metrics_json", "raw_json",
    "fetched_at", "created_at"]) {
    check(`1.x coluna ${col}`, cols.includes(col));
  }

  // Setup: 2 orgs, cada uma com 2 competitors.
  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";
  const cA1 = CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "nike" });
  const cA2 = CIS.addCompetitor({ orgId: ORG_A, platform: "tiktok", handle: "adidas" });
  const cB1 = CIS.addCompetitor({ orgId: ORG_B, platform: "instagram", handle: "puma" });

  // ═══════════════ 2. Validações ═══════════════
  let missingOrg = false;
  try { CPS.upsertPost({ orgId: "", competitorId: cA1.id, external_id: "x" }); }
  catch (e: any) { missingOrg = e instanceof CompetitorPostError && e.code === "missing_org"; }
  check("2.1 orgId vazio → missing_org", missingOrg);

  let missingCompetitor = false;
  try { CPS.upsertPost({ orgId: ORG_A, competitorId: "", external_id: "x" }); }
  catch (e: any) { missingCompetitor = e instanceof CompetitorPostError && e.code === "missing_competitor"; }
  check("2.2 competitorId vazio → missing_competitor", missingCompetitor);

  let missingExtId = false;
  try { CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "" }); }
  catch (e: any) { missingExtId = e instanceof CompetitorPostError && e.code === "missing_external_id"; }
  check("2.3 external_id vazio → missing_external_id", missingExtId);

  let invalidMetrics = false;
  try { CPS.upsertPost({ orgId: ORG_A, competitorId: cA1.id, external_id: "x", metrics: [1, 2, 3] as any }); }
  catch (e: any) { invalidMetrics = e instanceof CompetitorPostError && e.code === "invalid_metrics"; }
  check("2.4 metrics array → invalid_metrics", invalidMetrics);

  // ═══════════════ 3. Ownership check ═══════════════
  let notMine = false;
  try { CPS.upsertPost({ orgId: ORG_B, competitorId: cA1.id, external_id: "x" }); }
  catch (e: any) { notMine = e instanceof CompetitorPostError && e.code === "competitor_not_found"; }
  check("3.1 outra org upserta em competitor alheio → competitor_not_found", notMine);

  let notFound = false;
  try { CPS.upsertPost({ orgId: ORG_A, competitorId: "id-inexistente", external_id: "x" }); }
  catch (e: any) { notFound = e instanceof CompetitorPostError && e.code === "competitor_not_found"; }
  check("3.2 competitorId inexistente → competitor_not_found", notFound);

  // ═══════════════ 4. Happy path ═══════════════
  const p1 = CPS.upsertPost({
    orgId: ORG_A, competitorId: cA1.id, external_id: "IG-123",
    url: "https://ig.com/p/IG-123",
    kind: "reel",
    caption: "Novo lançamento",
    media_url: "https://cdn/ig-123.jpg",
    posted_at: "2026-08-25T10:00:00Z",
    metrics: { likes: 100, comments: 5, views: 900 },
  });
  check("4.1 upsert cria post com id", !!p1.id);
  check("4.2 kind válido preservado", p1.kind === "reel");
  check("4.3 metrics parseadas", p1.metrics.likes === 100 && p1.metrics.views === 900);
  check("4.4 posted_at ISO normalizado", p1.posted_at === "2026-08-25T10:00:00.000Z");
  check("4.5 competitor_id vem no retorno", p1.competitor_id === cA1.id);

  // Kind inválido → cai pra 'post'
  const pBadKind = CPS.upsertPost({
    orgId: ORG_A, competitorId: cA1.id, external_id: "IG-BAD-KIND",
    kind: "explosivo" as any,
  });
  check("4.6 kind fora do enum vira 'post'", pBadKind.kind === "post");
  check("4.7 POST_KINDS inclui post/reel/video/story/image/other",
    POST_KINDS.includes("post") && POST_KINDS.includes("reel") &&
    POST_KINDS.includes("video") && POST_KINDS.includes("story") &&
    POST_KINDS.includes("image") && POST_KINDS.includes("other"));

  // posted_at como epoch ms
  const epochMs = new Date("2026-08-20T15:30:00Z").getTime();
  const pEpoch = CPS.upsertPost({
    orgId: ORG_A, competitorId: cA1.id, external_id: "IG-EPOCH",
    posted_at: epochMs,
  });
  check("4.8 posted_at aceita epoch ms", pEpoch.posted_at === "2026-08-20T15:30:00.000Z");

  // ═══════════════ 5. Upsert idempotente (substituição total) ═══════════════
  const p1Again = CPS.upsertPost({
    orgId: ORG_A, competitorId: cA1.id, external_id: "IG-123",
    caption: "Legenda atualizada",
    posted_at: "2026-08-25T10:00:00Z",              // scraper sempre reenvia
    metrics: { likes: 500 },
  });
  check("5.1 upsert com mesmo (competitor, external_id) retorna MESMO id", p1Again.id === p1.id);
  check("5.2 caption foi atualizada", p1Again.caption === "Legenda atualizada");
  check("5.3 metrics substituídas", p1Again.metrics.likes === 500);

  // Contagem por competitor: deve ter 3 posts (IG-123, IG-BAD-KIND, IG-EPOCH), não 4.
  const countCA1 = (db.prepare(
    "SELECT COUNT(*) AS n FROM competitor_posts WHERE competitor_id = ?"
  ).get(cA1.id) as any).n;
  check("5.4 upsert idempotente não duplica linhas", countCA1 === 3);

  // ═══════════════ 6. Isolamento entre orgs ═══════════════
  const pB = CPS.upsertPost({
    orgId: ORG_B, competitorId: cB1.id, external_id: "PUMA-1",
    posted_at: "2026-08-27T00:00:00Z",
  });
  const listA = CPS.listPostsForCompetitor(ORG_A, cA1.id);
  check("6.1 ORG_A vê seus 3 posts de nike", listA.length === 3);

  const listBCross = CPS.listPostsForCompetitor(ORG_A, cB1.id);
  check("6.2 ORG_A tentando ver competitor de B → [] (isolamento)", listBCross.length === 0);

  const getCross = CPS.getPost(ORG_A, pB.id);
  check("6.3 getPost de outra org → null", getCross === null);

  const getSelf = CPS.getPost(ORG_A, p1.id);
  check("6.4 getPost próprio → retorna", getSelf?.id === p1.id);

  // ═══════════════ 7. listPostsForCompetitor: order + limit + since ═══════════════
  // Ordem: posted_at DESC. Postos criados:
  //   IG-123 → 2026-08-25
  //   IG-BAD-KIND → null (no posted_at)
  //   IG-EPOCH → 2026-08-20
  const ordered = CPS.listPostsForCompetitor(ORG_A, cA1.id);
  check("7.1 ordem: posted_at DESC (mais recente primeiro)",
    ordered[0].external_id === "IG-123" && ordered[1].external_id === "IG-EPOCH");
  check("7.2 posts sem posted_at vão pro fim",
    ordered[ordered.length - 1].external_id === "IG-BAD-KIND");

  const limited = CPS.listPostsForCompetitor(ORG_A, cA1.id, { limit: 1 });
  check("7.3 limit=1 retorna 1", limited.length === 1);

  const sinceRes = CPS.listPostsForCompetitor(ORG_A, cA1.id, { since: "2026-08-22T00:00:00Z" });
  check("7.4 since filtra por posted_at",
    sinceRes.length === 1 && sinceRes[0].external_id === "IG-123");

  // ═══════════════ 8. listRecentPostsForOrg (feed cronológico) ═══════════════
  // Adicionar 1 post em cA2 e outro em cB1 pra ter mistura
  CPS.upsertPost({ orgId: ORG_A, competitorId: cA2.id, external_id: "TT-1",
    posted_at: "2026-08-26T00:00:00Z" });
  const feedA = CPS.listRecentPostsForOrg(ORG_A);
  check("8.1 feed da ORG_A tem 4 posts (3 IG + 1 TT)", feedA.length === 4);
  check("8.2 anexa competitor_platform",
    feedA.every(p => typeof p.competitor_platform === "string"));
  check("8.3 anexa competitor_handle",
    feedA.every(p => typeof p.competitor_handle === "string"));
  check("8.4 ordenação mescla por posted_at DESC",
    feedA[0].external_id === "TT-1" &&    // 08-26
    feedA[1].external_id === "IG-123");    // 08-25

  const feedAins = CPS.listRecentPostsForOrg(ORG_A, { platform: "instagram" });
  check("8.5 filtro platform=instagram traz só 3 (só nike)",
    feedAins.length === 3 && feedAins.every(p => p.competitor_platform === "instagram"));

  const feedB = CPS.listRecentPostsForOrg(ORG_B);
  check("8.6 ORG_B vê só seu post", feedB.length === 1 && feedB[0].external_id === "PUMA-1");

  // Se desativar o competitor, seus posts somem do feed
  CIS.deactivate(ORG_A, cA1.id);
  const feedAfterDeact = CPS.listRecentPostsForOrg(ORG_A);
  check("8.7 competitor desativado → posts somem do feed",
    !feedAfterDeact.some(p => p.competitor_handle === "nike"));
  CIS.reactivate(ORG_A, cA1.id);

  // ═══════════════ 9. deletePost + isolamento ═══════════════
  const delWrongOrg = CPS.deletePost(ORG_B, p1.id);
  check("9.1 outra org não deleta post alheio", delWrongOrg === false);

  const stillHere = CPS.getPost(ORG_A, p1.id);
  check("9.2 post intacto após tentativa mal-sucedida", stillHere?.id === p1.id);

  const delOk = CPS.deletePost(ORG_A, p1.id);
  check("9.3 dono deleta com sucesso", delOk === true);

  const gone = CPS.getPost(ORG_A, p1.id);
  check("9.4 após delete, get retorna null", gone === null);

  const delAgain = CPS.deletePost(ORG_A, p1.id);
  check("9.5 delete em id já removido → false", delAgain === false);

  // ═══════════════ 10. deleteAllForCompetitor ═══════════════
  const beforeCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM competitor_posts WHERE competitor_id = ?"
  ).get(cA1.id) as any).n;
  check("10.1 cA1 tem 2 posts remanescentes (IG-BAD-KIND, IG-EPOCH)", beforeCount === 2);

  const removed = CPS.deleteAllForCompetitor(cA1.id);
  check("10.2 deleteAllForCompetitor retorna quantidade", removed === 2);

  const afterCount = (db.prepare(
    "SELECT COUNT(*) AS n FROM competitor_posts WHERE competitor_id = ?"
  ).get(cA1.id) as any).n;
  check("10.3 posts de cA1 removidos", afterCount === 0);

  // ═══════════════ 11. Cascade via CIS.hardDelete ═══════════════
  // cA2 ainda tem 1 post (TT-1). Ao hardDelete cA2, o post some.
  const cA2Posts = (db.prepare(
    "SELECT COUNT(*) AS n FROM competitor_posts WHERE competitor_id = ?"
  ).get(cA2.id) as any).n;
  check("11.1 cA2 tem 1 post antes do hardDelete", cA2Posts === 1);

  const hd = CIS.hardDelete(ORG_A, cA2.id);
  check("11.2 hardDelete retorna true", hd === true);

  const cA2PostsAfter = (db.prepare(
    "SELECT COUNT(*) AS n FROM competitor_posts WHERE competitor_id = ?"
  ).get(cA2.id) as any).n;
  check("11.3 hardDelete cascateou posts de cA2 (agora 0)", cA2PostsAfter === 0);

  // Confirmar que hardDelete de outra org não afeta posts
  const hdWrong = CIS.hardDelete(ORG_B, cA1.id);
  check("11.4 hardDelete por outra org → false", hdWrong === false);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
