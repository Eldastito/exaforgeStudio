/**
 * GitHubEvidenceSyncService — ADR-193 F4.
 *
 * Sync opt-in de metadata GitHub (PR/commit/issue) para o Ledger. NUNCA
 * infere vínculo por texto — quem chama passa `owner/repo#ref` explícito.
 *
 * Regras hard (PRD §8.5 + CONVENCOES.md §9):
 *   1. Opt-in via env (`GITHUB_TOKEN` + `GITHUB_EVIDENCE_ENABLED=1`).
 *   2. Cache local SQLite obrigatório (TTL configurável, default 1h).
 *   3. Rate-limit inline (respeita quota 5000/h autenticado da API do GitHub).
 *   4. Read-only — nunca cria/edita PR ou issue.
 *   5. Fetcher injetável (permite mock em testes; nada de rede em CI).
 *
 * Nunca infere que um commit "fecha" um item pelo texto — o vínculo entre
 * evidência e item é explícito (rota separada anexa a evidência).
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

// Contrato do fetcher: função que faz uma chamada HTTP e retorna JSON. Default
// usa `fetch` global. Testes substituem por implementação fake.
export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean; status: number; json: () => Promise<any>;
}>;

// Estado do rate-limit em memória. Reseta a cada hora.
let rateBucket: { hour: number; count: number } = { hour: -1, count: 0 };
const RATE_LIMIT_PER_HOUR = 4800; // < 5000 pra deixar folga.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h default

// Fetcher default — sobrescrito em teste via configure().
let currentFetcher: Fetcher = async (url, init) => {
  // fetch global do Node 18+; sem lib externa.
  const res = await (globalThis as any).fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export interface GitHubPr {
  kind: "pr";
  owner: string; repo: string; number: number;
  title: string; state: "open" | "closed" | string;
  merged: boolean; merged_at: string | null;
  author: string; created_at: string; url: string;
}
export interface GitHubCommit {
  kind: "commit";
  owner: string; repo: string; sha: string;
  message: string; author: string; date: string; url: string;
}
export interface GitHubIssue {
  kind: "issue";
  owner: string; repo: string; number: number;
  title: string; state: "open" | "closed" | string;
  author: string; created_at: string; url: string;
}
export type GitHubMeta = GitHubPr | GitHubCommit | GitHubIssue;

export class GitHubEvidenceSyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message); this.code = code; this.name = "GitHubEvidenceSyncError";
  }
}

export class GitHubEvidenceSyncService {

  /** Permite teste substituir fetcher. Não é rota pública. */
  static configure(opts: { fetcher?: Fetcher }): void {
    if (opts.fetcher) currentFetcher = opts.fetcher;
  }

  /** Reset pro fetcher default — usado em testes. */
  static reset(): void {
    rateBucket = { hour: -1, count: 0 };
    db.prepare("DELETE FROM product_evolution_github_cache").run();
  }

  /** Estado da configuração + rate-limit atual. Pra rota /status. */
  static status(): {
    enabled: boolean; token_configured: boolean;
    rate_limit_per_hour: number; rate_used_this_hour: number;
    rate_remaining: number; cache_ttl_ms: number;
  } {
    const currentHour = Math.floor(Date.now() / (60 * 60 * 1000));
    if (rateBucket.hour !== currentHour) rateBucket = { hour: currentHour, count: 0 };
    return {
      enabled: this.isEnabled(),
      token_configured: !!process.env.GITHUB_TOKEN,
      rate_limit_per_hour: RATE_LIMIT_PER_HOUR,
      rate_used_this_hour: rateBucket.count,
      rate_remaining: RATE_LIMIT_PER_HOUR - rateBucket.count,
      cache_ttl_ms: CACHE_TTL_MS,
    };
  }

  static isEnabled(): boolean {
    return process.env.GITHUB_EVIDENCE_ENABLED === "1"
      && !!process.env.GITHUB_TOKEN;
  }

  private static rateAllow(): boolean {
    const currentHour = Math.floor(Date.now() / (60 * 60 * 1000));
    if (rateBucket.hour !== currentHour) rateBucket = { hour: currentHour, count: 0 };
    if (rateBucket.count >= RATE_LIMIT_PER_HOUR) return false;
    rateBucket.count++;
    return true;
  }

  private static cacheKey(kind: string, owner: string, repo: string, ref: string): string {
    return `${owner}/${repo}#${kind}:${ref}`;
  }

  /** Lê cache fresh (não expirado). Retorna null se ausente ou expirado. */
  private static readCache(kind: string, owner: string, repo: string, ref: string): GitHubMeta | null {
    const key = this.cacheKey(kind, owner, repo, ref);
    const row = db.prepare(
      "SELECT payload_json FROM product_evolution_github_cache WHERE cache_key = ? AND expires_at > CURRENT_TIMESTAMP"
    ).get(key) as any;
    if (!row) return null;
    try { return JSON.parse(row.payload_json); } catch { return null; }
  }

  private static writeCache(kind: string, owner: string, repo: string, ref: string, meta: GitHubMeta): void {
    const key = this.cacheKey(kind, owner, repo, ref);
    const expires = new Date(Date.now() + CACHE_TTL_MS).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(`
      INSERT INTO product_evolution_github_cache (id, cache_key, kind, owner, repo, ref, payload_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = CURRENT_TIMESTAMP,
        expires_at = excluded.expires_at
    `).run(uuidv4(), key, kind, owner, repo, ref, JSON.stringify(meta), expires);
  }

  private static authHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "exaforgeStudio-product-evolution-ledger",
    };
  }

  static async fetchPr(owner: string, repo: string, number: number): Promise<GitHubPr> {
    if (!this.isEnabled()) throw new GitHubEvidenceSyncError("disabled",
      "GITHUB_EVIDENCE_ENABLED != 1 ou GITHUB_TOKEN ausente");
    const cached = this.readCache("pr", owner, repo, String(number));
    if (cached && cached.kind === "pr") return cached;

    if (!this.rateAllow()) throw new GitHubEvidenceSyncError("rate_limit",
      `rate-limit atingido (${RATE_LIMIT_PER_HOUR}/h)`);

    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
    const res = await currentFetcher(url, { headers: this.authHeaders() });
    if (!res.ok) throw new GitHubEvidenceSyncError(`github_${res.status}`,
      `GitHub API retornou ${res.status} para PR ${owner}/${repo}#${number}`);
    const j = await res.json();
    const meta: GitHubPr = {
      kind: "pr", owner, repo, number,
      title: String(j.title || ""),
      state: String(j.state || ""),
      merged: !!j.merged,
      merged_at: j.merged_at || null,
      author: j.user?.login || "",
      created_at: j.created_at || "",
      url: j.html_url || `https://github.com/${owner}/${repo}/pull/${number}`,
    };
    this.writeCache("pr", owner, repo, String(number), meta);
    return meta;
  }

  static async fetchCommit(owner: string, repo: string, sha: string): Promise<GitHubCommit> {
    if (!this.isEnabled()) throw new GitHubEvidenceSyncError("disabled",
      "GITHUB_EVIDENCE_ENABLED != 1 ou GITHUB_TOKEN ausente");
    const cached = this.readCache("commit", owner, repo, sha);
    if (cached && cached.kind === "commit") return cached;

    if (!this.rateAllow()) throw new GitHubEvidenceSyncError("rate_limit",
      `rate-limit atingido (${RATE_LIMIT_PER_HOUR}/h)`);

    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;
    const res = await currentFetcher(url, { headers: this.authHeaders() });
    if (!res.ok) throw new GitHubEvidenceSyncError(`github_${res.status}`,
      `GitHub API retornou ${res.status} para commit ${owner}/${repo}@${sha}`);
    const j = await res.json();
    const meta: GitHubCommit = {
      kind: "commit", owner, repo, sha,
      message: String(j.commit?.message || "").split("\n")[0].slice(0, 200),
      author: j.author?.login || j.commit?.author?.name || "",
      date: j.commit?.author?.date || "",
      url: j.html_url || `https://github.com/${owner}/${repo}/commit/${sha}`,
    };
    this.writeCache("commit", owner, repo, sha, meta);
    return meta;
  }

  static async fetchIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    if (!this.isEnabled()) throw new GitHubEvidenceSyncError("disabled",
      "GITHUB_EVIDENCE_ENABLED != 1 ou GITHUB_TOKEN ausente");
    const cached = this.readCache("issue", owner, repo, String(number));
    if (cached && cached.kind === "issue") return cached;

    if (!this.rateAllow()) throw new GitHubEvidenceSyncError("rate_limit",
      `rate-limit atingido (${RATE_LIMIT_PER_HOUR}/h)`);

    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
    const res = await currentFetcher(url, { headers: this.authHeaders() });
    if (!res.ok) throw new GitHubEvidenceSyncError(`github_${res.status}`,
      `GitHub API retornou ${res.status} para issue ${owner}/${repo}#${number}`);
    const j = await res.json();
    const meta: GitHubIssue = {
      kind: "issue", owner, repo, number,
      title: String(j.title || ""),
      state: String(j.state || ""),
      author: j.user?.login || "",
      created_at: j.created_at || "",
      url: j.html_url || `https://github.com/${owner}/${repo}/issues/${number}`,
    };
    this.writeCache("issue", owner, repo, String(number), meta);
    return meta;
  }

  /**
   * Parseia uma referência como "owner/repo#123" (PR/issue) ou
   * "owner/repo@sha" (commit) para os components esperados por fetch*.
   */
  static parseReference(ref: string): {
    kind: "pr" | "commit" | "issue"; owner: string; repo: string; ref: string;
  } | null {
    // owner/repo@sha (commit)
    const commitMatch = ref.match(/^([^/@\s]+)\/([^/@\s]+)@([0-9a-f]{7,40})$/i);
    if (commitMatch) return { kind: "commit", owner: commitMatch[1], repo: commitMatch[2], ref: commitMatch[3] };

    // owner/repo#123 — precisa distinguir PR de issue; padrão: assume PR
    // (rota separada permite forçar issue via param).
    const numMatch = ref.match(/^([^/@\s]+)\/([^/@\s]+)#(\d+)$/);
    if (numMatch) return { kind: "pr", owner: numMatch[1], repo: numMatch[2], ref: numMatch[3] };

    return null;
  }
}

export default GitHubEvidenceSyncService;
