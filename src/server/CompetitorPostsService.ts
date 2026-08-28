/**
 * CompetitorPostsService — Closure Track B do PRD-PEL-01, fatia F2.
 *
 * Storage + queries de posts das contas de concorrentes cadastradas na F1.
 * Esta fatia cobre:
 *   - upsertPost: registra ou atualiza um post pelo par (competitor_id, external_id)
 *   - listPostsForCompetitor: feed cronológico de um concorrente
 *   - listRecentPostsForOrg: feed cronológico de todos os concorrentes da org
 *   - getPost / deletePost: acesso individual com verificação de ownership
 *   - deleteAllForCompetitor: cascata manual (usada por CompetitorIntelligenceService.hardDelete)
 *
 * Fatia F2.5 (fora daqui) vai adicionar adapter de fetch DI-injetável por
 * plataforma. Nesta fatia, upsert é a única forma de popular (via API
 * REST manual, seed script ou tests).
 *
 * Regras (RN-CI-06..09):
 *   6. Isolamento multi-tenant via JOIN em competitor_accounts.organization_id
 *   7. UNIQUE (competitor_id, external_id) — idempotência da ingestão
 *   8. metrics_json e raw_json opcionais; validados como JSON serializável
 *   9. posted_at aceita ISO string ou epoch ms; normalizado pra ISO no storage
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

export const POST_KINDS = ["post", "reel", "video", "story", "image", "other"] as const;
export type PostKind = typeof POST_KINDS[number];

export interface CompetitorPostRow {
  id: string;
  competitor_id: string;
  external_id: string;
  url: string | null;
  kind: string;
  caption: string | null;
  media_url: string | null;
  posted_at: string | null;
  metrics_json: string | null;
  raw_json: string | null;
  fetched_at: string;
  created_at: string;
}

export interface CompetitorPost {
  id: string;
  competitor_id: string;
  external_id: string;
  url: string | null;
  kind: PostKind;
  caption: string | null;
  media_url: string | null;
  posted_at: string | null;
  metrics: Record<string, any>;
  fetched_at: string;
  created_at: string;
}

export interface CompetitorPostWithMeta extends CompetitorPost {
  competitor_platform: string;
  competitor_handle: string;
}

export class CompetitorPostError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg); this.code = code; this.name = "CompetitorPostError";
  }
}

function rowToPost(r: CompetitorPostRow): CompetitorPost {
  let metrics: Record<string, any> = {};
  if (r.metrics_json) {
    try {
      const parsed = JSON.parse(r.metrics_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metrics = parsed;
    } catch { /* keep {} */ }
  }
  return {
    id: r.id,
    competitor_id: r.competitor_id,
    external_id: r.external_id,
    url: r.url,
    kind: (POST_KINDS as readonly string[]).includes(r.kind) ? (r.kind as PostKind) : "other",
    caption: r.caption,
    media_url: r.media_url,
    posted_at: r.posted_at,
    metrics,
    fetched_at: r.fetched_at,
    created_at: r.created_at,
  };
}

function normalizePostedAt(input: any): string | null {
  if (!input && input !== 0) return null;
  if (typeof input === "number") {
    // epoch ms → ISO
    try { return new Date(input).toISOString(); } catch { return null; }
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Se já é uma string parseável, guarda em ISO; senão mantém como está
    // (SQLite guarda TEXT igual, mas ordenação lexicográfica pode confundir).
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString();
    return trimmed;
  }
  return null;
}

function serializeMetrics(input: any): string | null {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new CompetitorPostError("invalid_metrics", "metrics deve ser um objeto plano");
  }
  try { return JSON.stringify(input); }
  catch { throw new CompetitorPostError("invalid_metrics", "metrics não é serializável"); }
}

function serializeRaw(input: any): string | null {
  if (input == null) return null;
  try { return typeof input === "string" ? input : JSON.stringify(input); }
  catch { return null; }
}

function verifyCompetitorOwnership(orgId: string, competitorId: string): boolean {
  if (!orgId || !competitorId) return false;
  const row = db.prepare(
    "SELECT 1 FROM competitor_accounts WHERE id = ? AND organization_id = ?"
  ).get(competitorId, orgId);
  return !!row;
}

export class CompetitorPostsService {

