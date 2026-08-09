/**
 * ExternalResearchProvider (ADR-156 D4) — abstração de PROVEDOR de pesquisa
 * externa. O broker/serviço pede uma CAPACIDADE ("pesquisa de vertical") e o
 * provider concreto é resolvido por registry + env — a plataforma NÃO fica
 * refém de um projeto específico (PRD §9). Trocar a tecnologia amanhã não toca
 * o resto.
 *
 * DI-4.1 entregou o `StubResearchProvider` DETERMINÍSTICO (sem rede) — para tudo
 * rodar offline em CI.
 *
 * DI-5.1 (ADR-157 D2) adiciona o `LlmResearchProvider`: embrulha o `chat()`
 * (`llm.js`) — a MESMA IA que o resto do repo já usa — para sintetizar o
 * panorama do nicho. Decisão do dono (2026-08-09): sem integrar vendor de busca
 * nesta etapa; a "pesquisa" é a síntese do próprio modelo. O prompt deriva SÓ de
 * `(vertical, topic, region, timeframe)` (RN-156-2 / RN-157-1). O `stub` SEGUE
 * como default do registry (RN-157-5): sem chave de IA, o LlmResearchProvider
 * cai no stub — CI e ambientes sem chave continuam verdes. O custo real por
 * chamada (`costCents`) alimenta o orçamento de PLATAFORMA (ADR-156 D6): quem
 * mede/bloqueia é o `VerticalIntelligenceService.runResearch` (já pronto).
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

/** Piso 0..1 pra confidence vinda da IA (pode vir fora do range ou não-numérica). */
function clamp01(n: any): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

/**
 * Custo estimado (centavos) de UMA chamada de síntese ao modelo. Configurável por
 * env; o `chat()` não devolve tokens, então usamos um custo plano por chamada —
 * suficiente para o orçamento de plataforma (ADR-156 D6) proteger o gasto. O stub
 * custa 0 (não bloqueia nada). Default conservador.
 */
const LLM_RESEARCH_COST_CENTS = Math.max(0, parseInt(process.env.EXTERNAL_RESEARCH_LLM_COST_CENTS || "3", 10) || 0);

/**
 * LlmResearchProvider (ADR-157 D2) — usa a IA que já roda no repo (`chat()`) para
 * sintetizar o panorama de mercado do nicho. Guardrails duros:
 * - Sem chave de IA (`isAIConfigured()`) → cai no STUB determinístico (RN-157-5):
 *   nunca lança, CI offline segue verde.
 * - Falha de rede/IA em runtime → também cai no stub (best-effort, nunca derruba
 *   o passe do Scheduler).
 * - O prompt é montado SÓ de (vertical, topic, region, timeframe) (RN-157-1) —
 *   nunca de dado de tenant. A anonimização final segue no `persistShared`.
 */
export class LlmResearchProvider implements ExternalResearchProvider {
  name = "llm";
  async research(q: ResearchQuery): Promise<ResearchResult> {
    // Import dinâmico: não carrega o SDK de IA a menos que este provider rode
    // (convenção nº 11) e evita acoplar o registry ao llm.js no load.
    const { isAIConfigured, chat } = await import("./llm.js");
    const fallback = () => REGISTRY.stub.research(q);
    if (!isAIConfigured()) return fallback();

    const system = `Você é um analista de INTELIGÊNCIA DE MERCADO. Produza um panorama do NICHO informado usando SÓ conhecimento de mercado (tendências, sazonalidade, concorrência, comportamento do consumidor, regulação do setor). NUNCA cite uma empresa específica do cliente, dados pessoais (nome, e-mail, CPF/CNPJ, telefone) nem métricas privadas. Responda SOMENTE um JSON: {"summary": "2 a 4 frases de panorama do nicho", "drivers": ["fator de mercado 1", "fator 2", "..."], "sources": ["referência pública, se houver"], "confidence": <número 0..1 de quão sólido é o panorama>}.`;
    // Prompt derivado SÓ da taxonomia do nicho (RN-157-1) — nunca de dado de tenant.
    const userPrompt = [
      `Vertical/nicho: ${q.vertical}`,
      `Tópico: ${q.topic}`,
      q.region ? `Região: ${q.region}` : "",
      q.timeframe ? `Período: ${q.timeframe}` : "",
      "",
      "Produza o panorama de mercado deste nicho no JSON pedido.",
    ].filter(Boolean).join("\n");

    let raw = "";
    try {
      raw = await chat(userPrompt, { system, json: true, temperature: 0.3 });
    } catch {
      return fallback(); // falha de IA nunca derruba o passe (convenção nº 7)
    }
    // Transformação pura e testável (parseLlmResearch) separada do IO acima:
    // pacote vazio/incoerente do modelo → stub (null); o gate de qualidade forte
    // é o curador da DI-5.3.
    return parseLlmResearch(raw, q) ?? fallback();
  }
}

/**
 * Transforma a resposta CRUA do modelo (string JSON) no `ResearchResult`
 * canônico — função PURA, sem rede/IO, para ser testável direto (sem chave de
 * IA). Retorna `null` quando o pacote é vazio/incoerente (o chamador cai no
 * stub). `content` deriva só da taxonomia do nicho (RN-157-1); a anonimização
 * final segue no `persistShared`.
 */
export function parseLlmResearch(raw: string, q: ResearchQuery): ResearchResult | null {
  const parsed = safeParse(raw) || {};
  const scope = [q.vertical, q.topic, q.region, q.timeframe].filter(Boolean).join(" · ");
  const content = {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    drivers: Array.isArray(parsed.drivers) ? parsed.drivers.map((d: any) => String(d)).slice(0, 12) : [],
    scope,
    generatedBy: "llm",
  };
  if (!content.summary && content.drivers.length === 0) return null;
  return {
    content,
    sources: Array.isArray(parsed.sources) ? parsed.sources.map((s: any) => String(s)).slice(0, 12) : [],
    confidence: clamp01(parsed.confidence),
    costCents: LLM_RESEARCH_COST_CENTS,
  };
}

const REGISTRY: Record<string, ExternalResearchProvider> = {
  stub: new StubResearchProvider(),
  llm: new LlmResearchProvider(),
};

/** Resolve o provider por nome → env `EXTERNAL_RESEARCH_PROVIDER` → 'stub'. */
export function getResearchProvider(name?: string): ExternalResearchProvider {
  const key = name || process.env.EXTERNAL_RESEARCH_PROVIDER || "stub";
  return REGISTRY[key] || REGISTRY.stub;
}

export default getResearchProvider;
