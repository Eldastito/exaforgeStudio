/**
 * Conector Alterdata/ModaUp — RUNNER (ADR-105, Fase 1c): liga tudo.
 *
 * Orquestra o delta-sync ponta a ponta de uma organização: usa o motor de
 * transporte (AlterdataSyncService) com os mappers (Supply + Estoque) para puxar
 * Referencia → produto, CodigoDeBarras → variantes e Saldo (por filial) →
 * estoque por loja. Backfill inicial e delta contínuo são o mesmo caminho (o
 * cursor decide de onde parte). Gated pela flag `enabled` da org.
 *
 * Agendável: `Scheduler.alterdataSyncPass()` dispara `runOrg` das orgs ativas
 * respeitando o intervalo; a rota POST /alterdata/sync dispara sob demanda.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";
import { AlterdataSyncService } from "./AlterdataSyncService.js";
import { AlterdataSupplyMapper } from "./AlterdataSupplyMapper.js";
import { AlterdataStockMapper } from "./AlterdataStockMapper.js";
import { AlterdataPriceMapper } from "./AlterdataPriceMapper.js";
import { JobQueueService } from "./JobQueueService.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailReconciliationService } from "./RetailReconciliationService.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { RetailErpSellerSalesService, type ErpSellerSaleRow } from "./RetailErpSellerSalesService.js";
import {
  AlterdataSyncLedgerService,
  classifyError,
  extractHttpStatus,
  type LedgerRunHandle,
  type LedgerRunTrigger,
} from "./AlterdataSyncLedgerService.js";
import { AlterdataProfileService, type AlterdataEnvironment } from "./AlterdataProfileService.js";

export interface SyncRunSummary {
  referencias: number;
  /** Total ACUMULADO de produtos do catálogo (prova visual de que o cursor avança). */
  totalProdutos: number;
  totalVariantes: number;
  variantes: number;
  saldos: { applied: number; skippedNoStore: number; skippedNoProduct: number; sampleNoProduct: string[] };
  precos: { applied: number; skippedNoProduct: number; sampleNoProduct: string[] };
  /** Fechamentos do PDV conciliados via módulo Sales (Fase 2). */
  caixas: { applied: number; skippedNoStore: number; errors: number };
  /** Vendas do PDV importadas (venda a venda, com vendedor — Fase 4). */
  vendas: { imported: number };
  /** Comissão POR VENDEDOR calculada pelo ERP (Cenário A) — base + comissão de conferência. */
  erpComissao: { imported: number };
  /** Clientes do PDV importados (Fase 3, opt-in). */
  clientes: { imported: number };
  filiais: string[];
  ranAt: string;
  /** RF-06/12: status geral do ledger — 'success' | 'partial_failure' | 'failed' | 'cancelled'. */
  runStatus?: string;
  /** ID da run no ledger (RF-06), pra a UI cruzar com detalhes. */
  runId?: string;
  /** Correlation ID (RF-06) — viaja em logs e no ledger. */
  correlationId?: string;
}

function str(v: any): string { return v == null ? "" : String(v).trim(); }

export class AlterdataSyncRunner {
  /**
   * Sincroniza uma org (Supply: Referencia → CodigoDeBarras → Saldo por filial).
   * `manual` (clique em "Sincronizar agora") dispensa a flag `enabled` — o toggle
   * governa só a sincronização AUTOMÁTICA/agendada, não o teste manual (homologação).
   */
  /** Trava por org: execuções SIMULTÂNEAS (clique + agendador + fila) disputam
   *  o mesmo cursor — uma consome o delta silenciosamente e a outra reporta 0. */
  private static running = new Set<string>();

  /** A tela usa para mostrar "em andamento" de verdade (sobrevive à navegação). */
  static isRunning(orgId: string): boolean { return this.running.has(orgId); }

  static async runOrg(orgId: string, opts: { manual?: boolean; trigger?: LedgerRunTrigger; initiatedBy?: string } = {}): Promise<SyncRunSummary> {
    if (!opts.manual && !AlterdataConnectorService.isEnabled(orgId)) {
      throw new Error("Alterdata: integração desligada para esta organização (ative em Integrações).");
    }
    if (this.running.has(orgId)) {
      throw new Error("Alterdata: já existe uma sincronização em andamento para esta organização — aguarde ela terminar.");
    }
    this.running.add(orgId);
    try {
      const trigger: LedgerRunTrigger = opts.trigger ?? (opts.manual ? "manual" : "scheduler");
      return await this.runOrgInner(orgId, { trigger, initiatedBy: opts.initiatedBy ?? "system" });
    } finally {
      this.running.delete(orgId);
    }
  }

