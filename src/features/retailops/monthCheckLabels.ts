// Rótulos e regras puras da Conferência do mês (folha × caixa). Sem React — testável em CI.

export type MonthCheckSituation = 'ok' | 'folha_diferente_do_caixa' | 'sem_folha' | 'sem_caixa' | 'rejeitado';

export function situationLabel(s: MonthCheckSituation | string): string {
  switch (s) {
    case 'folha_diferente_do_caixa': return 'folha diferente do caixa';
    case 'sem_folha': return 'folha não lançada (caixa teve venda)';
    case 'sem_caixa': return 'caixa do PDV não chegou nesse dia';
    case 'rejeitado': return 'fechamento rejeitado (fora do total)';
    default: return 'confere';
  }
}

export function sourceLabel(src: string): string {
  return src === 'folha' ? 'Folha do gerente' : 'Caixa do PDV';
}

/** Frase curta que explica, para o dono, de onde sai o total do mês desta loja. */
export function storeExplanation(st: { totals: { counted: number; folha: number; countedMinusFolha: number }; caixaAvailable: boolean }, source: string): string {
  const extra = Math.round((Number(st.totals.countedMinusFolha) || 0) * 100) / 100;
  if (Math.abs(extra) <= 0.009) {
    return st.caixaAvailable ? 'O total do mês é a soma das folhas.' : 'O total do mês é a soma das folhas (o caixa do PDV não chegou para esta loja no mês).';
  }
  return source === 'folha'
    ? 'O total do mês difere da soma das folhas — confira os dias abaixo.'
    : `O total do mês usa o caixa do PDV nos dias em que ele existe; por isso difere da soma das folhas em ${extra > 0 ? '+' : ''}${brlPlain(extra)}.`;
}

export function brlPlain(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function ddmm(iso: string): string {
  return `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}`;
}
