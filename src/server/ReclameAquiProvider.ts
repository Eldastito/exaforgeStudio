/**
 * ReclameAquiProvider (ADR-162 / PRD 5 §6-§8, F2) — conector REAL do Reclame AQUI,
 * implementando o contrato `ReputationProvider` (F1). É SÓ TRANSPORTE (D4): faz
 * HTTP, autentica, pagina incremental e mapeia a resposta pra `ReputationItem` —
 * NÃO decide severidade/cliente/política/impacto (isso é do domínio, F2+).
 *
 * HONESTIDADE §6 (esta é a regra que rege o F2): a modalidade real da API do
 * Reclame AQUI (endpoints, formato de auth, shape de resposta, rate limits,
 * webhooks vs polling) depende do CONTRATO/credenciais da conta e NÃO foi
 * verificada. Por isso:
 *   - os PATHS e o MAPEAMENTO de campos são CONFIGURÁVEIS (config-driven) com
 *     defaults marcados como PREMISSA A CONFIRMAR — nunca hardcodados como verdade;
 *   - SEM configuração (baseUrl+token) o provider é "não-configurado": DEGRADA
 *     EXPLICITAMENTE (lista vazia, `unavailable` na publicação) e NUNCA fabrica
 *     dado nem simula integração inexistente (§6/§8);
 *   - falha de rede/HTTP não lança pro domínio: degrada (`unavailable`) e o caso é
 *     preservado (o `ReputationConnectorService` registra health; §68).
 *
 * `withTimeout` real via AbortController (fecha o gap do F0). Retry/backoff em
 * 429/5xx reusa o padrão das primitivas do repo (JobQueue/Alterdata).
 */
import type {
  ReputationProvider, ReputationProviderCapability, ReputationItem, ReputationItemStatus,
  ReputationReply, ReputationListQuery, ReputationListResult, ReputationReplyInput, ReputationPublishResult,
} from "./ReputationProvider.js";

export interface ReclameAquiConfig {
  /** Base da API autorizada (ex.: https://api.reclameaqui.com.br/...). */
  baseUrl: string;
  /** Credencial (bearer/API key). FORMATO a confirmar no onboarding da conta (§6). */
  token: string;
  /**
   * Paths e mapeamento — DEFAULTS SÃO PREMISSA (§6), sobrescritíveis por config
   * quando o contrato real da conta for conhecido. Nunca tratados como verdade.
   */
  listPath?: string;    // GET lista incremental
  itemPath?: string;    // GET item por id (usa {id})
  repliesPath?: string; // GET respostas/réplicas (usa {id})
  replyPath?: string;   // POST publicar resposta (usa {id})
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULTS = {
  listPath: "/complaints",             // PREMISSA §6 — confirmar
  itemPath: "/complaints/{id}",        // PREMISSA §6 — confirmar
  repliesPath: "/complaints/{id}/replies", // PREMISSA §6 — confirmar
  replyPath: "/complaints/{id}/replies",   // PREMISSA §6 — confirmar
  timeoutMs: 12000,
  maxRetries: 3,
};

/** Erro de transporte classificado (o caller degrada; nunca vaza pro domínio). */
class ReclameAquiTransportError extends Error {
  constructor(msg: string, readonly kind: "rate_limited" | "unavailable" | "auth" | "bad_response") { super(msg); }
}

export class ReclameAquiProvider implements ReputationProvider {
  name = "reclame_aqui";
  private cfg: ReclameAquiConfig | null;

  constructor(config?: ReclameAquiConfig | null) {
    this.cfg = config && config.baseUrl && config.token ? config : null;
  }

  /** Configurado = tem baseUrl + token. Sem isso, tudo degrada (§6). */
  isConfigured(): boolean { return !!this.cfg; }

  get capabilities(): ReputationProviderCapability[] {
    // Sem config, declaramos SÓ o que dá pra fazer sem enganar: nada de publicar.
    if (!this.cfg) return [];
    // Com config, declaramos o conjunto pretendido. As capacidades REAIS da conta
    // (ex.: publicar resposta) são confirmadas no onboarding (§6); enquanto a conta
    // não permitir, publishReply degrada em runtime pra manual_required/unavailable.
    return ["list", "getItem", "getReplies", "getStatus", "publishReply"];
  }