  private static async runOrgInner(orgId: string, ctx: { trigger: LedgerRunTrigger; initiatedBy: string }): Promise<SyncRunSummary> {
    const settings = AlterdataConnectorService.publicSettings(orgId);
    // RF-06: abre a run no ledger. env vem da linha legada (fonte da verdade
    // do dropdown até PR 5). correlationId viaja em cada resource.
    const environment: AlterdataEnvironment = settings.environment === "prod" ? "prod" : "homolog";
    const ledger = AlterdataSyncLedgerService.begin(orgId, environment, ctx.trigger, ctx.initiatedBy);
    const filiais: string[] = Array.isArray(settings.filiais) && settings.filiais.length ? settings.filiais : [""];
    const rede = str(settings.rede);

    try {
    // 1) Referências (produtos). Coleta os códigos de referência sincronizados
    //    para, em seguida, puxar os códigos de barras POR referência. RF-08:
    //    falha aqui é REGISTRADA (não silenciosa) e ainda propaga, porque as
    //    fases seguintes dependem do catálogo.
    const refCodes = new Set<string>();
    let ref = { imported: 0, pages: 0, fromVersion: "0", toVersion: "0" };
    try {
      ref = await AlterdataSyncService.syncResource(orgId, {
        moduleKey: "supply", resource: "Referencia",
        // A ModaUp devolve ~20 itens/página (ignora o itensPorPagina): 300 páginas
        // ≈ 6000 referências por execução — catálogos maiores completam nas
        // execuções seguintes (o cursor de versão continua de onde parou).
        maxPages: 300,
        buildPath: (c) => `/api/v1/Referencia/versao/${c}`,
        onItems: (items) => {
          for (const it of items) { const c = str(it?.referenciaId ?? it?.referencia ?? it?.codigo); if (c) refCodes.add(c); }
          return AlterdataSupplyMapper.upsertReferencias(orgId, items);
        },
      });
      ledger.record({
        module: "supply", resource: "Referencia", required: true,
        status: ref.imported > 0 ? "ready" : "empty_but_valid",
        cursorBefore: ref.fromVersion, cursorAfter: ref.toVersion,
        pages: ref.pages, imported: ref.imported,
      });
    } catch (e: any) {
      const http = extractHttpStatus(e);
      ledger.record({
        module: "supply", resource: "Referencia", required: true,
        status: http === 401 ? "auth_failed" : "server_error",
        httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
      });
      throw e;
    }

    // 2) Códigos de barras (variantes/EAN). O supply da ModaUp NÃO expõe delta
    //    `/versao` para barras — a leitura é POR REFERÊNCIA:
    //      GET /api/v1/CodigoDeBarras/ReferenciaRede/{referencia}/{rede}
    //    Então, para cada referência sincronizada, puxa suas barras e casa a grade.
    const bar = { imported: 0, refs: 0, errors: 0 };
    if (rede) {
      // Barras ENRIQUECEM a grade (cor/tamanho/EAN) e custam 1+ chamadas POR
      // referência — com milhares de referências isso não cabe numa execução.
      // Estoque e preço NÃO dependem delas (a variante nasce do próprio código
      // do ERP via ensureVariantForErpCode); então prioriza referências ainda
      // não enriquecidas (nenhuma variante com cor), limitado por execução, em
      // ordem aleatória p/ não repetir sempre as mesmas — o agendador de 15min
      // vai varrendo o restante aos poucos.
      const MAX_BAR_REFS = 300;
      const pend = db.prepare(
        `SELECT p.external_ref AS ref FROM products_services p
          WHERE p.organization_id = ? AND p.external_ref IS NOT NULL AND p.external_ref <> ''
            AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.organization_id = p.organization_id AND v.product_service_id = p.id AND v.color IS NOT NULL)
          ORDER BY RANDOM() LIMIT ?`
      ).all(orgId, MAX_BAR_REFS) as any[];
      for (const row of pend) {
        const referencia = str(row.ref);
        try {
          // Paginado: a ModaUp ignora o itensPorPagina do header e devolve ~20
          // por página (total no corpo) — grades grandes precisam do loop.
          let page = 1;
          while (page <= 50) {
            const { items, totalPages } = await AlterdataSyncService.apiGet(orgId, "supply", `/api/v1/CodigoDeBarras/ReferenciaRede/${encodeURIComponent(referencia)}/${encodeURIComponent(rede)}`, { page });
            if (items.length) bar.imported += AlterdataSupplyMapper.upsertCodigosDeBarras(orgId, items, referencia);
            if (!totalPages || page >= totalPages || items.length === 0) break;
            page++;
          }
          bar.refs++;
        } catch (e: any) {
          bar.errors++;
          const http = extractHttpStatus(e);
          ledger.record({
            module: "supply", resource: `CodigoDeBarras/${referencia}`,
            required: false,
            status: http === 401 ? "auth_failed" : (http === 404 ? "not_found" : "server_error"),
            httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
          });
        }
      }
      ledger.record({
        module: "supply", resource: "CodigoDeBarras", required: true,
        status: bar.imported > 0 ? "ready" : (bar.errors > 0 ? "server_error" : "empty_but_valid"),
        imported: bar.imported, mappingErrors: bar.errors, pages: bar.refs,
        errorCode: bar.errors > 0 ? "ALTERDATA_API" : null,
      });
    } else {
      ledger.record({
        module: "supply", resource: "CodigoDeBarras", required: true,
        status: "skipped_by_policy",
        errorCode: "TOULON_CONFIGURATION", errorMessage: "campo 'rede' vazio",
      });
    }

    const saldos = { applied: 0, skippedNoStore: 0, skippedNoProduct: 0, sampleNoProduct: [] as string[] };
    for (const filial of filiais) {
      try {
        const res = await AlterdataSyncService.syncResource(orgId, {
          moduleKey: "supply", resource: "Saldo", filial,
          buildPath: (c) => (filial ? `/api/v1/Saldo/versao/${filial}/${c}` : `/api/v1/Saldo/versao/${c}`),
          onItems: (items) => {
            const r = AlterdataStockMapper.upsertSaldos(orgId, items);
            saldos.applied += r.applied; saldos.skippedNoStore += r.skippedNoStore; saldos.skippedNoProduct += r.skippedNoProduct;
            for (const p of r.sampleNoProduct) if (saldos.sampleNoProduct.length < 5 && !saldos.sampleNoProduct.includes(p)) saldos.sampleNoProduct.push(p);
            return r.applied;
          },
        });
        ledger.record({
          module: "supply", resource: "Saldo", filial, required: true,
          status: res.imported > 0 ? "ready" : "empty_but_valid",
          cursorBefore: res.fromVersion, cursorAfter: res.toVersion,
          pages: res.pages, imported: res.imported,
        });
      } catch (e: any) {
        const http = extractHttpStatus(e);
        ledger.record({
          module: "supply", resource: "Saldo", filial, required: true,
          status: http === 401 ? "auth_failed" : "server_error",
          httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
        });
      }
    }

    // 4) Preço (módulo Price) — só quando a tabela de preço da rede está definida.
    //    O preço POR PRODUTO é o recurso `Preco` (produto, tabela, preco1) — o
    //    `TabelaPreco/versao` devolve só o CADASTRO das tabelas (sem produto,
    //    `preco: null`), visto na homologação Toulon. O path do delta do Preco
    //    varia entre instalações da ModaUp, então tenta os formatos conhecidos em
    //    ordem e fica no primeiro que devolver linhas de preço de verdade (com
    //    `produto`). Cursor isolado por formato (filial "tabela~i") para um
    //    formato errado não engolir o delta do formato certo.
    const precos = { applied: 0, skippedNoProduct: 0, sampleNoProduct: [] as string[] };
    const table = str(settings.priceTable);
    if (table) {
      // RF-14: mapa de formatos suportados. Chave = string estável guardada
      // no profile (`price_path_format`) pra que a próxima execução vá
      // DIRETO no formato que já funcionou — sem repetir 2-3 tentativas.
      const FORMATS: Record<string, (c: string) => string> = {
        "tabelaVersao":       (c) => `/api/v1/Preco/versao/${table}/${c}`,
        "versao":             (c) => `/api/v1/Preco/versao/${c}`,
        ...(rede ? { "redeTabelaVersao": (c: string) => `/api/v1/Preco/versao/${rede}/${table}/${c}` } : {}),
      };
      const cachedFormat = AlterdataProfileService.getPricePathFormat(orgId, environment);
      const orderedKeys = cachedFormat && FORMATS[cachedFormat]
        ? [cachedFormat, ...Object.keys(FORMATS).filter(k => k !== cachedFormat)]
        : Object.keys(FORMATS);
      const candidates: Array<{ key: string; build: (c: string) => string }> =
        orderedKeys.map(k => ({ key: k, build: FORMATS[k] }));
      let priceStatus: "ready" | "empty_but_valid" | "server_error" = "empty_but_valid";
      let lastError: any = null;
      let lastHttp: number | null = null;
      let winnerKey: string | null = null;
      for (let i = 0; i < candidates.length; i++) {
        try {
          // BUG-CURSOR-PRECO: a chave do cursor tem de ser o NOME do formato, não
          // a POSIÇÃO `i`. Quando o formato vencedor é cacheado, a ordem muda e o
          // mesmo formato passava a ler/gravar uma chave de posição diferente —
          // ressuscitando um cursor VELHO de outra posição (ex.: 141994718) que a
          // ModaUp responde 500 em `/versao/{valor}`, wedgeando o módulo (required)
          // em server_error. Chaveando por formato, cada formato tem UM cursor
          // estável que só avança; migração indolor (a chave nova nasce em "0" e
          // re-puxa o preço uma vez, depois os deltas são pequenos).
          await AlterdataSyncService.syncResource(orgId, {
            moduleKey: "price", resource: "Preco", filial: `${table}~${candidates[i].key}`,
            buildPath: candidates[i].build,
            onItems: (items) => {
              const r = AlterdataPriceMapper.upsertPrecos(orgId, items, table);
              precos.applied += r.applied; precos.skippedNoProduct += r.skippedNoProduct;
              for (const p of r.sampleNoProduct) if (precos.sampleNoProduct.length < 5 && !precos.sampleNoProduct.includes(p)) precos.sampleNoProduct.push(p);
              return r.applied;
            },
          });
        } catch (e: any) {
          lastError = e;
          lastHttp = extractHttpStatus(e);
          // formato inexistente nesta instalação (404/500) — tenta o próximo
        }
        if (precos.applied + precos.skippedNoProduct > 0) {
          priceStatus = "ready";
          winnerKey = candidates[i].key;
          break;
        }
      }
      // RF-14: persistir o formato vencedor NO PROFILE — próximo sync começa
      // direto por ele. Se o vencedor mudou (ex.: cliente reconfigurou), a
      // cache é atualizada; se o cache falhou e outro formato ganhou, sobrescreve.
      if (winnerKey && winnerKey !== cachedFormat) {
        try { AlterdataProfileService.setPricePathFormat(orgId, environment, winnerKey); } catch { /* noop */ }
      }
      if (priceStatus === "ready") {
        ledger.record({
          module: "price", resource: "Preco", filial: table, required: true,
          status: "ready", imported: precos.applied, skipped: precos.skippedNoProduct,
        });
      } else if (lastError) {
        ledger.record({
          module: "price", resource: "Preco", filial: table, required: true,
          status: lastHttp === 401 ? "auth_failed" : "server_error",
          httpStatus: lastHttp, errorCode: classifyError(lastError, lastHttp), errorMessage: lastError,
        });
      } else {
        ledger.record({
          module: "price", resource: "Preco", filial: table, required: true,
          status: "empty_but_valid",
        });
      }
    } else {
      ledger.record({
        module: "price", resource: "Preco", required: true,
        status: "skipped_by_policy",
        errorCode: "TOULON_CONFIGURATION", errorMessage: "priceTable ausente",
      });
    }

    // 5) FECHAMENTO DO PDV (módulo Sales — Fase 2): DataCaixa/versao é o stream
    //    de caixas por filial/dia/turno. Para cada caixa FECHADO (finalizado2=1)
    //    de loja cadastrada, busca o ResumoFecharMovimento e grava o "Total de
    //    Vendas" como system_total do fechamento diário — a aba Divergência se
    //    concilia sozinha, sem CSV. Falha do módulo Sales NÃO derruba o sync.
    const caixas = { applied: 0, skippedNoStore: 0, errors: 0 };
    try {
      const CAIXA_BACKFILL_DAYS = 90; // resumo custa 1 chamada POR caixa — não varre anos
      const closed: Array<{ filial: string; date: string; turno: number }> = [];
      await AlterdataSyncService.syncResource(orgId, {
        moduleKey: "sales", resource: "DataCaixa", maxPages: 400,
        buildPath: (c) => `/api/v1/DataCaixa/versao/${c}`,
        onItems: (items) => {
          let n = 0;
          for (const it of items) {
            const filial = str(it?.filial);
            const date = str(it?.data).slice(0, 10);
            if (!filial || !date) continue;
            if (Number(it?.finalizado2) !== 1) continue; // caixa ainda aberto
            closed.push({ filial, date, turno: Math.max(1, Number(it?.turno) || 1) });
            n++;
          }
          return n;
        },
      });
      const cutoff = new Date(Date.now() - CAIXA_BACKFILL_DAYS * 86_400_000).toISOString().slice(0, 10);
      // Agrupa por loja+dia somando os TURNOS (raro ter 2º turno, mas existe).
      const groups = new Map<string, { filial: string; date: string; turnos: Set<number> }>();
      for (const c of closed) {
        if (c.date < cutoff) continue;
        const k = `${c.filial}|${c.date}`;
        const g = groups.get(k) || { filial: c.filial, date: c.date, turnos: new Set<number>() };
        g.turnos.add(c.turno);
        groups.set(k, g);
      }
      const storeCache = new Map<string, string | null>();
      const storeIdFor = (filial: string): string | null => {
        if (!storeCache.has(filial)) {
          const row = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND (code = ? OR id = ?) AND active = 1 LIMIT 1`).get(orgId, filial, filial) as any;
          storeCache.set(filial, row?.id || null);
        }
        return storeCache.get(filial) || null;
      };
      // Fechamento AUTOMÁTICO pelo PDV (opt-in): preenche o fechamento PENDENTE
      // com o total e as formas de pagamento do PDV — a loja não digita nada.
      // Quem informou manualmente antes continua valendo (supervisionado).
      const autoClosing = AlterdataConnectorService.isPdvAutoClosing(orgId);
      const PAY_TITLES: Record<string, string> = { "dinheiro": "dinheiro", "cheque": "cheque", "cartão": "cartao", "cartao": "cartao", "pix": "pix", "outros": "outros" };
      for (const g of groups.values()) {
        const storeId = storeIdFor(g.filial);
        if (!storeId) { caixas.skippedNoStore++; continue; }
        // 19/09/2026 (caso Toulon "R$ 100 sumiram do dia") — total POR TURNO,
        // não somado aqui: o delta só traz os turnos fechados DESDE o último
        // sync; quando o turno 1 fecha de manhã e o 2 à noite, este loop via só
        // um deles por rodada e o total do dia era SOBRESCRITO com o subset.
        // O merge por turno (applyPdvTurnoTotals) soma o dia inteiro sempre.
        const turnoTotals: Record<string, number> = {};
        let got = false;
        const pay = new Map<string, number>();
        for (const turno of g.turnos) {
          try {
            const { items } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(g.filial)}/${g.date}/${turno}`);
            for (const r of items as any[]) {
              const titulo = String(r?.titulo || "").trim().toLowerCase();
              const valor = Number(r?.valor || 0);
              if (titulo === "total de vendas") { turnoTotals[String(turno)] = (turnoTotals[String(turno)] || 0) + valor; got = true; }
              else if (PAY_TITLES[titulo] && valor > 0) pay.set(PAY_TITLES[titulo], (pay.get(PAY_TITLES[titulo]) || 0) + valor);
            }
          } catch (e: any) {
            caixas.errors++;
            const http = extractHttpStatus(e);
            ledger.record({
              module: "sales", resource: `DataCaixa/ResumoFecharMovimento/${g.filial}/${g.date}/${turno}`,
              filial: g.filial, required: false,
              status: http === 401 ? "auth_failed" : "server_error",
              httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
            });
          }
        }
        if (!got) continue;
        const applied = RetailReconciliationService.applyPdvTurnoTotals(orgId, storeId, g.date, turnoTotals);
        const totalR = applied.mergedTotal; // dia INTEIRO (todos os turnos já vistos)
        if (autoClosing && totalR > 0) {
          const closing = RetailClosingService.getOrCreate(orgId, storeId, g.date);
          if (closing?.status === "pending" && Number(closing.informed_total || 0) === 0) {
            RetailClosingService.setInformed(orgId, closing.id, {
              informedTotal: totalR,
              items: Array.from(pay.entries()).map(([paymentMethod, v]) => ({ paymentMethod, informedAmount: Math.round(v * 100) / 100 })),
              source: "pdv",
            });
            // A divergência foi calculada ANTES do preenchimento (informado era
            // 0 → not_checked); recalcula agora que o informado existe.
            RetailReconciliationService.applyPdvTotal(orgId, storeId, g.date, totalR);
          }
        }
        caixas.applied++;
      }

      // RETROATIVO: fechamentos que JÁ têm o total do PDV (system_total gravado
      // por syncs anteriores) mas seguem pendentes — acontece quando o modo
      // automático é ligado DEPOIS do sync que os trouxe (o delta do DataCaixa
      // não revisita caixas antigos). Preenche direto do banco, sem API.
      if (autoClosing) {
        const pendentes = db.prepare(
          `SELECT id, store_id, closing_date, system_total FROM retail_daily_closings
            WHERE organization_id = ? AND status = 'pending' AND COALESCE(informed_total, 0) = 0
              AND COALESCE(system_total, 0) > 0 AND closing_date >= date('now', '-90 days')`
        ).all(orgId) as any[];
        for (const c of pendentes) {
          RetailClosingService.setInformed(orgId, c.id, { informedTotal: Number(c.system_total), source: "pdv" });
          RetailReconciliationService.applyPdvTotal(orgId, c.store_id, c.closing_date, Number(c.system_total));
          caixas.applied++;
        }
      }
      ledger.record({
        module: "sales", resource: "DataCaixa", required: true,
        status: caixas.applied > 0 ? "ready" : "empty_but_valid",
        imported: caixas.applied, skipped: caixas.skippedNoStore,
        mappingErrors: caixas.errors,
      });
    } catch (e: any) {
      const http = extractHttpStatus(e);
      ledger.record({
        module: "sales", resource: "DataCaixa", required: true,
        status: http === 401 ? "auth_failed" : "server_error",
        httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
      });
    }

