/**
 * Formata dinheiro em pt-BR COM separador de milhar ("R$ 1.426.635,58"). Fonte única dos textos que o dono lê (Central de Saúde, Tutor
 * no WhatsApp, simuladores). Antes cada serviço tinha o seu `brl` com `toFixed(2)` e saía "R$ 13428,60" — ilegível e inconsistente com "R$ 5.700".
 * Manual (sem Intl) para não depender do ICU do Node. Negativo vira "R$ -1.234,50"; não numérico vira "R$ 0,00".
 */
export const brl = (n: any): string => {
  const v = Number(n) || 0;
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  return `R$ ${v < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
};
