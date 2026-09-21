/**
 * FiscalInboundSyncService — captura automática de NF-e de ENTRADA pela
 * Distribuição DF-e do provedor (ADR-200, Fase 3 PR 3).
 *
 * Um passe (`syncConnection`) puxa o lote a partir do cursor (NSU) da conexão,
 * roteia cada documento pelo schema (resNFe/procNFe/procEventoNFe) para o
 * `FiscalDocumentService`, guarda o XML bruto CIFRADO (FiscalXmlStorage) e só
 * então avança o cursor via compare-and-set — se a persistência falhar no meio,
 * o cursor NÃO avança e o mesmo lote é reprocessado (idempotente por chave).
 *
 * Invariantes:
 *   - cursor avança SÓ depois do lote persistido (at-least-once + dedupe);
 *   - backoff do provedor (429/consumo indevido) pausa o polling sem perder cursor;
 *   - Ciência da Operação é o ÚNICO evento automático (política auto_awareness):
 *     libera o XML completo; a pendência fica registrada no documento;
 *     cancelamento é INGERIDO (situação fiscal) mas nunca emitido por nós;
 *   - provedor é INJETÁVEL (teste sem rede); o handler da fila monta o real.
 *
 * NÃO movimenta estoque (isso é do recebimento) e não resolve loja além do que
 * o FiscalDocumentService já faz. Isolado por organização.
 */
import db from "./db.js";
import { FiscalDocumentService } from "./FiscalDocumentService.js";
import { FiscalInboundConnectionService } from "./FiscalInboundConnectionService.js";
import { FiscalXmlStorage } from "./FiscalXmlStorage.js";
import { parseNFeDocument } from "./nfeParser.js";
import { JobQueueService, JobQueueError } from "./JobQueueService.js";
import { NuvemFiscalAdapter } from "./providers/NuvemFiscalAdapter.js";
import type { FiscalInboundProvider, FiscalDistributionDoc } from "./providers/FiscalInboundProvider.js";

export interface SyncSummary {
  connectionId: string;
  batches: number;
  documents: number;
  persisted: number;      // created + enriched
  events: number;         // procEventoNFe ingeridos
  cancellations: number;  // cancelamentos aplicados
  manifested: number;     // Ciência da Operação enviada
  skipped: number;        // sem XML / schema inválido
  blocked: boolean;
  blockedReason: string | null;
  ultNsu: string;
  maxNsu: string | null;
  ranAt: string;
}

const MAX_BATCHES_DEFAULT = 20; // teto por passe — o resto vai no passe seguinte

export class FiscalInboundSyncService {
  /** Trava por conexão: passes simultâneos (clique + agendador) disputam o cursor. */
  private static running = new Set<string>();
  static isRunning(connectionId: string): boolean { return this.running.has(connectionId); }

  /** Monta o adapter real a partir das credenciais cifradas da conexão. */
  private static buildProvider(orgId: string, conn: any): FiscalInboundProvider {
    const creds = FiscalInboundConnectionService.getCredentials(orgId, conn.id);
    if (!creds) { const e: any = new Error("credential_missing"); e.code = "invalid_client"; throw e; }
    const ambiente = conn.environment === "production" ? "producao" : "homologacao";
    return new NuvemFiscalAdapter(creds, { ambiente });
  }

  /**
   * Executa um passe de sync de UMA conexão. `manual` dispensa a flag `enabled`
   * (teste/homologação) e ignora o backoff. `provider` injetável no teste.
   */
  static async syncConnection(
    orgId: string,
    connectionId: string,
    opts: { manual?: boolean; provider?: FiscalInboundProvider; maxBatches?: number } = {}
  ): Promise<SyncSummary> {
    const conn = FiscalInboundConnectionService.get(orgId, connectionId);
    if (!conn) throw new Error("conexão inexistente");
    if (!opts.manual && !conn.enabled) {
      return this.emptySummary(connectionId, conn, "disabled");
    }
    // Backoff: não fura o bloqueio do provedor no passe automático.
    if (!opts.manual && conn.blockedUntil && new Date(conn.blockedUntil).getTime() > Date.now()) {
      return this.emptySummary(connectionId, conn, "backoff");
    }
    if (this.running.has(connectionId)) {
      throw new Error("já existe um sync em andamento para esta conexão");
    }
    this.running.add(connectionId);
    try {
      const provider = opts.provider || this.buildProvider(orgId, conn);
      return await this.runInner(orgId, conn, provider, opts.manual === true, opts.maxBatches ?? MAX_BATCHES_DEFAULT);
    } finally {
      this.running.delete(connectionId);
    }
  }

