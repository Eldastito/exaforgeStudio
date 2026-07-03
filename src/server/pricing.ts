/**
 * Preço sugerido por margem (Loja Virtual — incremento pós Smart Inventory,
 * ADR-023). Só faz sentido quando o custo é conhecido de verdade (via
 * InventoryService.recordMovement, alimentado pelas Fases 1/2 do Smart
 * Inventory — nota fiscal por foto ou XML) — nunca é aplicado sozinho, é
 * sempre uma SUGESTÃO editável antes de publicar.
 *
 * Markup padrão fixo (40%) em vez de configurável por organização: como é só
 * uma sugestão que o humano sempre revisa e pode sobrescrever livremente,
 * adicionar uma tela de configuração para isso ainda não se paga — se algum
 * dia vários lojistas pedirem para ajustar o padrão, aí sim vira uma
 * configuração de verdade.
 */
const DEFAULT_MARKUP_PERCENT = 40;

/** Arredondamento "psicológico": primeiro centavo cheio abaixo do próximo inteiro (ex.: 8.89 -> 8.99). */
function psychologicalRound(value: number): number {
  if (value <= 0) return 0;
  return Math.ceil(value) - 0.01;
}

export function suggestSalePrice(cost: number, markupPercent = DEFAULT_MARKUP_PERCENT): number {
  const c = Number(cost) || 0;
  if (c <= 0) return 0;
  const raw = c * (1 + markupPercent / 100);
  return Math.round(psychologicalRound(raw) * 100) / 100;
}
