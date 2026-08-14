import db from "./db.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * FacebookService (PRD 11 / ADR-168 F14) — plumbing MÍNIMO da Graph API de PÁGINA do Facebook,
 * espelhando o `InstagramService` (mesma família Meta/Graph). Lê a credencial do `channels`
 * (provider `facebook`, fluxo OAuth existente) — SEM 2ª tela de credenciais (§37, RN-SI-05).
 *
 * Todas as chamadas de rede são try/catch → null/[] (honesto): sem conexão ou falha de escopo,
 * o provider degrada explícito (nunca finge). Publica no feed da Página (`/{pageId}/feed` p/
 * texto/link, `/{pageId}/photos` p/ imagem).
 */
export class FacebookService {
  static getChannel(orgId: string): { token: string; pageId: string; name: string } | null {
    const ch = db.prepare(
      "SELECT identifier, name, token_encrypted FROM channels WHERE provider = 'facebook' AND organization_id = ? AND status != 'disabled'"
    ).get(orgId) as any;
    if (!ch || !ch.token_encrypted) return null;
    const name = (ch.name || "").replace(/^Facebook\s*/i, "").trim();
    return { token: ch.token_encrypted, pageId: ch.identifier, name };
  }

  static isConnected(orgId: string): boolean {
    return !!this.getChannel(orgId);
  }

  /** Posts recentes da Página (feed). Falha/escopo ausente → [] (honesto). */
  static async fetchFeed(orgId: string, limit = 24): Promise<any[]> {
    const ch = this.getChannel(orgId);
    if (!ch) return [];
    try {
      const fields = "id,message,permalink_url,created_time,full_picture,attachments{media_type}";
      const url = `${GRAPH}/${encodeURIComponent(ch.pageId)}/feed?fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${encodeURIComponent(ch.token)}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const j: any = await res.json();
      return Array.isArray(j?.data) ? j.data : [];
    } catch { return []; }
  }

  /** Insights de UM post. Escopo ausente/falha → null (nunca inventa). */
  static async fetchPostInsights(orgId: string, postId: string): Promise<any | null> {
    const ch = this.getChannel(orgId);
    if (!ch) return null;
    try {
      const metric = "post_impressions,post_impressions_unique,post_reactions_by_type_total,post_clicks";
      const url = `${GRAPH}/${encodeURIComponent(postId)}/insights?metric=${encodeURIComponent(metric)}&access_token=${encodeURIComponent(ch.token)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      if (!Array.isArray(j?.data) || !j.data.length) return null;
      const pick = (name: string) => { const m = j.data.find((x: any) => x.name === name); const v = m?.values?.[0]?.value; return typeof v === "number" ? v : null; };
      return {
        impressions: pick("post_impressions"),
        reach: pick("post_impressions_unique"),
        clicks: pick("post_clicks"),
        raw: j.data,
      };
    } catch { return null; }
  }

  /** Insights da Página (audiência). Escopo ausente/falha → null. */
  static async fetchPageInsights(orgId: string): Promise<any | null> {
    const ch = this.getChannel(orgId);
    if (!ch) return null;
    try {
      const url = `${GRAPH}/${encodeURIComponent(ch.pageId)}/insights?metric=page_impressions,page_post_engagements&period=days_28&access_token=${encodeURIComponent(ch.token)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      return Array.isArray(j?.data) && j.data.length ? j.data : null;
    } catch { return null; }
  }

  /** Publica no feed da Página. Com mídia → /photos; sem mídia → /feed (mensagem). */
  static async publish(orgId: string, mediaUrl: string | null, caption: string): Promise<{ postId: string }> {
    const ch = this.getChannel(orgId);
    if (!ch) throw new Error("Facebook não conectado.");
    const isPhoto = !!mediaUrl;
    const path = isPhoto ? `${encodeURIComponent(ch.pageId)}/photos` : `${encodeURIComponent(ch.pageId)}/feed`;
    const params: Record<string, string> = { access_token: ch.token };
    if (isPhoto) { params.url = mediaUrl as string; if (caption) params.caption = caption; }
    else { params.message = caption || ""; }
    const res = await fetch(`${GRAPH}/${path}`, { method: "POST", body: new URLSearchParams(params) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message || `Falha ao publicar no Facebook (HTTP ${res.status}).`);
    const postId = j?.post_id || j?.id;
    if (!postId) throw new Error("Facebook não retornou id do post.");
    return { postId: String(postId) };
  }
}

export default FacebookService;
