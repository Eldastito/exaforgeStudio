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
      const PAY_TITLES: Record<string, string> = { "dinheiro": "dinheiro", "cheque": "cheque", "cartão": "cartao", "cartao": "cartao", "outros": "outros" };
      for (const g of groups.values()) {
        const storeId = storeIdFor(g.filial);
        if (!storeId) { caixas.skippedNoStore++; continue; }
        let total = 0;
        let got = false;
        const pay = new Map<string, number>();
        for (const turno of g.turnos) {
          try {
            const { items } = await AlterdataSyncService.apiGet(orgId, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(g.filial)}/${g.date}/${turno}`);
            for (const r of items as any[]) {
              const titulo = String(r?.titulo || "").trim().toLowerCase();
              const valor = Number(r?.valor || 0);
              if (titulo === "total de vendas") { total += valor; got = true; }
              else if (PAY_TITLES[titulo] && valor > 0) pay.set(PAY_TITLES[titulo], (pay.get(PAY_TITLES[titulo]) || 0) + valor);
            }
          } catch { caixas.errors++; /* um turno com erro não derruba o dia */ }
        }
        if (!got) continue;
        const totalR = Math.round(total * 100) / 100;
        if (autoClosing && totalR > 0) {
          const closing = RetailClosingService.getOrCreate(orgId, storeId, g.date);
          if (closing?.status === "pending" && Number(closing.informed_total || 0) === 0) {
            RetailClosingService.setInformed(orgId, closing.id, {
              informedTotal: totalR,
              items: Array.from(pay.entries()).map(([paymentMethod, v]) => ({ paymentMethod, informedAmount: Math.round(v * 100) / 100 })),
              source: "pdv",
            });
          }
        }
        RetailReconciliationService.applyPdvTotal(orgId, storeId, g.date, totalR);
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
    } catch { /* módulo Sales indisponível nesta instalação — segue sem PDV */ }

    // 6) VENDAS DO PDV (módulo Sales — Fase 4): VendaMalote/versao é o stream
    //    venda a venda do caixa, com a MATRÍCULA do vendedor, valor, peças e
    //    formas de pagamento. Alimenta a comissão por vendedor e os rankings
    //    reais da rede. Falha do endpoint não derruba o sync.
    const vendas = { imported: 0 };
    try {
      const insVenda = db.prepare(
        `INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, vendedor, usuario, valor, pecas, status, payments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, filial, boleta, sale_date) DO UPDATE SET
           sale_time = excluded.sale_time, vendedor = excluded.vendedor, usuario = excluded.usuario, valor = excluded.valor,
           pecas = excluded.pecas, status = excluded.status, payments_json = excluded.payments_json`
      );
      // Itens de venda (vendas[]): produto, quantidade, valor, comissão e o
      // vendedor POR LINHA (nome do campo varia — tenta os candidatos).
      const insItem = db.prepare(
        `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, comissao, vendedor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, filial, boleta, sale_date, item_seq) DO UPDATE SET
           produto = excluded.produto, quantidade = excluded.quantidade, valor = excluded.valor,
           comissao = excluded.comissao, vendedor = excluded.vendedor`
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
            insVenda.run(
              randomUUID(), orgId, filial, boleta, date, str(cx?.hora) || null, str(cx?.matricula) || null,
              str(cx?.usuario) || null, Number(cx?.valor || 0), Number(cx?.vendidas || 0), str(cx?.status) || null, JSON.stringify(payments)
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
            n++;
          }
          vendas.imported += n;
          return n;
        },
      });
    } catch { /* endpoint indisponível nesta instalação — segue sem vendas PDV */ }

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
      referencias: ref.imported, totalProdutos, totalVariantes, variantes: bar.imported, saldos, precos, caixas, vendas, filiais,
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
    // Comissão POR VENDEDOR calculada pelo ERP — janela de 90 dias (as vendas
    // de homologação são de mai/jun; a janela recente vinha vazia). É a fonte
    // correta do vendedor individual (o VendaMalote só tem o operador de caixa).
    const noventaDias = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    await run("Venda Comissão (90 dias)", "sales", `/api/v1/Venda/ComissaoVendasPorPeriodo/${noventaDias}/${hoje}`);
    await run("VendaMalote (delta versao)", "sales", `/api/v1/VendaMalote/versao/0`);
    await run("VendaMalote (resumo por filial)", "sales", `/api/v1/VendaMalote/relatorio/resumo/porfilial`);
    if (f0) {
      await run(`DataCaixa (últ. movimento filial ${f0})`, "sales", `/api/v1/DataCaixa/UltimoMovimento/${encodeURIComponent(f0)}`);
      await run(`DataCaixa (dia ${hoje} filial ${f0})`, "sales", `/api/v1/DataCaixa/${hoje}/${encodeURIComponent(f0)}`);
      await run(`ResumoFecharMovimento (filial ${f0})`, "sales", `/api/v1/DataCaixa/ResumoFecharMovimento/${encodeURIComponent(f0)}/${hoje}/1`);
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
