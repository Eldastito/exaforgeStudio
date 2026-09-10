/**
 * FileRequestCatalogService — PRD WhatsApp Unificado F5.1 (RF-07 §13.1/§13.2/§13.3).
 *
 * O "cérebro" da etapa de INTERPRETAÇÃO + AUTORIZAÇÃO de um pedido de arquivo pela
 * conversa, separado da geração (F5.2) e da entrega (F5.3) — as quatro ações do
 * §13.1 são compostas, cada uma com seu estado/permissão. Esta fatia entrega:
 *
 *   1. CATÁLOGO FECHADO (§13.2) — o conjunto de relatórios/arquivos suportados,
 *      cada um ligado a uma CONSULTA DE DOMÍNIO já existente (nunca uma consulta
 *      nova dentro do webhook/gerador). Pedido fora do catálogo devolve as opções
 *      suportadas — NUNCA inventa relatório/documento (§13.2 in fine, RN-151).
 *   2. AUTORIZAÇÃO revalidada na resolução (§13.1 passo 2, §13.4) — reusa a
 *      projeção por papel (`ContextProjectionService`), fail-closed, sem listar
 *      títulos de documento proibido. Acesso revogado invalida a referência.
 *   3. RESULTADO ESTRUTURADO (§13.1 passo 3) — para as entradas com consulta
 *      pronta, forma o resultado com FONTE + INSTANTE da consulta + indicação de
 *      AUSÊNCIA de dado. NÃO gera arquivo aqui (isso é F5.2/F5.3).
 *   4. REFERÊNCIA AO "ISSO" (§13.3) — memória DURÁVEL do último resultado por
 *      usuário/conversa (`falatu_last_result`), pra reexportar o MESMO recorte e
 *      snapshot em outro formato ("me manda isso em Excel") sem reconsultar nem
 *      mudar os números. Padrão durável herdado da F3.4 (não em memória).
 *
 * O que esta fatia NÃO faz: não renderiza PDF/XLSX/DOCX (F5.2), não entrega pelo
 * WhatsApp (F5.3). `formatGeneratorReady` é honesto sobre qual gerador existe hoje
 * (pdf/xlsx sim; docx só na F5.2).
 */
import db from "./db.js";
import { ContextEngineService } from "./ContextEngineService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { ArtifactService } from "./ArtifactService.js";

export type FileFormat = "pdf" | "xlsx" | "docx";
const RECOGNIZED_FORMATS: FileFormat[] = ["pdf", "xlsx", "docx"];
// Geradores que EXISTEM hoje no HEAD. PDF (pdfkit), XLSX e DOCX (F5.2, OOXML real
// via DocxService) — todos produzem arquivo editável de verdade (nunca renomeiam).
const GENERATOR_READY: Record<FileFormat, boolean> = { pdf: true, xlsx: true, docx: true };

type QueryStatus = "ready" | "pending_domain_query";

interface CatalogEntry {
  key: string;
  label: string;
  /** Domínio de negócio exigido (chave de `DOMAIN_MODULE`). null = role-scoped. */
  requiredDomain: string | null;
  queryStatus: QueryStatus;
  /** Fonte declarada da consulta (impressa no resultado, §13.3). */
  source: string;
}

// Catálogo inicial obrigatório (§13.2). Cada entrada aponta pra uma consulta de
// domínio existente. `executive_summary` e `existing_artifact` têm consulta PRONTA;
// os demais declaram a dependência de domínio (a consulta correspondente é
// implementada NO DOMÍNIO — §13.2 — em fatia posterior, nunca aqui/no webhook).
const CATALOG: CatalogEntry[] = [
  { key: "executive_summary", label: "Resumo executivo", requiredDomain: null, queryStatus: "ready", source: "context_engine" },
  { key: "existing_artifact", label: "Arquivo já disponível", requiredDomain: null, queryStatus: "ready", source: "artifacts" },
  { key: "sales_by_period", label: "Vendas por dia/período e loja", requiredDomain: "sales", queryStatus: "pending_domain_query", source: "vendas" },
  { key: "accounts_finance", label: "Contas a pagar/receber", requiredDomain: "finance", queryStatus: "pending_domain_query", source: "financeiro" },
  { key: "tasks_by_assignee", label: "Tarefas por responsável/prazo", requiredDomain: "tasks", queryStatus: "pending_domain_query", source: "execucao" },
];
const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));

export interface FileRequestInput {
  /** Chave do catálogo. Omitido só quando `ref:'last'`. */
  kind?: string;
  /** Reexportar o último resultado da conversa ("isso"). */
  ref?: "last";
  format?: FileFormat;
  conversationId: string;
  period?: any;
  filters?: any;
  unitId?: string | null;
  correlationId?: string | null;
  /** Persistir como "último resultado" após resolver (default: true p/ ready). */
  remember?: boolean;
}

