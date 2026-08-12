/**
 * ReputationIngestionService (ADR-162 / PRD 5 §9-§10, F2) — a INGESTÃO: puxa itens
 * de um `ReputationProvider` (transporte) e os transforma em `business_signals` via
 * o contrato de sinais externos do PRD 2 (`ExternalSignalService`). É AQUI que vive
 * a lógica de domínio que o provider NÃO tem (D4/§8): mapear item→sinal, escolher
 * domain/signalType/basis, gate de flags, cursor incremental.
 *
 * Sem ledger/tabela de reputação nova (D1/§5): o sinal é `domain='reputation'`,
 * `signalType='public_complaint'` (D2), dedupe `external:<source>:<externalId>`
 * (idempotência de conector, §9/§71). A reclamação é `basis='estimate'` — afirmação
 * de terceiro, NUNCA fato automático (RN-CRR-2/§10/§13). Autor mascarado na ingestão
 * (LGPD). Leitura incremental por cursor (§70): só o que mudou desde o último sync.
 *
 * Gate triplo (opt-in, §83): `reputation_engine_enabled` (módulo) + o conector
 * habilitado (`reputation_connectors.enabled`) + o contrato externo
 * (`radar_external_signals_enabled`, checado pelo próprio ExternalSignalService).
 * Qualquer um OFF → não ingere; devolve motivo explícito, nunca falha silenciosa.
 */
import db from "./db.js";
import { ExternalSignalService, ExternalSignalInput } from "./ExternalSignalService.js";
import { ReputationConnectorService } from "./ReputationConnectorService.js";
import type { ReputationItem, ReputationProvider } from "./ReputationProvider.js";

export interface ReputationSyncResult {
  ok: boolean;
  reason?: string;      // motivo quando ok=false (gate) ou degradação
  ingested: number;     // sinais novos criados
  deduped: number;      // itens que atualizaram sinal existente (idempotência)
  scanned: number;      // itens lidos do provider
  pages: number;        // páginas percorridas
  cursor: string | null; // marca d'água final (updatedAt máx ingerido)
  degraded?: boolean;   // provider não-configurado/indisponível (§6/§68)
}

const MAX_PAGES = 20;   // teto de segurança por passe (não varre histórico inteiro, §70)

