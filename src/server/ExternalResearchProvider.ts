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

/**
 * Procedência de UMA fonte (PRD 9 / ADR-166 F7). Distingue evidência VIVA de
 * conhecimento do modelo. `tier`: A = fonte primária/oficial verificável; B =
 * secundária confiável; C = alegada/não-verificada (ex.: fonte que o MODELO citou
 * sem recuperação real). `retrievedAt` só existe em recuperação de fato (live).
 */
export interface SourceEvidence {
  url?: string | null;
  title?: string | null;
  publisher?: string | null;
  tier: "A" | "B" | "C";
  retrievedAt?: string | null;   // ISO — só em busca viva; null em model_knowledge
  freshness?: string | null;     // rótulo de recência quando conhecido
}

/**
 * Modo de evidência (PRD 9 / ADR-166 F7, RN-EI-1/6): `model_knowledge` = síntese do
 * MODELO a partir de conhecimento paramétrico (stub/llm hoje) — NÃO é fonte viva;
 * `live` = recuperação real de fonte externa (provider de busca viva, F8). A decisão
 * DEVE ponderar diferente por modo — model_synthesis ≠ live evidence (§53/§54).
 */
export type EvidenceMode = "model_knowledge" | "live";

export interface ResearchResult {
  content: any;       // achados do mundo externo (JSON)
  sources: string[];
  confidence: number; // 0..1
  costCents?: number; // custo da chamada (para o orçamento de pesquisa, DI-4.2); stub = 0
  // PRD 9 F7 — procedência explícita. Sem estes campos a decisão trata síntese do
  // modelo como se fosse fonte viva; com eles, a distinção é honesta.
  evidenceMode: EvidenceMode;
  sourceEvidence: SourceEvidence[];
  retrievedAt?: string | null;    // quando o pacote foi produzido/recuperado (live)
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
      // Stub é síntese determinística, não recuperação de fonte — model_knowledge honesto.
      evidenceMode: "model_knowledge",
      sourceEvidence: [],
      retrievedAt: null,
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
  const sources = Array.isArray(parsed.sources) ? parsed.sources.map((s: any) => String(s)).slice(0, 12) : [];
  // RN-EI-1/6: a "pesquisa" do LLM é conhecimento PARAMÉTRICO — model_knowledge, nunca
  // live. As fontes que o modelo cita são ALEGADAS (não recuperadas) → tier 'C', sem
  // retrievedAt. Isso impede a decisão de tratar síntese do modelo como fonte viva.
  const sourceEvidence: SourceEvidence[] = sources.map((s) => {
    const isUrl = /^https?:\/\//i.test(s);
    return { url: isUrl ? s : null, title: isUrl ? null : s, publisher: null, tier: "C" as const, retrievedAt: null, freshness: null };
  });
  return {
    content,
    sources,
    confidence: clamp01(parsed.confidence),
    costCents: LLM_RESEARCH_COST_CENTS,
    evidenceMode: "model_knowledge",
    sourceEvidence,
    retrievedAt: null,
  };
}

/** Custo estimado (centavos) de UMA busca VIVA. API real tende a custar mais que a
 * síntese do modelo — default conservador; configurável por env. */
const LIVE_RESEARCH_COST_CENTS = Math.max(0, parseInt(process.env.EXTERNAL_RESEARCH_LIVE_COST_CENTS || "8", 10) || 0);

/**
 * Transforma a resposta CRUA de uma API de busca (string JSON) em `ResearchResult`
 * com `evidenceMode: 'live'` — função PURA (sem rede), `retrievedAt` injetado (sem
 * relógio, testável). Aceita `{results:[...]}` ou um array no topo; cada item vira
 * `sourceEvidence` tier 'B' (RECUPERADA/verificável — não é fonte primária/oficial,
 * mas foi de fato buscada, ≠ tier C alegado do modelo). Vazio → null (o chamador cai
 * no stub; RN-EI-6 não inventa fonte). `content` deriva SÓ da taxonomia + snippets
 * públicos (RN-EI-2) — a anonimização final segue no `persistShared`.
 */
