/**
 * Rótulos e formatação da "Revisão do mês" (Board Review, ADR-205 F4.10/F4.11) — funções PURAS, sem React nem rede: a tela só EXIBE o que o
 * servidor já mediu e nunca recalcula. Dado ausente vira "—" (null ≠ 0); código desconhecido nunca vira texto cru.
 */
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "2026-09" → "setembro de 2026" · "2026-Q3" → "3º trimestre de 2026". Formato desconhecido volta como veio (nunca inventa). */
export function periodLabel(key: string | null | undefined): string {
  const k = String(key || "");
  const m = /^(\d{4})-(\d{2})$/.exec(k);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${MESES[+m[2] - 1]} de ${m[1]}`;
  const q = /^(\d{4})-Q([1-4])$/.exec(k);
  if (q) return `${q[2]}º trimestre de ${q[1]}`;
  return k;
}

export const brlOrDash = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const pctOrDash = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: digits })}%`;

export function metricValue(unit: string | null | undefined, v: number | null | undefined): string {
  return unit === "%" ? pctOrDash(v, 1) : brlOrDash(v);
}

export function paceLabel(status: string | null | undefined): string {
  switch (status) {
    case "met": return "meta atingida";
    case "missed": return "meta não atingida";
    case "ahead": return "à frente do ritmo";
    case "on_pace": return "no ritmo";
    case "behind": return "abaixo do ritmo";
    case "not_started": return "ainda não começou";
    default: return "";
  }
}

export function bandLabel(band: string | null | undefined): string {
  switch (band) {
    case "single_supplier": return "um único fornecedor";
    case "high": return "concentração alta";
    case "medium": return "concentração média";
    case "low": return "concentração baixa";
    default: return "";
  }
}

/** A pauta mistura FATOS medidos e "faltou dado": separa, pra o dono ler primeiro o que aconteceu. */
export function splitAgenda(agenda: Array<{ kind: string; text: string; source: string }> | null | undefined) {
  const list = Array.isArray(agenda) ? agenda : [];
  return { facts: list.filter((a) => a.kind !== "section_unavailable"), gaps: list.filter((a) => a.kind === "section_unavailable") };
}

export function planLines(data: any): string[] {
  const r = data?.track?.revenue;
  if (!r) return [];
  const out: string[] = [];
  if (r.target != null) out.push(`Faturamento: ${brlOrDash(r.actual)} de ${brlOrDash(r.target)} (${pctOrDash(r.progressPct)} da meta)${paceLabel(r.paceStatus) ? ` — ${paceLabel(r.paceStatus)}` : ""}.`);
  else out.push("O plano não define meta de faturamento.");
  return out;
}

export function decisionLines(data: any): string[] {
  if (!data) return [];
  const out: string[] = [];
  const due = Array.isArray(data.reviewsDue) ? data.reviewsDue : [];
  out.push(`${data.decidedCount ?? 0} decisão(ões) estratégica(s) registrada(s).`);
  if (due.length) out.push(`${due.length} com revisão vencida: ${due.map((d: any) => d.title).join("; ")}.`);
  const c = data.calibration;
  if (c && c.n > 0) out.push(`Resultado dentro da faixa esperada em ${c.within} de ${c.n} decisão(ões) medida(s) — amostra pequena, não é prova de acerto.`);
  return out;
}

export function supplierLines(data: any): string[] {
  if (!data) return [];
  const out: string[] = [`Compras por ordem no período: ${brlOrDash(data.totalSpend)}.`];
  if (data.topSharePct != null) out.push(`Maior fornecedor: ${pctOrDash(data.topSharePct, 1)} das compras${bandLabel(data.band) ? ` (${bandLabel(data.band)})` : ""}.`);
  const cov = data.coverage?.orderCoveragePct;
  if (cov != null) out.push(`${pctOrDash(cov)} das compras lançadas passam por ordem${cov < 70 ? " — leitura parcial" : ""}.`);
  return out;
}

export function evidenceLabel(label: string | null | undefined): string {
  return label === "fonte_viva" ? "fonte viva" : "síntese do modelo (hipótese, não evidência)";
}

/** Confiança nunca vira "alta" na tela enquanto o piloto não rodou — o servidor já limita, aqui só traduzimos. */
export function reviewConfidenceLabel(level: string | null | undefined): string {
  return level === "media" ? "confiança média" : level === "baixa" ? "confiança baixa" : "";
}
