/**
 * parseMoneyBR — parser de dinheiro em formato BRASILEIRO, à prova do separador
 * de milhar.
 *
 * BUG que isto corrige (Fechamento diário): o parser antigo fazia só
 * `String(v).replace(',', '.')`, então:
 *   - "2.253,33"  virava "2.253.33" → Number = NaN → 0   (valor SUMIA ao salvar)
 *   - "1.500"     virava Number("1.500") = 1,5           (mil reais viravam R$1,50)
 * Por isso o "Informado" não batia e mudava ao recarregar.
 *
 * Regra (convenção BR): vírgula = decimal; ponto = separador de milhar. Sem
 * vírgula, um ponto só é milhar quando o último grupo tem 3 dígitos (1.500 =
 * 1500) ou quando há mais de um ponto (1.234.567); caso contrário o ponto é
 * decimal (389.70 = 389,70; 1.5 = 1,5) — cobre quem digita no teclado numérico.
 */
export function parseMoneyBR(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  let s = String(v ?? "").trim().replace(/[^\d.,-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return 0;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma) {
    // vírgula decimal → tira os pontos de milhar e troca a vírgula por ponto
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    // vários pontos = milhar; um ponto seguido de 3 dígitos = milhar (1.500)
    if (parts.length > 2 || parts[parts.length - 1].length === 3) s = parts.join("");
  }
  const num = Number(s);
  return isFinite(num) ? num : 0;
}
