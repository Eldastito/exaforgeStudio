// Formatação compartilhada dos componentes do RIC.

export function brl(v: number, decimals = 0): string {
  return (
    'R$ ' +
    Number(v || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

export function pct(v: number): string {
  const n = Number(v || 0);
  return `${(Math.round(n * 10) / 10).toString().replace(/\.0$/, '')}%`;
}

// Tons semânticos do RIC (devem casar com os tokens ric-* do index.css).
export const RIC_TONE: Record<string, string> = {
  risk: '#ff8a4c',
  recoverable: '#ffb648',
  recovered: '#36e39a',
  critical: '#ff5b5b',
  info: '#6366f1',
};

// Cor do IQR / score de driver por faixa.
export function scoreColor(score: number): string {
  if (score >= 80) return '#36e39a';
  if (score >= 60) return '#ffb648';
  return '#ff5b5b';
}

export function scoreLabel(score: number): string {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'Bom';
  if (score >= 40) return 'Atenção';
  return 'Crítico';
}

export const TICKET_SOURCE_LABEL: Record<string, string> = {
  custom: 'definido por você',
  history: 'média histórica',
  fallback: 'sem base — defina o ticket',
};
