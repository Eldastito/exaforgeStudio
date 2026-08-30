/**
 * Helpers puros do formulário de FECHAMENTO DIÁRIO — conferência das bandeiras
 * de cartão. Ficam separados da UI pra serem testáveis sem React.
 *
 * O bug que motivou este módulo (Carioca 29/08): a IA leu a folha manuscrita
 * ("Electron 399,70") E TAMBÉM a bandeira do comprovante Clover ("Visa débito
 * 399,70") — que é a MESMA venda (Electron é adquirente de Visa débito) — e
 * jogou as duas em `debitoBandeiras`, virando 799,40. Como "Visa" não é uma
 * bandeira cadastrada de débito da loja (Redshop/Eletron/Elo), ela NÃO
 * aparecia como campo, mas ENTRAVA no subtotal — um "fantasma" invisível que
 * inflava o débito e derrubava a conferência (diferença de 399,70 em todo
 * lugar). A regra passa a ser: a lista de bandeiras cadastradas da loja é a
 * fonte da verdade; o subtotal é SEMPRE a soma dos campos visíveis.
 */

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normBrand = (s: unknown) => stripAccents(String(s ?? "")).trim().toLowerCase();

/** Rótulos de TOTAL/seção — nunca são uma bandeira de verdade. */
const GENERIC_LABEL = /^(credito|debito|total|cartao|cartoes|pos|resumo|vendas?|forma[s]? de pagamento)$/;

/**
 * Casa as bandeiras lidas pela IA com as bandeiras CADASTRADAS da loja. Só
 * entram valores de bandeiras conhecidas (match sem acento/caixa) — assim o
 * comprovante do POS e rótulos de total ("Débito", "Crédito") não viram
 * fantasma no subtotal. Devolve os valores já com o nome canônico da loja e a
 * lista do que foi ignorado (pra avisar o usuário).
 */
export function reconcileBandeiras(
  ocr: Record<string, unknown> | null | undefined,
  knownBrands: string[] = [],
): { values: Record<string, string>; ignored: string[] } {
  const values: Record<string, string> = {};
  const ignored: string[] = [];
  if (!ocr || typeof ocr !== "object") return { values, ignored };
  const known = new Map<string, string>();
  for (const b of knownBrands) known.set(normBrand(b), b);
  for (const [rawKey, rawVal] of Object.entries(ocr)) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num === 0) continue; // 0 não precisa pré-preencher
    const canon = known.get(normBrand(key));
    if (canon) {
      // Se a IA repetir a mesma bandeira, fica com o MAIOR (evita perder valor).
      const prev = Number(values[canon]);
      if (!Number.isFinite(prev) || num > prev) values[canon] = String(rawVal);
      continue;
    }
    // Bandeira desconhecida (POS, rótulo de total, ou marca não cadastrada):
    // não injeta no estado — só reporta pra conferência manual.
    if (!GENERIC_LABEL.test(normBrand(key))) ignored.push(key);
  }
  return { values, ignored };
}

/**
 * Soma das bandeiras SOMENTE sobre as cadastradas da loja — o subtotal exibido
 * é exatamente a soma dos campos visíveis, sem fantasma. `parse` é o parser de
 * moeda BR do formulário.
 */
export function sumBandeiras(
  state: Record<string, unknown> | null | undefined,
  knownBrands: string[] = [],
  parse: (s: string) => number = (s) => Number(s) || 0,
): number {
  if (!state) return 0;
  let total = 0;
  for (const b of knownBrands) total += parse(String(state[b] ?? ""));
  return Math.round(total * 100) / 100;
}
