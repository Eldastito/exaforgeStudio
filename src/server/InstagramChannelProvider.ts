/**
 * InstagramChannelProvider (PRD 10 / ADR-167 F3) — PRIMEIRO provider REAL do
 * `SocialChannelProvider` (F1). Vertical slice ponta-a-ponta: conectar → DESCOBRIR
 * capacidades da conta → ler perfil/posts/insights → publicar. Transporte APENAS
 * (D1/D4): NÃO decide política/aprovação/autonomia/oportunidade — isso é dos engines
 * canônicos. Envolve o `InstagramService` já provado em produção (Graph API), então
 * NÃO duplica OAuth nem armazenamento de token: a credencial continua no `channels`
 * (fluxo OAuth existente), lida via `InstagramService.getChannel` — SEM 2ª tela de
 * credenciais (§42, RN-SI-05).
 *
 * CAPABILITY É DESCOBERTA, NÃO PRESUMIDA (RN-SI-06): sem conexão → capacidades vazias
 * e estado `not_connected` (determinístico, só lê o DB — roda em CI). Conectado → base
 * (perfil/posts/publish) + `getAudienceAnalytics` SOMENTE se o escopo de insights de
 * fato responder (probe em `connect`/`health`); se a Meta não liberou insights, a
 * capacidade fica FORA e a leitura degrada explícito (`capability_unavailable`), nunca
 * finge (§7). `getPostAnalytics` fica pra F4 (Social Analytics Ingestion). Agendamento
 * NÃO é nativo deste caminho (o Scheduler do app cuida do horário e chama `publish`) →
 * `schedule` degrada `manual_required` (honesto). Publicação idempotente in-memory
 * (RN-SI-08, mesmo idempotencyKey no ciclo de vida do provider); a idempotência DURÁVEL
 * cross-processo é do publicador governado (F11 — CommandExecutor + Confirmation).
 */
import { InstagramService } from "./InstagramService.js";
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

export class InstagramChannelProvider implements SocialChannelProvider {
  name = "instagram";
  private orgId: string;
  private state: SocialConnectionState = "not_connected";
  private analyticsAvailable = false;      // descoberto (RN-SI-06) — só true se insights respondem
  private probed = false;
  private published = new Set<string>();    // idempotencyKey usados neste ciclo de vida (RN-SI-08)

  constructor(orgId: string) { this.orgId = orgId; }

  /** Capacidades DESCOBERTAS (nunca presumidas). Vazio quando desconectado. */
  get capabilities(): SocialChannelCapability[] {
    if (!InstagramService.isConnected(this.orgId)) return [];
    const caps: SocialChannelCapability[] = ["getProfile", "getPosts", "publish"];
    // getAudienceAnalytics só entra depois que um probe confirmou o escopo de insights.
    if (this.probed && this.analyticsAvailable) caps.push("getAudienceAnalytics");
    return caps;
  }

  /**
   * Conecta e DESCOBRE capacidades. Sem canal no DB → not_connected (determinístico,
   * sem rede). Conectado → probe de insights (RN-SI-06); se pediram escopos que a conta
   * não tem (analytics sem insights), reporta permission_limited — token nunca finge.
   */
  async connect(input: SocialConnectionInput): Promise<SocialConnectionResult> {
    if (!InstagramService.isConnected(this.orgId)) {
      this.state = "not_connected";
      return { state: this.state, detail: "Instagram não conectado (sem canal OAuth)." };
    }
    // Probe honesto do escopo de insights (App Review) — best-effort, não derruba a conexão.
    try {
      const ins = await InstagramService.fetchAccountInsights(this.orgId);
      this.analyticsAvailable = !!ins;
    } catch { this.analyticsAvailable = false; }
    this.probed = true;
    const wantsAnalytics = (input.scopes || []).some((s) => /insight|analytic|audience/i.test(s));
    if (wantsAnalytics && !this.analyticsAvailable) {
      this.state = "permission_limited";
      return { state: this.state, detail: "Insights não liberados pela Meta (App Review pendente)." };
    }
    this.state = "connected";
    return { state: this.state };
  }

  disconnect(): void {
    // A desconexão real da credencial é do fluxo OAuth (channels); aqui só zera o estado local.
    this.state = "not_connected";
    this.probed = false;
    this.analyticsAvailable = false;
  }

