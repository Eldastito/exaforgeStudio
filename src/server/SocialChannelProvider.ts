/**
 * SocialChannelProvider (PRD 10 / ADR-167 F1, §5/§7, D2, RN-SI-06) — abstração
 * provider-agnóstica de CANAL SOCIAL (Instagram, Facebook, TikTok, LinkedIn,
 * YouTube, X, Meta Ads, Google Ads…). A camada de Canais e IA / Estúdio pede uma
 * CAPACIDADE ("ler analytics", "publicar", "agendar"); o provider concreto é
 * resolvido por registry + env — trocar/ligar um canal amanhã não toca o domínio.
 *
 * Espelha DELIBERADAMENTE o `ReputationProvider` (ADR-162): contrato + `capabilities`
 * declaradas + `StubSocialChannelProvider` DETERMINÍSTICO (sem rede) pra rodar offline
 * em CI. Providers reais (Instagram etc.) entram da F3 em diante, e só ligam depois de
 * confirmar as capacidades da conta — CAPABILITY É DESCOBERTA, NÃO PRESUMIDA (RN-SI-06):
 * capacidade ausente DEGRADA EXPLICITAMENTE (`manual_required`/`capability_unavailable`),
 * NUNCA simula o que a API não oferece (§7 fim).
 *
 * REGRA (D1/D4/§42): o provider é APENAS TRANSPORTE. NÃO decide política, aprovação,
 * autonomia, oportunidade nem impacto — isso pertence aos engines canônicos
 * (`ApprovalPolicyService`/`CommandExecutorService`/`DecisionEngine`/…). Por isso este
 * arquivo NÃO importa db/serviço nenhum. Publicação idempotente (RN-SI-08): a mesma
 * publicação nunca sai 2× (idempotencyKey). Segredos/tokens NUNCA aqui (RN-SI-05); a
 * conexão/credencial é responsabilidade do Connection Hub (F2, server-side, criptografado).
 */

// ── Estados de conexão observáveis (§5). Token vencido NUNCA aparece como "conectado". ──
export type SocialConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "permission_limited"   // conectado, mas sem todas as permissões pedidas
  | "token_expiring"       // token perto de expirar (renovar)
  | "auth_expired"         // token vencido → precisa reautenticar
  | "rate_limited"         // limite de API atingido
  | "degraded"             // funcionando parcialmente
  | "unavailable";         // provider/rede fora

/** Capacidades FINAS que um provider PODE oferecer (a conta/plano pode não ter todas). */
export type SocialChannelCapability =
  | "getProfile"
  | "getPosts"
  | "getPostAnalytics"
  | "getAudienceAnalytics"
  | "publish"
  | "schedule"
  | "getAds"
  | "getAdAnalytics"
  | "competitorData";      // ler dado PÚBLICO de concorrente (F5) — só fonte legal (RN-SI-11)

/** Flags GROSSAS (§7) derivadas das capacidades finas — o que a UI/IA/entitlement consulta. */
export interface SocialChannelCapabilityFlags {
  analytics: boolean;
  publish: boolean;
  schedule: boolean;
  ads: boolean;
  competitorData: boolean;
}

/** Deriva as flags grossas (§7) da lista de capacidades finas. Pura/determinística. */
export function deriveCapabilityFlags(caps: SocialChannelCapability[]): SocialChannelCapabilityFlags {
  const has = (c: SocialChannelCapability) => caps.includes(c);
  return {
    analytics: has("getPostAnalytics") || has("getAudienceAnalytics"),
    publish: has("publish"),
    schedule: has("schedule"),
    ads: has("getAds") || has("getAdAnalytics"),
    competitorData: has("competitorData"),
  };
}

// ── Tipos de dados do canal ─────────────────────────────────────────────────────
export interface SocialProfile {
  handle: string;
  displayName?: string | null;
  followers?: number | null;
  url?: string | null;
  raw?: any;
}

export type SocialPostKind = "image" | "video" | "carousel" | "story" | "reel" | "text";

