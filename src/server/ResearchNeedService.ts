/**
 * ResearchNeedService — PRD 9 / ADR-166 F11 (§29, RN-EI-2/4).
 *
 * DETECÇÃO de necessidade de pesquisa externa + mapa de TAXONOMIA. Responde:
 * "sobre quais temas de mercado este negócio está lidando AGORA, e para quais NÃO há
 * inteligência de nicho fresca?". Cada lacuna vira uma tupla canônica
 * `(vertical, topic, region, timeframe)` — a MESMA taxonomia que o provider/curador
 * consomem (RN-EI-2, query só de taxonomia, sem dado de tenant).
 *
 * COMPÕE o que já existe (não cria motor): os `business_signals` ABERTOS do org (os
 * temas ativos do negócio) × a camada compartilhada `vertical_intelligence`
 * (`getFresh`). Determinístico, read-only, isolado por `organization_id`.
 *
 * GUARDRAILS: NÃO roda pesquisa (RN-EI-4 — master + budget + opt-in decidem isso, no
 * `runResearch`/`curate`); só DETECTA e prioriza. Sem `vertical` configurada → não há
 * como taxonomizar → retorna honesto (`reason:'no_vertical'`), nunca inventa nicho.
 */
import db from "./db.js";
import { VerticalIntelligenceService } from "./VerticalIntelligenceService.js";

// Mapa domínio→tópico de pesquisa (PT-BR). Determinístico; fallback = o próprio domínio.
const TOPIC_MAP: Record<string, string> = {
  finance: "custos e capital de giro",
  sales: "demanda e conversão",
  procurement: "insumos e fornecedores",
  inventory: "estoque e giro",
  retail_ops: "operação de loja",
  marketing: "aquisição e mídia",
  reputation: "reputação e concorrência",
  people: "pessoas e mão de obra",
  hr: "pessoas e mão de obra",
  tasks: "produtividade operacional",
};
const SEV_RANK: Record<string, number> = { info: 0, attention: 1, risk: 2, critical: 3 };

export class ResearchNeedService {
  static topicFor(domain: string): string {
    const d = String(domain || "").trim().toLowerCase();
    return TOPIC_MAP[d] || d || "mercado";
  }

  /**
   * Detecta as necessidades de pesquisa do org: temas ativos (sinais abertos) sem
   * inteligência de nicho fresca. `region`/`timeframe` opcionais entram na taxonomia.
   */
  static detect(orgId: string, opts: { region?: string; timeframe?: string } = {}): any {
    if (!orgId) return { vertical: null, needs: [], covered: [], reason: "no_org" };
    const vertical = (db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.vertical || null;
    if (!vertical) return { vertical: null, needs: [], covered: [], reason: "no_vertical" };

    const region = opts.region ? String(opts.region).trim() : null;
    const timeframe = opts.timeframe ? String(opts.timeframe).trim() : null;

    // Temas ativos = domínios dos sinais ABERTOS do org, com contagem + pior severidade.
    const rows = db.prepare(
      `SELECT domain,
              COUNT(*) AS signal_count,
              MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'risk' THEN 2 WHEN 'attention' THEN 1 ELSE 0 END) AS sev_rank
         FROM business_signals
        WHERE organization_id = ? AND status = 'open'
        GROUP BY domain`
    ).all(orgId) as any[];

    const needs: any[] = [];
    const covered: any[] = [];
    for (const r of rows) {
      const domain = String(r.domain);
      const topic = this.topicFor(domain);
      const taxonomy = { vertical, topic, region, timeframe };
      const fresh = VerticalIntelligenceService.getFresh(vertical, topic, region || undefined, timeframe || undefined);
      const entry = {
        domain, topic, taxonomy,
        signalCount: Number(r.signal_count) || 0,
        severityRank: Number(r.sev_rank) || 0,
        severity: Object.keys(SEV_RANK).find((k) => SEV_RANK[k] === (Number(r.sev_rank) || 0)) || "info",
      };
      if (fresh) covered.push({ ...entry, status: "covered", validUntil: fresh.validUntil ?? fresh.valid_until ?? null });
      else needs.push({ ...entry, status: "missing" });
    }
    // Prioriza: pior severidade primeiro, depois mais sinais.
    needs.sort((a, b) => (b.severityRank - a.severityRank) || (b.signalCount - a.signalCount));

    return {
      vertical, region, timeframe,
      needs, covered,
      note: "Detecção read-only (RN-004); NÃO roda pesquisa (master+budget decidem — RN-EI-4). Taxonomia (vertical,topic,region,timeframe) pronta pro provider.",
    };
  }
}

export default ResearchNeedService;
