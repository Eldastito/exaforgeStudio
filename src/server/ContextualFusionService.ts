/**
 * ContextualFusionService — PRD 9 / ADR-166 F12 (§9, RN-EL-6/RN-EI-1, CA34/CA35).
 *
 * FUSÃO das três origens de contexto que o pacote de decisão já carrega:
 *   INTERNO   (Business Snapshot — o que ESTÁ acontecendo no negócio)
 *   HISTÓRICO (aprendizado ASSEGURADO — o que JÁ FUNCIONOU/contradisse, F4)
 *   EXTERNO   (inteligência de nicho — o que o MERCADO indica, com evidenceMode)
 *
 * A fusão ALINHA e ROTULA — NUNCA soma bases distintas (CA35, RN-EL-6): fato,
 * estimativa, taxa-assegurada, model_knowledge e live convivem lado a lado com sua
 * procedência, e a "força" do contexto é CATEGÓRICA (strong/moderate/weak), não um
 * número inventado da mistura. Determinístico, read-only, isolado por org.
 *
 * COMPÕE `EvidencePackageService` (internal/historical/external) — não recalcula
 * domínio nem cria pipeline. Para o `evidenceMode` do externo (não exposto no slot
 * do pacote), lê o `vertical_intelligence` fresco por tópico (F7 persistiu lá).
 */
import db from "./db.js";
import { EvidencePackageService } from "./EvidencePackageService.js";
import { VerticalIntelligenceService } from "./VerticalIntelligenceService.js";

function safeParse(s: any): any { try { return JSON.parse(s); } catch { return null; } }

export class ContextualFusionService {
  /**
   * Funde o contexto por TÓPICO/domínio. Retorna, para cada tema ativo, as três
   * facetas (qualquer uma pode faltar), a procedência presente e a força categórica.
   */
  static fuse(orgId: string, opts: { subject?: string } = {}): any {
    if (!orgId) return { topics: [], note: "sem org" };
    const pkg = EvidencePackageService.build(orgId, opts.subject ? { subject: opts.subject } : {});
    const vertical = pkg.vertical;

    // HISTÓRICO: aprendizado assegurado por domínio (F4).
    const hist = new Map<string, any>();
    for (const h of pkg.historicalEvidence || []) {
      if (!h || !h.domain) continue;
      // guarda o de MAIOR prova assegurada por domínio (o mais informativo).
      const cur = hist.get(h.domain);
      if (!cur || (Number(h.assuredActed) || 0) > (Number(cur.assuredActed) || 0)) hist.set(h.domain, h);
    }

    // EXTERNO: por tópico (o externo é keyed por topic; o pacote traz vertical/topic).
    const ext = new Map<string, any>();
    for (const e of pkg.externalEvidence || []) {
      if (!e || !e.topic) continue;
      ext.set(String(e.topic).toLowerCase(), e);
    }

    // INTERNO: domínios presentes no snapshot com dado disponível.
    const internalDomains: Record<string, any> = (pkg.internalEvidence && typeof pkg.internalEvidence === "object") ? pkg.internalEvidence : {};

    // União das chaves de domínio (interno + histórico). O externo casa por tópico.
    const domains = new Set<string>([...Object.keys(internalDomains), ...hist.keys()]);

    const topics: any[] = [];
    for (const domain of domains) {
      const topic = topicForDomain(domain);
      const internalAvailable = !!internalDomains[domain] && internalDomains[domain]?.available !== false;
      const h = hist.get(domain) || null;
      let e = ext.get(topic.toLowerCase()) || null;

      // evidenceMode do externo: não vem no slot do pacote → lê do vertical_intelligence
      // fresco (F7 persistiu evidenceMode no content_json). Sem intel → null.
      let externalMode: string | null = null;
      if (e && vertical) {
        const fresh = VerticalIntelligenceService.getFresh(vertical, topic);
        const c = fresh?.content && typeof fresh.content === "object" ? fresh.content : safeParse(fresh?.content);
        externalMode = (c && typeof c.evidenceMode === "string") ? c.evidenceMode : null;
      }

      const historical = h ? {
        learningState: h.learningState, assuredEffectiveness: h.assuredEffectiveness,
        assuredActed: h.assuredActed, suggestedRefutation: !!h.suggestedRefutation, hasAssured: (Number(h.assuredActed) || 0) > 0,
      } : null;
      const external = e ? { summary: e.summary ?? null, confidence: e.confidence ?? null, evidenceMode: externalMode ?? "unknown" } : null;

      // Procedência PRESENTE (nunca somada — só listada, CA35).
      const provenance: string[] = [];
      if (internalAvailable) provenance.push("internal");
      if (historical?.hasAssured) provenance.push("assured_history");
      if (external) provenance.push(external.evidenceMode === "live" ? "external_live" : "external_model");
      const facets = provenance.length;

      // Força CATEGÓRICA (determinística; NÃO é média/soma):
      //  strong   = aprendizado assegurado E externo VIVO (as duas provas fortes).
      //  moderate = uma prova forte (assegurado OU externo vivo).
      //  weak     = só interno e/ou externo model_knowledge (síntese, sem prova forte).
      const hasAssured = !!historical?.hasAssured;
      const hasLive = external?.evidenceMode === "live";
      const strength = (hasAssured && hasLive) ? "strong" : (hasAssured || hasLive) ? "moderate" : "weak";

      const caveats: string[] = [];
      if (external && external.evidenceMode !== "live") caveats.push("external_is_model_synthesis");
      if (!hasAssured) caveats.push("no_assured_learning");
      if (facets <= 1) caveats.push("single_source");
      if (historical?.suggestedRefutation) caveats.push("history_contradicts_pattern");

      topics.push({ domain, topic, internal: { available: internalAvailable }, historical, external, provenance, facets, strength, caveats });
    }

    // Ordena: mais facetas (contexto mais completo) e força primeiro.
    const rank = { strong: 3, moderate: 2, weak: 1 } as any;
    topics.sort((a, b) => (b.facets - a.facets) || ((rank[b.strength] || 0) - (rank[a.strength] || 0)));

    return {
      vertical, subject: pkg.subject, topics,
      note: "Fusão ALINHA e ROTULA as 3 origens; NUNCA soma bases distintas (CA35/RN-EL-6). Força é categórica, não numérica.",
    };
  }
}

// Mesmo mapa domínio→tópico do ResearchNeedService (F11), duplicado mínimo para não
// acoplar os dois services; fallback = o próprio domínio.
function topicForDomain(domain: string): string {
  const MAP: Record<string, string> = {
    finance: "custos e capital de giro", sales: "demanda e conversão", procurement: "insumos e fornecedores",
    inventory: "estoque e giro", retail_ops: "operação de loja", marketing: "aquisição e mídia",
    reputation: "reputação e concorrência", people: "pessoas e mão de obra", hr: "pessoas e mão de obra",
    tasks: "produtividade operacional",
  };
  const d = String(domain || "").trim().toLowerCase();
  return MAP[d] || d || "mercado";
}

export default ContextualFusionService;