    // 5b) RECONFERÊNCIA automática dos últimos dias — best-effort, nunca
    //     derruba o sync (throttle próprio dentro do método).
    try { await AlterdataSyncRunner.recheckRecentClosings(orgId, ledger); } catch { /* noop */ }

    // 6) VENDAS DO PDV (módulo Sales — Fase 4): VendaMalote/versao é o stream
    //    venda a venda do caixa, com a MATRÍCULA do vendedor, valor, peças e
    //    formas de pagamento. Alimenta a comissão por vendedor e os rankings
    //    reais da rede. Falha do endpoint não derruba o sync.
    const vendas = { imported: 0 };
    try {
      const insVenda = db.prepare(
        `INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, vendedor, usuario, vendedor_codigo, valor, pecas, status, payments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, filial, boleta, sale_date) DO UPDATE SET
           sale_time = excluded.sale_time, vendedor = excluded.vendedor, usuario = excluded.usuario, vendedor_codigo = excluded.vendedor_codigo,
           valor = excluded.valor, pecas = excluded.pecas, status = excluded.status, payments_json = excluded.payments_json`
      );
      // Itens de venda (vendas[]): produto, quantidade, valor, comissão e o
      // vendedor POR LINHA (nome do campo varia — tenta os candidatos).
      const insItem = db.prepare(
        `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, comissao, vendedor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, filial, boleta, sale_date, item_seq) DO UPDATE SET
           produto = excluded.produto, quantidade = excluded.quantidade, valor = excluded.valor,
           comissao = excluded.comissao, vendedor = excluded.vendedor,
           -- PERF-001: se o código do produto mudou, invalida a resolução (o
           -- backfill re-resolve). Item novo entra com resolved_at NULL.
           catalog_resolved_at = CASE WHEN retail_pdv_sale_items.produto <> excluded.produto THEN NULL ELSE retail_pdv_sale_items.catalog_resolved_at END`
      );
      // Parcelas de cartão (parcelasCartao): recebíveis com líquido/taxa/vencimento.
      const insCard = db.prepare(
        `INSERT INTO retail_pdv_card_installments (id, organization_id, filial, boleta, sale_date, numero, parcela, seq, codigo_cartao, valor, liquido, taxa, vencimento)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, filial, numero, parcela, seq) DO UPDATE SET
           valor = excluded.valor, liquido = excluded.liquido, taxa = excluded.taxa,
           vencimento = excluded.vencimento, codigo_cartao = excluded.codigo_cartao, sale_date = excluded.sale_date`
      );
      await AlterdataSyncService.syncResource(orgId, {
        // Lotes de ~20 vendas: 250 iterações ≈ 5000 vendas/execução — o
        // histórico da rede (dezenas de milhares) completa em algumas horas
        // com o agendador de 15 min.
        moduleKey: "sales", resource: "VendaMalote", maxPages: 250,
        buildPath: (c) => `/api/v1/VendaMalote/versao/${c}`,
        onItems: (items) => {
          let n = 0;
          for (const it of items) {
            const cx = it?.caixa ?? it; // o item vem { caixa: {...}, ... } (contrato real) ou plano
            const filial = str(cx?.filial);
            const boleta = str(cx?.boleta);
            const date = str(cx?.data).slice(0, 10);
            if (!filial || !boleta || !date) continue;
            const payments = {
              dinheiro: Number(cx?.dinheiro || 0), cartao: Number(cx?.cartao || 0), debito: Number(cx?.debito || 0),
              creditoParcelado: Number(cx?.creditoParcelado || 0), cheque: Number(cx?.cheque || 0),
              vale: Number(cx?.vale || 0), deposito: Number(cx?.deposito || 0), crediario: Number(cx?.crediario || 0),
            };
            // Homologação Toulon (ADR-105): a `matricula` do caixa é o OPERADOR;
            // o VENDEDOR da comissão é o CAI_USUARIO (relação com VENDEDORES via
            // VEN_CODIGO = CAI_CODIGO). No payload da ModaUp o CAI_USUARIO chega
            // como `usuario`; aceitamos candidatos explícitos por robustez.
            const vendedorCodigo = str(cx?.vendedorCodigo ?? cx?.codigoVendedor ?? cx?.venCodigo ?? cx?.caiUsuario ?? cx?.usuario) || null;
            insVenda.run(
              randomUUID(), orgId, filial, boleta, date, str(cx?.hora) || null, str(cx?.matricula) || null,
              str(cx?.usuario) || null, vendedorCodigo, Number(cx?.valor || 0), Number(cx?.vendidas || 0), str(cx?.status) || null, JSON.stringify(payments)
            );
            // Itens vendidos (linhas): mais-vendidos + vendedor por linha.
            const linhas = Array.isArray(it?.vendas) ? it.vendas : (Array.isArray(cx?.vendas) ? cx.vendas : []);
            linhas.forEach((ln: any, idx: number) => {
              const seq = Number(ln?.item ?? ln?.seq ?? idx + 1);
              const vend = str(ln?.vendedor ?? ln?.matricula ?? ln?.usuario ?? ln?.matriculaVendedor ?? ln?.codVendedor) || null;
              insItem.run(
                randomUUID(), orgId, filial, boleta, date, seq,
                str(ln?.produto) || null, Number(ln?.quantidade || 0), Number(ln?.valor || 0),
                Number(ln?.comissao || 0), vend
              );
            });
            // Parcelas de cartão (recebíveis): do item ou do caixa.
            const parcelas = Array.isArray(it?.parcelasCartao) ? it.parcelasCartao : (Array.isArray(cx?.parcelasCartao) ? cx.parcelasCartao : []);
            parcelas.forEach((pc: any, idx: number) => {
              insCard.run(
                randomUUID(), orgId, filial, boleta, date,
                str(pc?.numero) || null, str(pc?.parcela) || null, Number(pc?.seq ?? idx + 1),
                str(pc?.codigoCartao) || null, Number(pc?.valor || 0), Number(pc?.liquido || 0),
                Number(pc?.taxa || 0), str(pc?.vencimento).slice(0, 10) || null
              );
            });
            n++;
          }
          vendas.imported += n;
          return n;
        },
      });
      ledger.record({
        module: "sales", resource: "VendaMalote", required: true,
        status: vendas.imported > 0 ? "ready" : "empty_but_valid",
        imported: vendas.imported,
      });
    } catch (e: any) {
      const http = extractHttpStatus(e);
      ledger.record({
        module: "sales", resource: "VendaMalote", required: true,
        status: http === 401 ? "auth_failed" : "server_error",
        httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
      });
    }

