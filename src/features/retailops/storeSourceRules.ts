// P5 (docs/retail/ANALISE-CODIGOS-VENDEDOR-SEM-NOME.md) — de onde vem a venda de cada vendedor da loja.
// Regras puras (sem React) para rodar em CI. A loja nova não nasce mais na fonte padrão sem ninguém escolher:
// PDV + lançamento do gerente na mesma loja somam a mesma venda duas vezes (caso BANGU).

export type SellerSourceChoice = 'pdv' | 'manual';
export type StoreSourceLike = { id: string; active?: boolean | number; seller_source?: string | null };

export const isSourceChoice = (v: unknown): v is SellerSourceChoice => v === 'pdv' || v === 'manual';

/** Loja nova exige a escolha; ao editar, o valor atual já vem preenchido (null no banco = caixa, o padrão antigo). */
export function sourceChoiceError(choice: unknown, editing: boolean): string | null {
  if (editing || isSourceChoice(choice)) return null;
  return 'Escolha de onde vem a venda de cada vendedor desta loja: do caixa ou do lançamento do gerente.';
}

/** O que as OUTRAS lojas ativas da rede usam hoje — ajuda a não criar a loja nova diferente das demais sem querer. */
export function networkSourceSummary(stores: StoreSourceLike[], exceptId?: string | null): { pdv: number; manual: number; total: number } {
  const others = stores.filter((s) => (s.active === true || s.active === 1) && s.id !== exceptId);
  const manual = others.filter((s) => s.seller_source === 'manual').length;
  return { pdv: others.length - manual, manual, total: others.length };
}

export function networkSourceHint(sum: { pdv: number; manual: number; total: number }): string | null {
  if (!sum.total) return null;
  const parts: string[] = [];
  if (sum.manual) parts.push(`${sum.manual} ${sum.manual === 1 ? 'loja usa' : 'lojas usam'} o lançamento do gerente`);
  if (sum.pdv) parts.push(`${sum.pdv} ${sum.pdv === 1 ? 'loja usa' : 'lojas usam'} o caixa`);
  return `Na sua rede hoje: ${parts.join(' · ')}.`;
}

/** Texto do "⚠ dobrado" para quem NÃO edita a loja (gerente): a escolha é do dono. */
export const DOUBLED_ASK_OWNER = 'peça ao dono para escolher a fonte desta loja';