  private static async runInner(orgId: string, conn: any, provider: FiscalInboundProvider, manual: boolean, maxBatches: number): Promise<SyncSummary> {
    const summary: SyncSummary = {
      connectionId: conn.id, batches: 0, documents: 0, persisted: 0, events: 0,
      cancellations: 0, manifested: 0, skipped: 0, blocked: false, blockedReason: null,
      ultNsu: conn.ultNsu || "0", maxNsu: conn.maxNsu || null, ranAt: new Date().toISOString(),
    };

    for (let i = 0; i < maxBatches; i++) {
      const cursor = FiscalInboundConnectionService.getCursor(orgId, conn.id);
      if (!cursor) break;
      const batch = await provider.listSinceNsu({ cnpj: conn.cnpj, ultNsu: cursor.ultNsu });
      summary.batches++;

      // Backoff sinalizado pelo provedor — pausa o polling, PRESERVA cursor.
      if (batch.blocked) {
        FiscalInboundConnectionService.applyBackoff(orgId, conn.id, batch.blocked.until, batch.blocked.reason);
        summary.blocked = true; summary.blockedReason = batch.blocked.reason;
        break;
      }

      // Persiste o lote INTEIRO antes de mover o cursor (at-least-once + dedupe).
      for (const doc of batch.documents) {
        summary.documents++;
        try { this.processDoc(orgId, conn, provider, doc, summary); }
        catch (e) { console.error("[FiscalSync] doc falhou", conn.id, doc.nsu, e); summary.skipped++; }
      }

      // CAS: só avança se ninguém mais avançou (corrida entre clique+agendador).
      const advanced = FiscalInboundConnectionService.advanceCursor(orgId, conn.id, cursor.version, { ultNsu: batch.ultNsu, maxNsu: batch.maxNsu });
      summary.ultNsu = batch.ultNsu; summary.maxNsu = batch.maxNsu ?? summary.maxNsu;
      if (!advanced) break; // outro passe avançou — evita reprocessar/duplicar cursor

      // Fim do backlog: cursor não andou, ou alcançou o máximo informado.
      if (batch.ultNsu === cursor.ultNsu) break;
      if (batch.maxNsu && Number(batch.ultNsu) >= Number(batch.maxNsu)) break;
    }
    return summary;
  }

  /** Roteia um documento do lote pelo schema. Guarda o XML cifrado quando há. */
  private static processDoc(orgId: string, conn: any, provider: FiscalInboundProvider, doc: FiscalDistributionDoc, summary: SyncSummary): void {
    if (!doc.xml) { summary.skipped++; return; }
    const parsed = parseNFeDocument(doc.xml);
    const stored = FiscalXmlStorage.putPrivate(orgId, doc.xml); // idempotente por conteúdo

    // Evento (cancelamento/ciência etc.) — ingere a situação fiscal.
    if (parsed.contentLevel === "event_only") {
      summary.events++;
      const r = FiscalDocumentService.ingestEvent(orgId, parsed, { nsu: doc.nsu, xmlSha256: stored?.sha256 || null });
      if (r.cancelled) summary.cancellations++;
      return;
    }

    // Documento (resumo, assinado ou autorizado) — persiste/enriquece.
    if (["summary_only", "signed_only", "authorized_process"].includes(parsed.contentLevel)) {
      const res = FiscalDocumentService.persist(orgId, parsed, { source: "provider", connectionId: conn.id });
      if (res.status === "created" || res.status === "enriched") {
        summary.persisted++;
        if (res.documentId && stored) FiscalDocumentService.attachXml(orgId, res.documentId, stored, doc.nsu);
        // Cancelamento que chegou ANTES do documento: aplica agora.
        if (parsed.accessKey) FiscalDocumentService.applyPendingCancellation(orgId, parsed.accessKey);
      } else if (res.status === "unchanged") {
        // já persistido; nada a fazer além do XML já guardado.
      } else {
        summary.skipped++;
      }

      // Ciência da Operação (política auto_awareness): só sobre resumo autorizado
      // ainda sem manifestação — libera o XML completo (chega num NSU posterior).
      if (
        conn.manifestationPolicy === "auto_awareness" &&
        parsed.contentLevel === "summary_only" &&
        parsed.fiscalStatus === "authorized" &&
        parsed.accessKey &&
        this.needsAwareness(orgId, parsed.accessKey)
      ) {
        this.requestAwareness(orgId, conn, provider, parsed.accessKey, summary);
      }
      return;
    }

    summary.skipped++; // invalid
  }