    // 6b) COMISSÃO POR VENDEDOR do ERP (módulo Sales — Cenário A): o VendaMalote
    //    traz só o OPERADOR do caixa; o vendedor individual e a comissão JÁ
    //    calculada vêm do relatório Venda/ComissaoVendasPorPeriodo. Guarda o valor
    //    vendido (BASE para as nossas regras) e a comissao_erp (conferência de
    //    divergência). Varre MÊS A MÊS uma janela de backfill — o histórico de
    //    homologação é de meses atrás, então uma janela curta viria vazia; cada
    //    chamada é um agregado por vendedor (barato) e o upsert é idempotente por
    //    (filial, matrícula, mês). O mapper é defensivo (tenta os nomes de campo
    //    mais prováveis). Falha do endpoint NÃO derruba o sync.
    const erpComissao = { imported: 0 };
    try {
      const COMMISSION_BACKFILL_MONTHS = 18;
      // Dedupe entre janelas pela MESMA chave natural do ingest (filial|matrícula|
      // dia) — se o payload não tiver data por linha, cada mês cai no seu fim-de-mês
      // (`w.end`), então meses distintos não colidem e o mesmo vendedor não conta 2x.
      const byKey = new Map<string, ErpSellerSaleRow>();
      for (const w of lastMonthsWindows(COMMISSION_BACKFILL_MONTHS)) {
        let page = 1;
        while (page <= 50) {
          const { items, totalPages, body } = await AlterdataSyncService.apiGet(
            orgId, "sales", `/api/v1/Venda/ComissaoVendasPorPeriodo/${w.start}/${w.end}`, { page }
          );
          // Contrato REAL da ModaUp (homologação Toulon): as linhas por vendedor
          // vêm ANINHADAS em `data.metaVendedorRealizado[]` (realizado = valor
          // vendido + comissão) — NÃO num array plano, então a extração genérica
          // (`items`) não as alcança. `data.metaVendedor[]` é a META (alvo), e é
          // ignorada de propósito para não contar alvo como venda. Cai para
          // `items` em instalações que porventura devolvam um array plano.
          const realizado = body?.data?.metaVendedorRealizado;
          const rowsPage: any[] = Array.isArray(realizado) ? realizado : items;
          for (const it of rowsPage) {
            const row = RetailErpSellerSalesService.mapErpRow(it, w.end);
            if (row) byKey.set(`${row.filial || ""}|${row.matricula || (row.sellerName || "").toLowerCase()}|${row.saleDate}`, row);
          }
          if (!totalPages || page >= totalPages || rowsPage.length === 0) break;
          page++;
        }
      }
      if (byKey.size) erpComissao.imported += RetailErpSellerSalesService.ingest(orgId, Array.from(byKey.values()));
      ledger.record({
        module: "sales", resource: "Venda/ComissaoVendasPorPeriodo", required: false,
        status: erpComissao.imported > 0 ? "ready" : "empty_but_valid",
        imported: erpComissao.imported,
      });
    } catch (e: any) {
      const http = extractHttpStatus(e);
      ledger.record({
        module: "sales", resource: "Venda/ComissaoVendasPorPeriodo", required: false,
        status: http === 401 ? "auth_failed" : "server_error",
        httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
      });
    }

    // 7) CLIENTES DO PDV (módulo CRM — Fase 3, OPT-IN por LGPD): ClienteMalote/
    //    versao é o stream de clientes (item embrulha em `cliente`). Vai para uma
    //    base SEPARADA (retail_pdv_customers), não para os contatos do WhatsApp.
    const clientes = { imported: 0 };
    if (AlterdataConnectorService.isPdvCustomerImport(orgId)) {
      // PDV por loja (Caminho 2a): o stream `ClienteMalote` traz a REDE inteira;
      // quando a conta opta por escopo (flag) E tem filiais, filtra pela filial.
      // null → sem filtro (0-regressão; a TOULON segue com a base consolidada).
      const filialAllow: Set<string> | null = AlterdataConnectorService.pdvFilialAllowSet(orgId, settings.filiais);
      try {
        const insCli = db.prepare(
          `INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, cpf, celular, email, nascimento, filial, cidade, bairro, primeira_compra, ultima_compra, inativo, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(organization_id, codigo_n) DO UPDATE SET
             nome = excluded.nome, cpf = excluded.cpf, celular = excluded.celular, email = excluded.email,
             nascimento = excluded.nascimento, filial = excluded.filial, cidade = excluded.cidade, bairro = excluded.bairro,
             primeira_compra = excluded.primeira_compra, ultima_compra = excluded.ultima_compra, inativo = excluded.inativo,
             updated_at = CURRENT_TIMESTAMP`
        );
        await AlterdataSyncService.syncResource(orgId, {
          moduleKey: "crm", resource: "ClienteMalote", maxPages: 200,
          buildPath: (c) => `/api/v1/ClienteMalote/versao/${c}`,
          onItems: (items) => {
            let n = 0;
            for (const it of items) {
              const c = it?.cliente ?? it;
              const codigoN = str(c?.codigoN ?? c?.codigon);
              if (!codigoN) continue;
              // PDV por loja: pula cliente de outra filial quando a conta é escopada.
              if (filialAllow && !filialAllow.has(str(c?.filial).trim().toUpperCase())) continue;
              insCli.run(
                randomUUID(), orgId, codigoN, str(c?.nome) || null, str(c?.cgc) || null,
                str(c?.celular) || str(c?.telefone) || null, str(c?.email) || null,
                str(c?.nascimento).slice(0, 10) || null, str(c?.filial) || null,
                str(c?.cidade) || null, str(c?.bairro) || null,
                str(c?.primeiraCompra).slice(0, 10) || null, str(c?.ultimaCompra).slice(0, 10) || null,
                Number(c?.inativo) === 1 ? 1 : 0
              );
              n++;
            }
            clientes.imported += n;
            return n;
          },
        });
        ledger.record({
          module: "crm", resource: "ClienteMalote", required: false,
          status: clientes.imported > 0 ? "ready" : "empty_but_valid",
          imported: clientes.imported,
        });
      } catch (e: any) {
        const http = extractHttpStatus(e);
        ledger.record({
          module: "crm", resource: "ClienteMalote", required: false,
          status: http === 401 ? "auth_failed" : "server_error",
          httpStatus: http, errorCode: classifyError(e, http), errorMessage: e,
        });
      }
    } else {
      // CRM tem policy 'conditional' (RF-05): sem opt-in do PDV, é skip legítimo.
      ledger.record({
        module: "crm", resource: "ClienteMalote", required: false,
        status: "skipped_by_policy",
        errorCode: "LGPD_APPROVAL", errorMessage: "pdvCustomerImport off",
      });
    }

    // Preço de EXIBIÇÃO do produto: o ERP precifica por VARIANTE (grade), mas o
    // card do catálogo e a vitrine mostram products_services.price — que veio
    // 0.0 da Referencia. Sem isso, o produto aparece "R$ 0,00" mesmo com as
    // variantes precificadas. Preenche com o MENOR preço (>0) das variantes
    // quando o produto está sem preço (idempotente; roda a cada sync).
    try {
      db.prepare(
        `UPDATE products_services SET price = (
            SELECT MIN(v.price) FROM product_variants v
             WHERE v.product_service_id = products_services.id AND v.price > 0)
          WHERE organization_id = ? AND (price IS NULL OR price <= 0)
            AND EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_service_id = products_services.id AND v2.price > 0)`
      ).run(orgId);
    } catch { /* noop */ }

