/**
 * FacebookChannelProvider (PRD 11 / ADR-168 F14) — SEGUNDO provider REAL do
 * `SocialChannelProvider`, espelhando `InstagramChannelProvider` (§37 — mesmo contrato/registry,
 * sem 2º Estúdio/credencial). Envolve o `FacebookService` (Graph API de Página); NÃO duplica
 * OAuth: a credencial vem do `channels` (provider `facebook`), lida via `FacebookService`
 * (RN-SI-05, sem 2ª tela).
 *
 * CAPABILITY DESCOBERTA, não presumida (RN-SI-06): sem conexão → capacidades vazias e
 * `not_connected` (determinístico, só lê o DB — roda em CI). Conectado → base
 * (getProfile/getPosts/publish) + analytics SOMENTE após probe de insights responder.
 * Degrada explícito (`manual_required`/`capability_unavailable`) — nunca finge (§7). Publish
 * idempotente in-memory (RN-SI-08; a durável cross-processo é do publicador governado F11).
 * Agendamento nativo não usado (o Scheduler do app publica na hora) → `manual_required`. Ads
 * DEFERIDO (§4).
 */
import { FacebookService } from "./FacebookService.js";
import {
  SocialChannelProvider,
  SocialChannelCapability,
  SocialChannelHealth,
  SocialConnectionInput,
  SocialConnectionResult,
  SocialConnectionState,
  SocialProfile,
  SocialPost,
  SocialPostsQuery,
  SocialPostsResult,
  SocialPostAnalytics,
  SocialAudienceAnalytics,
  SocialReadResult,
  SocialPublishInput,
  SocialScheduleInput,
  SocialPublishResult,
  SocialAd,
  SocialAdAnalytics,
} from "./SocialChannelProvider.js";

export class FacebookChannelProvider implements SocialChannelProvider {
  name = "facebook";
  private orgId: string;
  private state: SocialConnectionState = "not_connected";
  private analyticsAvailable = false;
  private probed = false;
  private published = new Set<string>();

  constructor(orgId: string) { this.orgId = orgId; }

  get capabilities(): SocialChannelCapability[] {
    if (!FacebookService.isConnected(this.orgId)) return [];
    const caps: SocialChannelCapability[] = ["getProfile", "getPosts", "publish"];
    if (this.probed && this.analyticsAvailable) caps.push("getAudienceAnalytics", "getPostAnalytics");
    return caps;
  }

  async connect(input: SocialConnectionInput): Promise<SocialConnectionResult> {
    if (!FacebookService.isConnected(this.orgId)) {
      this.state = "not_connected";
      return { state: this.state, detail: "Facebook não conectado (sem canal OAuth)." };
    }
    try { this.analyticsAvailable = !!(await FacebookService.fetchPageInsights(this.orgId)); } catch { this.analyticsAvailable = false; }
    this.probed = true;
    const wantsAnalytics = (input.scopes || []).some((s) => /insight|analytic|audience/i.test(s));
    if (wantsAnalytics && !this.analyticsAvailable) {
      this.state = "permission_limited";
      return { state: this.state, detail: "Insights da Página não liberados (escopo/App Review)." };
    }
    this.state = "connected";
    return { state: this.state };
  }

  disconnect(): void {
    this.state = "not_connected";
    this.probed = false;
    this.analyticsAvailable = false;
  }

  async health(): Promise<SocialChannelHealth> {
    const ch = FacebookService.getChannel(this.orgId);
    if (!ch) return { state: "not_connected", detail: "Facebook não conectado." };
    if (!this.probed) { try { this.analyticsAvailable = !!(await FacebookService.fetchPageInsights(this.orgId)); this.probed = true; } catch { /* best-effort */ } }
    const state: SocialConnectionState = this.state === "not_connected" ? "connected" : this.state;
    return { state, detail: ch.name || undefined, permissions: this.capabilities.map(String), lastSyncedAt: null };
  }

