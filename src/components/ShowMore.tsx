import { useState, useCallback } from 'react';

/**
 * Paginação client-side "ver mais" — teto de linhas visíveis pra listas de
 * resultado não ficarem infinitas (mata a experiência e trava a tela). Padrão
 * 12 (dentro da faixa 10–15 pedida pelo produto); o usuário cresce sob demanda.
 *
 * Uso típico:
 *   const page = useVisibleLimit(sorted, { resetKey: sorted.length });
 *   page.visible.map(...)                         // renderiza só o topo
 *   <ShowMore page={page} noun="empresas" />      // barra "ver mais / ver todas"
 *
 * `resetKey` volta ao teto inicial quando muda (ex.: nova busca, troca de filtro
 * ou de aba) — sem isso o teto "grudaria" alto depois que o usuário expandiu uma
 * lista antiga. Usa o padrão oficial do React de derivar estado durante o render
 * (guardado por comparação com a key anterior), evitando repaint extra.
 *
 * NOTA DE TIPAGEM: `visible` é `any[]`, não genérico. O projeto não instala
 * `@types/react`, então os hooks (useState etc.) são `any` — um array vindo de
 * `useState` chega aqui como `any`, e um genérico `<T>(items: T[])` degenera a
 * inferência pra `{}` (quebra o `.map` em ~20 telas). Como o array de origem já
 * é `any` de qualquer forma, tipar `visible` como `any[]` casa com a realidade
 * do projeto e mantém o `.map(x => x.campo)` funcionando em todos os callers.
 */

export const SHOW_MORE_DEFAULT = 12;
export const SHOW_MORE_STEP = 12;

export interface VisiblePage {
  visible: any[];
  total: number;
  remaining: number;
  hasMore: boolean;
  /** quanto o próximo "ver mais" vai revelar (limitado ao que resta) */
  nextChunk: number;
  showMore: () => void;
  showAll: () => void;
}

export function useVisibleLimit(
  items: readonly any[],
  opts?: { initial?: number; step?: number; resetKey?: unknown },
): VisiblePage {
  const initial = opts?.initial ?? SHOW_MORE_DEFAULT;
  const step = opts?.step ?? SHOW_MORE_STEP;
  const [limit, setLimit] = useState(initial);
  const [prevKey, setPrevKey] = useState<unknown>(opts?.resetKey);

  // Reset ao trocar de dataset (nova busca/filtro/aba). Derivado no render.
  if (prevKey !== opts?.resetKey) {
    setPrevKey(opts?.resetKey);
    setLimit(initial);
  }

  const total = items.length;
  const effective = Math.min(limit, total);
  const remaining = Math.max(0, total - effective);
  const showMore = useCallback(() => setLimit((l) => l + step), [step]);
  const showAll = useCallback(() => setLimit(total), [total]);

  return {
    visible: items.slice(0, effective),
    total,
    remaining,
    hasMore: remaining > 0,
    nextChunk: Math.min(step, remaining),
    showMore,
    showAll,
  };
}

/**
 * Barra "ver mais / ver todas". Só aparece quando há itens ocultos. Estilo
 * neutro (zinc) que combina com as views escuras do app; passe `className` pra
 * ajustar espaçamento no contexto (ex.: dentro de um card).
 */
export function ShowMore({
  page,
  noun = 'itens',
  className = '',
}: {
  page: VisiblePage;
  /** substantivo pra contagem, ex.: "empresas", "contatos", "pedidos" */
  noun?: string;
  className?: string;
}) {
  if (!page.hasMore) return null;
  return (
    <div className={`flex flex-wrap items-center justify-center gap-3 py-3 text-sm ${className}`}>
      <span className="text-xs text-zinc-500">
        Mostrando {page.visible.length} de {page.total} {noun}
      </span>
      <button
        onClick={page.showMore}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
      >
        Ver mais {page.nextChunk}
      </button>
      <button
        onClick={page.showAll}
        className="text-xs text-indigo-400 hover:text-indigo-300 hover:underline"
      >
        Ver todas ({page.remaining} restantes)
      </button>
    </div>
  );
}