    // Totais acumulados — o "N produtos" de cada execução é igual até o catálogo
    // acabar; o TOTAL crescendo é a prova de que o cursor está avançando.
    const totalProdutos = Number((db.prepare(`SELECT COUNT(*) c FROM products_services WHERE organization_id = ? AND external_ref IS NOT NULL AND external_ref <> ''`).get(orgId) as any)?.c || 0);
    const totalVariantes = Number((db.prepare(`SELECT COUNT(*) c FROM product_variants WHERE organization_id = ?`).get(orgId) as any)?.c || 0);
    const summary: SyncRunSummary = {
      referencias: ref.imported, totalProdutos, totalVariantes, variantes: bar.imported, saldos, precos, caixas, vendas, erpComissao, clientes, filiais,
      ranAt: new Date().toISOString(),
    };
    // Marca a última execução (gate do Scheduler) via cursor '_meta'/'lastRun'
    // e persiste o resumo (a ressincronização roda em background — a tela lê o
    // resultado em GET /alterdata/last-sync).
    AlterdataConnectorService.setCursor(orgId, "_meta", "lastRun", "", String(Date.now()));
    try { AlterdataConnectorService.setCursor(orgId, "_meta", "lastSummary", "", JSON.stringify(summary)); } catch { /* noop */ }
    // PERF-005: a sincronização reescreveu vendas/preços/saldos → invalida o
    // cache das telas analíticas pra elas recomputarem com o dado fresco.
    try { const { RetailAnalyticsCache } = await import("./RetailAnalyticsCache.js"); RetailAnalyticsCache.invalidate(orgId); } catch { /* noop */ }
    try { logAuthEvent(orgId, "system", "alterdata", "ALTERDATA_SYNC_RUN", summary as any); } catch { /* noop */ }
    const finalStatus = ledger.finish();
    summary.runStatus = finalStatus;
    summary.runId = ledger.runId;
    summary.correlationId = ledger.correlationId;
    return summary;
    } catch (e: any) {
      // RF-08: qualquer erro que escapou fica REGISTRADO como ZAPFLOW_CODE (bug
      // interno) antes de propagar — a run fecha como `failed`.
      ledger.record({
        module: "_meta", resource: "runOrgInner", required: true,
        status: "server_error",
        errorCode: classifyError(e), errorMessage: e,
      });
      ledger.finish({ status: "failed" });
      throw e;
    }
  }

  /**
   * DIAGNÓSTICO ("Testar módulos"): probe cada endpoint separadamente (sem
   * retry, sem lançar) para isolar, por eliminação, qual está devolvendo 500 na
   * homologação. Não grava nada, não respeita a flag `enabled` — é só teste.
   */
  static async probeOrg(orgId: string): Promise<Array<{ resource: string; module: string; path: string; url: string | null; status: number; ok: boolean; snippet: string }>> {
    const settings = AlterdataConnectorService.publicSettings(orgId);
    const filiais: string[] = Array.isArray(settings.filiais) && settings.filiais.length ? settings.filiais : [""];
    const rede = str(settings.rede);
    const table = str(settings.priceTable);

    const out: Array<{ resource: string; module: string; path: string; url: string | null; status: number; ok: boolean; snippet: string }> = [];
    const run = async (resource: string, moduleKey: string, path: string) => {
      const p = await AlterdataSyncService.probe(orgId, moduleKey, path);
      out.push({ resource, ...p });
    };

    await run("Referencia", "supply", "/api/v1/Referencia/versao/0");
    // Barras não têm delta `/versao`; testa um GET real do módulo de barras.
    // CodigoProdutoTipo/{rede} depende só da rede (a leitura de barras em si é
    // por referência: ReferenciaRede/{referencia}/{rede}).
    if (rede) await run("CodigoDeBarras", "supply", `/api/v1/CodigoDeBarras/CodigoProdutoTipo/${encodeURIComponent(rede)}`);
    else out.push({ resource: "CodigoDeBarras", module: "supply", path: "(sem rede)", url: null, status: 0, ok: false, snippet: "Preencha o campo Rede para testar o módulo de código de barras." });
    // Amostra de barras POR REFERÊNCIA (o endpoint que o sync usa de verdade):
    // revela os CAMPOS reais do payload (produto ERP / EAN) usados no casamento
    // de saldo e preço com as variantes.
    if (rede) {
      const sample = db.prepare(`SELECT external_ref FROM products_services WHERE organization_id = ? AND external_ref IS NOT NULL AND external_ref <> '' LIMIT 1`).get(orgId) as any;
      if (sample?.external_ref) await run(`CodigoDeBarras (ref ${sample.external_ref})`, "supply", `/api/v1/CodigoDeBarras/ReferenciaRede/${encodeURIComponent(sample.external_ref)}/${encodeURIComponent(rede)}`);
    }
    for (const filial of filiais) {
      await run(filial ? `Saldo (filial ${filial})` : "Saldo", "supply", filial ? `/api/v1/Saldo/versao/${filial}/0` : "/api/v1/Saldo/versao/0");
    }
    if (table) {
      await run(`TabelaPreco (cadastro de tabelas)`, "price", `/api/v1/TabelaPreco/versao/0`);
      // Preço POR PRODUTO: o path do delta varia entre instalações — testa os
      // formatos conhecidos; o corpo de cada um mostra qual devolve linhas.
      await run(`Preco (formato tabela/versao)`, "price", `/api/v1/Preco/versao/${table}/0`);
      await run(`Preco (formato versao)`, "price", `/api/v1/Preco/versao/0`);
      if (rede) await run(`Preco (formato rede/tabela/versao)`, "price", `/api/v1/Preco/versao/${rede}/${table}/0`);
      // DIAGNÓSTICO do 500 no DELTA: os probes acima usam cursor 0 e respondem
      // 200, mas o sync usa o CURSOR ALTO guardado (o delta) e leva server_error.
      // Reproduz a chamada EXATA que falha lendo o cursor real guardado — decide
      // ModaUp (o endpoint quebra em cursor alto) vs. nosso (cursor mal montado).
      const env: AlterdataEnvironment = settings.environment === "prod" ? "prod" : "homolog";
      let priceCursors: any[] = [];
      try {
        priceCursors = db.prepare(
          `SELECT filial, version FROM alterdata_sync_cursors
            WHERE organization_id = ? AND environment = ? AND module = 'price' AND resource = 'Preco'
              AND version IS NOT NULL AND version <> '' AND version <> '0'`
        ).all(orgId, env) as any[];
      } catch { priceCursors = []; }
      const seenCursor = new Set<string>();
      for (const pc of priceCursors) {
        const c = String(pc.version || "").split("|")[0].trim(); // ignora sufixo de página
        if (!c || c === "0" || seenCursor.has(c)) continue;
        seenCursor.add(c);
        if (rede) await run(`Preco DELTA cursor real ${c} (rede/tabela/versao)`, "price", `/api/v1/Preco/versao/${rede}/${table}/${encodeURIComponent(c)}`);
        await run(`Preco DELTA cursor real ${c} (tabela/versao)`, "price", `/api/v1/Preco/versao/${table}/${encodeURIComponent(c)}`);
      }
      if (!seenCursor.size) {
        out.push({ resource: "Preco DELTA", module: "price", path: "(sem cursor guardado)", url: null, status: 0, ok: false, snippet: "Nenhum cursor de preço guardado ainda para reproduzir o delta — rode um sync de preço antes." });
      }
    } else {
      out.push({ resource: "Preco", module: "price", path: "(sem tabela)", url: null, status: 0, ok: false, snippet: "Preencha a Tabela de preço da rede para testar o módulo de preço." });
    }

    // MÓDULO SALES (Fase 2 — fechamento do PDV): sonda os endpoints de caixa da
    // ModaUp para revelar o FORMATO real das respostas (mesmo método que
    // destravou o preço). Alvo: preencher a conferência do fechamento diário
    // (retail_daily_closings.system_total) direto do PDV, sem CSV.
    const hoje = new Date().toISOString().slice(0, 10);
    const f0 = filiais.find((f) => f) || "";
    await run("DataCaixa (delta versao)", "sales", `/api/v1/DataCaixa/versao/0`);
    // MÓDULO CRM (Fase 3 — clientes do PDV): controllers reais confirmados no
    // Swagger do cliente — ClienteMalote/versao é o stream versionado com o
    // cadastro completo; o corpo revela os campos p/ mapear em contacts.
    await run("CRM ClienteMalote (delta versao)", "crm", `/api/v1/ClienteMalote/versao/0`);
    await run("CRM ClienteCodigo (delta versao)", "crm", `/api/v1/ClienteCodigo/versao/0`);
    // FASE 4 (comissão por vendedor / vendas reais): controller Venda do módulo
    // Sales — o corpo revela o shape da comissão por vendedor e do stream de
    // vendas (VendaMalote/versao é versionado, igual aos que já sincronizamos).
    // Comissão POR VENDEDOR calculada pelo ERP — janela LARGA (18 meses): o
    // histórico de homologação é de meses atrás, então uma janela curta vinha
    // vazia e escondia o formato real do payload. É a fonte correta do vendedor
    // individual (o VendaMalote só tem o operador de caixa).
    const janelaComissao = new Date(Date.now() - 548 * 86_400_000).toISOString().slice(0, 10);
    await run("Venda Comissão (18 meses)", "sales", `/api/v1/Venda/ComissaoVendasPorPeriodo/${janelaComissao}/${hoje}`);
    await run("VendaMalote (delta versao)", "sales", `/api/v1/VendaMalote/versao/0`);
    await run("VendaMalote (resumo por filial)", "sales", `/api/v1/VendaMalote/relatorio/resumo/porfilial`);
    if (f0) {
      await run(`DataCaixa (últ. movimento filial ${f0})`, "sales", `/api/v1/DataCaixa/UltimoMovimento/${encodeURIComponent(f0)}`);
      await run(`DataCaixa (dia ${hoje} filial ${f0})`, "sales", `/api/v1/DataCaixa/${hoje}/${encodeURIComponent(f0)}`);
      await run(`ResumoFecharMovimento (filial ${f0})`, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(f0)}/${hoje}/1`);
      // DIAGNÓSTICO do backfill de fechamento: o "Recuperar fechamentos" busca o
      // ResumoFecharMovimento em DIAS PASSADOS. Se o endpoint só servir o dia
      // ATUAL (devolvendo 0/erro pra datas antigas), o backfill aplica 0 e a loja
      // segue zerada. Estes probes em datas passadas respondem, com prova, se o
      // endpoint serve histórico — "Total de Vendas" > 0 num dia passado = serve.
      for (const back of [7, 21, 45]) {
        const d = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
        await run(`ResumoFecharMovimento HISTÓRICO (filial ${f0}, ${back}d atrás = ${d})`, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(f0)}/${d}/1`);
      }
    }
    return out;
  }

  /**
   * FILIAIS ÓRFÃS (diagnóstico): cruza as filiais que VENDEM no ERP (VendaMalote
   * resumo por filial) com as lojas cadastradas. As que têm venda e NÃO têm loja
   * são órfãs — o PDV delas é descartado no sync. Pra cada órfã, busca a ÚLTIMA
   * data de movimento (DataCaixa/UltimoMovimento): uma órfã com movimento
   * RECENTE é candidata a "pra onde a operação migrou" (ex.: a Grande Rio 1006
   * ficou muda em 10/08 e a loja pode ter seguido em outra filial). Read-only,
   * não grava, não lança (best-effort por filial). Isolado por org.
   */
  /**
   * RAIO-X DO DIA (19/09/2026 — caso Toulon "faltam R$ 3.108,10 de cartão"):
   * a folha da loja fechou o dia em R$ 5.476,80, mas o "Total de Vendas" do
   * ResumoFecharMovimento devolveu R$ 2.368,60 — a linha que usamos como
   * system_total NÃO abrange todas as formas. Este diagnóstico mostra, lado a
   * lado e SEM interpretar:
   *  1. as linhas CRUAS do resumo do caixa (título → valor, por turno) — é
   *     aqui que se enxerga em QUAL linha o cartão está (ou se não está);
   *  2. a soma das BOLETAS do VendaMalote já sincronizadas no banco (a fonte
   *     granular, venda a venda) — se ela bate com a folha, o PDV conhece as
   *     vendas e o problema é a escolha da linha; se também vier menor, as
   *     vendas não passaram no caixa da Alterdata (divergência REAL);
   *  3. o que está gravado no fechamento (system_total/turnos/informado).
   * Read-only; nada é gravado. A CORREÇÃO da derivação só entra com esse
   * raio-x na mão (nunca chutar qual linha somar — RN: não inventa).
   */
  static async dayXray(orgId: string, filial: string, date: string): Promise<{
    filial: string; date: string;
    resumo: Array<{ turno: number; titulo: string; valor: number }>;
    resumoTotais: Record<string, number>;
    boletas: { count: number; cancelled: number; total: number; byBoleta: Array<{ boleta: string; valor: number; status: string | null }> };
    closing: { systemTotal: number | null; systemTurnos: Record<string, number> | null; informedTotal: number | null; status: string | null } | null;
    // Estado da CONSULTA AO VIVO (não confundir "não consegui consultar" com
    // "não houve movimento"): success_with_rows | success_empty | auth_error |
    // request_error | partial_success. `turnos` traz o estado de cada turno.
    queryState: "success_with_rows" | "success_empty" | "auth_error" | "request_error" | "partial_success";
    turnos: Array<{ turno: number; state: "rows" | "empty" | "auth" | "error"; detail?: string }>;
    authError: { message: string; at: string } | null;
    lastSystemDataAt: string | null;   // última vez que a AlterData entregou system_total p/ esta filial
    errors: string[];
  }> {
    const f = str(filial);
    const d = String(date || "").slice(0, 10);
    const out = {
      filial: f, date: d,
      resumo: [] as Array<{ turno: number; titulo: string; valor: number }>,
      resumoTotais: {} as Record<string, number>,
      boletas: { count: 0, cancelled: 0, total: 0, byBoleta: [] as Array<{ boleta: string; valor: number; status: string | null }> },
      closing: null as any,
      queryState: "success_empty" as "success_with_rows" | "success_empty" | "auth_error" | "request_error" | "partial_success",
      turnos: [] as Array<{ turno: number; state: "rows" | "empty" | "auth" | "error"; detail?: string }>,
      authError: null as { message: string; at: string } | null,
      lastSystemDataAt: null as string | null,
      errors: [] as string[],
    };
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { out.errors.push("filial e data (YYYY-MM-DD) são obrigatórias"); out.queryState = "request_error"; return out; }
    // 1) Linhas CRUAS do resumo, turnos 1..3 (o 3º é raro; barato no diagnóstico).
    for (const turno of [1, 2, 3]) {
      try {
        const { items } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(f)}/${d}/${turno}`);
        let rowsHere = 0;
        for (const r of items as any[]) {
          const titulo = String(r?.titulo || "").trim();
          const valor = Math.round(Number(r?.valor || 0) * 100) / 100;
          if (!titulo && !valor) continue;
          out.resumo.push({ turno, titulo, valor });
          rowsHere++;
          const k = titulo.toLowerCase();
          out.resumoTotais[k] = Math.round(((out.resumoTotais[k] || 0) + valor) * 100) / 100;
        }
        // Resposta OK: com linhas (movimento) ou vazia de verdade (sem caixa).
        out.turnos.push({ turno, state: rowsHere > 0 ? "rows" : "empty" });
      } catch (e: any) {
        const msg = String(e?.message || e);
        // Falha de AUTENTICAÇÃO ≠ "sem movimento": distingue explicitamente.
        const isAuth = /credenciais ausentes|guardian/i.test(msg);
        out.turnos.push({ turno, state: isAuth ? "auth" : "error", detail: msg.slice(0, 120) });
        out.errors.push(`turno ${turno}: ${msg.slice(0, 120)}`);
      }
    }
    // Agrega o estado da consulta ao vivo (auth domina o "vazio" — nunca deixa
    // uma falha de credencial parecer dia sem movimento).
    const st = out.turnos.map((t) => t.state);
    const anyRows = st.includes("rows"), anyAuth = st.includes("auth"), anyErr = st.includes("error");
    if (anyRows) out.queryState = (anyAuth || anyErr) ? "partial_success" : "success_with_rows";
    else if (anyAuth) out.queryState = "auth_error";
    else if (anyErr) out.queryState = "request_error";
    else out.queryState = "success_empty";
    // Lido DEPOIS dos turnos: a falha de credencial só é registrada quando o
    // acquireToken roda no meio da consulta acima.
    out.authError = AlterdataConnectorService.getAuthFailure(orgId);
    // 2) Boletas do VendaMalote já no banco (fonte granular do MESMO dia).
    const rows = db.prepare(
      `SELECT boleta, valor, status FROM retail_pdv_sales WHERE organization_id = ? AND filial = ? AND sale_date = ? ORDER BY boleta`
    ).all(orgId, f, d) as any[];
    for (const r of rows) {
      const cancelled = String(r.status || "N") === "C";
      if (cancelled) { out.boletas.cancelled++; continue; }
      out.boletas.count++;
      out.boletas.total = Math.round((out.boletas.total + Number(r.valor || 0)) * 100) / 100;
      if (out.boletas.byBoleta.length < 60) out.boletas.byBoleta.push({ boleta: String(r.boleta), valor: Math.round(Number(r.valor || 0) * 100) / 100, status: r.status || null });
    }
    // 3) O que está gravado no fechamento da loja correspondente.
    const store = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND (code = ? OR id = ?) AND active = 1 LIMIT 1`).get(orgId, f, f) as any;
    if (store?.id) {
      const c = db.prepare(`SELECT system_total, system_turnos_json, informed_total, status FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ?`).get(orgId, store.id, d) as any;
      if (c) {
        let turnos: Record<string, number> | null = null;
        try { turnos = JSON.parse(c.system_turnos_json || "null"); } catch { turnos = null; }
        out.closing = { systemTotal: c.system_total != null ? Number(c.system_total) : null, systemTurnos: turnos, informedTotal: c.informed_total != null ? Number(c.informed_total) : null, status: c.status || null };
      }
      try {
        const last = db.prepare(`SELECT MAX(updated_at) AS at FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND COALESCE(system_total, 0) > 0`).get(orgId, store.id) as any;
        out.lastSystemDataAt = last?.at || null;
      } catch { /* coluna updated_at pode faltar em base antiga */ }
    }
    return out;
  }

  static async orphanFiliaisReport(orgId: string): Promise<Array<{ filial: string; totalVenda: number; hasStore: boolean; storeName: string | null; lastMovement: string | null; lastFinalized: boolean | null }>> {
    type Row = { filial: string; totalVenda: number; hasStore: boolean; storeName: string | null; lastMovement: string | null; lastFinalized: boolean | null };
    const out: Row[] = [];
    let items: any[] = [];
    try { items = (await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/VendaMalote/relatorio/resumo/porfilial`)).items || []; } catch { items = []; }
    for (const it of items) {
      const filial = str(it?.filial);
      const totalVenda = Number(it?.totalVenda || 0);
      if (!filial || totalVenda <= 0) continue; // só filiais que efetivamente vendem
      const store = db.prepare(`SELECT name FROM retail_stores WHERE organization_id = ? AND (code = ? OR id = ?) AND active = 1 LIMIT 1`).get(orgId, filial, filial) as any;
      const row: Row = { filial, totalVenda, hasStore: !!store, storeName: store?.name || null, lastMovement: null, lastFinalized: null };
      if (!store) {
        // Órfã: descobre até quando movimentou (candidata a loja migrada).
        try {
          const { body } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/UltimoMovimento/${encodeURIComponent(filial)}`);
          const m = (body as any)?.data;
          const mv = Array.isArray(m) ? m[0] : m;
          row.lastMovement = str(mv?.data).slice(0, 10) || null;
          row.lastFinalized = mv?.finalizado2 != null ? Number(mv.finalizado2) === 1 : null;
        } catch { /* segue sem a data */ }
      }
      out.push(row);
    }
    out.sort((a, b) => b.totalVenda - a.totalVenda);
    return out;
  }

  /** Passa nas orgs ativas e enfileira o sync das que venceram o intervalo. */
  static alterdataSyncPass(): void {
    const orgs = enabledOrgs();
    const now = Date.now();
    for (const orgId of orgs) {
      try {
        const settings = AlterdataConnectorService.publicSettings(orgId);
        const intervalMs = Math.max(1, Number(settings.syncIntervalMinutes || 15)) * 60_000;
        const last = Number(AlterdataConnectorService.getCursor(orgId, "_meta", "lastRun", "")) || 0;
        if (now - last < intervalMs) continue;
        // Marca antes de enfileirar (evita duplo-disparo) e enfileira.
        AlterdataConnectorService.setCursor(orgId, "_meta", "lastRun", "", String(now));
        JobQueueService.enqueue("alterdata_sync", { orgId }, { organizationId: orgId });
      } catch (e) { console.error("[Alterdata] pass falhou p/ org", orgId, e); }
    }
  }

  /**
   * RECONFERÊNCIA automática dos últimos dias (caso Toulon 19/09/2026: a folha
   * dizia R$ 5.476,80 e o sistema R$ 2.368,60 — os cartões/TEF entram no caixa
   * da Alterdata HORAS depois do turno fechar). O delta do DataCaixa entrega
   * cada turno UMA vez e não o revisita, então um dia lido cedo demais ficava
   * com valor PARCIAL até alguém apertar "Recuperar fechamentos". Aqui o sync
   * re-lê sozinho o resumo dos últimos RECHECK_DAYS das lojas com feed de PDV
   * vivo, REUSANDO o backfill (mesma leitura por turno + merge idempotente do
   * applyPdvTurnoTotals — valor igual reescreve o mesmo valor, valor novo
   * substitui só o turno que mudou e a divergência é recalculada).
   *
   * Throttle próprio (cursor `_meta/lastRecheck`): o sync roda a cada ~15 min,
   * mas a reconferência só a cada RECHECK_INTERVAL — senão seriam centenas de
   * chamadas de resumo por dia sem necessidade (o TEF consolida em horas).
   */
  private static async recheckRecentClosings(orgId: string, ledger: LedgerRunHandle): Promise<void> {
    // 19/09/2026 (Toulon): o dia foi lido parcial (R$ 2.368,60 sem o débito de
    // R$ 3.108,10) e ficou congelado até releitura manual — 3 dias eram pouco
    // quando ninguém olha o painel no fim de semana. 7 dias cobre a semana.
    // NÃO pular por `status='approved'`: aprovação é assinatura HUMANA, que
    // pode acontecer com o TEF ainda parcial (o próprio caso 19/09 foi
    // aprovado em 2.368,60). Pular o aprovado recongelava o valor parcial — o
    // recheck precisa reler TODOS os 7 dias. Custo: 7 × 2 turnos × 4x/dia = 56
    // chamadas/loja/dia; se um dia virar caro numa rede grande, reduzir
    // RECHECK_DAYS/intervalo aqui (config futura), nunca reintroduzir o skip.
    const RECHECK_DAYS = 7;                       // janela em que o TEF ainda "engorda" o caixa
    const RECHECK_INTERVAL_MS = 6 * 60 * 60_000;  // 4x/dia
    const now = Date.now();
    const last = Number(AlterdataConnectorService.getCursor(orgId, "_meta", "lastRecheck", "")) || 0;
    if (now - last < RECHECK_INTERVAL_MS) return;
    // Só lojas com PDV VIVO (fechamento com system_total recente): prova que o
    // módulo Sales responde pra essa filial — org sem PDV não gasta 1 chamada.
    const stores = db.prepare(
      `SELECT DISTINCT s.code FROM retail_stores s
         JOIN retail_daily_closings c ON c.organization_id = s.organization_id AND c.store_id = s.id
        WHERE s.organization_id = ? AND s.active = 1 AND COALESCE(s.code, '') != ''
          AND c.closing_date >= date('now', '-30 days') AND COALESCE(c.system_total, 0) > 0`
    ).all(orgId) as Array<{ code: string }>;
    if (!stores.length) return; // nada a reconferir — e o throttle não é consumido à toa
    AlterdataConnectorService.setCursor(orgId, "_meta", "lastRecheck", "", String(now));
    let applied = 0, errors = 0, fullFail = 0;
    for (const s of stores) {
      try {
        const r = await AlterdataSyncRunner.backfillFilialClosings(orgId, String(s.code), RECHECK_DAYS);
        applied += r.applied; errors += r.errors;
        // Módulo fora do ar: toda chamada da loja falhou. Duas lojas seguidas
        // assim → para de martelar; a próxima janela tenta de novo.
        if (r.applied === 0 && r.errors >= RECHECK_DAYS * 2) { if (++fullFail >= 2) break; } else fullFail = 0;
      } catch { errors++; }
    }
    ledger.record({
      module: "sales", resource: "DataCaixa/Reconferencia", required: false,
      status: applied > 0 ? "ready" : "empty_but_valid",
      imported: applied, mappingErrors: errors,
    });
  }

  /**
   * BACKFILL de FECHAMENTO por filial (RECUPERAÇÃO). O delta do DataCaixa é UM
   * stream global que começa em 2017 — uma loja cadastrada DEPOIS tem os caixas
   * recentes ATRÁS do cursor (nunca voltam num sync comum) e longe demais na
   * frente (o resync do zero volta pra 2017 e não alcança o passado recente numa
   * passada). Aqui, em vez de caminhar o stream, busca DIRETO os últimos `days`
   * dias da filial pelos endpoints por-data (ResumoFecharMovimento/{filial}/
   * {data}/{turno}) — os mesmos que a conciliação diária já usa. Grava o
   * system_total do dia (e, com o modo automático ligado, preenche o fechamento
   * pendente com o total e as formas de pagamento do PDV).
   *
   * Idempotente: `applyPdvTotal`/`setInformed` não duplicam; rodar de novo só
   * reescreve o mesmo valor. NÃO mexe em cursor — é uma leitura pontual paralela
   * ao delta, então não atrapalha nem é atrapalhada pela sincronização normal.
   * Isolado por org (a loja é resolvida por `organization_id` + código da filial).
   */
  /**
   * Lê o ResumoFecharMovimento de UMA filial em UM dia (turnos 1-2) e aplica
   * por turno (applyPdvTurnoTotals) — corpo compartilhado entre o backfill e a
   * releitura sob demanda. 19/09/2026 — POR TURNO (mesma correção do delta):
   * gravar por turno torna isto a FERRAMENTA DE REPARO dos dias que o delta
   * gravou pela metade (turno perdido ou TEF que entrou horas depois).
   * Turno inexistente devolve 0 / erro → sem dado, sem derrubar a varredura.
   */
  private static async readAndApplyFilialDay(orgId: string, storeId: string, f: string, date: string, autoClosing: boolean): Promise<{ got: boolean; errors: number; total: number }> {
    const PAY_TITLES: Record<string, string> = { "dinheiro": "dinheiro", "cheque": "cheque", "cartão": "cartao", "cartao": "cartao", "pix": "pix", "outros": "outros" };
    const turnoTotals: Record<string, number> = {};
    let got = false, errors = 0;
    const pay = new Map<string, number>();
    for (const turno of [1, 2]) {
      try {
        const { items } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(f)}/${date}/${turno}`);
        for (const r of items as any[]) {
          const titulo = String(r?.titulo || "").trim().toLowerCase();
          const valor = Number(r?.valor || 0);
          if (titulo === "total de vendas") { turnoTotals[String(turno)] = (turnoTotals[String(turno)] || 0) + valor; if (valor > 0) got = true; }
          else if (PAY_TITLES[titulo] && valor > 0) pay.set(PAY_TITLES[titulo], (pay.get(PAY_TITLES[titulo]) || 0) + valor);
        }
      } catch { errors++; }
    }
    if (!got) return { got: false, errors, total: 0 };
    const totalR = Math.round(Object.values(turnoTotals).reduce((a, v) => a + Number(v || 0), 0) * 100) / 100;
    if (totalR <= 0) return { got: false, errors, total: 0 };
    if (autoClosing) {
      // Preenche o fechamento pendente com o PDV (loja não digita). Quem já
      // informou à mão continua valendo. Try/catch: dia de FOLGA GERAL faz o
      // setInformed lançar (CLOSE-002) — nesse caso só o system_total abaixo é
      // gravado, sem abortar a varredura.
      try {
        const closing = RetailClosingService.getOrCreate(orgId, storeId, date);
        const informedCents = Math.round(Number(closing?.informed_total || 0) * 100);
        const fillEmpty = closing?.status === "pending" && informedCents === 0;
        // 19/09/2026 (caso Toulon): informado que é ESPELHO do PDV
        // (source='pdv', ainda não aprovado) ACOMPANHA o total novo quando o
        // TEF entra tarde no caixa — aqui o dia inteiro foi relido, então
        // total e formas estão completos. Informado humano (manual/OCR/
        // WhatsApp) e fechamento aprovado NUNCA são tocados.
        const refreshPdvMirror = closing?.source === "pdv" && closing?.status === "received"
          && informedCents !== Math.round(totalR * 100);
        if (fillEmpty || refreshPdvMirror) {
          RetailClosingService.setInformed(orgId, closing.id, {
            informedTotal: totalR,
            items: Array.from(pay.entries()).map(([paymentMethod, v]) => ({ paymentMethod, informedAmount: Math.round(v * 100) / 100 })),
            source: "pdv",
          });
        }
      } catch { /* folga geral etc — system_total ainda é aplicado abaixo */ }
    }
    // Por turno: além de somar o dia inteiro, REESCREVE as chaves de turno —
    // repara dias que o delta gravou pela metade (turno perdido).
    RetailReconciliationService.applyPdvTurnoTotals(orgId, storeId, date, turnoTotals);
    return { got: true, errors, total: totalR };
  }

  /**
   * RELEITURA SOB DEMANDA de um dia (botão "Reler Alterdata" da conferência de
   * valores): re-lê o resumo de TODAS as lojas ativas com filial naquele dia e
   * regrava os turnos. É o antídoto imediato do dia lido parcial (TEF tardio)
   * sem esperar a reconferência automática. Guard-rail herdado do merge por
   * turno: releitura que devolve 0 num turno NÃO apaga o valor bom já gravado.
   */
  static async refreshDayClosings(orgId: string, date: string): Promise<{ date: string; stores: Array<{ storeId: string; storeName: string; filial: string; applied: boolean; total: number; errors: number }>; errors: number }> {
    const autoClosing = AlterdataConnectorService.isPdvAutoClosing(orgId);
    const stores = db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND active = 1 AND COALESCE(code, '') != '' ORDER BY name`).all(orgId) as any[];
    const out = { date, stores: [] as Array<{ storeId: string; storeName: string; filial: string; applied: boolean; total: number; errors: number }>, errors: 0 };
    for (const st of stores) {
      const r = await this.readAndApplyFilialDay(orgId, st.id, String(st.code), date, autoClosing);
      out.errors += r.errors;
      out.stores.push({ storeId: st.id, storeName: st.name, filial: String(st.code), applied: r.got, total: r.total, errors: r.errors });
      // Autenticação morta: TODAS as chamadas falham igual — para na primeira
      // loja com erro puro pra não martelar o Guardian com credencial ruim.
      if (!r.got && r.errors >= 2 && AlterdataConnectorService.getAuthFailure(orgId)) break;
    }
    try { logAuthEvent(orgId, "system", date, "ALTERDATA_REFRESH_DAY", { date, stores: out.stores.length, errors: out.errors }); } catch { /* noop */ }
    return out;
  }

  static async backfillFilialClosings(orgId: string, filial: string, days = 90): Promise<{ filial: string; days: number; applied: number; skippedNoStore: number; errors: number; storeId: string | null; storeName: string | null; persisted: number; sample: Array<{ date: string; total: number }> }> {
    const f = str(filial);
    const out = { filial: f, days, applied: 0, skippedNoStore: 0, errors: 0, storeId: null as string | null, storeName: null as string | null, persisted: 0, sample: [] as Array<{ date: string; total: number }> };
    if (!f) return out;
    // Casamento filial→loja: mesma regra do sync (código OU id, loja ativa).
    // Guarda o NOME e o id resolvidos no resultado — é a verdade-de-campo pra
    // cruzar com a grade (se a grade mostra 0 mas aqui a loja é a certa e há
    // registros persistidos, o problema é de exibição, não de gravação).
    const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND (code = ? OR id = ?) AND active = 1 LIMIT 1`).get(orgId, f, f) as any;
    const storeId = store?.id || null;
    if (!storeId) { out.skippedNoStore = 1; return out; } // filial sem loja → nada a recuperar
    out.storeId = storeId;
    out.storeName = store?.name || null;
    const autoClosing = AlterdataConnectorService.isPdvAutoClosing(orgId);
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      // Relê SEMPRE, inclusive dia aprovado: o TEF pode ter entrado depois da
      // aprovação (caso 19/09). applyPdvTurnoTotals atualiza só o system_total;
      // o informado humano do fechamento aprovado permanece intocado.
      const r = await this.readAndApplyFilialDay(orgId, storeId, f, date, autoClosing);
      out.errors += r.errors;
      if (!r.got) continue; // dia sem caixa fechado (total 0) → não inventa fechamento
      if (out.sample.length < 5) out.sample.push({ date, total: r.total }); // amostra p/ cruzar com a grade
      out.applied++;
    }
    // Verdade-de-campo: RE-LÊ do banco quantos fechamentos DESTA loja ficaram com
    // system_total>0 na janela. Se `persisted` bater com `applied` mas a grade
    // mostrar 0, a gravação está certa e o problema é de exibição/loja errada.
    try {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      out.persisted = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date >= ? AND COALESCE(system_total, 0) > 0`
      ).get(orgId, storeId, cutoff) as any)?.n || 0);
    } catch { /* noop */ }
    try { logAuthEvent(orgId, "system", "backfillFilialClosings", "ALTERDATA_BACKFILL_CLOSINGS", out as any); } catch { /* noop */ }
    return out;
  }

  /**
   * LINHA DO TEMPO de uma filial (DIAGNÓSTICO read-only). Varre os fechamentos
   * (ResumoFecharMovimento) numa janela e descobre o PRIMEIRO e o ÚLTIMO dia com
   * venda, mais a última movimentação (UltimoMovimento). Serve pra provar (ou
   * derrubar) uma passagem de bastão entre códigos de filial: se o código velho
   * PAROU num dia e o código novo COMEÇOU logo em seguida, é a mesma loja que
   * migrou de código. NÃO grava nada (não mexe em fechamento, cursor nem loja);
   * é uma leitura pontual isolada por org.
   */
  static async filialTimeline(orgId: string, filial: string, days = 150): Promise<{ filial: string; days: number; firstData: string | null; lastData: string | null; daysWithData: number; errors: number; lastMovement: string | null; lastFinalized: boolean | null; samples: Array<{ date: string; total: number }> }> {
    const f = str(filial);
    const out = { filial: f, days, firstData: null as string | null, lastData: null as string | null, daysWithData: 0, errors: 0, lastMovement: null as string | null, lastFinalized: null as boolean | null, samples: [] as Array<{ date: string; total: number }> };
    if (!f) return out;
    // Última movimentação (1 chamada barata): até quando a filial mexeu no caixa.
    try {
      const { body } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/UltimoMovimento/${encodeURIComponent(f)}`);
      const m = (body as any)?.data;
      const mv = Array.isArray(m) ? m[0] : m;
      out.lastMovement = str(mv?.data).slice(0, 10) || null;
      out.lastFinalized = mv?.finalizado2 != null ? Number(mv.finalizado2) === 1 : null;
    } catch { /* segue sem a data */ }
    const dated: Array<{ date: string; total: number }> = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      let total = 0;
      let got = false;
      for (const turno of [1, 2]) {
        try {
          const { items } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(f)}/${date}/${turno}`);
          for (const r of items as any[]) {
            if (String(r?.titulo || "").trim().toLowerCase() === "total de vendas") { const v = Number(r?.valor || 0); total += v; if (v > 0) got = true; }
          }
        } catch { out.errors++; }
      }
      if (!got) continue; // dia sem caixa fechado → não conta
      const totalR = Math.round(total * 100) / 100;
      if (totalR <= 0) continue;
      dated.push({ date, total: totalR });
    }
    if (dated.length) {
      dated.sort((a, b) => (a.date < b.date ? -1 : 1));
      out.firstData = dated[0].date;               // primeiro dia com venda (começou)
      out.lastData = dated[dated.length - 1].date;  // último dia com venda (parou)
      out.daysWithData = dated.length;
      // Amostra: 3 primeiros + 3 últimos dias com venda (sem duplicar quando <6).
      const ends = [...dated.slice(0, 3), ...dated.slice(-3)];
      out.samples = ends.filter((v, idx) => ends.findIndex((x) => x.date === v.date) === idx);
    }
    try { logAuthEvent(orgId, "system", "filialTimeline", "ALTERDATA_FILIAL_TIMELINE", out as any); } catch { /* noop */ }
    return out;
  }
}

