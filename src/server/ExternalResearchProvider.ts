/**
 * ExternalResearchProvider (ADR-156 D4) — abstração de PROVEDOR de pesquisa
 * externa. O broker/serviço pede uma CAPACIDADE ("pesquisa de vertical") e o
 * provider concreto é resolvido por registry + env — a plataforma NÃO fica
 * refém de um projeto específico (PRD §9). Trocar a tecnologia amanhã não toca
 * o resto.
 *
 * DI-4.1 entrega só o `StubResearchProvider` DETERMINÍSTICO (sem chamada de
 * rede) — para tudo rodar offline em CI. Um provider real (web-search) entra na
 * DI-4.4, atrás desta mesma interface, gated por env.
 */

export interface ResearchQuery {
  vertical: string;
  topic: string;
  region?: string;
  timeframe?: string;
  query: string; // derivada SÓ de (vertical, topic, region, timeframe) — RN-156-2
}

export interface ResearchResult {
  content: any;       // achados do mundo externo (JSON)
  sources: string[];
  confidence: number; // 0..1
  costCents?: number; // custo da chamada (para o orçamento de pesquisa, DI-4.2); stub = 0
}

export interface ExternalResearchProvider {
  name: string;
  research(q: ResearchQuery): Promise<ResearchResult> | ResearchResult;
}

/**
 * Stub determinístico: devolve um pacote derivado da query, SEM rede, SEM dado
 * de tenant, SEM dado pessoal. Serve para exercitar broker/dedup/freshness/
 * contextualização em CI. O conteúdo é claramente "mundo externo".
 */
export class StubResearchProvider implements ExternalResearchProvider {
  name = "stub";
  research(q: ResearchQuery): ResearchResult {
    const scope = [q.vertical, q.topic, q.region, q.timeframe].filter(Boolean).join(" · ");
    return {
      content: {
        summary: `Panorama de mercado do nicho ${q.vertical} sobre "${q.topic}"${q.region ? ` em ${q.region}` : ""}${q.timeframe ? ` (${q.timeframe})` : ""}.`,
        drivers: [`tendência agregada do nicho ${q.vertical}`, "sazonalidade típica do período", "movimento de concorrência no setor"],
        scope,
        generatedBy: "stub",
      },
      sources: ["stub://vertical-intelligence"],
      confidence: 0.5,
    };
  }
}

const REGISTRY: Record<string, ExternalResearchProvider> = {
  stub: new StubResearchProvider(),
};

/** Resolve o provider por nome → env `EXTERNAL_RESEARCH_PROVIDER` → 'stub'. */
export function getResearchProvider(name?: string): ExternalResearchProvider {
  const key = name || process.env.EXTERNAL_RESEARCH_PROVIDER || "stub";
  return REGISTRY[key] || REGISTRY.stub;
}

export default getResearchProvider;
