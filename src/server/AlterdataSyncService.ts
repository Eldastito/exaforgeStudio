/**
 * Conector Alterdata/ModaUp — MOTOR DE SINCRONIZAÇÃO (ADR-105, Fase 1a).
 *
 * A camada de transporte do delta-sync: GET autenticado por módulo (Bearer via
 * Guardian, renovado sozinho), paginação por HEADER (pagina/itensPorPagina/…),
 * retry com backoff em 5xx/429/rede, e o LOOP DE VERSÃO que lê o cursor,
 * consome `/versao/{cursor}` página a página e avança o cursor.
 *
 * NÃO conhece entidades da ModaUp nem do ZappFlow — quem traduz é o mapper
 * passado em `onItems` (Fase 1b/1c). Cliente HTTP injetável (teste offline, sem
 * tocar a rede). Nada roda enquanto a integração está desligada.
 */
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";
import { logAuthEvent } from "./auditLog.js";

// Resposta HTTP mínima que o motor consome (compatível com fetch Response).
export interface SyncResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}
export type SyncHttp = (url: string, init: any) => Promise<SyncResponse>;

let _http: SyncHttp | null = null;
/** Injeta o cliente HTTP (teste offline). Também desliga os sleeps reais do backoff. */
export function __setAlterdataSyncHttpForTests(fn: SyncHttp | null): void { _http = fn; }

const MAX_RETRIES = 3;

export interface SyncResourceSpec {
  moduleKey: string;                       // ex.: 'supply' | 'price'
  resource: string;                        // ex.: 'Referencia' | 'Saldo' (chave do cursor)
  filial?: string;                         // '' = sem filial no cursor/paths
  buildPath: (cursor: string) => string;   // sufixo COMPLETO, ex.: `/api/v1/Referencia/versao/${c}`
  onItems: (items: any[]) => Promise<number> | number; // mapper → nº importado
  pageSize?: number;
  maxPages?: number;
}

export class AlterdataSyncService {
  /**
   * GET autenticado a um módulo, com paginação por header. Renova o token no
   * Guardian se levar 401 uma vez. Retorna itens + total de páginas + versão.
   */
  static async apiGet(orgId: string, moduleKey: string, pathSuffix: string, opts: { page?: number; pageSize?: number; orderBy?: string; direction?: string } = {}): Promise<{ status: number; items: any[]; totalPages: number | null; version: string | null; body: any }> {
    const base = AlterdataConnectorService.moduleBaseUrl(orgId, moduleKey);
    if (!base) throw new Error(`Alterdata: base URL do módulo '${moduleKey}' não configurada (defina base_pattern ou moduleBaseUrls).`);
    const url = `${base}${pathSuffix.startsWith("/") ? "" : "/"}${pathSuffix}`;

    const baseHeaders: Record<string, string> = {
      Accept: "application/json",
      pagina: String(opts.page ?? 1),
      itensPorPagina: String(opts.pageSize ?? 100),
    };
    if (opts.orderBy) baseHeaders.ordenadoPor = String(opts.orderBy);
    if (opts.direction) baseHeaders.direcao = String(opts.direction);

    const call = async (bearer: string) => this.fetchWithRetry(url, { method: "GET", headers: { ...baseHeaders, Authorization: `Bearer ${bearer}` } });

    let token = await AlterdataConnectorService.getOrRefreshToken(orgId);
    let res = await call(token);
    if (res.status === 401) {
      // Token pode ter sido revogado no Guardian — força uma renovação e repete.
      token = (await AlterdataConnectorService.acquireToken(orgId)).accessToken;
      res = await call(token);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Alterdata ${moduleKey} ${pathSuffix}: HTTP ${res.status} ${String(t).slice(0, 200)}`);
    }
    const body = await res.json().catch(() => null);
    const items = Array.isArray(body) ? body
      : Array.isArray(body?.itens) ? body.itens
      : Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.registros) ? body.registros
      : [];
    const totalPages = num(res.headers.get("total-paginas") ?? res.headers.get("totalpaginas") ?? res.headers.get("x-total-pages"));
    const version = res.headers.get("versao") ?? res.headers.get("x-versao") ?? (body?.versao != null ? String(body.versao) : null);
    return { status: res.status, items, totalPages, version, body };
  }

  /** Fetch com retry/backoff em 5xx, 429 e falha de rede. */
  static async fetchWithRetry(url: string, init: any): Promise<SyncResponse> {
    const http: SyncHttp = _http || ((u, i) => fetch(u, i) as any);
    let lastErr: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await http(url, init);
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) { lastErr = new Error(`HTTP ${res.status}`); await this.backoff(attempt); continue; }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_RETRIES) { await this.backoff(attempt); continue; }
      }
    }
    throw lastErr || new Error("Alterdata: falha de rede após retries.");
  }

  private static backoff(attempt: number): Promise<void> {
    if (_http) return Promise.resolve(); // teste: sem espera real
    const ms = Math.min(16000, 1000 * Math.pow(2, attempt));
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * LOOP DE VERSÃO (delta) de um recurso: lê o cursor persistido, consome
   * `/versao/{cursor}` página a página chamando o mapper, e avança o cursor para
   * a MAIOR versão vista (header `versao` ou campo `versao`/`version` dos itens —
   * contrato tolerante, a confirmar na homologação). Idempotente por natureza:
   * o cursor só avança; o mapper deve fazer upsert por chave natural.
   */
  static async syncResource(orgId: string, spec: SyncResourceSpec): Promise<{ imported: number; pages: number; fromVersion: string; toVersion: string }> {
    const filial = spec.filial || "";
    const maxPages = spec.maxPages ?? 50;
    const pageSize = spec.pageSize ?? 200;
    const from = AlterdataConnectorService.getCursor(orgId, spec.moduleKey, spec.resource, filial);
    let maxVersion = from;
    let imported = 0;
    let pages = 0;
    let page = 1;

    while (page <= maxPages) {
      const { items, totalPages, version } = await this.apiGet(orgId, spec.moduleKey, spec.buildPath(from), { page, pageSize });
      pages++;
      if (items.length) imported += await spec.onItems(items);
      if (version != null && gt(version, maxVersion)) maxVersion = String(version);
      for (const it of items) {
        // No spec Supply da ModaUp, a versão do item é `controleVersao`
        // (fallback tolerante para `versao`/`version` em outros módulos).
        const v = it?.controleVersao ?? it?.versao ?? it?.version;
        if (v != null && gt(v, maxVersion)) maxVersion = String(v);
      }
      if (!totalPages || page >= totalPages || items.length === 0) break;
      page++;
    }

    if (String(maxVersion) !== String(from)) AlterdataConnectorService.setCursor(orgId, spec.moduleKey, spec.resource, filial, maxVersion);
    try { logAuthEvent(orgId, "system", spec.resource, "ALTERDATA_SYNC_RESOURCE", { module: spec.moduleKey, resource: spec.resource, filial, from, to: String(maxVersion), imported, pages }); } catch { /* noop */ }
    return { imported, pages, fromVersion: from, toVersion: String(maxVersion) };
  }
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function gt(a: any, b: any): boolean {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb;
  return String(a) > String(b);
}