/** Janelas [1º dia, último dia] (YYYY-MM-DD) dos últimos N meses, mês atual incluído.
 *  Usado pelo pull de comissão do ERP, que consulta por período mês a mês. */
function lastMonthsWindows(n: number): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    out.push({ start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) });
  }
  return out;
}

function enabledOrgs(): string[] {
  try {
    return (db.prepare(`SELECT organization_id FROM alterdata_integration_settings WHERE enabled = 1`).all() as any[]).map((r) => r.organization_id);
  } catch { return []; }
}

// Handler da fila: processa o sync de uma org em background. `manual` (resync
// disparado pelo botão) dispensa a flag `enabled`, igual ao sync manual.
// Falha do job fica REGISTRADA em _meta/lastError — sem isso a tela ficaria
// em "em andamento…" para sempre sem saber que o job morreu.
JobQueueService.registerHandler("alterdata_sync", async (p: any) => {
  try {
    const summary = await AlterdataSyncRunner.runOrg(p.orgId, { manual: !!p.manual });
    return { done: true, ...summary };
  } catch (e: any) {
    try { AlterdataConnectorService.setCursor(p.orgId, "_meta", "lastError", "", JSON.stringify({ message: String(e?.message || e), at: new Date().toISOString() })); } catch { /* noop */ }
    throw e;
  }
});