export interface SocialPost {
  externalId: string;
  kind: SocialPostKind;
  caption?: string | null;
  mediaUrl?: string | null;
  permalink?: string | null;
  publishedAt?: string | null;   // ISO
  raw?: any;
}

/** Analytics por-post — métricas NULL quando o provedor não fornece (RN-SI-12/13, não inventa). */
export interface SocialPostAnalytics {
  postExternalId: string;
  impressions?: number | null;
  reach?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  retrievedAt?: string | null;   // ISO — só quando de fato recuperado
}

export interface SocialAudienceAnalytics {
  followers?: number | null;
  growth?: number | null;
  demographics?: any | null;
  retrievedAt?: string | null;
}

/** Leitura incremental de posts (cursor/since; nunca varre o histórico inteiro). */
export interface SocialPostsQuery { since?: string | null; cursor?: string | null; limit?: number; }
export interface SocialPostsResult { available: boolean; posts: SocialPost[]; nextCursor?: string | null; reason?: string; }

/** Resultado de leitura opcional (analytics/ads): honesto quando a capacidade falta. */
export interface SocialReadResult<T> { available: boolean; data: T | null; reason?: string; }

/** Publicação/agendamento — idempotente (RN-SI-08); degrada explícito sem a capacidade (RN-SI-06). */
export interface SocialPublishInput {
  kind: SocialPostKind;
  caption?: string | null;
  mediaRef?: string | null;      // referência ao ativo (ArtifactService) — não o binário
  idempotencyKey: string;        // a MESMA publicação nunca sai 2×
}
export interface SocialScheduleInput extends SocialPublishInput { scheduledAt: string; } // ISO

export interface SocialPublishResult {
  status:
    | "published"                // publicado de verdade
    | "scheduled"                // agendado de verdade
    | "manual_required"          // provider sem capacidade → publicação manual (§6/RN-SI-06)
    | "duplicate"                // idempotencyKey já usado — no-op seguro (RN-SI-08)
    | "capability_unavailable"   // a conta/plano não tem essa capacidade
    | "unavailable";             // provider/rede fora — preservar e tentar depois
  externalId?: string | null;
  detail?: string;
}

export interface SocialAd { externalId: string; name?: string | null; status?: string | null; raw?: any; }
export interface SocialAdAnalytics { adExternalId: string; spendCents?: number | null; impressions?: number | null; clicks?: number | null; retrievedAt?: string | null; }

export interface SocialConnectionInput { orgId?: string | null; scopes?: string[]; }
export interface SocialConnectionResult { state: SocialConnectionState; detail?: string; }

/** Saúde observável da conexão (§5/§34). Token vencido → auth_expired, nunca "connected". */
export interface SocialChannelHealth {
  state: SocialConnectionState;
  detail?: string;
  permissions?: string[];
  lastSyncedAt?: string | null;
  retrievedAt?: string | null;
}

/**
 * Contrato provider-agnóstico (§7). Métodos podem ser sync ou async (o stub é sync;
 * conectores reais são async). O provider DECLARA `capabilities` — o domínio consulta
 * ANTES de agir e degrada explicitamente quando falta (RN-SI-06). NUNCA simula.
 */
export interface SocialChannelProvider {
  name: string;
  capabilities: SocialChannelCapability[];
  connect(input: SocialConnectionInput): Promise<SocialConnectionResult> | SocialConnectionResult;
  disconnect(): Promise<void> | void;
  health(): Promise<SocialChannelHealth> | SocialChannelHealth;
  getProfile(): Promise<SocialReadResult<SocialProfile>> | SocialReadResult<SocialProfile>;
  getPosts(q: SocialPostsQuery): Promise<SocialPostsResult> | SocialPostsResult;
  getPostAnalytics(postExternalId: string): Promise<SocialReadResult<SocialPostAnalytics>> | SocialReadResult<SocialPostAnalytics>;
  getAudienceAnalytics(): Promise<SocialReadResult<SocialAudienceAnalytics>> | SocialReadResult<SocialAudienceAnalytics>;
  publish(input: SocialPublishInput): Promise<SocialPublishResult> | SocialPublishResult;
  schedule(input: SocialScheduleInput): Promise<SocialPublishResult> | SocialPublishResult;
  getAds(): Promise<SocialReadResult<SocialAd[]>> | SocialReadResult<SocialAd[]>;
  getAdAnalytics(adExternalId: string): Promise<SocialReadResult<SocialAdAnalytics>> | SocialReadResult<SocialAdAnalytics>;
}