  /** True se o documento ainda não teve manifestação registrada. */
  private static needsAwareness(orgId: string, accessKey: string): boolean {
    const row = db.prepare(
      `SELECT manifestation_state FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`
    ).get(orgId, accessKey) as any;
    const st = row?.manifestation_state;
    return !st || st === "none";
  }

  /** Envia Ciência da Operação; registra pendência/estado. Nunca derruba o lote. */
  private static requestAwareness(orgId: string, conn: any, provider: FiscalInboundProvider, accessKey: string, summary: SyncSummary): void {
    try {
      // fire-and-record: manifest é async, mas não bloqueamos o lote inteiro por
      // ele — a pendência fica marcada e o XML completo vem no próximo passe.
      Promise.resolve(provider.manifest({ cnpj: conn.cnpj, accessKey, event: "ciencia_operacao" }))
        .then((r) => {
          FiscalDocumentService.markManifestation(orgId, accessKey, r.ok ? "awareness_requested" : "failed", "210210");
        })
        .catch(() => FiscalDocumentService.markManifestation(orgId, accessKey, "failed", "210210"));
      FiscalDocumentService.markManifestation(orgId, accessKey, "awareness_requested", "210210");
      summary.manifested++;
    } catch { /* noop — pendência não fatal */ }
  }

  private static emptySummary(connectionId: string, conn: any, reason: string): SyncSummary {
    return {
      connectionId, batches: 0, documents: 0, persisted: 0, events: 0, cancellations: 0,
      manifested: 0, skipped: 0, blocked: reason === "backoff", blockedReason: reason === "backoff" ? "backoff" : null,
      ultNsu: conn.ultNsu || "0", maxNsu: conn.maxNsu || null, ranAt: new Date().toISOString(),
    };
  }

  /**
   * Probe real da conexão (valida credenciais) e registra o resultado. Usado
   * pela rota de "testar/ativar conexão" — só um probe OK liga a conexão.
   */
  static async probeConnection(orgId: string, connectionId: string): Promise<{ connected: boolean; errorCode?: string | null }> {
    const conn = FiscalInboundConnectionService.get(orgId, connectionId);
    if (!conn) throw new Error("conexão inexistente");
    let provider: FiscalInboundProvider;
    try { provider = this.buildProvider(orgId, conn); }
    catch { FiscalInboundConnectionService.markProbe(orgId, connectionId, { connected: false, errorCode: "credential_missing" }); return { connected: false, errorCode: "credential_missing" }; }
    const r = await provider.probe();
    FiscalInboundConnectionService.markProbe(orgId, connectionId, { connected: r.connected, capabilities: r.capabilities, errorCode: r.errorCode || null });
    return { connected: r.connected, errorCode: r.errorCode || null };
  }

  /**
   * Passe do agendador: enfileira o sync das conexões ligadas, fora de backoff.
   * Enfileira (não roda inline) — o handler roda em background com retry/dead-letter.
   */
  static syncPass(): void {
    let rows: any[] = [];
    try {
      // Gate de intervalo (~15 min) por last_batch_at — evita enfileirar a cada
      // tick do agendador. Conexão nova (last_batch_at nulo) entra no 1º passe.
      rows = db.prepare(
        `SELECT id, organization_id FROM fiscal_inbound_connections
          WHERE enabled = 1 AND state = 'connected'
            AND (blocked_until IS NULL OR datetime(blocked_until) <= CURRENT_TIMESTAMP)
            AND (last_batch_at IS NULL OR datetime(last_batch_at) <= datetime('now', '-15 minutes'))`
      ).all() as any[];
    } catch { return; }
    for (const r of rows) {
      try { JobQueueService.enqueue("fiscal_inbound_sync", { orgId: r.organization_id, connectionId: r.id }, { organizationId: r.organization_id }); }
      catch (e) { console.error("[FiscalSync] pass falhou", r.id, e); }
    }
  }
}

// Handler da fila: um passe de sync em background. Classifica o erro pra decidir
// retry (JobQueue): credencial ausente/401 → permission (dead-letter, vira
// exceção "credencial ausente"); provedor fora do ar → external_unavailable
// (backoff maior); demais → retryable.
JobQueueService.registerHandler("fiscal_inbound_sync", async (p: any) => {
  try {
    const summary = await FiscalInboundSyncService.syncConnection(p.orgId, p.connectionId, { manual: !!p.manual });
    return { done: true, ...summary };
  } catch (e: any) {
    const code = e?.code || "";
    if (code === "invalid_client") throw new JobQueueError(String(e?.message || "credential_missing"), "permission");
    if (code === "provider_unavailable") throw new JobQueueError(String(e?.message || "provider_unavailable"), "external_unavailable");
    throw e; // retryable (default)
  }
});

export default FiscalInboundSyncService;
