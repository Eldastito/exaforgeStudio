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
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";
import { AlterdataSyncService } from "./AlterdataSyncService.js";
import { AlterdataSupplyMapper } from "./AlterdataSupplyMapper.js";
import { AlterdataStockMapper } from "./AlterdataStockMapper.js";
import { AlterdataPriceMapper } from "./AlterdataPriceMapper.js";
import { JobQueueService } from "./JobQueueService.js";
import { logAuthEvent } from "./auditLog.js";

export interface SyncRunSummary {
  referencias: number;
  /** Total ACUMULADO de produtos do catálogo (prova visual de que o cursor avança). */
  totalProdutos: number;
  totalVariantes: number;
  variantes: number;
  saldos: { applied: number; skippedNoStore: number; skippedNoProduct: number; sampleNoProduct: string[] };
  precos: { applied: number; skippedNoProduct: number; sampleNoProduct: string[] };
  filiais: string[];
  ranAt: string;
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

  static async runOrg(orgId: string, opts: { manual?: boolean } = {}): Promise<SyncRunSummary> {
    if (!opts.manual && !AlterdataConnectorService.isEnabled(orgId)) {
      throw new Error("Alterdata: integração desligada para esta organização (ative em Integrações).");
    }
    if (this.running.has(orgId)) {
      throw new Error("Alterdata: já existe uma sincronização em andamento para esta organização — aguarde ela terminar.");
    }
    this.running.add(orgId);
    try {
      return await this.runOrgInner(orgId);
    } finally {
      this.running.delete(orgId);
    }
  }

  private static async runOrgInner(orgId: string): Promise<SyncRunSummary> {
    const settings = AlterdataConnectorService.publicSettings(orgId);
    const filiais: string[] = Array.isArray(settings.filiais) && settings.filiais.length ? settings.filiais : [""];
    const rede = str(settings.rede);

    // 1) Referências (produtos). Coleta os códigos de referência sincronizados
    //    para, em seguida, puxar os códigos de barras POR referência.
    const refCodes = new Set<string>();
    const ref = await AlterdataSyncService.syncResource(orgId, {
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
        } catch { bar.errors++; /* uma referência sem barras/erro não derruba o sync */ }
      }
    }

    const saldos = { applied: 0, skippedNoStore: 0, skippedNoProduct: 0, sampleNoProduct: [] as string[] };
    for (const filial of filiais) {
      await AlterdataSyncService.syncResource(orgId, {
        moduleKey: "supply", resource: "Saldo", filial,
        buildPath: (c) => (filial ? `/api/v1/Saldo/versao/${filial}/${c}` : `/api/v1/Saldo/versao/${c}`),
        onItems: (items) => {
          const r = AlterdataStockMapper.upsertSaldos(orgId, items);
          saldos.applied += r.applied; saldos.skippedNoStore += r.skippedNoStore; saldos.skippedNoProduct += r.skippedNoProduct;
          for (const p of r.sampleNoProduct) if (saldos.sampleNoProduct.length < 5 && !saldos.sampleNoProduct.includes(p)) saldos.sampleNoProduct.push(p);
          return r.applied;
        },
      });
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
      const candidates: Array<(c: string) => string> = [
        (c) => `/api/v1/Preco/versao/${table}/${c}`,
        (c) => `/api/v1/Preco/versao/${c}`,
      ];
      if (rede) candidates.push((c) => `/api/v1/Preco/versao/${rede}/${table}/${c}`);
      for (let i = 0; i < candidates.length; i++) {
        try {
          await AlterdataSyncService.syncResource(orgId, {
            moduleKey: "price", resource: "Preco", filial: `${table}~${i}`,
            buildPath: candidates[i],
            onItems: (items) => {
              const r = AlterdataPriceMapper.upsertPrecos(orgId, items, table);
              precos.applied += r.applied; precos.skippedNoProduct += r.skippedNoProduct;
              for (const p of r.sampleNoProduct) if (precos.sampleNoProduct.length < 5 && !precos.sampleNoProduct.includes(p)) precos.sampleNoProduct.push(p);
              return r.applied;
            },
          });
        } catch { /* formato inexistente nesta instalação (404/500) — tenta o próximo */ }
        if (precos.applied + precos.skippedNoProduct > 0) break; // achou o formato com linhas de preço
      }
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
      referencias: ref.imported, totalProdutos, totalVariantes, variantes: bar.imported, saldos, precos, filiais,
      ranAt: new Date().toISOString(),
    };
    // Marca a última execução (gate do Scheduler) via cursor '_meta'/'lastRun'
    // e persiste o resumo (a ressincronização roda em background — a tela lê o
    // resultado em GET /alterdata/last-sync).
    AlterdataConnectorService.setCursor(orgId, "_meta", "lastRun", "", String(Date.now()));
    try { AlterdataConnectorService.setCursor(orgId, "_meta", "lastSummary", "", JSON.stringify(summary)); } catch { /* noop */ }
    try { logAuthEvent(orgId, "system", "alterdata", "ALTERDATA_SYNC_RUN", summary as any); } catch { /* noop */ }
    return summary;
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
    } else {
      out.push({ resource: "Preco", module: "price", path: "(sem tabela)", url: null, status: 0, ok: false, snippet: "Preencha a Tabela de preço da rede para testar o módulo de preço." });
    }
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
