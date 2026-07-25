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
    const items = extractItems(body);
    // Total de páginas: header OU corpo — a ModaUp devolve a paginação no CORPO
    // (`pagination.totalPages`) e IGNORA o itensPorPagina do header (a homologação
    // Toulon devolve ~20/página com "itemsPerPage":0). Sem ler o corpo, o loop
    // parava na página 1 e o catálogo vinha truncado (20 produtos).
    const totalPages = num(res.headers.get("total-paginas") ?? res.headers.get("totalpaginas") ?? res.headers.get("x-total-pages"))
      ?? num(body?.pagination?.totalPages)
      ?? num(body?.paginacao?.totalPaginas);
    const version = res.headers.get("versao") ?? res.headers.get("x-versao") ?? (body?.versao != null ? String(body.versao) : null);
    return { status: res.status, items, totalPages, version, body };
  }

  /**
   * DIAGNÓSTICO ("Testar módulos"): faz UM único GET autenticado a um endpoint,
   * SEM retry-em-5xx e SEM lançar erro — devolve o HTTP status cru + um trecho
   * do corpo. Serve para isolar, por eliminação, qual endpoint (Referencia /
   * CodigoDeBarras / Saldo / Preco) está devolvendo 500 na homologação.
   */
  static async probe(orgId: string, moduleKey: string, pathSuffix: string): Promise<{ module: string; path: string; url: string | null; status: number; ok: boolean; snippet: string }> {
    let base: string | null = null;
    try { base = AlterdataConnectorService.moduleBaseUrl(orgId, moduleKey); } catch { base = null; }
    if (!base) return { module: moduleKey, path: pathSuffix, url: null, status: 0, ok: false, snippet: `base URL do módulo '${moduleKey}' não configurada` };
    const url = `${base}${pathSuffix.startsWith("/") ? "" : "/"}${pathSuffix}`;
    const http: SyncHttp = _http || ((u, i) => fetch(u, i) as any);
    const hdr = (b: string): Record<string, string> => ({ Accept: "application/json", pagina: "1", itensPorPagina: "1", Authorization: `Bearer ${b}` });
    try {
      let token = await AlterdataConnectorService.getOrRefreshToken(orgId);
      let res = await http(url, { method: "GET", headers: hdr(token) });
      if (res.status === 401) {
        token = (await AlterdataConnectorService.acquireToken(orgId)).accessToken;
        res = await http(url, { method: "GET", headers: hdr(token) });
      }
      const body = await res.text().catch(() => "");
      return { module: moduleKey, path: pathSuffix, url, status: res.status, ok: !!res.ok, snippet: String(body).slice(0, 900) };
    } catch (e: any) {
      return { module: moduleKey, path: pathSuffix, url, status: 0, ok: false, snippet: String(e?.message || e).slice(0, 900) };
    }
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
    // Cursor "versão" ou "versão|página". A parte de página só existe quando os
    // itens NÃO expõem campo de versão utilizável — sem ela, cada execução
    // recomeçaria da página 1 e reimportaria o MESMO bloco para sempre (foi o
    // que travou a Referencia da homologação Toulon em "6000 produtos"/run).
    const rawCursor = AlterdataConnectorService.getCursor(orgId, spec.moduleKey, spec.resource, filial);
    const sep = String(rawCursor).indexOf("|");
    const from = sep >= 0 ? String(rawCursor).slice(0, sep) : String(rawCursor);
    const startPage = sep >= 0 ? Math.max(1, parseInt(String(rawCursor).slice(sep + 1), 10) || 1) : 1;
    let maxVersion = from;
    let imported = 0;
    let pages = 0;
    let sawItems = false;
    let reachedEnd = false;
    let lastPage = startPage;

    let page = startPage;
    while (page < startPage + maxPages) {
      const { items, totalPages, version } = await this.apiGet(orgId, spec.moduleKey, spec.buildPath(from), { page, pageSize });
      pages++;
      lastPage = page;
      if (items.length) { sawItems = true; imported += await spec.onItems(items); }
      if (version != null && gt(version, maxVersion)) maxVersion = String(version);
      for (const it of items) {
        const v = itemVersion(it);
        if (v != null && gt(v, maxVersion)) maxVersion = String(v);
      }
      if (!totalPages || page >= totalPages || items.length === 0) { reachedEnd = true; break; }
      page++;
    }

    if (String(maxVersion) !== String(from)) {
      AlterdataConnectorService.setCursor(orgId, spec.moduleKey, spec.resource, filial, maxVersion);
    } else if (sawItems) {
      // Nenhum item trouxe versão utilizável → progresso por PÁGINA. No fim do
      // recurso, fica na ÚLTIMA página (itens novos entram no final: re-buscar a
      // última pega o delta e o totalPages crescente leva às páginas seguintes).
      const nextCursor = `${from}|${reachedEnd ? lastPage : lastPage + 1}`;
      if (nextCursor !== String(rawCursor)) AlterdataConnectorService.setCursor(orgId, spec.moduleKey, spec.resource, filial, nextCursor);
    }
    try { logAuthEvent(orgId, "system", spec.resource, "ALTERDATA_SYNC_RESOURCE", { module: spec.moduleKey, resource: spec.resource, filial, from: String(rawCursor), to: String(maxVersion), imported, pages }); } catch { /* noop */ }
    return { imported, pages, fromVersion: from, toVersion: String(maxVersion) };
  }
}

function num(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

/**
 * Versão de um item: `controleVersao`/`versao`/`version` (>0) ou, na falta
 * deles, o rowversion base64 do campo `controle` (SQL Server, 8 bytes — ex.:
 * "AAAAAAgObNc=" = 135163095). Serializers da ModaUp às vezes emitem
 * controleVersao ZERADO (campo readOnly não mapeado) — 0 não é versão válida.
 */
function itemVersion(it: any): string | null {
  for (const v of [it?.controleVersao, it?.versao, it?.version]) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) { if (n > 0) return String(v); continue; }
    if (String(v)) return String(v); // versão não numérica (contrato tolerante)
  }
  const d = decodeControleVersao(it?.controle);
  return d != null ? String(d) : null;
}

/** `controle` (rowversion base64 de até 8 bytes) → número (== controleVersao). */
function decodeControleVersao(v: any): number | null {
  if (typeof v !== "string" || v.length < 4 || v.length > 16) return null;
  try {
    const buf = Buffer.from(v, "base64");
    if (buf.length === 0 || buf.length > 8) return null;
    let n = 0;
    for (const b of buf) n = n * 256 + b;
    return n > 0 ? n : null;
  } catch { return null; }
}

/**
 * Extrai a lista de itens do corpo, tolerante ao envelope de CADA módulo da
 * ModaUp — os endpoints não são consistentes: uns devolvem array puro
 * (Referencia), outros um objeto com a lista dentro (itens/data/registros/…) e
 * alguns (ex.: TabelaPreco/versao no Swagger) um ÚNICO objeto. Um 200 com corpo
 * num formato não previsto era lido como 0 itens → "0 saldos/preços" silencioso.
 */
function extractItems(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const k of ["itens", "items", "data", "registros", "lista", "resultado", "resultados", "content", "value", "saldos", "precos"]) {
      if (Array.isArray(body[k])) return body[k];
    }
    // Objeto único (não-envelope) → trata como lista de 1; o mapper ignora o que
    // não tiver as chaves que precisa (produto/filial), então é seguro.
    if (Object.keys(body).length > 0) return [body];
  }
  return [];
}
function gt(a: any, b: any): boolean {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb;
  return String(a) > String(b);
}
