/**
 * Barra "Pergunte ou procure" (ADR-203, PRD §35) — decisões PURAS (sem React/DOM, testáveis em CI).
 * Ao digitar, o usuário ganha até 3 caminhos: PERGUNTAR ao FalaTu, ABRIR uma tela, achar um CONTATO. Esta função só decide
 * qual vem PRIMEIRO (o que a tecla Enter faz): pergunta de verdade → Perguntar; palavra que é nome de tela → Abrir.
 * Nunca decide por regra de negócio nem inventa resposta — quem responde é o FalaTu (motores existentes).
 */
const INTERROGATIVES = /^(como|quanto|quantos|quantas|quem|qual|quais|onde|quando|por ?que|pq|tem|tenho|posso|devo|vale|mostra|mostre|crie|cria|criar|analisa|analise|me |preciso|quero|estou|o que|oq|e a |e o )/;

/** Parece uma PERGUNTA/pedido (e não só o nome de uma tela)? '?' · 3+ palavras · começa com palavra de pergunta/pedido. */
export function isQuestion(raw: string): boolean {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return false;
  if (q.includes('?')) return true;
  if (q.split(/\s+/).filter(Boolean).length >= 3) return true;
  return INTERROGATIVES.test(q);
}

export type BarAction = 'ask' | 'open' | 'contact';

/** Ordem dos caminhos (o 1º é o que o Enter executa). Sem FalaTu disponível, 'ask' nunca aparece. */
export function actionOrder(raw: string, counts: { open: number; contact: number }, canAsk: boolean): BarAction[] {
  const q = String(raw || '').trim();
  if (q.length < 2) return [];
  const out: BarAction[] = [];
  const asking = canAsk && isQuestion(q);
  if (asking) out.push('ask');
  if (counts.open > 0) out.push('open');
  if (counts.contact > 0) out.push('contact');
  // palavra solta sem tela nem contato: ainda assim vale PERGUNTAR (o FalaTu diz se entendeu) — melhor que "nada encontrado"
  if (canAsk && !asking) out.push('ask');
  return out;
}

/**
 * Atalhos para ABAS dentro de uma tela (PRD §35: "comissão" → Operação da Rede → Comissão). Só aliases de nomes que o usuário já
 * conhece; o destino é uma aba que JÁ existe. Quem chama só os oferece quando a tela pai está disponível (mesmo gate do menu).
 */
const RETAIL_TAB_ALIASES: Array<{ words: string[]; tab: string; label: string }> = [
  { words: ['comissao', 'comissoes', 'premiacao'], tab: 'comissao', label: 'Operação da Rede → Comissão' },
  { words: ['meta', 'metas', 'cota', 'cotas'], tab: 'metas', label: 'Operação da Rede → Metas do vendedor' },
  { words: ['escala', 'folga', 'folgas'], tab: 'escala', label: 'Operação da Rede → Escala & cotas' },
  { words: ['fechamento', 'fechar'], tab: 'fechamento', label: 'Operação da Rede → Fechamento diário' },
  { words: ['estoque', 'negativo'], tab: 'estoque', label: 'Operação da Rede → Estoque negativo' },
  { words: ['transferencia', 'transferencias'], tab: 'transferencias', label: 'Operação da Rede → Transferências' },
  { words: ['vendedor', 'vendedores'], tab: 'vendedores', label: 'Operação da Rede → Vendedores da loja' },
  { words: ['resultado', 'lucro'], tab: 'resultado', label: 'Operação da Rede → Resultado por loja' },
  { words: ['cliente', 'clientes'], tab: 'clientes', label: 'Operação da Rede → Clientes (PDV)' },
  { words: ['divergencia', 'divergencias'], tab: 'divergencia', label: 'Operação da Rede → Divergência' },
];
const fold = (t: string) => String(t || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Abas da Operação da Rede que combinam com o que foi digitado (começa com a palavra; mínimo 3 letras). */
export function retailTabMatches(raw: string): Array<{ tab: string; label: string }> {
  const t = fold(raw);
  if (t.length < 3) return [];
  return RETAIL_TAB_ALIASES.filter((a) => a.words.some((w) => w.startsWith(t) || t.startsWith(w))).map(({ tab, label }) => ({ tab, label }));
}
