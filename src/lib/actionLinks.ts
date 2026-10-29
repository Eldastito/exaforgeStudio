// Links de "acerto": quando a tela avisa "informe X em Y", o Y vira link que leva ao lugar e ao campo certos.
// Puro (sem React) para rodar em CI. Quem consome: o link guarda o destino em `pendingStoreFix` (useStore) e a tela
// de destino abre a loja e foca o campo.
export type StoreFixField = 'margin';
export type StoreLike = { id: string; name?: string; active?: boolean | number; gross_margin_percent?: number | string | null };

/** Id do campo na tela de destino — o mesmo id usado no input do formulário da loja. */
export const storeFieldId = (field: StoreFixField): string => `store-field-${field}`;

const hasMargin = (s: StoreLike) => s.gross_margin_percent != null && Number(s.gross_margin_percent) > 0;

/**
 * Qual loja abrir: a pedida (se existir e estiver ativa); sem pedido, a PRIMEIRA ativa que ainda não tem o dado.
 * Nada achado → null (a tela avisa em vez de abrir a loja errada).
 */
export function pickStoreForFix(stores: StoreLike[], storeId: string | null, field: StoreFixField): StoreLike | null {
  const active = stores.filter((s) => s.active === true || s.active === 1);
  if (storeId) return active.find((s) => s.id === storeId) || null;
  if (field === 'margin') return active.find((s) => !hasMargin(s)) || null;
  return null;
}