  /**
   * Insere ou atualiza um post pelo par (competitor_id, external_id).
   * Só permite se a org for dona do competitor.
   */
  static upsertPost(input: {
    orgId: string;
    competitorId: string;
    external_id: string;
    url?: string | null;
    kind?: string;
    caption?: string | null;
    media_url?: string | null;
    posted_at?: string | number | null;
    metrics?: Record<string, any> | null;
    raw?: any;
  }): CompetitorPost {
    if (!input.orgId) throw new CompetitorPostError("missing_org", "orgId é obrigatório");
    if (!input.competitorId) throw new CompetitorPostError("missing_competitor", "competitorId é obrigatório");
    const externalId = (input.external_id || "").trim();
    if (!externalId) throw new CompetitorPostError("missing_external_id", "external_id é obrigatório");

    if (!verifyCompetitorOwnership(input.orgId, input.competitorId)) {
      throw new CompetitorPostError("competitor_not_found",
        "concorrente não encontrado ou não pertence à sua organização");
    }

    const kind = input.kind && (POST_KINDS as readonly string[]).includes(input.kind)
      ? input.kind : "post";
    const postedAt = normalizePostedAt(input.posted_at);
    const metricsJson = serializeMetrics(input.metrics ?? null);
    const rawJson = serializeRaw(input.raw ?? null);

    // Verifica se já existe pra fazer update; senão insere novo.
    const existing = db.prepare(
      "SELECT id FROM competitor_posts WHERE competitor_id = ? AND external_id = ?"
    ).get(input.competitorId, externalId) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE competitor_posts
            SET url = ?, kind = ?, caption = ?, media_url = ?,
                posted_at = ?, metrics_json = ?, raw_json = ?,
                fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      ).run(
        input.url?.trim() || null,
        kind,
        input.caption?.trim() || null,
        input.media_url?.trim() || null,
        postedAt,
        metricsJson,
        rawJson,
        existing.id,
      );
      return this.getPostByIdInternal(existing.id)!;
    }

    const id = uuidv4();
    db.prepare(
      `INSERT INTO competitor_posts
       (id, competitor_id, external_id, url, kind, caption, media_url,
        posted_at, metrics_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.competitorId, externalId,
      input.url?.trim() || null,
      kind,
      input.caption?.trim() || null,
      input.media_url?.trim() || null,
      postedAt,
      metricsJson,
      rawJson,
    );
    return this.getPostByIdInternal(id)!;
  }

  /** Uso interno — bypassa ownership porque já foi verificado no upsert. */
  private static getPostByIdInternal(id: string): CompetitorPost | null {
    const row = db.prepare(
      "SELECT * FROM competitor_posts WHERE id = ?"
    ).get(id) as CompetitorPostRow | undefined;
    return row ? rowToPost(row) : null;
  }

  /** Retorna 1 post por id, verificando ownership via JOIN. */
  static getPost(orgId: string, postId: string): CompetitorPost | null {
    if (!orgId || !postId) return null;
    const row = db.prepare(
      `SELECT p.* FROM competitor_posts p
          JOIN competitor_accounts c ON c.id = p.competitor_id
         WHERE p.id = ? AND c.organization_id = ?`
    ).get(postId, orgId) as CompetitorPostRow | undefined;
    return row ? rowToPost(row) : null;
  }

  /**
   * Lista posts de um concorrente, mais recentes primeiro (posted_at DESC,
   * fetched_at DESC como tie-break). Filtro opcional `since` (ISO ou null).
   * Retorna [] se a org não é dona do competitor (isolamento).
   */
  static listPostsForCompetitor(orgId: string, competitorId: string, opts: {
    limit?: number;
    since?: string | null;
  } = {}): CompetitorPost[] {
    if (!verifyCompetitorOwnership(orgId, competitorId)) return [];
    const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
    const wheres: string[] = ["competitor_id = ?"];
    const params: any[] = [competitorId];
    if (opts.since) { wheres.push("posted_at >= ?"); params.push(opts.since); }
    const rows = db.prepare(
      `SELECT * FROM competitor_posts
        WHERE ${wheres.join(" AND ")}
        ORDER BY COALESCE(posted_at, '') DESC, fetched_at DESC
        LIMIT ?`
    ).all(...params, limit) as CompetitorPostRow[];
    return rows.map(rowToPost);
  }

  /**
   * Feed cronológico de todos os concorrentes da org (mais recentes primeiro).
   * Anexa `competitor_platform` e `competitor_handle` pra economizar JOIN
   * no consumidor. Filtros opcionais: platform e limit (padrão 100, max 500).
   */
  static listRecentPostsForOrg(orgId: string, opts: {
    limit?: number;
    platform?: string;
    since?: string | null;
  } = {}): CompetitorPostWithMeta[] {
    if (!orgId) return [];
    const limit = Math.min(Math.max(opts.limit || 100, 1), 500);
    const wheres: string[] = ["c.organization_id = ?", "c.active = 1"];
    const params: any[] = [orgId];
    if (opts.platform) { wheres.push("c.platform = ?"); params.push(opts.platform); }
    if (opts.since) { wheres.push("p.posted_at >= ?"); params.push(opts.since); }
    const rows = db.prepare(
      `SELECT p.*, c.platform AS competitor_platform, c.handle AS competitor_handle
         FROM competitor_posts p
         JOIN competitor_accounts c ON c.id = p.competitor_id
        WHERE ${wheres.join(" AND ")}
        ORDER BY COALESCE(p.posted_at, '') DESC, p.fetched_at DESC
        LIMIT ?`
    ).all(...params, limit) as Array<CompetitorPostRow & { competitor_platform: string; competitor_handle: string }>;
    return rows.map(r => ({
      ...rowToPost(r),
      competitor_platform: r.competitor_platform,
      competitor_handle: r.competitor_handle,
    }));
  }

  /**
   * Remove 1 post, com verificação de ownership via JOIN. Retorna true
   * se removeu.
   */
  static deletePost(orgId: string, postId: string): boolean {
    if (!orgId || !postId) return false;
    // Verifica ownership antes pra devolver false silenciosamente se não é da org.
    const owned = db.prepare(
      `SELECT 1 FROM competitor_posts p
          JOIN competitor_accounts c ON c.id = p.competitor_id
         WHERE p.id = ? AND c.organization_id = ?`
    ).get(postId, orgId);
    if (!owned) return false;
    const info = db.prepare("DELETE FROM competitor_posts WHERE id = ?").run(postId);
    return info.changes > 0;
  }

  /**
   * Cascade manual — apaga todos os posts de um competitor. Chamado pelo
   * hardDelete de CompetitorIntelligenceService pra manter competitor_posts
   * limpa (SQLite não força FK sem PRAGMA foreign_keys=ON, que não vamos
   * ligar globalmente pra não afetar outras tabelas do repo).
   * Retorna quantos posts foram removidos.
   */
  static deleteAllForCompetitor(competitorId: string): number {
    if (!competitorId) return 0;
    const info = db.prepare("DELETE FROM competitor_posts WHERE competitor_id = ?").run(competitorId);
    return info.changes;
  }
}