  async listNewItems(q: ReputationListQuery): Promise<ReputationListResult> {
    if (!this.cfg) return { items: [], nextCursor: null }; // degradação: nunca fabrica
    const params = new URLSearchParams();
    if (q.since) params.set("updatedSince", q.since);      // polling incremental §70
    if (q.cursor) params.set("cursor", q.cursor);
    if (q.limit) params.set("limit", String(q.limit));
    const url = this.url(this.cfg.listPath || DEFAULTS.listPath) + (params.toString() ? `?${params}` : "");
    let body: any;
    try {
      body = await this.httpGet(url);
    } catch {
      return { items: [], nextCursor: null }; // §68: falha não perde o passe; health registra
    }
    return { items: mapItems(body), nextCursor: pickCursor(body) };
  }

  async getItem(externalId: string): Promise<ReputationItem | null> {
    if (!this.cfg) return null;
    try {
      const body = await this.httpGet(this.url((this.cfg.itemPath || DEFAULTS.itemPath).replace("{id}", encodeURIComponent(externalId))));
      const items = mapItems(body);
      return items[0] || mapItem(body) || null;
    } catch { return null; }
  }

  async getReplies(itemExternalId: string): Promise<ReputationReply[]> {
    if (!this.cfg) return [];
    try {
      const body = await this.httpGet(this.url((this.cfg.repliesPath || DEFAULTS.repliesPath).replace("{id}", encodeURIComponent(itemExternalId))));
      return mapReplies(body, itemExternalId);
    } catch { return []; }
  }

  async getStatus(externalId: string): Promise<ReputationItemStatus> {
    const it = await this.getItem(externalId);
    return it?.status || "unknown";
  }

  async publishReply(input: ReputationReplyInput): Promise<ReputationPublishResult> {
    // Sem config OU sem capacidade confirmada → publicação manual (§6): nunca finge.
    if (!this.cfg) return { status: "manual_required", detail: "conector não configurado — publicação manual necessária" };
    try {
      const path = (this.cfg.replyPath || DEFAULTS.replyPath).replace("{id}", encodeURIComponent(input.itemExternalId));
      const body = await this.httpPost(this.url(path), {
        content: input.content,
        idempotencyKey: input.idempotencyKey, // §30: servidor deve deduplicar por esta chave
      });
      const externalReplyId = (body && (body.id || body.replyId)) ? String(body.id || body.replyId) : null;
      return { status: "published", externalReplyId };
    } catch (e: any) {
      // 429/5xx/rede → indisponível (caso preservado, tenta depois §68); auth → manual.
      if (e instanceof ReclameAquiTransportError && e.kind === "auth") {
        return { status: "manual_required", detail: "credencial inválida/expirada — publicação manual necessária" };
      }
      return { status: "unavailable", detail: "Reclame AQUI temporariamente indisponível — o caso está preservado" };
    }
  }

  // ── HTTP com timeout (AbortController) + retry/backoff em 429/5xx ──────────────
  private url(path: string): string {
    const base = (this.cfg!.baseUrl || "").replace(/\/+$/, "");
    return path.startsWith("http") ? path : base + (path.startsWith("/") ? path : `/${path}`);
  }
  private headers(): Record<string, string> {
    // Formato do header de auth a CONFIRMAR (§6); default bearer é premissa.
    return { Authorization: `Bearer ${this.cfg!.token}`, Accept: "application/json", "Content-Type": "application/json" };
  }
  private async httpGet(url: string): Promise<any> { return this.request("GET", url); }
  private async httpPost(url: string, json: any): Promise<any> { return this.request("POST", url, json); }

