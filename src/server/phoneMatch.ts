/**
 * Utilitário de comparação de telefones brasileiros para roteamento
 * pelo WhatsApp — ADR-051 (CoordenadorService).
 *
 * Motivação: o número que chega no webhook pode vir em vários formatos
 * (com/sem DDI 55, com/sem 9º dígito, com/sem espaços e traços). O
 * mesmo número cadastrado em `users.phone` pode ter sido digitado de
 * outra forma. Comparar strings direto perde ~70% dos casos reais.
 *
 * A implementação faz duas normalizações:
 * 1) Remove DDI 55 quando presente (número passa a ter 10 ou 11 dígitos).
 * 2) Trata o 9º dígito opcional (celulares antigos ainda cadastrados
 *    sem o 9 casam com formato novo).
 *
 * Se ambos os números têm 8+ dígitos após normalização, tenta match
 * exato ou remoção do 9º dígito. Para menos de 8 dígitos, só match
 * exato (proteção contra falsos positivos por sufixos curtos).
 */

/** Extrai só dígitos. Aceita null/undefined sem lançar. */
export const onlyDigits = (s: unknown): string => String(s || "").replace(/\D/g, "");

/**
 * Remove DDI 55 quando o número tem 12+ dígitos e começa com "55".
 * Não altera números já sem DDI (10-11 dígitos) ou muito curtos.
 */
function stripCountry(d: string): string {
  if (d.length >= 12 && d.startsWith("55")) return d.slice(2);
  return d;
}

/**
 * Compara dois números tolerando DDI/9º dígito.
 * Retorna true se representam o mesmo telefone.
 *
 * Casos que casam:
 *  - "5511987654321" vs "11987654321"    (DDI opcional)
 *  - "1187654321"    vs "11987654321"    (9º dígito opcional em celular novo)
 *  - "5511987654321" vs "(11) 98765-4321" (formato)
 *  - "5511987654321" vs "1187654321"     (DDI + 9º dígito juntos)
 *
 * Casos que NÃO casam:
 *  - Vazios / null / undefined
 *  - Sufixos diferentes ("...54321" vs "...54322")
 *  - DDDs diferentes ("11..." vs "21...")
 *  - Números < 8 dígitos (proteção contra falso positivo)
 */
export function phoneMatches(a: unknown, b: unknown): boolean {
  const x = stripCountry(onlyDigits(a));
  const y = stripCountry(onlyDigits(b));
  if (!x || !y) return false;
  if (x === y) return true;

  // Ambos com 8+ dígitos: tenta match exato dos últimos N.
  if (x.length >= 8 && y.length >= 8) {
    const k = Math.min(11, Math.min(x.length, y.length));
    if (x.slice(-k) === y.slice(-k)) return true;
  }

  // 9º dígito opcional: 11 vs 10 dígitos, DDD igual, o mais longo tem "9"
  // na posição 2 (após DDD).
  if ((x.length === 11 && y.length === 10) || (x.length === 10 && y.length === 11)) {
    const longer = x.length === 11 ? x : y;
    const shorter = x.length === 10 ? x : y;
    // Formato: DDD (2) + [9] + subscritor (8)
    if (longer[2] === "9"
        && longer.slice(0, 2) === shorter.slice(0, 2)
        && longer.slice(3) === shorter.slice(2)) {
      return true;
    }
  }

  return false;
}