export function parseLiveSearch(raw: string, q: ResearchQuery, opts: { retrievedAt: string }): ResearchResult | null {
  const parsed = safeParse(raw);
  const rows: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  const items = rows.filter((r) => r && (r.url || r.title)).slice(0, 12);
  if (!items.length) return null;
  const scope = [q.vertical, q.topic, q.region, q.timeframe].filter(Boolean).join(" · ");
  const sourceEvidence: SourceEvidence[] = items.map((r) => ({
    url: typeof r.url === "string" ? r.url : null,
    title: typeof r.title === "string" ? r.title : null,
    publisher: typeof r.publisher === "string" ? r.publisher : (typeof r.source === "string" ? r.source : null),
    tier: "B" as const,
    retrievedAt: opts.retrievedAt,
    freshness: typeof r.date === "string" ? r.date : (typeof r.published === "string" ? r.published : null),
  }));
  const drivers = items.map((r) => (typeof r.snippet === "string" ? r.snippet : (typeof r.title === "string" ? r.title : ""))).filter(Boolean).slice(0, 8);
  const content = {
    summary: `Panorama VIVO do nicho ${q.vertical} sobre "${q.topic}" — ${items.length} fonte(s) recuperada(s).`,
    drivers, scope, generatedBy: "live_search",
  };
  return {
    content, sources: sourceEvidence.map((e) => e.url || e.title || "").filter(Boolean),
    confidence: clamp01(0.5 + Math.min(0.3, items.length * 0.05)), // mais fontes → um pouco mais de confiança
    costCents: LIVE_RESEARCH_COST_CENTS,
    evidenceMode: "live",
    sourceEvidence,
    retrievedAt: opts.retrievedAt,
  };
}

/**
 * LiveSearchResearchProvider (PRD 9 / ADR-166 F8) — busca VIVA de fonte externa atrás
 * do MESMO contrato (RN-EI-7, sem pipeline paralelo). HONESTO por design:
 *  - SEM vendor configurado (`EXTERNAL_RESEARCH_SEARCH_URL`) → cai no STUB determinístico
 *    (evidenceMode model_knowledge). NUNCA fabrica fonte viva (RN-EI-6).
 *  - Falha de rede/parse → também cai no stub (best-effort, nunca derruba o passe).
 *  - Query derivada SÓ de (vertical, topic, region, timeframe) (RN-EI-2) — nunca dado
 *    de tenant. Opt-in + orçamento + master-only são impostos por quem chama
 *    (`VerticalIntelligenceService.runResearch`); o provider só executa a recuperação.
 */
export class LiveSearchResearchProvider implements ExternalResearchProvider {
  name = "live";
  static isConfigured(): boolean { return !!(process.env.EXTERNAL_RESEARCH_SEARCH_URL || "").trim(); }

  async research(q: ResearchQuery): Promise<ResearchResult> {
    const fallback = () => REGISTRY.stub.research(q);
    const url = (process.env.EXTERNAL_RESEARCH_SEARCH_URL || "").trim();
    if (!url) return fallback(); // sem vendor → honesto (model_knowledge), não inventa live
    const apiKey = (process.env.EXTERNAL_RESEARCH_SEARCH_API_KEY || "").trim();
    const endpoint = `${url}${url.includes("?") ? "&" : "?"}q=${encodeURIComponent(q.query)}`;
    let raw = "";
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const resp = await fetch(endpoint, { headers });
      if (!resp.ok) return fallback();
      raw = await resp.text();
    } catch {
      return fallback(); // falha de rede nunca derruba o passe (convenção nº 7)
    }
    const retrievedAt = new Date().toISOString();
    return parseLiveSearch(raw, q, { retrievedAt }) ?? fallback();
  }
}

const REGISTRY: Record<string, ExternalResearchProvider> = {
  stub: new StubResearchProvider(),
  llm: new LlmResearchProvider(),
  live: new LiveSearchResearchProvider(),
};

/** Resolve o provider por nome → env `EXTERNAL_RESEARCH_PROVIDER` → 'stub'. */
export function getResearchProvider(name?: string): ExternalResearchProvider {
  const key = name || process.env.EXTERNAL_RESEARCH_PROVIDER || "stub";
  return REGISTRY[key] || REGISTRY.stub;
}

export default getResearchProvider;
