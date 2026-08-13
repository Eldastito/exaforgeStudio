/**
 * SocialAnalyticsService (PRD 10 / ADR-167 F4 — Social Analytics Ingestion) — puxa os
 * POSTS PRÓPRIOS e suas métricas do provider de canal (via o Connection Hub F2) e
 * PERSISTE um snapshot por-org em `social_post_metrics`. É a leitura que abastece o
 * closed-loop de conteúdo (Outcome Assurance / Creative Learning nas fatias finais).
 *
 * Reúso (§42): NÃO cria 2º Scheduler/JobQueue — o passe roda no `Scheduler.tick`
 * (horário) existente. NÃO cria motor de analytics: só lê do `SocialChannelProvider`
 * (F1/F3) e grava. Idempotência (RN-SI-08): UNIQUE(org,channel,post_external_id) + upsert
 * — reingestão nunca duplica, só atualiza o snapshot. HONESTIDADE (RN-SI-12): métrica
 * ausente vira NULL, nunca 0; sem a capacidade de analytics o post é gravado só com o
 * que o feed dá (caption/permalink) e `analytics_available=0` — não inventa número.
 * Isolamento (convenção #1): `orgId` 1º arg; toda query filtra `organization_id`.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { SocialConnectionService } from "./SocialConnectionService.js";
import { supportsCapability, SocialPostAnalytics } from "./SocialChannelProvider.js";

export interface SocialAnalyticsSyncResult {
  channel: string;
  synced: number;          // posts vistos/gravados
  withAnalytics: number;   // quantos vieram com métricas de fato
  degraded?: boolean;      // provider sem leitura de posts → nada a fazer (honesto)
  reason?: string;
}

export class SocialAnalyticsService {
  private static num(v: number | null | undefined): number | null {
    return typeof v === "number" ? v : null;   // null≠0 (RN-SI-12) — nunca coage ausência a 0
  }

  /**
   * Passe de ingestão para UMA org/canal. Resolve o provider pelo Hub, lê os posts
   * (incremental, cursor) e — quando a capacidade existe — as métricas por post, e faz
   * upsert idempotente. Best-effort: erro de rede num post não derruba o lote.
   */
  static async sync(orgId: string, channel: string, opts: { limit?: number } = {}): Promise<SocialAnalyticsSyncResult> {
    const provider = SocialConnectionService.providerFor(orgId, channel);
    if (!supportsCapability(provider, "getPosts")) {
      return { channel, synced: 0, withAnalytics: 0, degraded: true, reason: "capability_unavailable" };
    }
    const postsRes = await provider.getPosts({ limit: opts.limit && opts.limit > 0 ? opts.limit : 24 });
    if (!postsRes.available) {
      return { channel, synced: 0, withAnalytics: 0, degraded: true, reason: postsRes.reason || "unavailable" };
    }
    const canAnalytics = supportsCapability(provider, "getPostAnalytics");
    let synced = 0, withAnalytics = 0;
    for (const post of postsRes.posts) {
      let a: SocialPostAnalytics | null = null;
      if (canAnalytics) {
        try {
          const r = await provider.getPostAnalytics(post.externalId);
          if (r.available && r.data) { a = r.data; withAnalytics++; }
        } catch { /* best-effort — analytics de um post não derruba o lote */ }
      }
      this.upsert(orgId, channel, post, a);
      synced++;
    }
    return { channel, synced, withAnalytics };
  }

  /** Upsert idempotente de um post + snapshot de métricas (NULL honesto). */
  private static upsert(orgId: string, channel: string, post: any, a: SocialPostAnalytics | null): void {
    const existing = db.prepare(
      `SELECT id FROM social_post_metrics WHERE organization_id = ? AND channel = ? AND post_external_id = ?`,
    ).get(orgId, channel, post.externalId) as any;
    const vals = {
      kind: post.kind || null,
      caption: post.caption ?? null,
      permalink: post.permalink ?? null,
      published_at: post.publishedAt ?? null,
      impressions: this.num(a?.impressions),
      reach: this.num(a?.reach),
      likes: this.num(a?.likes),
      comments: this.num(a?.comments),
      shares: this.num(a?.shares),
      saves: this.num(a?.saves),
      clicks: this.num(a?.clicks),
      analytics_available: a ? 1 : 0,
      fetched_at: a?.retrievedAt ?? null,
    };
    if (existing) {
      db.prepare(
        `UPDATE social_post_metrics SET kind=?, caption=?, permalink=?, published_at=?,
           impressions=?, reach=?, likes=?, comments=?, shares=?, saves=?, clicks=?,
           analytics_available=?, fetched_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).run(vals.kind, vals.caption, vals.permalink, vals.published_at, vals.impressions, vals.reach,
        vals.likes, vals.comments, vals.shares, vals.saves, vals.clicks, vals.analytics_available, vals.fetched_at, existing.id);
    } else {
      db.prepare(
        `INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, kind, caption,
           permalink, published_at, impressions, reach, likes, comments, shares, saves, clicks,
           analytics_available, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), orgId, channel, post.externalId, vals.kind, vals.caption, vals.permalink,
        vals.published_at, vals.impressions, vals.reach, vals.likes, vals.comments, vals.shares,
        vals.saves, vals.clicks, vals.analytics_available, vals.fetched_at);
    }
  }

  /** Posts persistidos (mais recentes primeiro). Leitura por-org. */
  static list(orgId: string, channel: string, opts: { limit?: number } = {}): any[] {
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
    return db.prepare(
      `SELECT post_external_id, kind, caption, permalink, published_at, impressions, reach, likes,
         comments, shares, saves, clicks, analytics_available, fetched_at
       FROM social_post_metrics WHERE organization_id = ? AND channel = ?
       ORDER BY COALESCE(published_at,'') DESC LIMIT ?`,
    ).all(orgId, channel, limit);
  }

  /**
   * Resumo agregado por-org/canal. Totais SOMAM só o que existe (COALESCE p/ soma), mas
   * `postsWithAnalytics` distingue quantos posts têm métrica — sem prova, o total fica
   * `null` (não 0). Determinístico, derivado por query (RN-004).
   */
  static summary(orgId: string, channel: string): {
    posts: number; postsWithAnalytics: number;
    totalImpressions: number | null; totalReach: number | null; totalLikes: number | null;
  } {
    const r = db.prepare(
      `SELECT COUNT(*) AS posts,
              SUM(CASE WHEN analytics_available=1 THEN 1 ELSE 0 END) AS withA,
              SUM(impressions) AS imp, SUM(reach) AS reach, SUM(likes) AS likes
       FROM social_post_metrics WHERE organization_id = ? AND channel = ?`,
    ).get(orgId, channel) as any;
    const withA = Number(r?.withA || 0);
    return {
      posts: Number(r?.posts || 0),
      postsWithAnalytics: withA,
      // Sem nenhum post com analytics, o total é DESCONHECIDO (null), não 0 (RN-SI-12).
      totalImpressions: withA > 0 ? Number(r?.imp || 0) : null,
      totalReach: withA > 0 ? Number(r?.reach || 0) : null,
      totalLikes: withA > 0 ? Number(r?.likes || 0) : null,
    };
  }

  /**
   * Passe do Scheduler (horário): ingere para toda conexão HABILITADA de provider REAL
   * (nunca stub). Best-effort por org — falha de uma não trava as outras. Opt-in por
   * `social_connections.enabled=1`. NÃO cria 2º Scheduler (§42) — chamado do `tick`.
   */
  static async pass(): Promise<void> {
    let conns: any[] = [];
    try {
      conns = db.prepare(
        `SELECT organization_id, channel FROM social_connections
         WHERE enabled = 1 AND provider IS NOT NULL AND provider != 'stub'`,
      ).all() as any[];
    } catch { return; }
    for (const c of conns) {
      try { await this.sync(c.organization_id, c.channel); }
      catch (e: any) { console.error(`[SocialAnalytics] sync falhou (org ${c.organization_id}, ${c.channel})`, e?.message || e); }
    }
  }
}

export default SocialAnalyticsService;