export interface FileRequestResolution {
  ok: boolean;
  authorized: boolean;
  catalogKey: string | null;
  label?: string;
  format: FileFormat | null;
  formatGeneratorReady: boolean;
  params: { period?: any; filters?: any; unitId?: string | null };
  queryStatus?: QueryStatus;
  /** Resultado estruturado (data-only) — nunca o binário. null p/ pending/deny. */
  structuredResult: any | null;
  source?: string;
  queriedAt?: string;
  /** Resolvido via referência ao "isso". */
  fromReference?: boolean;
  /** Motivo GENÉRICO de recusa (§13.4) — nunca vaza título/estrutura. */
  denialReason?: string;
  /** Pedido fora do catálogo/formato — devolve as opções (§13.2). */
  unsupported?: { reason: string; supportedKinds?: string[]; supportedFormats?: FileFormat[] };
}

export class FileRequestCatalogService {
  /** Catálogo VISÍVEL pro usuário — entradas cujo domínio ele pode ver (§13.1/§13.4). */
  static list(orgId: string, user: any): Array<{ key: string; label: string; queryStatus: QueryStatus }> {
    return CATALOG
      .filter((e) => this.authorize(orgId, user, e))
      .map((e) => ({ key: e.key, label: e.label, queryStatus: e.queryStatus }));
  }

  /**
   * Interpreta + autoriza um pedido. NÃO gera arquivo. Para pedido "isso"
   * (ref:'last'), reusa o recorte/snapshot do último resultado da conversa,
   * reaplicando a autorização ATUAL (acesso revogado invalida/reduz).
   */
  static resolve(orgId: string, user: any, input: FileRequestInput): FileRequestResolution {
    const format = this.normalizeFormat(input.format);

    // ── Referência ao "isso" (§13.3) ──
    if (input.ref === "last") {
      const last = this.getLast(orgId, user, input.conversationId);
      if (!last) {
        return this.unsupportedRes("no_prior_result", format);
      }
      const entry = BY_KEY.get(last.catalog_key);
      if (!entry || !this.authorize(orgId, user, entry)) {
        // Acesso ao domínio foi revogado desde a consulta → não entrega (§13.4).
        return this.denyRes(last.catalog_key, format);
      }
      // Mesmo snapshot; só o formato pode mudar ("isso em Excel"). Reaplica a
      // projeção ATUAL sobre o snapshot congelado (revogação parcial reduz).
      const frozen = this.parse(last.snapshot_json);
      const reprojected = this.reprojectFrozen(orgId, user, entry, frozen);
      const fmt = format || this.normalizeFormat(last.format) || "pdf";
      return {
        ok: true, authorized: true, catalogKey: entry.key, label: entry.label,
        format: fmt, formatGeneratorReady: GENERATOR_READY[fmt],
        params: this.parse(last.params_json) || {},
        queryStatus: entry.queryStatus, structuredResult: reprojected,
        source: last.source || entry.source, queriedAt: last.queried_at || undefined,
        fromReference: true,
      };
    }

    // ── Pedido explícito por catálogo ──
    const entry = input.kind ? BY_KEY.get(input.kind) : undefined;
    if (!entry) {
      return this.unsupportedRes("unknown_kind", format);
    }
    // Autorização (§13.1 passo 2) — fail-closed, sem vazar título/estrutura.
    if (!this.authorize(orgId, user, entry)) {
      return this.denyRes(entry.key, format);
    }
    const fmt = format || "pdf";
    const params = { period: input.period, filters: input.filters, unitId: input.unitId ?? null };
    const base: FileRequestResolution = {
      ok: true, authorized: true, catalogKey: entry.key, label: entry.label,
      format: fmt, formatGeneratorReady: GENERATOR_READY[fmt],
      params, queryStatus: entry.queryStatus, structuredResult: null, source: entry.source,
    };

    if (entry.queryStatus !== "ready") {
      // Consulta de domínio ainda não plugada — honesto, NÃO inventa dado (§13.2).
      return base;
    }

    const built = this.runQuery(orgId, user, entry, params);
    base.structuredResult = built.structuredResult;
    base.queriedAt = built.queriedAt;

    if (input.remember !== false) {
      this.remember(orgId, user, {
        conversationId: input.conversationId, catalogKey: entry.key, format: fmt,
        params, structuredResult: built.structuredResult, source: entry.source,
        queriedAt: built.queriedAt, correlationId: input.correlationId ?? null,
      });
    }
    return base;
  }

