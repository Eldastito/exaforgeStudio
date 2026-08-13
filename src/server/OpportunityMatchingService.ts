/**
 * OpportunityMatchingService (PRD 10 / ADR-167 F7) — cruza a inteligência social do
 * nicho (F6) com o MOMENTO da própria org e, quando há encaixe REAL, publica uma
 * OPORTUNIDADE na espinha canônica (`business_signals`, D6/§42 — NUNCA tabela paralela
 * de alertas). É a virada de percepção → ação: "o que o mercado faz" vira "esta é a
 * oportunidade acionável pra você agora", entrando no fluxo existente de
 * decisão/governança (attention → DecisionEngine → ApprovalPolicy → …).
 *
 * GROUNDING (RN-SI-02/03): NÃO inventa oportunidade. Só publica a partir de inteligência
 * de nicho FRESCA e disponível (F6); sem base fresca → nada (honesto). A oportunidade é
 * HIPÓTESE (`basis='hypothesis'`) — PUBLISHED ≠ RESULTADO; vira fato só quando executada
 * e medida (Outcome Assurance). NUNCA inventa dinheiro (`impactAmount=null`). Idempotente:
 * `dedupe_key` estável por (vertical, topic, channel) — re-detecção renova, não duplica.
 * TTL honesto: a oportunidade expira junto com a inteligência que a fundamenta (validUntil).
 * Isolamento (convenção #1): `orgId` 1º arg; toda leitura/publicação filtra a org.
 */
import db from "./db.js";
import { VerticalSocialIntelligenceService } from "./VerticalSocialIntelligenceService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

export interface OpportunityMatch {
  topic: string;
  dedupeKey: string;
  signalId: string;
  correlationId: string;
  evidenceMode: string;
  confidence: number;
  validUntil: string | null;
}

export class OpportunityMatchingService {
  private static verticalOf(orgId: string): string | null {
    const row = db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const v = row?.vertical ? String(row.vertical).trim() : "";
    return v || null;
  }

  /**
   * Cruza F6 com o momento da org e (opt-in `publish`) publica as oportunidades frescas.
   * `vertical` default = o da org (`organization_settings.vertical`). Read-only quando
   * `publish=false`. Retorna o que casou + motivo quando nada casa (honesto).
   */
  static match(
    orgId: string,
    input: { vertical?: string; channel?: string; publish?: boolean } = {},
  ): { vertical: string | null; channel: string; matched: number; opportunities: OpportunityMatch[]; reason?: string; caveats: string[] } {
    const vertical = (input.vertical && input.vertical.trim()) || this.verticalOf(orgId);
    const channel = String(input.channel || "instagram").trim() || "instagram";
    if (!vertical) return { vertical: null, channel, matched: 0, opportunities: [], reason: "no_vertical", caveats: [] };

    const view = VerticalSocialIntelligenceService.assemble(orgId, { vertical, channel });
    if (!view.brokerEnabled) return { vertical, channel, matched: 0, opportunities: [], reason: "external_intelligence_off", caveats: view.caveats };

    const now = Date.now();
    // Candidatos = inteligência do nicho DISPONÍVEL e ainda FRESCA (grounding — RN-SI-02).
    const fresh = view.external.filter((e) => e.available && e.validUntil && new Date(e.validUntil).getTime() > now);
    if (fresh.length === 0) return { vertical, channel, matched: 0, opportunities: [], reason: "no_fresh_intelligence", caveats: view.caveats };

    // "Momento da org": presença/desempenho próprios elevam levemente a confiança do encaixe.
    const ownPosts = view.own?.summary?.posts || 0;
    const ownBoost = ownPosts > 0 ? 0.1 : 0;

    const opportunities: OpportunityMatch[] = [];
    for (const cand of fresh) {
      const dedupeKey = `social_opportunity:${vertical}:${cand.topic}:${channel}`;
      const confidence = Math.max(0, Math.min(1, (typeof cand.confidence === "number" ? cand.confidence : 0.5) + ownBoost));
      if (!input.publish) {
        opportunities.push({ topic: cand.topic, dedupeKey, signalId: "", correlationId: "", evidenceMode: cand.evidenceMode || "model_knowledge", confidence, validUntil: cand.validUntil || null });
        continue;
      }
      // Publica na espinha canônica. HIPÓTESE (basis) — PUBLISHED ≠ RESULTADO (RN-SI-03).
      const pub = BusinessSignalService.publish(orgId, {
        domain: "social",
        signalType: "content_opportunity",
        severity: "attention",
        basis: "hypothesis",
        confidence,
        impactAmount: null,          // NUNCA inventa dinheiro (RN-SI)
        sourceService: "OpportunityMatchingService",
        subjectType: "opportunity",
        subjectId: dedupeKey,
        dedupeKey,
        expiresAt: cand.validUntil || null,   // expira junto da inteligência que a fundamenta
        evidence: {
          vertical, topic: cand.topic, channel,
          source: cand.source || null,
          evidenceMode: cand.evidenceMode || "model_knowledge",
          validUntil: cand.validUntil || null,
          summary: cand.summary ?? null,
          own: { channel, posts: ownPosts },
          note: `Oportunidade de conteúdo no nicho ${vertical} sobre "${cand.topic}".`,
        },
        premises: view.caveats.length ? { caveats: view.caveats } : null,
      });
      opportunities.push({ topic: cand.topic, dedupeKey, signalId: pub.id, correlationId: pub.correlationId, evidenceMode: cand.evidenceMode || "model_knowledge", confidence, validUntil: cand.validUntil || null });
    }
    return { vertical, channel, matched: opportunities.length, opportunities, caveats: view.caveats };
  }

  /**
   * Passe do Scheduler (horário): casa oportunidades pras orgs com inteligência externa
   * LIGADA + vertical definida. Best-effort por org; publica na espinha (idempotente).
   * NÃO cria 2º Scheduler (§42) — chamado do `tick`.
   */
  static pass(): void {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT organization_id FROM organization_settings
         WHERE COALESCE(external_intelligence_enabled,0) = 1 AND vertical IS NOT NULL AND TRIM(vertical) != ''`,
      ).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try { this.match(o.organization_id, { publish: true }); }
      catch (e: any) { console.error(`[OpportunityMatching] falhou (org ${o.organization_id})`, e?.message || e); }
    }
  }
}

export default OpportunityMatchingService;