  async health(): Promise<SocialChannelHealth> {
    const ch = InstagramService.getChannel(this.orgId);
    if (!ch) return { state: "not_connected", detail: "Instagram não conectado." };
    // Reflete o último probe; se ainda não probou, faz um leve agora (best-effort).
    if (!this.probed) { try { this.analyticsAvailable = !!(await InstagramService.fetchAccountInsights(this.orgId)); this.probed = true; } catch { /* best-effort */ } }
    const state: SocialConnectionState = this.state === "not_connected" ? "connected" : this.state;
    return { state, detail: ch.username ? `@${ch.username}` : undefined, permissions: this.capabilities.map(String), lastSyncedAt: null };
  }

  async getProfile(): Promise<SocialReadResult<SocialProfile>> {
    const ch = InstagramService.getChannel(this.orgId);
    if (!ch) return { available: false, data: null, reason: "not_connected" };
    // Identidade que conhecemos de forma confiável pelo canal OAuth — sem LLM, sem
    // presumir métrica. Seguidores exigem escopo business/insights → null honesto (RN-SI-12).
    const data: SocialProfile = {
      handle: ch.username ? `@${ch.username}` : ch.igId,
      displayName: ch.username || null,
      followers: null,
      url: ch.username ? `https://instagram.com/${ch.username}` : null,
      raw: undefined,
    };
    return { available: true, data };
  }

  async getPosts(q: SocialPostsQuery): Promise<SocialPostsResult> {
    if (!InstagramService.isConnected(this.orgId)) return { available: false, posts: [], reason: "not_connected" };
    try {
      const limit = q.limit && q.limit > 0 ? q.limit : 24;
      const start = q.cursor ? Math.max(0, parseInt(q.cursor, 10) || 0) : 0;
      const media = await InstagramService.fetchMedia(this.orgId, start + limit);
      const since = q.since || "";
      const mapped: SocialPost[] = (media || [])
        .filter((m: any) => !since || String(m.timestamp || "") > since)
        .map((m: any) => ({
          externalId: String(m.id),
          kind: m.media_type === "VIDEO" ? "video" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : "image",
          caption: m.caption ?? null,
          mediaUrl: m.media_url ?? m.thumbnail_url ?? null,
          permalink: m.permalink ?? null,
          publishedAt: m.timestamp ?? null,
          raw: undefined,
        }));
      const page = mapped.slice(start, start + limit);
      const end = start + page.length;
      return { available: true, posts: page, nextCursor: end < mapped.length ? String(end) : null };
    } catch (e: any) {
      return { available: false, posts: [], reason: String(e?.message || e) };
    }
  }

  /** Analytics por-post fica pra F4 (Social Analytics Ingestion) — degrada honesto. */
  async getPostAnalytics(postExternalId: string): Promise<SocialReadResult<SocialPostAnalytics>> {
    return { available: false, data: null, reason: "capability_unavailable" };
  }

  async getAudienceAnalytics(): Promise<SocialReadResult<SocialAudienceAnalytics>> {
    if (!InstagramService.isConnected(this.orgId)) return { available: false, data: null, reason: "not_connected" };
    try {
      const ins = await InstagramService.fetchAccountInsights(this.orgId);
      if (!ins) return { available: false, data: null, reason: "capability_unavailable" };
      return { available: true, data: { followers: null, growth: null, demographics: ins, retrievedAt: null } };
    } catch (e: any) {
      return { available: false, data: null, reason: String(e?.message || e) };
    }
  }

  async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
    if (!InstagramService.isConnected(this.orgId)) return { status: "manual_required", detail: "Instagram não conectado — publicação manual (RN-SI-06)." };
    if (this.published.has(input.idempotencyKey)) return { status: "duplicate", detail: "idempotencyKey já usado neste provider (RN-SI-08)." };
    if (!input.mediaRef) return { status: "manual_required", detail: "publicação sem mídia — Instagram exige imagem/vídeo." };
    try {
      const isVideo = input.kind === "video" || input.kind === "reel";
      const out = await InstagramService.publish(this.orgId, input.mediaRef, input.caption || "", isVideo);
      this.published.add(input.idempotencyKey);
      return { status: "published", externalId: out.mediaId };
    } catch (e: any) {
      // Efeito externo incerto/falho → preserva pra tentar depois (o governador F11 decide).
      return { status: "unavailable", detail: String(e?.message || e) };
    }
  }

  /** IG neste caminho não agenda nativamente; o Scheduler do app cuida do horário (F10). */
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

export default InstagramChannelProvider;