  // ── Consultas de domínio (data-only; nunca geram arquivo) ──
  private static runQuery(orgId: string, user: any, entry: CatalogEntry, params: any): { structuredResult: any; queriedAt: string } {
    const queriedAt = new Date().toISOString();
    if (entry.key === "executive_summary") {
      const ctx = ContextEngineService.buildForUser(orgId, user);
      const domains = (ctx.snapshot && ctx.snapshot.domains) || {};
      const missing = Object.keys(domains).length === 0;
      return {
        structuredResult: {
          kind: "executive_summary", source: entry.source, queriedAt,
          narrative: ctx.narrative, domains, missing,
          droppedDomains: ctx.droppedDomains, redactedPaths: ctx.redactedPaths,
        }, queriedAt,
      };
    }
    if (entry.key === "existing_artifact") {
      // Localizar versão existente autorizada (§13.2) — RBAC por classificação já
      // aplicado por `listForUser`. Não gera nada; só lista o que o usuário pode ver.
      const arts = ArtifactService.listForUser(orgId, user).map((a: any) => ({
        id: a.id, title: a.title, kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes, createdAt: a.createdAt,
      }));
      return {
        structuredResult: { kind: "existing_artifact", source: entry.source, queriedAt, artifacts: arts, missing: arts.length === 0 },
        queriedAt,
      };
    }
    return { structuredResult: null, queriedAt };
  }

  /** Reaplica a autorização ATUAL sobre o snapshot congelado (revogação parcial). */
  private static reprojectFrozen(orgId: string, user: any, entry: CatalogEntry, frozen: any): any {
    if (!frozen || typeof frozen !== "object") return frozen;
    if (entry.key === "executive_summary" && frozen.domains && typeof frozen.domains === "object") {
      const r = ContextProjectionService.projectSnapshot(orgId, user, { domains: frozen.domains });
      return { ...frozen, domains: r.snapshot.domains || {}, droppedDomains: r.manifest.droppedDomains, redactedPaths: r.manifest.redactedPaths };
    }
    if (entry.key === "existing_artifact" && Array.isArray(frozen.artifacts)) {
      // Só devolve os artefatos que o usuário AINDA pode acessar (revogação, §13.4).
      const artifacts = frozen.artifacts.filter((a: any) => !!ArtifactService.getForUser(orgId, user, a.id));
      return { ...frozen, artifacts, missing: artifacts.length === 0 };
    }
    return frozen;
  }

  // ── Autorização (§13.1/§13.4) — reusa a projeção por papel, fail-closed ──
  private static authorize(orgId: string, user: any, entry: CatalogEntry): boolean {
    if (!entry.requiredDomain) return true; // role-scoped (a própria projeção recorta)
    return ContextProjectionService.canSeeDomain(orgId, user, entry.requiredDomain);
  }

  // ── Referência durável "isso" (§13.3) ──
  static remember(orgId: string, user: any, r: {
    conversationId: string; catalogKey: string; format: FileFormat; params: any;
    structuredResult: any; source: string; queriedAt: string; correlationId?: string | null;
  }): void {
    const userId = user?.userId || user?.id || null;
    if (!userId || !r.conversationId) return; // sem chave de conversa, não há "isso"
    db.prepare(
      `INSERT INTO falatu_last_result (organization_id, user_id, conversation_id, catalog_key, format, params_json, snapshot_json, source, queried_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, user_id, conversation_id) DO UPDATE SET
         catalog_key=excluded.catalog_key, format=excluded.format, params_json=excluded.params_json,
         snapshot_json=excluded.snapshot_json, source=excluded.source, queried_at=excluded.queried_at,
         correlation_id=excluded.correlation_id`
    ).run(
      orgId, userId, r.conversationId, r.catalogKey, r.format,
      JSON.stringify(r.params ?? {}), JSON.stringify(r.structuredResult ?? null),
      r.source, r.queriedAt, r.correlationId ?? null
    );
  }

  static getLast(orgId: string, user: any, conversationId: string): any | null {
    const userId = user?.userId || user?.id || null;
    if (!userId || !conversationId) return null;
    return db.prepare(
      `SELECT * FROM falatu_last_result WHERE organization_id = ? AND user_id = ? AND conversation_id = ?`
    ).get(orgId, userId, conversationId) || null;
  }

  // ── helpers ──
  private static normalizeFormat(f: any): FileFormat | null {
    return RECOGNIZED_FORMATS.includes(f) ? (f as FileFormat) : null;
  }
  private static parse(s: any): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }
  private static unsupportedRes(reason: string, format: FileFormat | null): FileRequestResolution {
    return {
      ok: false, authorized: true, catalogKey: null, format, formatGeneratorReady: format ? GENERATOR_READY[format] : false,
      params: {}, structuredResult: null,
      unsupported: { reason, supportedKinds: CATALOG.map((e) => e.key), supportedFormats: RECOGNIZED_FORMATS },
    };
  }
  private static denyRes(catalogKey: string | null, format: FileFormat | null): FileRequestResolution {
    // Recusa GENÉRICA (§13.4) — não confirma existência de dado/documento.
    return {
      ok: false, authorized: false, catalogKey, format, formatGeneratorReady: format ? GENERATOR_READY[format] : false,
      params: {}, structuredResult: null, denialReason: "not_authorized",
    };
  }
}
