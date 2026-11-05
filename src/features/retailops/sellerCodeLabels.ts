// Regras puras dos códigos de vendedor sem nome (cadastro e "Vendedores a identificar"). Sem React — testável em CI.

/** Mesmo limiar de "parado" da auditoria do servidor (RetailSellerCodeAuditService.AUDIT_INACTIVE_DAYS). */
export const STOPPED_AFTER_DAYS = 45;

const dayNum = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);

/** Código parado = última venda há mais de STOPPED_AFTER_DAYS dias (sem data = parado: não há venda conhecida). */
export function isStoppedCode(lastSale: string | null | undefined, todayISO: string, days = STOPPED_AFTER_DAYS): boolean {
  const s = String(lastSale || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  return dayNum(todayISO.slice(0, 10)) - dayNum(s) > days;
}

export function ddmm(iso: string | null | undefined): string {
  const s = String(iso || '');
  return s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '—';
}

/** "10830005 · 27 vendas · última 04/11" — rótulo de um código candidato no cadastro. */
export function candidateLabel(c: { matricula: string; sales: number; lastSale: string }): string {
  return `${c.matricula} · ${c.sales} venda${c.sales === 1 ? '' : 's'} · última ${ddmm(c.lastSale)}`;
}

/** Pergunta quando o nome digitado já é de outra pessoa cadastrada (409 same_name_exists do servidor). */
export function sameNameQuestion(existing: { name: string; matricula: string }, matricula: string): string {
  return `Já existe ${existing.name} (matrícula ${existing.matricula}).\n\nO código ${matricula} é dessa mesma pessoa?\n\nOK = ligar o código ${matricula} a ${existing.name} (não cria outra pessoa).\nCancelar = é outra pessoa com o mesmo nome.`;
}
