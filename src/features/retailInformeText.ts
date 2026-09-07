/**
 * Texto compartilhável do INFORME DIÁRIO da rede (INFORME-EXPORT) — pedido do
 * cliente: mandar o informe do dia pronto pro WhatsApp, no padrão do "Informe
 * Diário do Brunno" (por loja: valor/venda/cota/bateu-faltou/cota do dia
 * seguinte + "Empresa Dia" no total), MAIS as formas de pagamento da empresa
 * "tudo num lugar só".
 *
 * Função PURA e determinística (sem React/DOM) — por isso é testável em Node
 * (scripts/test-retail-daily-informe.ts) e reusada pela UI (DailyInformeCard)
 * pros botões Copiar/Compartilhar.
 */

export interface InformeStoreRow {
  storeName: string;
  dinheiro: number;
  venda: number;
  cota: number;
  desvio: number;   // venda - cota (>=0 bateu, <0 faltou)
  cotaNext: number;
  byMethod?: any;
}
export interface InformeData {
  date: string;      // YYYY-MM-DD
  nextDate: string;  // YYYY-MM-DD
  stores: InformeStoreRow[];
  total: {
    dinheiro: number; venda: number; cota: number; desvio: number; cotaNext: number;
    byMethod?: any;
  };
}

/** R$ 6.056,10 (pt-BR). Fallback manual se o ambiente não tiver Intl completo. */
function money(n: number): string {
  const v = Number(n) || 0;
  try {
    return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch {
    return `R$ ${v.toFixed(2).replace(".", ",")}`;
  }
}

/** DD/MM/AA a partir de YYYY-MM-DD. */
function br(dateStr: string): string {
  const s = String(dateStr || "");
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}`;
}
/** DD/MM a partir de YYYY-MM-DD. */
function dm(dateStr: string): string {
  const s = String(dateStr || "");
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}

/** Bandeiras com valor > 0, da maior pra menor. */
function bandeiras(m: any): Array<[string, number]> {
  return Object.entries(m || {})
    .map(([k, v]) => [k, Number(v)] as [string, number])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
}
function hasPay(m: any): boolean {
  return !!m && (Number(m.dinheiro) > 0 || Number(m.pix) > 0 || Number(m.voucher) > 0 || Number(m.troca) > 0 || bandeiras(m.credito).length > 0 || bandeiras(m.debito).length > 0);
}

function block(name: string, r: { dinheiro: number; venda: number; cota: number; desvio: number; cotaNext: number }, nextDate: string): string[] {
  const L: string[] = [name];
  L.push(money(r.dinheiro));
  L.push(`Venda ${money(r.venda)}`);
  L.push(`Cota ${money(r.cota)}`);
  L.push(Number(r.desvio) >= 0 ? `Bateu ${money(r.desvio)}` : `Faltou ${money(Math.abs(Number(r.desvio)))}`);
  L.push(`Cota ${dm(nextDate)} ${money(r.cotaNext)}`);
  return L;
}

/** Monta o texto completo do informe do dia (por loja + Empresa Dia + pagamentos). */
export function buildDailyInformeText(data: InformeData): string {
  if (!data || !data.total) return "";
  const L: string[] = ["Informe Diário", br(data.date), ""];
  for (const s of data.stores || []) {
    L.push(...block(s.storeName, s, data.nextDate));
    L.push("");
  }
  L.push("Empresa Dia", br(data.date));
  const t = data.total;
  L.push(money(t.dinheiro));
  L.push(`Venda ${money(t.venda)}`);
  L.push(`Cota ${money(t.cota)}`);
  L.push(Number(t.desvio) >= 0 ? `Bateu ${money(t.desvio)}` : `Faltou ${money(Math.abs(Number(t.desvio)))}`);
  L.push(`Cota ${dm(data.nextDate)} ${money(t.cotaNext)}`);

  // Formas de pagamento da empresa "num lugar só" (pedido do cliente).
  const bm = t.byMethod || {};
  if (hasPay(bm)) {
    L.push("", "Formas de pagamento (empresa)");
    if (Number(bm.dinheiro) > 0) L.push(`Dinheiro ${money(bm.dinheiro)}`);
    if (Number(bm.pix) > 0) L.push(`PIX ${money(bm.pix)}`);
    if (Number(bm.voucher) > 0) L.push(`Voucher ${money(bm.voucher)}`);
    if (Number(bm.troca) > 0) L.push(`Troca ${money(bm.troca)}`);
    const cB = bandeiras(bm.credito), dB = bandeiras(bm.debito);
    if (cB.length) L.push(`Crédito ${money(bm.totalCredito)} (${cB.map(([b, v]) => `${b} ${money(v)}`).join(", ")})`);
    if (dB.length) L.push(`Débito ${money(bm.totalDebito)} (${dB.map(([b, v]) => `${b} ${money(v)}`).join(", ")})`);
  }
  return L.join("\n");
}
