/**
 * NuvemFiscalAdapter — implementa FiscalInboundProvider sobre a API da Nuvem
 * Fiscal (ADR-200, Fase 3). OAuth2 client_credentials + Distribuição DF-e +
 * manifestação. HTTP é injetável (fetchFn) para teste sem rede.
 *
 * TRANSPORTE/AUTH/ERROS são firmes e testados. O MAPEAMENTO da resposta de
 * distribuição (mapBatch) usa os campos que a doc referencia (documentos, nsu,
 * chave_acesso, tipo_documento, ultimo_nsu, maximo_nsu) de forma tolerante —
 * CONFIRMAR contra homologação e ajustar só mapBatch/parseDoc se divergir.
 *
 * Docs: https://dev.nuvemfiscal.com.br/docs/autenticacao/ e
 *       https://dev.nuvemfiscal.com.br/docs/distribuicao-nfe/
 */
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import {
  FiscalInboundProvider, FiscalProbeResult, FiscalDistributionBatch, FiscalDistributionDoc,
  FiscalEventResult, FiscalManifestationEvent, FiscalDocSchema, MANIFESTATION_TP_EVENTO,
} from "./FiscalInboundProvider.js";

type FetchFn = (url: string, init?: any) => Promise<any>;

export interface NuvemFiscalOptions {
  fetchFn?: FetchFn;
  authBase?: string;   // default https://auth.nuvemfiscal.com.br
  apiBase?: string;    // default https://api.nuvemfiscal.com.br
  ambiente?: "producao" | "homologacao";
  timeoutMs?: number;
}
export interface NuvemFiscalCredentials { clientId: string; clientSecret: string; scope: string; }

const DEFAULT_AUTH = "https://auth.nuvemfiscal.com.br";
const DEFAULT_API = "https://api.nuvemfiscal.com.br";

/** Mapeia HTTP/erros conhecidos para códigos sanitizados (nunca vaza segredo). */
function errorCode(status: number): string {
  if (status === 401 || status === 403) return "invalid_client";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return `http_${status}`;
}

export class NuvemFiscalAdapter implements FiscalInboundProvider {
  private readonly creds: NuvemFiscalCredentials;
  private readonly fetchFn: FetchFn;
  private readonly authBase: string;
  private readonly apiBase: string;
  private readonly ambiente: string;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(creds: NuvemFiscalCredentials, opts: NuvemFiscalOptions = {}) {
    this.creds = creds;
    this.fetchFn = opts.fetchFn || ((globalThis as any).fetch as FetchFn);
    this.authBase = (opts.authBase || process.env.NUVEMFISCAL_AUTH_BASE || DEFAULT_AUTH).replace(/\/$/, "");
    this.apiBase = (opts.apiBase || process.env.NUVEMFISCAL_API_BASE || DEFAULT_API).replace(/\/$/, "");
    this.ambiente = opts.ambiente || "homologacao";
    this.timeoutMs = opts.timeoutMs || 20000;
  }

