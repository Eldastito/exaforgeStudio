/**
 * ZappFlow — tokens de marca para uso em TypeScript (gráficos, e-mails
 * transacionais e componentes que não leem CSS). Espelha a paleta oficial do
 * Brand Book v1.0 e os tokens --color-zf-* de src/index.css.
 *
 * ADITIVO: não substitui nada do app. Use ao construir telas/charts novos.
 */
export const zappflow = {
  // Bases e superfícies (Command Center premium)
  midnight: "#07111F",
  navy: "#0D1A2B",
  slate: "#152942",
  // Sinais
  teal: "#22D3B6",    // marca / ação / fluxo
  blue: "#6395FF",    // inteligência / IA / análise
  amber: "#F6B84A",   // Supply / atenção / prioridade de reposição
  green: "#43D39E",   // sucesso / aprovado
  coral: "#F56C78",   // risco / ruptura / destrutivo
  // Texto e linhas
  cloud: "#F5F8FC",   // títulos e números
  steel: "#9BAEC1",   // texto secundário
  grid: "#243B58",    // bordas / divisores
} as const;

/** Hierarquia de cor da marca (cor ≠ único sinal de status — sempre rotular). */
export const zappflowRole = {
  action: zappflow.teal,        // criar, avançar, confirmar, executar
  intelligence: zappflow.blue,  // análises, recomendações, IA
  supply: zappflow.amber,       // reposição, cobertura, prioridade de compra
  success: zappflow.green,      // aprovado, concluído, saudável
  risk: zappflow.coral,         // erro, ruptura, bloqueio, excluir
} as const;

export type ZappflowColor = keyof typeof zappflow;
