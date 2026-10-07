/**
 * retailOpsGroups (ADR-203 F2.7) — as 20 abas da "Operação da Rede" reagrupadas em 5 grupos por PROPÓSITO, para o
 * menu simplificado. Superfície ≠ motor (RN-F2-1): nenhuma aba é removida, renomeada ou alterada — só agrupada.
 * Puro (sem React) para rodar em CI. `test:retail-ops-groups` garante que TODA aba do `RetailOpsView` está em
 * exatamente 1 grupo (nada some, nada duplica) e que os rótulos não mudaram.
 */
export interface RetailTabGroup { key: string; label: string; hint: string; tabs: string[] }

export const RETAIL_TAB_GROUPS: RetailTabGroup[] = [
  { key: 'fechar', label: 'Fechar o dia', hint: 'Fechamento, malote, conferência e cartão.', tabs: ['fechamento', 'malote', 'divergencia', 'cartao'] },
  { key: 'vendas', label: 'Vendas e metas', hint: 'Resultado por loja, previsão do mês, mais vendidos, metas e preços.', tabs: ['resultado', 'previsao', 'maisvendidos', 'metas', 'precificar'] },
  { key: 'equipe', label: 'Equipe', hint: 'Escala, vendedores, comissão e cobrança.', tabs: ['escala', 'vendedores', 'comissao', 'equipe'] },
  { key: 'estoque', label: 'Estoque e reposição', hint: 'Estoque negativo, reposição, transferências e loja virtual.', tabs: ['estoque', 'reposicao', 'transferencias', 'lojavirtual'] },
  { key: 'inteligencia', label: 'Clientes e inteligência', hint: 'Insights, clientes do PDV e padrões.', tabs: ['insights', 'clientes', 'padroes'] },
];

/** Grupo a que a aba pertence (null só se a aba for desconhecida). */
export function groupOfTab(tab: string): RetailTabGroup | null {
  return RETAIL_TAB_GROUPS.find((g) => g.tabs.includes(tab)) || null;
}