  /** Token OAuth2 client_credentials, com cache até ~60s antes de expirar. */
  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: this.creds.scope || "distribuicao-nfe",
    });
    const res = await this.call(`${this.authBase}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    if (!res.ok) { const e: any = new Error("auth_failed"); e.code = errorCode(res.status); throw e; }
    const j = await res.json();
    const ttl = Number(j.expires_in || 3600) * 1000;
    this.token = { value: j.access_token, expiresAt: Date.now() + ttl };
    return this.token.value;
  }

  private async authedFetch(url: string, init: any = {}): Promise<any> {
    const token = await this.getToken();
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
    return this.call(url, { ...init, headers });
  }

  private async call(url: string, init: any): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async probe(): Promise<FiscalProbeResult> {
    try {
      await this.getToken();
      return { connected: true, capabilities: { scope: this.creds.scope || "distribuicao-nfe", ambiente: this.ambiente } };
    } catch (e: any) {
      return { connected: false, errorCode: e?.code || "network_error" };
    }
  }

  async listSinceNsu(input: { cnpj: string; ultNsu: string }): Promise<FiscalDistributionBatch> {
    const url = `${this.apiBase}/distribuicao/nfe?cpf_cnpj=${encodeURIComponent(input.cnpj)}&ambiente=${encodeURIComponent(this.ambiente)}&ult_nsu=${encodeURIComponent(input.ultNsu || "0")}`;
    return this.fetchBatch(url, input.ultNsu);
  }

  async getByAccessKey(input: { cnpj: string; accessKey: string }): Promise<FiscalDistributionBatch> {
    const url = `${this.apiBase}/distribuicao/nfe?cpf_cnpj=${encodeURIComponent(input.cnpj)}&ambiente=${encodeURIComponent(this.ambiente)}&chave=${encodeURIComponent(input.accessKey)}`;
    return this.fetchBatch(url, "0");
  }

  private async fetchBatch(url: string, fallbackNsu: string): Promise<FiscalDistributionBatch> {
    const res = await this.authedFetch(url, { method: "GET", headers: { Accept: "application/json" } });
    if (res.status === 429) {
      const retry = Number(res.headers?.get?.("Retry-After")) || 3600;
      return { ultNsu: fallbackNsu, maxNsu: null, documents: [], blocked: { until: new Date(Date.now() + retry * 1000).toISOString(), reason: "rate_limited" } };
    }
    if (!res.ok) { const e: any = new Error("distribuicao_failed"); e.code = errorCode(res.status); throw e; }
    return mapBatch(await res.json(), fallbackNsu);
  }

  async manifest(input: { cnpj: string; accessKey: string; event: FiscalManifestationEvent; justification?: string }): Promise<FiscalEventResult> {
    const url = `${this.apiBase}/distribuicao/nfe/manifestacao`;
    const payload = {
      cpf_cnpj: input.cnpj,
      chave: input.accessKey,
      ambiente: this.ambiente,
      tipo_evento: MANIFESTATION_TP_EVENTO[input.event],
      justificativa: input.justification,
    };
    const res = await this.authedFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) return { ok: false, errorCode: errorCode(res.status) };
    const j = await res.json().catch(() => ({}));
    return { ok: true, protocol: j.protocolo || j.nProt || null, status: String(j.status || j.cStat || "") || null };
  }
}

// ===========================================================================
// Mapeamento da resposta de distribuição → tipos internos (isolado + tolerante).
// CONFIRMAR contra homologação; ajustar SÓ aqui se os nomes de campo divergirem.
// ===========================================================================

function pick(obj: any, ...keys: string[]): any {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/** Se o conteúdo vier como base64 (gzip ou não), devolve o XML string. */
function decodeXml(raw: any): string | null {
  if (raw == null) return null;
  const s = String(raw);
  if (s.trimStart().startsWith("<")) return s; // já é XML
  try {
    const buf = Buffer.from(s, "base64");
    // Tenta gunzip (docZip da SEFAZ é gzip); se não for gzip, usa o base64 puro.
    try { return gunzipSync(buf).toString("utf8"); } catch { return buf.toString("utf8"); }
  } catch { return null; }
}

function classify(tipo: any, xml: string | null): FiscalDocSchema {
  const t = String(tipo || "").toLowerCase();
  if (t.includes("resnfe") || t.includes("resumo")) return "resNFe";
  if (t.includes("procnfe") || t.includes("nfe")) return "procNFe";
  if (t.includes("evento")) return "procEventoNFe";
  if (xml) {
    if (/<resNFe[\s>]/.test(xml)) return "resNFe";
    if (/<procEventoNFe[\s>]/.test(xml)) return "procEventoNFe";
    if (/<(nfeProc|NFe)[\s>]/.test(xml)) return "procNFe";
  }
  return "unknown";
}

export function mapBatch(raw: any, fallbackNsu: string): FiscalDistributionBatch {
  const list = pick(raw, "documentos", "docs", "data", "itens") || [];
  const documents: FiscalDistributionDoc[] = (Array.isArray(list) ? list : []).map((d: any) => {
    const xml = decodeXml(pick(d, "xml", "conteudo", "documento", "resumo"));
    const key = String(pick(d, "chave_acesso", "chave", "chNFe") || "").replace(/\D/g, "") || null;
    return {
      nsu: String(pick(d, "nsu", "NSU") ?? ""),
      schema: classify(pick(d, "tipo_documento", "tipo", "schema"), xml),
      accessKey: key && key.length === 44 ? key : null,
      xml,
    };
  });
  return {
    ultNsu: String(pick(raw, "ultimo_nsu", "ult_nsu", "ultNSU") ?? fallbackNsu),
    maxNsu: (pick(raw, "maximo_nsu", "max_nsu", "maxNSU") ?? null) == null ? null : String(pick(raw, "maximo_nsu", "max_nsu", "maxNSU")),
    documents,
  };
}

export default NuvemFiscalAdapter;
