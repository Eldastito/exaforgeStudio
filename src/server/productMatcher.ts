/**
 * Matching aproximado de nome de produto (Smart Inventory, ADR-024).
 *
 * Problema real: o nome do item na nota fiscal quase nunca é idêntico ao nome
 * cadastrado no catálogo ("FEIJAO PRETO KICALDO 1KG" na nota vs. "Feijão Preto
 * Kicaldo 1kg" no catálogo, ou "ARROZ BCO T1 5KG" vs. "Arroz Branco Tipo 1
 * 5kg"). Sem isso, a tela de revisão pré-seleciona "novo produto" e o lojista
 * distraído cria um duplicado a cada recompra.
 *
 * Abordagem deliberadamente simples: similaridade por tokens (Dice) sobre o
 * texto normalizado (sem acento/caixa/pontuação), com bônus quando todos os
 * tokens de um lado estão contidos no outro (abreviação típica de nota).
 * Nada de embedding/IA — é uma PRÉ-SELEÇÃO que o humano sempre revê na tela;
 * um algoritmo determinístico e explicável basta e não custa chamada de IA.
 */

export function normalizeProductName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos (combining marks pós-NFD)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeProductName(s).split(" ").filter(Boolean);
}

/** Similaridade 0..1 entre dois nomes (1 = idênticos após normalização). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeProductName(a);
  const nb = normalizeProductName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;

  // Dice: 2·|A∩B| / (|A|+|B|)
  const dice = (2 * common) / (ta.size + tb.size);

  // Contenção total de um lado no outro (ex.: "feijao preto 1kg" ⊂
  // "feijao preto kicaldo 1kg") indica o mesmo produto com nome abreviado.
  const contained = common === Math.min(ta.size, tb.size);
  return contained ? Math.max(dice, 0.85) : dice;
}

export interface ProductCandidate {
  id: string;
  name: string;
}

/**
 * Melhor produto do catálogo para um nome vindo da nota. Retorna null abaixo
 * do limiar — melhor sugerir "novo produto" do que sugerir a reposição errada
 * (o custo de um falso positivo é maior: somaria estoque no produto errado).
 */
export function findBestProductMatch(
  name: string,
  products: ProductCandidate[],
  threshold = 0.6
): { id: string; name: string; score: number } | null {
  let best: { id: string; name: string; score: number } | null = null;
  for (const p of products) {
    const score = nameSimilarity(name, p.name);
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: p.id, name: p.name, score };
    }
  }
  return best;
}
