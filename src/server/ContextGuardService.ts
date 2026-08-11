/**
 * ContextGuardService — PRD 3 F9 (§71): a GUARDA ÚNICA data-vs-instrução.
 *
 * PROBLEMA que resolve: conteúdo EXTERNO não-confiável (mensagem de cliente, chunk
 * de RAG, memória, e-mail, comentário) entra no contexto e, sem cerco, a LLM pode
 * tratá-lo como INSTRUÇÃO ("ignore as regras acima…") em vez de DADO. As primitivas
 * já existiam espalhadas (`isPromptInjection` no AIOrchestrator e no geminiRAG, o
 * padrão `sanitize*`), mas não havia uma CAMADA ÚNICA que isolasse o conteúdo antes
 * do modelo. Este é o ponto de estrangulamento: todo texto externo passa por aqui.
 *
 * O que FAZ (determinístico, sem IA — roda em CI):
 *  - `classify` — sinaliza marcadores de injeção (heurística consolidada das duas
 *    cópias existentes). NÃO bloqueia sozinho: informa o caller.
 *  - `neutralize` — DEFANG: remove chars de controle e desarma o sentinela do
 *    cerco (impede que o conteúdo "feche" o bloco e escape pra fora — a invariante
 *    de segurança). Nunca reescreve a intenção do texto; só neutraliza o que quebra
 *    o cerco.
 *  - `fence` — embrulha o texto neutralizado num envelope rotulado
 *    `<untrusted_external_data>…</untrusted_external_data>`, que o system prompt do
 *    modelo declara ser DADO, nunca instrução. Retorna também o flag `suspicious`
 *    pro caller poder DESCARTAR (isolar > censurar: o default é cercar, não apagar).
 *
 * O que NÃO faz: não executa nada, não chama modelo, não decide política — só isola.
 *
 * GUARDRAILS (testados):
 *  - RN-CG-1 SEM QUEBRA DE CERCO (§71): conteúdo com o sentinela do envelope é
 *    desarmado — não há como o texto externo escapar pra fora do bloco.
 *  - RN-CG-2 SEM EXECUÇÃO/IA: puro e determinístico.
 *  - RN-CG-3 ISOLAR > CENSURAR: `fence` preserva o texto (neutralizado) e sinaliza;
 *    a decisão de descartar é do caller.
 */

export interface UntrustedClassification {
  suspicious: boolean;
  matched: string[];
}

export interface FencedContent {
  fenced: string;
  suspicious: boolean;
  matched: string[];
}

// Heurística consolidada (união de AIOrchestratorService.isPromptInjection +
// geminiRAG.isPromptInjection). Conservadora e explícita — marcadores conhecidos de
// tentativa de sobrescrever instruções / injeção de comando.
const INJECTION_MARKERS = [
  "ignore todas as instru", "ignore as instru", "ignore previous", "ignore the above",
  "esqueça o que eu disse", "esqueca o que", "esqueça as instru",
  "system prompt", "system:", "sistema:", "</system", "<system",
  "você é agora", "voce e agora", "you are now", "modo desenvolvedor", "developer mode",
  "desconsidere as regras", "desconsidere tudo", "execute sql", "drop table", "delete from",
  "act as", "jailbreak", "dan ", "prompt injection", "reveal your", "revele suas instru",
];

// O sentinela do envelope, em qualquer forma (abre/fecha, com atributos) — o que
// precisa ser desarmado pra não haver quebra de cerco.
const SENTINEL_RE = /<\s*\/?\s*untrusted_external_data[^>]*>/gi;

// Chars de controle a remover (0x00-08, 0x0B, 0x0C, 0x0E-1F, 0x7F) — mantém \n e \t.
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export class ContextGuardService {
  /** Sinaliza marcadores de injeção no texto. NÃO bloqueia — informa o caller. */
  static classify(text: string | null | undefined): UntrustedClassification {
    const lower = String(text ?? "").toLowerCase();
    const matched = INJECTION_MARKERS.filter((m) => lower.includes(m));
    return { suspicious: matched.length > 0, matched };
  }

  /**
   * DEFANG: remove chars de controle (mantém \n e \t) e DESARMA o sentinela do
   * cerco. É o que impede a quebra de cerco (RN-CG-1) — sem isso, um texto externo
   * contendo `</untrusted_external_data>` fecharia o bloco e o resto viraria
   * "instrução" pro modelo.
   */
  static neutralize(text: string | null | undefined): string {
    return String(text ?? "").replace(CONTROL_RE, "").replace(SENTINEL_RE, "[marcador removido]");
  }

  /**
   * Embrulha o texto neutralizado no envelope de DADO não-confiável. `maxLen` corta
   * (com reticências) pra caber no orçamento de contexto. Retorna o flag
   * `suspicious` pro caller decidir descartar (RN-CG-3 — o default é cercar).
   */
  static fence(text: string | null | undefined, opts: { source?: string; maxLen?: number } = {}): FencedContent {
    const cls = this.classify(text);
    let body = this.neutralize(text);
    if (opts.maxLen && opts.maxLen > 0 && body.length > opts.maxLen) body = body.slice(0, opts.maxLen) + "…";
    // atributo `source` também neutralizado (aspas/ângulos viram simples) — sem quebra do atributo.
    const src = opts.source ? ` source="${String(opts.source).replace(/["<>]/g, "'")}"` : "";
    const fenced = `<untrusted_external_data${src}>\n${body}\n</untrusted_external_data>`;
    return { fenced, suspicious: cls.suspicious, matched: cls.matched };
  }

  /** Cerca uma lista de trechos externos (ex.: hits de RAG) de uma vez. */
  static fenceAll(items: Array<{ text: string | null | undefined; source?: string }>, opts: { maxLen?: number } = {}): FencedContent[] {
    return (items || []).map((it) => this.fence(it?.text, { source: it?.source, maxLen: opts.maxLen }));
  }
}

export default ContextGuardService;
