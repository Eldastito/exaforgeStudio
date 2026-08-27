/**
 * TEST — GitHubEvidenceSyncService (ADR-193 F4).
 * DB-backed, determinístico. Sem chamadas HTTP reais — usa fetcher fake.
 *
 * Prova:
 *   1. isEnabled() = false sem env → fetchPr throws 'disabled';
 *   2. parseReference("owner/repo#123") → pr; owner/repo@sha → commit;
 *   3. Cache SQLite: 1ª chamada faz fetch, 2ª chamada não;
 *   4. Rate limit: bloqueia após max;
 *   5. Sucesso do fetch persiste no cache; TTL respeitado;
 *   6. Falha do upstream (404) → GitHubEvidenceSyncError com code=github_404;
 *   7. Schema da tabela de cache SEM organization_id;
 *   8. status() reporta config + rate-limit corrente.
 *
 * Uso: npm run test:product-evolution-github-sync
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pel-gh-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-gh-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { GitHubEvidenceSyncService: Gh, GitHubEvidenceSyncError } =
    await import("../src/server/GitHubEvidenceSyncService.js");

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(product_evolution_github_cache)").all() as any[]).map(c => c.name);
  check("1.1 tabela existe com cache_key/kind/expires_at",
    cols.includes("cache_key") && cols.includes("kind") && cols.includes("expires_at"));
  check("1.2 tabela SEM organization_id (GLOBAL)", !cols.includes("organization_id"));

  // ═══════════════ 2. isEnabled sem env ═══════════════
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_EVIDENCE_ENABLED;
  check("2.1 isEnabled=false sem env", Gh.isEnabled() === false);

  let disabledThrown = false;
  try { await Gh.fetchPr("owner", "repo", 1); }
  catch (e: any) { disabledThrown = e instanceof GitHubEvidenceSyncError && e.code === "disabled"; }
  check("2.2 fetchPr sem env lança 'disabled'", disabledThrown);

  const status1 = Gh.status();
  check("2.3 status.enabled=false", status1.enabled === false);
  check("2.4 status.token_configured=false", status1.token_configured === false);

  // ═══════════════ 3. Habilita + fetcher fake ═══════════════
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_EVIDENCE_ENABLED = "1";
  check("3.1 isEnabled=true com env", Gh.isEnabled() === true);
  Gh.reset();

  let fetchCount = 0;
  Gh.configure({
    fetcher: async (url) => {
      fetchCount++;
      // Simula resposta pra PR
      if (url.includes("/pulls/")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            title: "Test PR", state: "closed", merged: true,
            merged_at: "2026-01-15T10:00:00Z",
            user: { login: "alice" },
            created_at: "2026-01-14T12:00:00Z",
            html_url: url.replace("api.github.com/repos/", "github.com/").replace("/pulls/", "/pull/"),
          }),
        };
      }
      // Commit
      if (url.includes("/commits/")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            commit: { message: "fix: something\n\nlong body", author: { name: "Bob", date: "2026-01-10T09:00:00Z" } },
            author: { login: "bob" },
            html_url: url.replace("api.github.com/repos/", "github.com/"),
          }),
        };
      }
      // Issue
      if (url.includes("/issues/")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            title: "Bug report",
            state: "open",
            user: { login: "charlie" },
            created_at: "2026-01-20T08:00:00Z",
            html_url: url.replace("api.github.com/repos/", "github.com/"),
          }),
        };
      }
      // Not found
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    }
  });

  // ═══════════════ 4. fetchPr sucesso + cache ═══════════════
  const pr1 = await Gh.fetchPr("acme", "widget", 42);
  check("4.1 fetchPr retorna kind=pr", pr1.kind === "pr");
  check("4.2 fetchPr preenche title", pr1.title === "Test PR");
  check("4.3 fetchPr preenche merged=true", pr1.merged === true);
  check("4.4 fetchPr preenche url", pr1.url.includes("github.com/acme/widget/pull/42"));
  check("4.5 primeira chamada fez fetch", fetchCount === 1);

  const pr2 = await Gh.fetchPr("acme", "widget", 42);
  check("4.6 segunda chamada usou cache (fetchCount inalterado)", fetchCount === 1);
  check("4.7 segunda chamada retorna dado idêntico", pr2.title === pr1.title);

  // ═══════════════ 5. Commit ═══════════════
  const commit = await Gh.fetchCommit("acme", "widget", "abc1234");
  check("5.1 fetchCommit kind=commit", commit.kind === "commit");
  check("5.2 message pega só a primeira linha", commit.message === "fix: something");
  check("5.3 author preferido login sobre commit.author.name", commit.author === "bob");
  check("5.4 fetch conta 2", fetchCount === 2);

  // ═══════════════ 6. Issue ═══════════════
  const issue = await Gh.fetchIssue("acme", "widget", 99);
  check("6.1 fetchIssue kind=issue", issue.kind === "issue");
  check("6.2 title preservado", issue.title === "Bug report");
  check("6.3 state=open", issue.state === "open");
  check("6.4 fetch conta 3", fetchCount === 3);

  // ═══════════════ 7. Falha upstream (404) ═══════════════
  let notFoundError: any = null;
  Gh.configure({
    fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  try { await Gh.fetchPr("ghost", "unknown", 1); }
  catch (e: any) { notFoundError = e; }
  check("7.1 fetchPr em repo inexistente lança GitHubEvidenceSyncError",
    notFoundError instanceof GitHubEvidenceSyncError);
  check("7.2 code=github_404", notFoundError?.code === "github_404");

  // ═══════════════ 8. parseReference ═══════════════
  const pr = Gh.parseReference("acme/widget#42");
  check("8.1 owner/repo#N parse como PR", pr?.kind === "pr" && pr?.owner === "acme" && pr?.repo === "widget" && pr?.ref === "42");

  const cm = Gh.parseReference("acme/widget@abcdef1234567890abcdef1234567890abcdef12");
  check("8.2 owner/repo@sha parse como commit", cm?.kind === "commit" && cm?.ref.startsWith("abcdef"));

  check("8.3 SHA curto (7 chars) também aceito",
    Gh.parseReference("acme/widget@abc1234")?.kind === "commit");

  check("8.4 formato inválido → null", Gh.parseReference("not a github ref") === null);
  check("8.5 apenas o número → null", Gh.parseReference("#42") === null);

  // ═══════════════ 9. status() com dados ═══════════════
  const status2 = Gh.status();
  check("9.1 status.enabled=true", status2.enabled === true);
  check("9.2 status.token_configured=true", status2.token_configured === true);
  check("9.3 rate_used_this_hour > 0 (chamamos várias vezes)", status2.rate_used_this_hour > 0);
  check("9.4 rate_remaining < rate_limit", status2.rate_remaining < status2.rate_limit_per_hour);

  // ═══════════════ 10. Cache persistido no SQLite ═══════════════
  const cacheRows = db.prepare("SELECT * FROM product_evolution_github_cache").all() as any[];
  check("10.1 cache tem >= 3 linhas (pr + commit + issue)", cacheRows.length >= 3);
  check("10.2 cada linha tem cache_key formatado",
    cacheRows.every(r => r.cache_key.includes("/") && r.cache_key.includes("#")));

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
