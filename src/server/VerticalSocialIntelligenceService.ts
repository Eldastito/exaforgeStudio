/**
 * VerticalSocialIntelligenceService (PRD 10 / ADR-167 F6) — CONSOLIDAÇÃO read-only da
 * inteligência social por NICHO pra uma org. REUTILIZA (§42, RN-EI-4): NÃO cria motor,
 * cache, budget nem tabela — só LÊ o que já existe e junta:
 *   (1) EXTERNO — pesquisa do nicho no pool COMPARTILHADO via `ResearchBrokerService.resolve`
 *       (respeita opt-in, freshness/valid_until e o cache L2/L3 do PRD 9; NUNCA chama o
 *       provider — RN-EI-4). Inclui a inteligência COMPETITIVA da F5 (topic "concorrência").
 *   (2) PRÓPRIO — o desempenho de POSTS da própria org via `SocialAnalyticsService` (F4):
 *       o que ESTA conta postou e como performou (formatos/engajamento).
 *
 * HONESTO: cada item externo carrega `evidenceMode` (síntese do modelo × fonte viva,
 * §53/§54) e `validUntil` (freshness); tópico sem entrada fresca aparece como
 * `available:false` com motivo — nunca inventa. Sem analytics próprios → `own` null (não 0).
 * Isolamento (convenção #1): `orgId` 1º arg; o próprio é por-org; o externo é a camada
 * compartilhada anonimizada (ADR-156). Serve o Estúdio orientado por inteligência (F8+).
 */
import { ResearchBrokerService } from "./ResearchBrokerService.js";
import { VerticalIntelligenceService } from "./VerticalIntelligenceService.js";
import { SocialAnalyticsService } from "./SocialAnalyticsService.js";

const DEFAULT_TOPICS = ["concorrência", "tendências", "formatos"];

export interface VerticalSocialExternalItem {
  topic: string;
  available: boolean;
  reason?: string;
  source?: string;           // cacheLevel L2/L3 (procedência do cache)
  evidenceMode?: string;     // model_knowledge × live (§53/§54)
  confidence?: number | null;
  summary?: string | null;
  validUntil?: string | null;
  trend?: any;
}

export class VerticalSocialIntelligenceService {
  /**
   * Monta a visão de inteligência social do nicho pra org. `channel` default 'instagram'
   * (o próprio); `topics` default concorrência/tendências/formatos. Read-only, determinístico.
   */
  static assemble(
    orgId: string,
    input: { vertical: string; channel?: string; topics?: string[]; region?: string; timeframe?: string },
  ): {
    vertical: string;
    channel: string;
    brokerEnabled: boolean;
    external: VerticalSocialExternalItem[];
    own: { channel: string; summary: any; topPosts: any[] } | null;
    freshness: { anyFresh: boolean; freshestValidUntil: string | null };
    caveats: string[];
  } {
    const vertical = String(input?.vertical || "").trim();
    if (!vertical) throw new Error("vertical é obrigatório.");
    const channel = String(input?.channel || "instagram").trim() || "instagram";
    const topics = (Array.isArray(input?.topics) && input.topics.length ? input.topics : DEFAULT_TOPICS).map((t) => String(t).trim()).filter(Boolean);
    const caveats: string[] = [];

    const brokerEnabled = ResearchBrokerService.isEnabled(orgId);
    if (!brokerEnabled) caveats.push("external_intelligence_off"); // camada externa opt-out (§31)

    // ── (1) EXTERNO — pool compartilhado (reusa freshness/cache/budget, nunca pesquisa) ──
    const external: VerticalSocialExternalItem[] = topics.map((topic) => {
      const res = ResearchBrokerService.resolve(orgId, { vertical, topic, region: input.region, timeframe: input.timeframe });
      if (!res?.available) return { topic, available: false, reason: res?.reason || "unavailable" };
      // Enriquecer com procedência (evidenceMode) + freshness da entrada compartilhada.
      const vi = VerticalIntelligenceService.getFresh(vertical, topic, input.region, input.timeframe);
      const content = vi?.content || {};
      return {
        topic,
        available: true,
        source: res.cacheLevel || res.source || null,
        evidenceMode: content.evidenceMode || "model_knowledge",
        confidence: typeof vi?.confidence === "number" ? vi.confidence : null,
        summary: content.summary ?? res.contextualization?.summary ?? null,
        validUntil: vi?.valid_until || res.contextualization?.validUntil || null,
        trend: res.trend || null,
      };
    });

    const freshDates = external.filter((e) => e.available && e.validUntil).map((e) => e.validUntil as string);
    const freshestValidUntil = freshDates.length ? freshDates.sort().slice(-1)[0] : null;
    const anyFresh = external.some((e) => e.available);
    if (!anyFresh) caveats.push("no_fresh_external_intelligence");
    if (external.some((e) => e.available && e.evidenceMode === "model_knowledge") && !external.some((e) => e.evidenceMode === "live")) {
      caveats.push("external_model_knowledge_only"); // só síntese do modelo, sem fonte viva (§53/§54)
    }

    // ── (2) PRÓPRIO — desempenho dos posts da própria org (F4). Null honesto se vazio. ──
    const ownSummary = SocialAnalyticsService.summary(orgId, channel);
    let own: { channel: string; summary: any; topPosts: any[] } | null = null;
    if (ownSummary.posts > 0) {
      own = { channel, summary: ownSummary, topPosts: SocialAnalyticsService.list(orgId, channel, { limit: 5 }) };
    } else {
      caveats.push("no_own_analytics"); // sem histórico próprio ingerido (F4) — não inventa
    }

    return {
      vertical,
      channel,
      brokerEnabled,
      external,
      own,
      freshness: { anyFresh, freshestValidUntil },
      caveats,
    };
  }
}

export default VerticalSocialIntelligenceService;