// Handler da fila: backfill de FECHAMENTO por filial (recuperação). Roda em
// background (dezenas/centenas de chamadas ResumoFecharMovimento) e persiste o
// resultado em _meta/lastBackfillClosings para a tela ler depois.
JobQueueService.registerHandler("alterdata_backfill_closings", async (p: any) => {
  const filiais: string[] = Array.isArray(p.filiais) ? p.filiais.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const days = Math.max(1, Math.min(370, Number(p.days) || 90));
  const results: any[] = [];
  for (const f of filiais) {
    try { results.push(await AlterdataSyncRunner.backfillFilialClosings(p.orgId, f, days)); }
    catch (e: any) { results.push({ filial: f, days, applied: 0, skippedNoStore: 0, errors: 1, error: String(e?.message || e) }); }
  }
  const summary = {
    done: true, days, results,
    applied: results.reduce((a, r: any) => a + (Number(r?.applied) || 0), 0),
    skippedNoStore: results.reduce((a, r: any) => a + (Number(r?.skippedNoStore) || 0), 0),
    at: new Date().toISOString(),
  };
  try { AlterdataConnectorService.setCursor(p.orgId, "_meta", "lastBackfillClosings", "", JSON.stringify(summary)); } catch { /* noop */ }
  return summary;
});

// Handler da fila: LINHA DO TEMPO de filiais (diagnóstico). Roda em background
// (varre ResumoFecharMovimento por dia numa janela ampla) e persiste em
// _meta/lastFilialTimeline para a tela ler depois. Read-only — não grava nada.
JobQueueService.registerHandler("alterdata_filial_timeline", async (p: any) => {
  const filiais: string[] = Array.isArray(p.filiais) ? p.filiais.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const days = Math.max(1, Math.min(370, Number(p.days) || 150));
  const results: any[] = [];
  for (const f of filiais) {
    try { results.push(await AlterdataSyncRunner.filialTimeline(p.orgId, f, days)); }
    catch (e: any) { results.push({ filial: f, days, firstData: null, lastData: null, daysWithData: 0, errors: 1, error: String(e?.message || e) }); }
  }
  const summary = { done: true, days, results, at: new Date().toISOString() };
  try { AlterdataConnectorService.setCursor(p.orgId, "_meta", "lastFilialTimeline", "", JSON.stringify(summary)); } catch { /* noop */ }
  return summary;
});
