/**
 * CompetitiveIntelligenceProvider (PRD 10 / ADR-167 F5) — adaptador de INTELIGÊNCIA
 * COMPETITIVA atrás do MESMO contrato `ExternalResearchProvider` do PRD 9 (D5, §42):
 * NÃO cria um segundo pipeline de pesquisa — plugga no registry existente e o resultado
 * flui pelo `VerticalIntelligenceService.runResearch` (orçamento + anonimização +
 * curadoria + procedência + persistência já prontos).
 *
 * FONTE PÚBLICA/LEGAL apenas (RN-SI-11): lê só de uma fonte configurada de dado PÚBLICO
 * de concorrência (`COMPETITIVE_INTEL_SOURCE_URL`) — nunca raspa área logada nem contorna
 * termos. HONESTO por design (RN-EI-6, espelha `LiveSearchResearchProvider`):
 *  - SEM fonte configurada → síntese `model_knowledge` determinística (claramente rotulada
 *    "sem fonte pública configurada"); NUNCA fabrica evidência viva de concorrente.
 *  - Falha de rede/parse → também degrada pra model_knowledge (best-effort, nunca derruba).
 *  - GROUNDING obrigatório (RN-EI-5): só emite `live` com ≥1 fonte recuperada; payload sem
 *    fonte volta a model_knowledge honesto (não inventa fonte pra parecer viva).
 *  - Query derivada SÓ de (vertical, topic, region, timeframe) (RN-EI-2) — nunca dado de
 *    tenant. Opt-in + orçamento + master-only são impostos por quem chama (runResearch).
 */
import type {
  ExternalResearchProvider,
  ResearchQuery,
  ResearchResult,
  SourceEvidence,
} from "./ExternalResearchProvider.js";

export class CompetitiveIntelligenceProvider implements ExternalResearchProvider {
  name = "competitive";

  static isConfigured(): boolean {
    return !!(process.env.COMPETITIVE_INTEL_SOURCE_URL || "").trim();
  }

  /** Síntese honesta do modelo quando não há fonte pública viva (nunca inventa live). */
  private modelKnowledge(q: ResearchQuery, detail?: string): ResearchResult {
    const scope = [q.vertical, q.topic, q.region, q.timeframe].filter(Boolean).join(" · ");
    return {
      content: {
        summary: `Panorama competitivo do nicho ${q.vertical} sobre "${q.topic}"${q.region ? ` em ${q.region}` : ""}${q.timeframe ? ` (${q.timeframe})` : ""}.`,
        competitiveDrivers: [
          `movimento típico de concorrência no nicho ${q.vertical}`,
          "posicionamento e sortimento comuns no setor",
          "sazonalidade competitiva do período",
        ],
        scope,
        note: detail || "sem fonte pública de concorrência configurada — síntese do modelo (não é fonte viva).",
        generatedBy: "competitive:model_knowledge",
      },
      sources: [],
      confidence: 0.4,
      evidenceMode: "model_knowledge",   // síntese ≠ fonte viva (§53/§54, RN-EI-1/6)
      sourceEvidence: [],
      retrievedAt: null,
    };
  }

  async research(q: ResearchQuery): Promise<ResearchResult> {
    const url = (process.env.COMPETITIVE_INTEL_SOURCE_URL || "").trim();
    if (!url) return this.modelKnowledge(q); // sem fonte → honesto, não inventa live
    const apiKey = (process.env.COMPETITIVE_INTEL_SOURCE_API_KEY || "").trim();
    const endpoint = `${url}${url.includes("?") ? "&" : "?"}q=${encodeURIComponent(q.query)}`;
    let raw = "";
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const resp = await fetch(endpoint, { headers });
      if (!resp.ok) return this.modelKnowledge(q, "fonte pública indisponível no momento — síntese do modelo.");
      raw = await resp.text();
    } catch {
      return this.modelKnowledge(q, "falha ao consultar a fonte pública — síntese do modelo."); // rede nunca derruba (convenção nº 7)
    }
    const retrievedAt = new Date().toISOString();
    return this.parse(raw, q, retrievedAt) ?? this.modelKnowledge(q, "resposta da fonte sem fundamentação — síntese do modelo.");
  }

  /**
   * Transforma a resposta CRUA (JSON público) num `ResearchResult` LIVE tier B —
   * PURA (o `retrievedAt` é injetado). GROUNDING (RN-EI-5): sem nenhuma fonte
   * recuperada → retorna null (o caller cai em model_knowledge honesto). Aceita
   * `{ competitors|results: [...], sources: [{url,title,publisher}] }` de forma tolerante.
   */
  parse(raw: string, q: ResearchQuery, retrievedAt: string): ResearchResult | null {
    let data: any;
    try { data = JSON.parse(raw); } catch { return null; }
    const items = Array.isArray(data?.competitors) ? data.competitors
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data) ? data : [];
    const rawSources = Array.isArray(data?.sources) ? data.sources : [];
    const sourceEvidence: SourceEvidence[] = rawSources
      .map((s: any) => ({
        url: typeof s?.url === "string" ? s.url : null,
        title: typeof s?.title === "string" ? s.title : null,
        publisher: typeof s?.publisher === "string" ? s.publisher : null,
        tier: "B" as const,          // recuperada/verificável, não fonte primária oficial
        retrievedAt,
        freshness: typeof s?.freshness === "string" ? s.freshness : null,
      }))
      .filter((s: SourceEvidence) => s.url || s.title);
    // GROUNDING: live SEM fonte não é live (RN-EI-5) → deixa o caller degradar honesto.
    if (sourceEvidence.length === 0) return null;
    const content = {
      summary: typeof data?.summary === "string" ? data.summary : `Concorrência recuperada para "${q.topic}" (${q.vertical}).`,
      competitors: items.slice(0, 20),
      scope: [q.vertical, q.topic, q.region, q.timeframe].filter(Boolean).join(" · "),
      generatedBy: "competitive:live",
    };
    return {
      content,
      sources: sourceEvidence.map((e) => e.url || e.title || "").filter(Boolean),
      confidence: typeof data?.confidence === "number" ? Math.max(0, Math.min(1, data.confidence)) : 0.6,
      costCents: typeof data?.costCents === "number" ? data.costCents : 0,
      evidenceMode: "live",
      sourceEvidence,
      retrievedAt,
    };
  }
}

export default CompetitiveIntelligenceProvider;
