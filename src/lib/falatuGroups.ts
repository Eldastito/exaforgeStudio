/**
 * falatuGroups (ADR-203 F2.8 / PRD §11) — as 9 abas do FalaTu em 4 grupos de 1º nível: Conversar · Para mim · Organizar · Mais.
 * Superfície ≠ motor (RN-F2-1): nenhuma aba é removida ou alterada — só agrupada. Puro (sem React) para rodar em CI;
 * `test:falatu-conversation` garante que toda aba do `FalaTuView` está em exatamente 1 grupo.
 */
export interface FalaTuGroup { key: string; label: string; hint: string; tabs: string[] }

export const FALATU_GROUPS: FalaTuGroup[] = [
  { key: 'conversar', label: 'Conversar', hint: 'Pergunte ao seu negócio.', tabs: ['ask'] },
  { key: 'paramim', label: 'Para mim', hint: 'O que chegou e o resumo do dia.', tabs: ['inbox', 'briefing'] },
  { key: 'organizar', label: 'Organizar', hint: 'Tarefas, agenda, listas e memória.', tabs: ['tasks', 'events', 'lists', 'memory'] },
  { key: 'mais', label: 'Mais', hint: 'Conexões e protocolos.', tabs: ['plugues', 'protocols'] },
];

export function falatuGroupOf(tab: string): FalaTuGroup | null {
  return FALATU_GROUPS.find((g) => g.tabs.includes(tab)) || null;
}