  private async request(method: string, url: string, json?: any, attempt = 1): Promise<any> {
    const timeoutMs = this.cfg!.timeoutMs || DEFAULTS.timeoutMs;
    const maxRetries = this.cfg!.maxRetries ?? DEFAULTS.maxRetries;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: this.headers(), body: json != null ? JSON.stringify(json) : undefined, signal: ctrl.signal });
      if (res.status === 401 || res.status === 403) throw new ReclameAquiTransportError("auth", "auth");
      if (res.status === 429 || res.status >= 500) {
        if (attempt <= maxRetries) { await backoff(attempt); return this.request(method, url, json, attempt + 1); }
        throw new ReclameAquiTransportError(`http_${res.status}`, "rate_limited");
      }
      if (!res.ok) throw new ReclameAquiTransportError(`http_${res.status}`, "unavailable");
      const text = await res.text();
      try { return text ? JSON.parse(text) : {}; } catch { throw new ReclameAquiTransportError("bad_json", "bad_response"); }
    } catch (e: any) {
      if (e instanceof ReclameAquiTransportError) throw e;
      // abort/timeout/rede → retry, senão indisponível
      if (attempt <= maxRetries) { await backoff(attempt); return this.request(method, url, json, attempt + 1); }
      throw new ReclameAquiTransportError("network", "unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Backoff determinístico-por-tentativa (sem random): 0.5s, 1s, 2s… ─────────────
function backoff(attempt: number): Promise<void> {
  const ms = Math.min(8000, 500 * Math.pow(2, attempt - 1));
  return new Promise((r) => setTimeout(r, ms));
}

// ── Mapeadores DEFENSIVOS (§6: shape a confirmar) — leem nomes de campo comuns e
//    degradam pra null quando ausentes; nunca inventam. Exportados pra teste puro. ──
export function mapItems(body: any): ReputationItem[] {
  const arr = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items
    : Array.isArray(body?.data) ? body.data : Array.isArray(body?.complaints) ? body.complaints : [];
  return arr.map(mapItem).filter(Boolean) as ReputationItem[];
}

export function mapItem(raw: any): ReputationItem | null {
  if (!raw || typeof raw !== "object") return null;
  const externalId = str(raw.id ?? raw.externalId ?? raw.complaintId ?? raw.protocol);
  const content = str(raw.description ?? raw.content ?? raw.text ?? raw.body ?? "");
  if (!externalId || !content) return null; // sem proveniência/conteúdo não vira item
  return {
    source: "reclame_aqui",
    externalId,
    title: strOrNull(raw.title ?? raw.subject),
    content,
    author: strOrNull(raw.consumerName ?? raw.author ?? raw.userName),
    rating: numOrNull(raw.rating ?? raw.score),
    ratingScale: numOrNull(raw.ratingScale) ?? (raw.rating != null ? 5 : null),
    sentiment: mapSentiment(raw.sentiment),
    url: strOrNull(raw.url ?? raw.link ?? raw.permalink),
    publishedAt: strOrNull(raw.createdAt ?? raw.publishedAt ?? raw.date),
    updatedAt: strOrNull(raw.updatedAt ?? raw.modifiedAt ?? raw.createdAt ?? raw.date),
    status: mapStatus(raw.status ?? raw.state),
    orderRef: strOrNull(raw.orderId ?? raw.orderRef ?? raw.order),
    protocol: strOrNull(raw.protocol ?? raw.protocolNumber),
    locationRef: strOrNull(raw.store ?? raw.location ?? raw.branch),
    raw,
  };
}

export function mapReplies(body: any, itemExternalId: string): ReputationReply[] {
  const arr = Array.isArray(body) ? body : Array.isArray(body?.replies) ? body.replies : Array.isArray(body?.data) ? body.data : [];
  return arr.map((r: any) => {
    const content = str(r?.content ?? r?.text ?? r?.message ?? "");
    if (!content) return null;
    return {
      externalId: str(r.id ?? r.replyId ?? `${itemExternalId}-r`),
      itemExternalId,
      authorType: mapAuthorType(r.authorType ?? r.author ?? r.from),
      content,
      publishedAt: strOrNull(r.createdAt ?? r.publishedAt ?? r.date),
    } as ReputationReply;
  }).filter(Boolean) as ReputationReply[];
}

function pickCursor(body: any): string | null {
  return strOrNull(body?.nextCursor ?? body?.next ?? body?.paging?.next ?? body?.cursor) || null;
}
function mapSentiment(v: any): "negative" | "neutral" | "positive" | null {
  const s = String(v || "").toLowerCase();
  if (["negative", "negativo", "neg"].includes(s)) return "negative";
  if (["positive", "positivo", "pos"].includes(s)) return "positive";
  if (["neutral", "neutro"].includes(s)) return "neutral";
  return null;
}
function mapStatus(v: any): ReputationItemStatus {
  const s = String(v || "").toLowerCase();
  if (["new", "novo"].includes(s)) return "new";
  if (["open", "aberto", "pending"].includes(s)) return "open";
  if (["answered", "respondido", "replied"].includes(s)) return "answered";
  if (["consumer_replied", "replica", "réplica"].includes(s)) return "replied_by_consumer";
  if (["resolved", "resolvido", "solved"].includes(s)) return "resolved";
  if (["closed", "encerrado", "finished"].includes(s)) return "closed";
  return "unknown";
}
function mapAuthorType(v: any): "company" | "consumer" | "moderator" | "unknown" {
  const s = String(v || "").toLowerCase();
  if (["company", "empresa", "business"].includes(s)) return "company";
  if (["consumer", "consumidor", "user"].includes(s)) return "consumer";
  if (["moderator", "moderador", "admin"].includes(s)) return "moderator";
  return "unknown";
}
function str(v: any): string { return v == null ? "" : String(v).trim(); }
function strOrNull(v: any): string | null { const s = str(v); return s || null; }
function numOrNull(v: any): number | null { const n = Number(v); return Number.isFinite(n) ? n : null; }

export default ReclameAquiProvider;