/** Consulta simples: o provider suporta a capacidade? (o domínio checa antes de agir). */
export function supportsCapability(p: SocialChannelProvider, cap: SocialChannelCapability): boolean {
  return p.capabilities.includes(cap);
}

// ── Dataset determinístico do stub (sem Date.now/random) — exercita o contrato em CI. ──
const STUB_POSTS: SocialPost[] = [
  { externalId: "SP-1", kind: "image", caption: "Coleção nova de linho ☀️", mediaUrl: "stub://social/SP-1.jpg", permalink: "stub://social/p/SP-1", publishedAt: "2026-08-05T12:00:00Z" },
  { externalId: "SP-2", kind: "reel", caption: "Bastidores do ateliê", mediaUrl: "stub://social/SP-2.mp4", permalink: "stub://social/p/SP-2", publishedAt: "2026-08-07T18:30:00Z" },
];
const STUB_POST_ANALYTICS: Record<string, SocialPostAnalytics> = {
  "SP-1": { postExternalId: "SP-1", impressions: 1200, reach: 900, likes: 84, comments: 6, shares: 3, saves: 12, clicks: 21, retrievedAt: "2026-08-08T09:00:00Z" },
  // SP-2: métricas parcialmente indisponíveis → NULL honesto (RN-SI-12), não zero.
  "SP-2": { postExternalId: "SP-2", impressions: 640, reach: 500, likes: 41, comments: null, shares: null, saves: null, clicks: null, retrievedAt: "2026-08-08T09:00:00Z" },
};

/**
 * StubSocialChannelProvider — provider DETERMINÍSTICO em memória (sem rede, sem tenant,
 * sem token). Exercita descoberta de capability, leitura, publicação idempotente e a
 * DEGRADAÇÃO explícita (RN-SI-06). As `opts` simulam contas com capacidades diferentes
 * (uma conta pode ler mas não publicar; outra pode publicar mas não tem ads) — o stub
 * NUNCA finge uma capacidade que não declarou.
 */
export class StubSocialChannelProvider implements SocialChannelProvider {
  name = "stub";
  private state: SocialConnectionState = "not_connected";
  private published = new Set<string>(); // idempotencyKey já usados (RN-SI-08, in-memory)
  private opts: { canPublish: boolean; canSchedule: boolean; canAnalytics: boolean; canAds: boolean; canCompetitor: boolean };

  constructor(opts: Partial<{ canPublish: boolean; canSchedule: boolean; canAnalytics: boolean; canAds: boolean; canCompetitor: boolean }> = {}) {
    this.opts = {
      canPublish: opts.canPublish !== false,
      canSchedule: opts.canSchedule !== false,
      canAnalytics: opts.canAnalytics !== false,
      canAds: opts.canAds === true,          // ads DEFERIDO por default (§4/DEFERIR)
      canCompetitor: opts.canCompetitor === true,
    };
  }

  get capabilities(): SocialChannelCapability[] {
    const caps: SocialChannelCapability[] = ["getProfile", "getPosts"];
    if (this.opts.canAnalytics) caps.push("getPostAnalytics", "getAudienceAnalytics");
    if (this.opts.canPublish) caps.push("publish");
    if (this.opts.canSchedule) caps.push("schedule");
    if (this.opts.canAds) caps.push("getAds", "getAdAnalytics");
    if (this.opts.canCompetitor) caps.push("competitorData");
    return caps;
  }

