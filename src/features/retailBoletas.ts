/**
 * Regra de negócio da loja (Toulon): cada BOLETA (talão de venda impresso) tem
 * no máximo 5 LINHAS, e cada linha é um PRODUTO DISTINTO — um código de barras.
 * Várias unidades do MESMO código ocupam UMA linha (ex.: 5 blusas G iguais =
 * 1 linha), então a conta é por produto DISTINTO, nunca por peças. Passou de 5
 * produtos distintos, abre-se nova boleta para o MESMO vendedor.
 * Ex.: 15 produtos distintos = 3 boletas.
 *
 * A fonte da verdade para conferir isso é o PDV (itens lançados por boleta) —
 * ver RetailBoletaService.lineAudit. Estas funções são só a expressão pura da
 * regra (arredondamento POR vendedor: 6 + 6 produtos = 2 + 2 = 4 boletas, e
 * não ceil(12/5) = 3).
 */
export const PRODUTOS_POR_BOLETA = 5;

/** Boletas de UM vendedor pelo nº de PRODUTOS DISTINTOS (códigos de barras). */
export function boletasDeVendedor(produtosDistintos: unknown, porBoleta = PRODUTOS_POR_BOLETA): number {
  const p = Math.max(0, Math.floor(Number(produtosDistintos) || 0));
  const div = Math.max(1, Math.floor(Number(porBoleta) || PRODUTOS_POR_BOLETA));
  if (p <= 0) return 0;
  return Math.ceil(p / div);
}

/**
 * Total de boletas somando o arredondamento de CADA vendedor (nunca o total de
 * produtos da loja de uma vez — ver nota acima).
 */
export function boletasEsperadas(produtosPorVendedor: Array<unknown>, porBoleta = PRODUTOS_POR_BOLETA): number {
  if (!Array.isArray(produtosPorVendedor)) return 0;
  return produtosPorVendedor.reduce<number>((acc, v) => acc + boletasDeVendedor(v, porBoleta), 0);
}

/**
 * Último número de boleta a partir do INICIAL do talão, dado o total de boletas
 * que serão usadas (nova boleta a cada 5 produtos). Preserva a largura dos zeros
 * do talão ("018050" → largura 6). null quando o inicial não é numérico ou não
 * há boletas. Ex.: inicial "018050", 3 boletas → "018052".
 */
export function boletaFinalEsperada(inicial: unknown, totalBoletas: number): string | null {
  const digits = String(inicial ?? "").replace(/\D/g, "");
  const n = Math.max(0, Math.floor(Number(totalBoletas) || 0));
  if (!digits || n <= 0) return null;
  const last = parseInt(digits, 10) + n - 1;
  return String(last).padStart(digits.length, "0");
}