export class ReputationIngestionService {
  /** Módulo de reputação ligado? (guarda-chuva §83, D7). */
  static engineEnabled(orgId: string): boolean {
    const r = db.prepare(`SELECT COALESCE(reputation_engine_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && r.e);
  }

  /** Conector habilitado pra esta org? (linha reputation_connectors.enabled). */
  static connectorEnabled(orgId: string, provider: string): boolean {
    const r = db.prepare(`SELECT enabled FROM reputation_connectors WHERE organization_id = ? AND provider = ?`).get(orgId, provider) as any;
    return !!(r && r.enabled);
  }

  /**
   * Mapeia um `ReputationItem` (transporte) → `ExternalSignalInput` (domínio). PURO
   * e testável. Escolhas de domínio (não do provider): domain='reputation',
   * signalType='public_complaint' (D2), `verifiable=false`/`basis='estimate'` — a
   * reclamação é afirmação de terceiro (RN-CRR-2). Sujeito = o próprio item (source/
   * externalId) até a identity resolution (F3) re-sujeitar ao contato. Severidade é
   * DERIVADA pelo ExternalSignalService a partir de rating/sentiment.
   */
  static toExternalSignalInput(item: ReputationItem): ExternalSignalInput {
    return {
      source: item.source,
      externalId: item.externalId,
      domain: "reputation",
      signalType: "public_complaint",
      content: item.content,
      basis: "estimate",       // §10/§13/RN-CRR-2: claim de terceiro, nunca fato automático
      verifiable: false,
      subjectType: "reputation_item",
      subjectId: item.externalId,
      url: item.url ?? null,
      publishedAt: item.publishedAt ?? null,
      author: item.author ?? null,   // mascarado dentro do ExternalSignalService (LGPD)
      sentiment: item.sentiment ?? null,
      rating: item.rating ?? null,
      ratingScale: item.ratingScale ?? null,
      // correlationId omitido: enraíza a própria cadeia (ADR-158); réplica/update do
      // mesmo externalId dedupam no mesmo sinal.
    };
  }

  /**
   * Passe de sincronização incremental. Resolve o provider da org, lê a partir do
   * cursor, ingere cada item e avança o cursor pela MAIOR updatedAt vista. Provider
   * não-configurado/indisponível → degrada (ok:true, degraded:true, 0 ingerido), com
   * health registrado — nunca lança, nunca perde o caso (§6/§68).
   */
  static async sync(orgId: string, opts: { provider?: string; maxPages?: number } = {}): Promise<ReputationSyncResult> {
    const provider = opts.provider || "reclame_aqui";
    const base: ReputationSyncResult = { ok: false, ingested: 0, deduped: 0, scanned: 0, pages: 0, cursor: null };

    // Gate 1 — módulo. Gate 2 — conector. Gate 3 — contrato externo (ExternalSignalService).
    if (!this.engineEnabled(orgId)) return { ...base, reason: "reputation_engine_disabled" };
    if (!this.connectorEnabled(orgId, provider)) return { ...base, reason: "connector_disabled" };
    if (!ExternalSignalService.enabled(orgId)) return { ...base, reason: "external_signals_disabled" };

    const prov: ReputationProvider = ReputationConnectorService.providerFor(orgId, provider);

    // Provider real sem config → degrada explicitamente (não fabrica, §6).
    if (typeof (prov as any).isConfigured === "function" && !(prov as any).isConfigured()) {
      ReputationConnectorService.recordHealth(orgId, provider, "unavailable", "conector não configurado");
      return { ...base, ok: true, degraded: true, reason: "provider_unconfigured", cursor: ReputationConnectorService.getCursor(orgId, provider) };
    }

    let cursor = ReputationConnectorService.getCursor(orgId, provider); // marca d'água (ISO updatedAt)
    let watermark = cursor;
    let pageCursor: string | null = null;
    let ingested = 0, deduped = 0, scanned = 0, pages = 0;
    const maxPages = Math.min(MAX_PAGES, opts.maxPages && opts.maxPages > 0 ? opts.maxPages : MAX_PAGES);

    try {
      do {
        const res = await prov.listNewItems({ since: cursor, cursor: pageCursor, limit: 50 });
        const items = res.items || [];
        for (const item of items) {
          scanned++;
          const out = ExternalSignalService.ingest(orgId, this.toExternalSignalInput(item));
          if (out.ok) { out.deduped ? deduped++ : ingested++; }
          // Avança a marca d'água pela maior updatedAt vista (não pela ordem de página).
          const ts = item.updatedAt || item.publishedAt || null;
          if (ts && (!watermark || ts > watermark)) watermark = ts;
        }
        pages++;
        pageCursor = res.nextCursor || null;
      } while (pageCursor && pages < maxPages);

      // Persiste a marca d'água só se avançou (idempotência: re-sync não regride).
      if (watermark && watermark !== cursor) ReputationConnectorService.setCursor(orgId, provider, watermark);
      ReputationConnectorService.recordHealth(orgId, provider, "connected", `sync ok: +${ingested} novos, ${deduped} atualizados`);
      return { ok: true, ingested, deduped, scanned, pages, cursor: watermark || cursor };
    } catch (e: any) {
      // Falha de transporte não perde o caso — degrada e registra health (§68).
      ReputationConnectorService.recordHealth(orgId, provider, "degraded", String(e?.message || e).slice(0, 200));
      return { ...base, ok: true, degraded: true, reason: "provider_error", ingested, deduped, scanned, pages, cursor: watermark || cursor };
    }
  }
}

export default ReputationIngestionService;
