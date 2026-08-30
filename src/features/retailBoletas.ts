/**
 * Regra de negócio da loja (Toulon): cada BOLETA (talão de venda manuscrito)
 * comporta no máximo 5 produtos. Se um vendedor vende mais que isso, abre-se
 * uma NOVA boleta para o MESMO vendedor. Ex.: 15 produtos = 3 boletas.
 *
 * O arredondamento é POR VENDEDOR (cada um enche a própria boleta), então a
 * soma não pode ser feita no total geral: 4 + 4 produtos = 1 + 1 = 2 boletas,
 * não ceil(8/5) = 2 por acaso; já 6 + 6 = 2 + 2 = 4, e não ceil(12/5) = 3.
 */
export const PRODUTOS_POR_BOLETA = 5;

/** Boletas esperadas de UM vendedor pelo nº de produtos/peças vendidos. */
export function boletasDeVendedor(pecas: unknown, porBoleta = PRODUTOS_POR_BOLETA): number {
  const p = Math.max(0, Math.floor(Number(pecas) || 0));
  const div = Math.max(1, Math.floor(Number(porBoleta) || PRODUTOS_POR_BOLETA));
  if (p <= 0) return 0;
  return Math.ceil(p / div);
}

/**
 * Total de boletas esperadas no dia, somando o arredondamento de CADA vendedor
 * (nunca o total de peças da loja de uma vez — ver nota acima).
 */
export function boletasEsperadas(pecasPorVendedor: Array<unknown>, porBoleta = PRODUTOS_POR_BOLETA): number {
  if (!Array.isArray(pecasPorVendedor)) return 0;
  return pecasPorVendedor.reduce<number>((acc, v) => acc + boletasDeVendedor(v, porBoleta), 0);
}
