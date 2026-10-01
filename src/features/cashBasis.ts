/**
 * O que o "saldo" do livro-caixa é DE VERDADE (espelha `FinancialLedgerService.tracking().cashBasis`).
 * Sem nenhuma saída lançada, o saldo é só a soma do que entrou — ex.: a ponte "Faturamento no Diretor" lança todo fechamento aprovado como
 * entrada. Chamar isso de "Caixa atual" engana (parece dinheiro em conta) e a projeção de 13 semanas sobre ele esconde a ruptura.
 */
export type CashBasis = "caixa" | "vendas" | "entradas";

export function cashBasisOf(summary: any): CashBasis {
  const b = summary?.tracking?.cashBasis;
  return b === "vendas" || b === "entradas" ? b : "caixa";
}

export function cashHeadline(summary: any): { basis: CashBasis; reliable: boolean; label: string; value: number | null; note: string | null; flowLabel: string } {
  const basis = cashBasisOf(summary);
  if (basis === "caixa") {
    return { basis, reliable: true, label: "Caixa atual", value: summary?.caixaAtual ?? null, note: null, flowLabel: "líquido" };
  }
  return {
    basis,
    reliable: false,
    label: basis === "vendas" ? "Vendas registradas" : "Entradas registradas",
    value: summary?.entradasRegistradas ?? null,
    note: "Sem saídas lançadas — não é o saldo em conta.",
    flowLabel: "entradas",
  };
}