  async getProfile(): Promise<SocialReadResult<SocialProfile>> {
    const ch = FacebookService.getChannel(this.orgId);
    if (!ch) return { available: false, data: null, reason: "not_connected" };
    // Identidade conhecida do canal OAuth — sem rede/LLM. Seguidores exigem insights → null (RN-SI-12).
    const data: SocialProfile = {
      handle: ch.name || ch.pageId,
      displayName: ch.name || null,
      followers: null,
      url: `https://facebook.com/${ch.pageId}`,
      raw: undefined,
    };
    return { available: true, data };
  }

  async getPosts(q: SocialPostsQuery): Promise<SocialPostsResult> {
    if (!FacebookService.isConnected(this.orgId)) return { available: false, posts: [], reason: "not_connected" };
    try {
      const limit = q.limit && q.limit > 0 ? q.limit : 24;
      const feed = await FacebookService.fetchFeed(this.orgId, limit);
      const since = q.since || "";
      const posts: SocialPost[] = (feed || [])
        .filter((m: any) => !since || String(m.created_time || "") > since)
        .map((m: any) => ({
          externalId: String(m.id),
          kind: m.attachments?.data?.[0]?.media_type === "video" ? "video" : m.full_picture ? "image" : "text",
          caption: m.message ?? null,
          mediaUrl: m.full_picture ?? null,
          permalink: m.permalink_url ?? null,
          publishedAt: m.created_time ?? null,
          raw: undefined,
        }));
      return { available: true, posts };
    } catch (e: any) {
      return { available: false, posts: [], reason: String(e?.message || e) };
    }
  }

  async getPostAnalytics(postExternalId: string): Promise<SocialReadResult<SocialPostAnalytics>> {
    if (!FacebookService.isConnected(this.orgId)) return { available: false, data: null, reason: "not_connected" };
    try {
      const ins = await FacebookService.fetchPostInsights(this.orgId, postExternalId);
      if (!ins) return { available: false, data: null, reason: "capability_unavailable" };
      const data: SocialPostAnalytics = {
        postExternalId,
        impressions: ins.impressions ?? null,
        reach: ins.reach ?? null,
        likes: null, comments: null, shares: null, saves: null,  // FB post insights não expõem por-tipo aqui → null honesto
        clicks: ins.clicks ?? null,
        retrievedAt: null,
      };
      return { available: true, data };
    } catch (e: any) {
      return { available: false, data: null, reason: String(e?.message || e) };
    }
  }

  async getAudienceAnalytics(): Promise<SocialReadResult<SocialAudienceAnalytics>> {
    if (!FacebookService.isConnected(this.orgId)) return { available: false, data: null, reason: "not_connected" };
    try {
      const ins = await FacebookService.fetchPageInsights(this.orgId);
      if (!ins) return { available: false, data: null, reason: "capability_unavailable" };
      return { available: true, data: { followers: null, growth: null, demographics: ins, retrievedAt: null } };
    } catch (e: any) {
      return { available: false, data: null, reason: String(e?.message || e) };
    }
  }

  async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
    if (!FacebookService.isConnected(this.orgId)) return { status: "manual_required", detail: "Facebook não conectado — publicação manual (RN-SI-06)." };
    if (this.published.has(input.idempotencyKey)) return { status: "duplicate", detail: "idempotencyKey já usado neste provider (RN-SI-08)." };
    try {
      const out = await FacebookService.publish(this.orgId, input.mediaRef || null, input.caption || "");
      this.published.add(input.idempotencyKey);
      return { status: "published", externalId: out.postId };
    } catch (e: any) {
      return { status: "unavailable", detail: String(e?.message || e) };
    }
  }

  async schedule(input: SocialScheduleInput): Promise<SocialPublishResult> {
    return { status: "manual_required", detail: "agendamento nativo indisponível — o Scheduler do app publica na hora (RN-SI-06)." };
  }

  async getAds(): Promise<SocialReadResult<SocialAd[]>> {
    return { available: false, data: null, reason: "capability_unavailable" };  // Ads DEFERIDO (§4)
  }
  async getAdAnalytics(adExternalId: string): Promise<SocialReadResult<SocialAdAnalytics>> {
    return { available: false, data: null, reason: "capability_unavailable" };  // Ads DEFERIDO (§4)
  }
}

export default FacebookChannelProvider;
