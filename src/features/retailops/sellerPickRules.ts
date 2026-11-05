// Regras puras do seletor de vendedor do fechamento (P4). Sem React — testável em CI.

export type TeamPerson = { sellerId: string; matricula: string; name: string; stores: string[] };

/** Mesma normalização do servidor (RetailOpsService.resolveMatriculaByName): sem acento/caixa/pontuação. */
export function normName(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Casa um nome lido/digitado (escala, foto da folha, fechamento antigo) com UMA pessoa da lista — a mesma regra
 * do servidor: nome completo igual e único; senão o PRIMEIRO nome, se único. Ambíguo ou sem par → null (nunca chuta).
 */
export function matchPerson(rawName: unknown, people: TeamPerson[]): TeamPerson | null {
  const t = normName(rawName);
  if (!t) return null;
  const full = people.filter((p) => normName(p.name) === t);
  if (full.length === 1) return full[0];
  if (full.length > 1) return null;
  const first = t.split(' ')[0];
  const byFirst = people.filter((p) => normName(p.name).split(' ')[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Aplica `matchPerson` às linhas SEM pessoa escolhida; a equipe da loja tem prioridade sobre o resto da rede. */
export function autoMatchRows<T extends { sellerName: string; matricula?: string | null }>(rows: T[], team: TeamPerson[], others: TeamPerson[]): T[] {
  return rows.map((r) => {
    if (r.matricula || !String(r.sellerName || '').trim()) return r;
    const p = matchPerson(r.sellerName, team) || matchPerson(r.sellerName, others);
    return p ? { ...r, matricula: p.matricula, sellerName: p.name } : r;
  });
}

/** Nomes digitados como "outro" (fora da equipe e da rede): contam como pessoa à parte. */
export function outsideTeamNames(rows: Array<{ sellerName: string; matricula?: string | null }>): string[] {
  return rows.filter((r) => String(r.sellerName || '').trim() && !r.matricula).map((r) => String(r.sellerName).trim());
}
