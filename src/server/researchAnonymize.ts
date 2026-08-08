/**
 * Filtro de anonimização (ADR-156 D2, RN-156-3) — garante que a camada
 * COMPARTILHADA (`vertical_intelligence`) nunca guarde dado pessoal nem dado que
 * identifique um tenant. Roda ANTES de persistir no compartilhado. Na dúvida,
 * remove/bloqueia (conservador).
 *
 * Cobre PII comum no Brasil (e-mail, CPF, CNPJ, telefone) via regex — não é
 * detector semântico de nomes (isso viria de um serviço dedicado), mas remove os
 * identificadores estruturados que vazariam de uma pesquisa mal-comportada, e o
 * `assertNoTenantData` barra explicitamente ids/nome de org conhecidos.
 */

const PII_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: "email" },
  { re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, label: "cpf" },
  { re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, label: "cnpj" },
  { re: /\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g, label: "phone" },
];

/** Há PII estruturada no texto? */
export function containsPII(text: string): boolean {
  if (typeof text !== "string") return false;
  return PII_PATTERNS.some((p) => { p.re.lastIndex = 0; return p.re.test(text); });
}

/** Remove PII de um texto (substitui por marcador). */
export function stripPII(text: string): string {
  if (typeof text !== "string") return text;
  let out = text;
  for (const p of PII_PATTERNS) { out = out.replace(p.re, "[removido]"); }
  return out;
}

/** Aplica stripPII recursivamente em todas as strings de um objeto/array. */
export function deepStripPII<T>(value: T): T {
  if (typeof value === "string") return stripPII(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepStripPII(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value as any)) out[k] = deepStripPII(v);
    return out;
  }
  return value;
}

/**
 * Barra explicitamente qualquer id/nome de tenant no payload que vai pro
 * compartilhado (RN-156-1). `terms` = ids de org e nomes de negócio conhecidos.
 * Lança se encontrar — o compartilhado é, por construção, org-agnóstico.
 */
export function assertNoTenantData(value: any, terms: string[]): void {
  const hay = JSON.stringify(value ?? {}).toLowerCase();
  for (const t of terms || []) {
    const term = String(t || "").trim().toLowerCase();
    if (term.length >= 3 && hay.includes(term)) {
      throw new Error(`anonymize_violation: conteúdo compartilhado contém identificador de tenant ("${term}").`);
    }
  }
}

/**
 * Sanitiza um resultado de pesquisa para a camada compartilhada: remove PII e
 * garante ausência de ids/nome de tenant. Retorna o conteúdo seguro.
 */
export function sanitizeForShared(content: any, tenantTerms: string[] = []): any {
  const clean = deepStripPII(content);
  assertNoTenantData(clean, tenantTerms);
  return clean;
}
