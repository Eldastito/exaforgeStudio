/**
 * ResearchCuratorService (ADR-157) — o "cérebro" da automação da External
 * Intelligence. Esta fatia (DI-5.2) entrega o **motor de delta DETERMINÍSTICO**:
 * dado o conteúdo da última versão de um nicho e o da nova pesquisa, calcula o
 * que MUDOU no mercado — novo / saiu / cresceu / retraiu + tendência de
 * confiança. É a "memória de mercado" que a IA usa como ponto de partida (RN-004
 * espírito: derivado, não contador mutável).
 *
 * A curadoria por IA (provider → curador → anonimização → publicação autônoma)
 * entra na DI-5.3 e reusa este motor; aqui NÃO há chamada de IA (roda offline em
 * CI). Função pura, sem IO — testável direto.
 *
 * Sinal de magnitude para "cresceu/retraiu": os `drivers` vêm ORDENADOS por
 * relevância pelo provider/curador (o 1º é o fator mais importante do nicho).
 * Então a POSIÇÃO no ranking é a magnitude determinística — subir de posição =
 * cresceu; descer = retraiu. Sem inventar número que não existe.
 */

export interface ResearchDelta {
  isFirst: boolean;        // não havia versão anterior (tudo é "novo")
  new: string[];           // drivers que apareceram agora
  gone: string[];          // drivers que sumiram
  grew: string[];          // drivers que SUBIRAM no ranking (mais relevantes)
  shrank: string[];        // drivers que DESCERAM no ranking
  confidenceDelta: number; // next.confidence - prev.confidence (2 casas)
}

/** Normaliza um driver para casar entre versões (case/espaço-insensível). */
function normKey(s: any): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
/** Extrai a lista de drivers (strings não vazias) de um content, na ordem dada. */
function driversOf(content: any): string[] {
  const arr = Array.isArray(content?.drivers) ? content.drivers : [];
  return arr.map((d: any) => String(d ?? "").trim()).filter(Boolean);
}
function confOf(content: any): number {
  const v = Number(content?.confidence);
  return Number.isFinite(v) ? v : 0;
}

export class ResearchCuratorService {
  /**
   * Delta entre a versão anterior (`prev`, ou null se for a 1ª) e a nova
   * (`next`). Ordena tudo para saída ESTÁVEL (determinística) — dois runs com os
   * mesmos dados dão exatamente o mesmo delta.
   *
   * `confidence` pode vir dentro do content (content.confidence) OU ser passada à
   * parte; o chamador (persistShared) passa no content para simplificar.
   */
  static computeDelta(prev: any | null, next: any): ResearchDelta {
    const nextDrivers = driversOf(next);
    const confidenceDelta = round2(confOf(next) - confOf(prev));

    if (prev == null) {
      return { isFirst: true, new: [...nextDrivers].sort(cmp), gone: [], grew: [], shrank: [], confidenceDelta: 0 };
    }

    const prevDrivers = driversOf(prev);
    const prevIdx = new Map<string, number>();
    prevDrivers.forEach((d, i) => { const k = normKey(d); if (!prevIdx.has(k)) prevIdx.set(k, i); });
    const nextIdx = new Map<string, number>();
    nextDrivers.forEach((d, i) => { const k = normKey(d); if (!nextIdx.has(k)) nextIdx.set(k, i); });

    const isNew: string[] = [];
    const grew: string[] = [];
    const shrank: string[] = [];
    for (const d of nextDrivers) {
      const k = normKey(d);
      if (!prevIdx.has(k)) { isNew.push(d); continue; }
      const before = prevIdx.get(k)!;
      const after = nextIdx.get(k)!;
      if (after < before) grew.push(d);        // subiu no ranking = ganhou relevância
      else if (after > before) shrank.push(d); // desceu = perdeu relevância
      // mesma posição → estável (não reporta)
    }
    const gone: string[] = prevDrivers.filter((d) => !nextIdx.has(normKey(d)));

    return {
      isFirst: false,
      new: isNew.sort(cmp),
      gone: gone.sort(cmp),
      grew: grew.sort(cmp),
      shrank: shrank.sort(cmp),
      confidenceDelta,
    };
  }

  /** Há alguma mudança MATERIAL (o suficiente para valer um sinal/destaque)? */
  static isMaterial(delta: ResearchDelta): boolean {
    return delta.new.length > 0 || delta.gone.length > 0 || delta.grew.length > 0
      || delta.shrank.length > 0 || Math.abs(delta.confidenceDelta) >= 0.1;
  }

