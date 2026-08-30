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

/**
 * Formata um valor (em reais) no padrão BR "20.000,00" — sem o "R$", pra caber
 * em célula estreita. Vazio/NaN → "" (célula em branco continua significando
 * "usa a derivada da escala"). Usado nos campos de cota semanal, que antes
 * eram texto puro ("20000") e deixavam o usuário na dúvida se era valor.
 */
export function formatMoneyBR(value: unknown): string {
  if (value === "" || value == null) return "";
  const num = typeof value === "number" ? value : parseMoneyBR(value);
  if (!isFinite(num) || num === 0) return "";
  return num.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Máscara de digitação de dinheiro estilo "calculadora": os dígitos entram da
 * DIREITA pras casas decimais, então o usuário digita "2000000" e vê
 * "20.000,00" — reconhecendo as casas decimais na hora, sem ter que pôr
 * vírgula/ponto. Recebe o texto atual do input e devolve o texto já formatado.
 */
export function maskMoneyBRInput(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const cents = parseInt(digits, 10);
  if (!isFinite(cents) || cents === 0) return "";
  return formatMoneyBR(cents / 100);
}
