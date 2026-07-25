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
  variantes: number;
  saldos: { applied: number; skippedNoStore: number; skippedNoProduct: number };
  precos: { applied: number; skippedNoProduct: number };
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
  static async runOrg(orgId: string, opts: { manual?: boolean } = {}): Promise<SyncRunSummary> {
    if (!opts.manual && !AlterdataConnectorService.isEnabled(orgId)) {
      throw new Error("Alterdata: integração desligada para esta organização (ative em Integrações).");
    }
    const settings = AlterdataConnectorService.publicSettings(orgId);
    const filiais: string[] = Array.isArray(settings.filiais) && settings.filiais.length ? settings.filiais : [""];
    const rede = str(settings.rede);

    // 1) Referências (produtos). Coleta os códigos de referência sincronizados
    //    para, em seguida, puxar os códigos de barras POR referência.
    const refCodes = new Set<string>();
    const ref = await AlterdataSyncService.syncResource(orgId, {
      moduleKey: "supply", resource: "Referencia",
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
      for (const referencia of refCodes) {
        try {
          const { items } = await AlterdataSyncService.apiGet(orgId, "supply", `/api/v1/CodigoDeBarras/ReferenciaRede/${encodeURIComponent(referencia)}/${encodeURIComponent(rede)}`);
          if (items.length) bar.imported += AlterdataSupplyMapper.upsertCodigosDeBarras(orgId, items, referencia);
          bar.refs++;
        } catch { bar.errors++; /* uma referência sem barras/erro não derruba o sync */ }
      }
    }

    const saldos = { applied: 0, skippedNoStore: 0, skippedNoProduct: 0 };
    for (const filial of filiais) {
      await AlterdataSyncService.syncResource(orgId, {
        moduleKey: "supply", resource: "Saldo", filial,
        buildPath: (c) => (filial ? `/api/v1/Saldo/versao/${filial}/${c}` : `/api/v1/Saldo/versao/${c}`),
        onItems: (items) => {
          const r = AlterdataStockMapper.upsertSaldos(orgId, items);
          saldos.applied += r.applied; saldos.skippedNoStore += r.skippedNoStore; saldos.skippedNoProduct += r.skippedNoProduct;
          return r.applied;
        },
      });
    }

    // 4) Preço (módulo Price) — só quando a tabela de preço da rede está definida.
    const precos = { applied: 0, skippedNoProduct: 0 };
    const table = str(settings.priceTable);
    if (rede && table) {
      await AlterdataSyncService.syncResource(orgId, {
        moduleKey: "price", resource: "Preco", filial: table,
        buildPath: (c) => `/api/v1/Preco/versao/${rede}/${table}/${c}`,
        onItems: (items) => {
          const r = AlterdataPriceMapper.upsertPrecos(orgId, items);
          precos.applied += r.applied; precos.skippedNoProduct += r.skippedNoProduct;
          return r.applied;
        },
      });
    }

    const summary: SyncRunSummary = {
      referencias: ref.imported, variantes: bar.imported, saldos, precos, filiais,
      ranAt: new Date().toISOString(),
    };
    // Marca a última execução (gate do Scheduler) via cursor '_meta'/'lastRun'.
    AlterdataConnectorService.setCursor(orgId, "_meta", "lastRun", "", String(Date.now()));
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
    for (const filial of filiais) {
      await run(filial ? `Saldo (filial ${filial})` : "Saldo", "supply", filial ? `/api/v1/Saldo/versao/${filial}/0` : "/api/v1/Saldo/versao/0");
    }
    if (rede && table) {
      await run("Preco", "price", `/api/v1/Preco/versao/${rede}/${table}/0`);
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

// Handler da fila: processa o sync de uma org em background.
JobQueueService.registerHandler("alterdata_sync", async (p: any) => {
  const summary = await AlterdataSyncRunner.runOrg(p.orgId);
  return { done: true, ...summary };
});
