/**
 * Validação de EAN/GTIN pelo dígito verificador (mod 10) — vale para GTIN-8,
 * UPC-A (12 dígitos), EAN-13 e GTIN-14.
 *
 * Por que isto existe: a leitura do código de barras a partir de uma FOTO é
 * feita pela IA de visão (gpt-4o), que não é confiável para transcrever dígitos
 * com exatidão — pode trocar/inverter um número. O dígito verificador de um
 * GTIN é derivado dos demais, então um código lido errado quase nunca "fecha" o
 * checksum. Só autopreenchemos o EAN quando ele passa aqui: um EAN errado no
 * cadastro (que leva a produto trocado, busca falha, integração quebrada) é
 * pior do que nenhum EAN. Fora do fluxo de IA (ex.: NF-e), o código já vem de
 * uma fonte estruturada e confiável — mas validar não custa nada.
 */
export function isValidGtin(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const code = String(raw).trim();
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop() as number;
  // Da direita para a esquerda dos dígitos de dados, pesos alternando 3,1,3,1...
  let sum = 0;
  let mult = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * mult;
    mult = mult === 3 ? 1 : 3;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check;
}

/**
 * Normaliza a entrada (mantém só dígitos) e devolve o EAN/GTIN se — e somente
 * se — ele passar no dígito verificador; caso contrário devolve null. É o ponto
 * único de decisão "aceito este código de barras?" para qualquer origem de IA.
 */
export function sanitizeGtin(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const code = String(raw).replace(/\D/g, "");
  if (!code) return null;
  return isValidGtin(code) ? code : null;
}