  /**
   * DI-5.3 — GATE DE QUALIDADE determinístico (sem IA). Reprova um pacote de
   * pesquisa vazio/incoerente ou com confiança abaixo do piso. É o coração da
   * publicação autônoma (RN-157-3): um pacote reprovado NÃO publica e NÃO
   * sobrescreve a última versão boa. Puro/testável.
   */
  static assessQuality(result: any, floor: number = DEFAULT_CONFIDENCE_FLOOR): { ok: boolean; reasons: string[]; confidence: number; floor: number } {
    const content = result?.content ?? {};
    const summary = typeof content.summary === "string" ? content.summary.trim() : "";
    const drivers = driversOf(content);
    const confidence = confOf(result); // confidence mora no result (não no content)
    const reasons: string[] = [];
    if (!summary && drivers.length === 0) reasons.push("empty");        // nada de conteúdo
    if (confidence < clampFloor(floor)) reasons.push("low_confidence"); // abaixo do piso
    return { ok: reasons.length === 0, reasons, confidence, floor: clampFloor(floor) };
  }

  /**
   * DI-5.3 — pipeline AUTÔNOMO: provider → curador (gate) → anonimização →
   * publicação. Decisão do dono: o curador publica sozinho (o gate é o guarda).
   * Import dinâmico de VerticalIntelligenceService pra quebrar o ciclo (VIS já
   * importa este service pro delta — convenção nº 11).
   *
   * Retorna `{ published, reason?, quality, result? }`. Nunca lança por reprovar
   * (reprovar é resultado normal); só lança em erro de entrada. O custo da
   * chamada ao provider é registrado mesmo quando reprova (a chamada aconteceu).
   * budget_exceeded é sinalizado por `reason` (não publica, não gasta além).
   */
  static async curate(
    actor: { userId?: string | null; organizationId?: string | null } | null,
    input: { vertical: string; topic: string; region?: string; timeframe?: string; ttlDays?: number },
    opts: { provider?: any; providerName?: string; confidenceFloor?: number } = {},
  ): Promise<{ published: boolean; reason?: string; quality?: any; result?: any }> {
    const vertical = String(input?.vertical || "").trim();
    const topic = String(input?.topic || "").trim();
    if (!vertical || !topic) throw new Error("vertical e topic são obrigatórios.");
    const region = input.region ? String(input.region).trim() : undefined;
    const timeframe = input.timeframe ? String(input.timeframe).trim() : undefined;

    const [{ getResearchProvider }, { ResearchBudgetService }, { VerticalIntelligenceService, researchFingerprint }] = await Promise.all([
      import("./ExternalResearchProvider.js"),
      import("./ResearchBudgetService.js"),
      import("./VerticalIntelligenceService.js"),
    ]);

    // Guardrail de orçamento ANTES do provider (RN-157-2): não gasta se estourou.
    if (!ResearchBudgetService.canSpend()) return { published: false, reason: "budget_exceeded" };

    const provider = opts.provider || getResearchProvider(opts.providerName);
    const query = [vertical, topic, region, timeframe].filter(Boolean).join(" "); // só a taxonomia (RN-157-1)
    const raw = await provider.research({ vertical, topic, region, timeframe, query });

    // Registra o custo (a chamada aconteceu — mesmo que o pacote seja reprovado).
    const fingerprint = researchFingerprint(vertical, topic, region, timeframe);
    ResearchBudgetService.record({ fingerprint, vertical, topic, provider: provider.name, costCents: Number(raw?.costCents) || 0 });

    // GATE (RN-157-3): pacote reprovado NÃO publica nem sobrescreve a base boa.
    const quality = this.assessQuality(raw, opts.confidenceFloor);
    if (!quality.ok) return { published: false, reason: "quality_rejected", quality };

    // Aprovado → publica (a anonimização roda DENTRO do publish, depois da
    // curadoria — RN-157-1) + versiona no histórico (DI-5.2).
    const result = VerticalIntelligenceService.publish(actor, {
      vertical, topic, region, timeframe,
      content: raw?.content ?? {},
      sources: Array.isArray(raw?.sources) ? raw.sources : [],
      confidence: Number(raw?.confidence) || 0,
      provider: provider.name, ttlDays: input.ttlDays,
    });
    return { published: true, quality, result };
  }
}

/** Piso mínimo de confiança para publicar (configurável por env). */
const DEFAULT_CONFIDENCE_FLOOR = (() => {
  const v = Number(process.env.EXTERNAL_RESEARCH_CONFIDENCE_FLOOR);
  return Number.isFinite(v) ? clampFloor(v) : 0.2;
})();
function clampFloor(n: number): number { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.2; }

function round2(n: number): number { return Math.round(n * 100) / 100; }
// Comparador estável PT-BR-ish (determinístico entre runs/plataformas).
function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export default ResearchCuratorService;
