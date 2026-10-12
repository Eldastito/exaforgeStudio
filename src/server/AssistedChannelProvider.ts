/**
 * AssistedChannelProvider (ADR-207 F13c) — TikTok, LinkedIn, YouTube e X SEM API conectada.
 *
 * Publicar nesses canais por API exige app aprovado pela plataforma, OAuth e (no TikTok/YouTube) auditoria do app — coisa de
 * terceiro. Até lá o canal opera em modo ASSISTIDO: o provider declara ZERO capacidades (RN-SI-06 — capacidade é descoberta,
 * não presumida), `publish`/`schedule` degradam para `manual_required` e a leitura de perfil/posts/analytics diz
 * `capability_unavailable` (RN-SI-12: métrica ausente ≠ zero). NUNCA finge publicar. O conteúdo pronto pra colar vem do
 * `PublishPackageService` (mesmo Estúdio, sem 2º fluxo — §37). Sem db/rede/segredo (RN-SI-05).
 */
import {
  SocialChannelProvider, SocialChannelCapability, SocialChannelHealth, SocialConnectionInput, SocialConnectionResult,
  SocialProfile, SocialPostsQuery, SocialPostsResult, SocialPostAnalytics, SocialAudienceAnalytics, SocialReadResult,
  SocialPublishInput, SocialScheduleInput, SocialPublishResult, SocialAd, SocialAdAnalytics,
} from "./SocialChannelProvider.js";

export const ASSISTED_CHANNELS = ["tiktok", "linkedin", "youtube", "x"] as const;
export type AssistedChannel = typeof ASSISTED_CHANNELS[number];

export function isAssistedChannel(c: string): c is AssistedChannel {
  return (ASSISTED_CHANNELS as readonly string[]).includes(c);
}

export class AssistedChannelProvider implements SocialChannelProvider {
  name: string;
  capabilities: SocialChannelCapability[] = [];

  constructor(public channel: AssistedChannel) { this.name = `assisted:${channel}`; }

  connect(_input: SocialConnectionInput): SocialConnectionResult {
    return { state: "not_connected", detail: "Publicação assistida: este canal ainda não tem API conectada — o conteúdo é preparado para você publicar." };
  }
  disconnect(): void { /* nada a desconectar */ }
  health(): SocialChannelHealth {
    return { state: "not_connected", detail: "publicação assistida (sem API conectada)", permissions: [] };
  }

  getProfile(): SocialReadResult<SocialProfile> { return { available: false, data: null, reason: "capability_unavailable" }; }
  getPosts(_q: SocialPostsQuery): SocialPostsResult { return { available: false, posts: [], reason: "capability_unavailable" }; }
  getPostAnalytics(_id: string): SocialReadResult<SocialPostAnalytics> { return { available: false, data: null, reason: "capability_unavailable" }; }
  getAudienceAnalytics(): SocialReadResult<SocialAudienceAnalytics> { return { available: false, data: null, reason: "capability_unavailable" }; }
  publish(_input: SocialPublishInput): SocialPublishResult {
    return { status: "manual_required", detail: `${this.channel}: sem API conectada — publique manualmente com o pacote preparado (RN-SI-06)` };
  }
  schedule(_input: SocialScheduleInput): SocialPublishResult {
    return { status: "manual_required", detail: `${this.channel}: sem API conectada — agende manualmente na plataforma (RN-SI-06)` };
  }
  getAds(): SocialReadResult<SocialAd[]> { return { available: false, data: null, reason: "capability_unavailable" }; }
  getAdAnalytics(_id: string): SocialReadResult<SocialAdAnalytics> { return { available: false, data: null, reason: "capability_unavailable" }; }
}

export default AssistedChannelProvider;