  connect(input: SocialConnectionInput): SocialConnectionResult {
    // Sem OAuth aqui (F2): o stub só transiciona o estado observável.
    const missing = (input.scopes || []).length > 0 && !this.opts.canPublish;
    this.state = missing ? "permission_limited" : "connected";
    return { state: this.state, detail: missing ? "escopos pedidos além das permissões do stub" : undefined };
  }
  disconnect(): void { this.state = "not_connected"; }
  health(): SocialChannelHealth {
    return { state: this.state, permissions: this.capabilities.map(String), lastSyncedAt: "2026-08-08T09:00:00Z", retrievedAt: "2026-08-08T09:05:00Z" };
  }

  getProfile(): SocialReadResult<SocialProfile> {
    return { available: true, data: { handle: "@stub.brand", displayName: "Stub Brand", followers: 3200, url: "stub://social/@stub.brand" } };
  }

  getPosts(q: SocialPostsQuery): SocialPostsResult {
    const since = q.since || "";
    const ordered = [...STUB_POSTS]
      .filter((p) => (p.publishedAt || "") > since)
      .sort((a, b) => (a.publishedAt || "").localeCompare(b.publishedAt || ""));
    const start = q.cursor ? Math.max(0, parseInt(q.cursor, 10) || 0) : 0;
    const limit = q.limit && q.limit > 0 ? q.limit : 50;
    const page = ordered.slice(start, start + limit);
    const end = start + page.length;
    return { available: true, posts: page, nextCursor: end < ordered.length ? String(end) : null };
  }

  getPostAnalytics(postExternalId: string): SocialReadResult<SocialPostAnalytics> {
    if (!this.opts.canAnalytics) return { available: false, data: null, reason: "capability_unavailable" };
    return { available: true, data: STUB_POST_ANALYTICS[postExternalId] || { postExternalId, retrievedAt: null } };
  }
  getAudienceAnalytics(): SocialReadResult<SocialAudienceAnalytics> {
    if (!this.opts.canAnalytics) return { available: false, data: null, reason: "capability_unavailable" };
    return { available: true, data: { followers: 3200, growth: 45, demographics: null, retrievedAt: "2026-08-08T09:00:00Z" } };
  }

  publish(input: SocialPublishInput): SocialPublishResult {
    if (!this.opts.canPublish) return { status: "manual_required", detail: "provider sem capacidade de publicar — publicação manual necessária (RN-SI-06)" };
    if (this.published.has(input.idempotencyKey)) return { status: "duplicate", detail: "idempotencyKey já usado (RN-SI-08)" };
    this.published.add(input.idempotencyKey);
    return { status: "published", externalId: `stub-post:${input.idempotencyKey}` };
  }
  schedule(input: SocialScheduleInput): SocialPublishResult {
    if (!this.opts.canSchedule) return { status: "manual_required", detail: "provider sem capacidade de agendar (RN-SI-06)" };
    if (this.published.has(input.idempotencyKey)) return { status: "duplicate", detail: "idempotencyKey já usado (RN-SI-08)" };
    this.published.add(input.idempotencyKey);
    return { status: "scheduled", externalId: `stub-scheduled:${input.idempotencyKey}` };
  }

  getAds(): SocialReadResult<SocialAd[]> {
    if (!this.opts.canAds) return { available: false, data: null, reason: "capability_unavailable" };
    return { available: true, data: [] };
  }
  getAdAnalytics(adExternalId: string): SocialReadResult<SocialAdAnalytics> {
    if (!this.opts.canAds) return { available: false, data: null, reason: "capability_unavailable" };
    return { available: true, data: { adExternalId, spendCents: null, impressions: null, clicks: null, retrievedAt: null } };
  }
}

// Registry de CANAL (sem org): F1 só tem o stub; providers reais entram da F3 em diante.
const REGISTRY: Record<string, SocialChannelProvider> = {
  stub: new StubSocialChannelProvider(),
};

/** Resolve o provider por nome → env `SOCIAL_CHANNEL_PROVIDER` → 'stub' (default seguro). */
export function getSocialChannelProvider(name?: string): SocialChannelProvider {
  const key = name || process.env.SOCIAL_CHANNEL_PROVIDER || "stub";
  return REGISTRY[key] || REGISTRY.stub;
}

export default getSocialChannelProvider;
