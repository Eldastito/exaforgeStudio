/**
 * moneyVisibility — visibilidade de DINHEIRO por papel (SEC-F25 / FE3 / RN-CG-06 / §73).
 *
 * Convenção do repo (SEC-F13): receita/custo/lucro/margem/fiado (a receber) são DADO SENSÍVEL
 * de gestão — só owner/admin veem. Rotas que são PURO relatório financeiro levam
 * `requireRole("owner","admin")`; rotas MISTAS (operacional + dinheiro, ex.: catálogo) mantêm a
 * resposta mas REDIGEM só o campo de dinheiro pra quem não é owner/admin (espelha
 * `canSeeProductCost` em routes/products.ts). Este módulo centraliza a regra pra reuso e teste.
 *
 * Não concede nada por ausência (FAIL CLOSED): sem user, ou papel fora de owner/admin → não vê.
 */
export function canSeeOrgMoney(user: any): boolean {
  return !!user && (user.role === "owner" || user.role === "admin");
}

/** Devolve o valor pra quem pode ver dinheiro; senão `null` (redação, nunca 0 — não inventa). */
export function redactMoney<T>(value: T, user: any): T | null {
  return canSeeOrgMoney(user) ? value : null;
}
