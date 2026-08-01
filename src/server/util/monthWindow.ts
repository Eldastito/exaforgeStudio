/**
 * Helpers de janela mensal — extraídos do ClinicMonthlyReportService pra
 * poderem ser reusados por qualquer relatório/consolidação por mês
 * (clínica, comigo, retail no futuro). Aritmética em UTC (estável, sem
 * surpresa de fuso).
 */

const PT_MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Aceita "YYYY-MM" ou undefined (default: mês anterior ao atual — relatório é retrospectivo). */
export function normalizeMonth(input: string | undefined | null, nowMs: number = Date.now()): string {
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const [y, m] = input.split("-").map(Number);
    if (m >= 1 && m <= 12 && y >= 1970 && y <= 2999) return input;
  }
  const d = new Date(nowMs);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Devolve [fromISO, toISO] cobrindo o mês inteiro em UTC (primeiro ao último dia). */
export function monthWindow(month: string): { fromISO: string; toISO: string; label: string } {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - 1);
  return {
    fromISO: from.toISOString(),
    toISO: to.toISOString(),
    label: `${PT_MONTHS[m - 1]} de ${y}`,
  };
}
