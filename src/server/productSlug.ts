import db from "./db.js";

/**
 * Slug por produto (ADR-028): identificador estável e legível para a URL
 * pública da vitrine (/loja/:loja/produto/:slug). Único por organização
 * (índice parcial idx_products_org_slug); colisão ganha sufixo numérico.
 * O slug NÃO muda quando o nome do produto muda — URL compartilhada não pode
 * quebrar por causa de uma correção de digitação no nome.
 */
export function slugifyProductName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function uniqueProductSlug(orgId: string, name: string): string {
  const base = slugifyProductName(name) || "produto";
  let candidate = base;
  let n = 2;
  const exists = db.prepare(`SELECT 1 FROM products_services WHERE organization_id = ? AND slug = ? LIMIT 1`);
  while (exists.get(orgId, candidate)) candidate = `${base}-${n++}`;
  return candidate;
}

/** Garante que um produto tenha slug (fallback preguiçoso da vitrine pública). */
export function ensureProductSlug(orgId: string, product: { id: string; name: string; slug?: string | null }): string {
  if (product.slug) return product.slug;
  const slug = uniqueProductSlug(orgId, product.name);
  db.prepare(`UPDATE products_services SET slug = ? WHERE id = ? AND organization_id = ?`).run(slug, product.id, orgId);
  return slug;
}
