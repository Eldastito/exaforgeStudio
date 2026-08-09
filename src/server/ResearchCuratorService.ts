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
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
// Comparador estável PT-BR-ish (determinístico entre runs/plataformas).
function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export default ResearchCuratorService;
