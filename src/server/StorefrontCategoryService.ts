import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

/**
 * Cadastro GERENCIADO das categorias da vitrine (menu de 2 níveis):
 * departamento (ex.: "Roupas masculinas") → categoria (ex.: "Bermudas").
 *
 * MODELO código→nome (a decisão do dono): o catálogo real guarda a categoria em
 * `products_services.category` — muitas vezes um CÓDIGO ("002"). A categoria do
 * registro APONTA para esse valor (`source_value`) e exibe um nome amigável
 * (`name`). Assim o menu organiza/renomeia SEM re-marcar produto: o filtro
 * continua por `source_value` (o que está no produto), só a exibição muda.
 * Departamento tem `source_value` NULL. Sem registro, a vitrine mantém o menu
 * plano (0-regressão).
 *
 * Isolamento multi-tenant: `orgId` é sempre o 1º argumento e toda query filtra
 * `organization_id`.
 */
export class StorefrontCategoryService {
  /** Árvore departamentos → categorias (com o valor filtrado e o nome exibido). */
  static tree(orgId: string): Array<{ id: string; name: string; position: number; categories: Array<{ id: string; name: string; value: string; position: number }> }> {
    const depts = db.prepare(
      `SELECT id, name, position FROM storefront_categories
        WHERE organization_id = ? AND parent_id IS NULL
        ORDER BY position ASC, name COLLATE NOCASE`
    ).all(orgId) as any[];
    return depts.map((d) => ({
      id: d.id,
      name: d.name,
      position: d.position,
      categories: (db.prepare(
        `SELECT id, name, COALESCE(source_value, name) AS value, position FROM storefront_categories
          WHERE organization_id = ? AND parent_id = ?
          ORDER BY position ASC, name COLLATE NOCASE`
      ).all(orgId, d.id) as any[]).map((c) => ({ id: c.id, name: c.name, value: c.value, position: c.position })),
    }));
  }

  /** Valores (o que está gravado no produto) das categorias de um departamento — alimenta `?department=`. */
  static sourceValues(orgId: string, departmentId: string): string[] {
    return (db.prepare(
      `SELECT COALESCE(source_value, name) AS value FROM storefront_categories WHERE organization_id = ? AND parent_id = ?`
    ).all(orgId, departmentId) as any[]).map((r) => r.value);
  }

  /**
   * Valores de categoria realmente usados nos produtos (para o dono mapear).
   * Traz contagem e um nome de produto de exemplo por valor — assim o dono
   * reconhece o código ("002" → "BERMUDA...") na hora de dar o nome amigável.
   */
  static availableValues(orgId: string): Array<{ value: string; count: number; sample: string; mapped: boolean }> {
    const rows = db.prepare(
      `SELECT category AS value, COUNT(*) AS count, MIN(name) AS sample
         FROM products_services
        WHERE organization_id = ? AND type = 'product' AND active = 1
          AND category IS NOT NULL AND TRIM(category) != ''
        GROUP BY category ORDER BY category COLLATE NOCASE`
    ).all(orgId) as any[];
    const mapped = new Set(
      (db.prepare(`SELECT COALESCE(source_value, name) AS value FROM storefront_categories WHERE organization_id = ? AND parent_id IS NOT NULL`).all(orgId) as any[]).map((r) => r.value)
    );
    return rows.map((r) => ({ value: r.value, count: Number(r.count || 0), sample: r.sample || "", mapped: mapped.has(r.value) }));
  }

  private static nextPosition(orgId: string, parentId: string | null): number {
    const row = db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM storefront_categories
        WHERE organization_id = ? AND ${parentId === null ? "parent_id IS NULL" : "parent_id = ?"}`
    ).get(...(parentId === null ? [orgId] : [orgId, parentId])) as any;
    return Number(row?.pos || 0);
  }

  /** Cria um departamento. Nome obrigatório; ignora duplicado exato (case-insensitive). */
  static createDepartment(orgId: string, name: string): { id: string; name: string } {
    const n = String(name || "").trim();
    if (!n) throw new Error("Informe o nome do departamento.");
    const existing = db.prepare(
      `SELECT id, name FROM storefront_categories WHERE organization_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE`
    ).get(orgId, n) as any;
    if (existing) return { id: existing.id, name: existing.name };
    const id = uuidv4();
    db.prepare(`INSERT INTO storefront_categories (id, organization_id, parent_id, name, position) VALUES (?, ?, NULL, ?, ?)`)
      .run(id, orgId, n, this.nextPosition(orgId, null));
    return { id, name: n };
  }

  /**
   * Cria uma categoria num departamento. `name` = nome amigável exibido;
   * `sourceValue` = o valor que está no produto (ex.: código "002"). Se
   * `sourceValue` vier vazio, usa o próprio nome (categoria "nova", sem código).
   * Dedupe por valor mapeado dentro do org (um código → uma categoria).
   */
  static createCategory(orgId: string, departmentId: string, name: string, sourceValue?: string): { id: string; name: string } {
    const n = String(name || "").trim();
    if (!n) throw new Error("Informe o nome da categoria.");
    const val = String(sourceValue || "").trim() || n;
    const dept = db.prepare(
      `SELECT id FROM storefront_categories WHERE id = ? AND organization_id = ? AND parent_id IS NULL`
    ).get(departmentId, orgId) as any;
    if (!dept) throw new Error("Departamento não encontrado.");
    // Um mesmo valor não pode ser mapeado duas vezes (evita categoria duplicada no menu).
    const dupVal = db.prepare(
      `SELECT id FROM storefront_categories WHERE organization_id = ? AND parent_id IS NOT NULL AND COALESCE(source_value, name) = ?`
    ).get(orgId, val) as any;
    if (dupVal) throw new Error("Esse código/categoria já está mapeado.");
    const id = uuidv4();
    db.prepare(`INSERT INTO storefront_categories (id, organization_id, parent_id, name, source_value, position) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, departmentId, n, val, this.nextPosition(orgId, departmentId));
    return { id, name: n };
  }

  /** Renomeia o nome EXIBIDO de um departamento ou categoria (não toca o produto — o filtro é por `source_value`). */
  static rename(orgId: string, id: string, name: string): void {
    const n = String(name || "").trim();
    if (!n) throw new Error("Informe o novo nome.");
    const node = db.prepare(`SELECT id FROM storefront_categories WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!node) throw new Error("Item não encontrado.");
    db.prepare(`UPDATE storefront_categories SET name = ? WHERE id = ? AND organization_id = ?`).run(n, id, orgId);
  }

  /**
   * Remove um item do REGISTRO. Departamento remove também suas categorias (só do
   * registro); NADA muda no produto — o valor `category` continua lá, só deixa de
   * estar agrupado. Reversível: basta recriar o mapeamento.
   */
  static remove(orgId: string, id: string): void {
    const node = db.prepare(`SELECT id, parent_id FROM storefront_categories WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!node) return;
    const tx = db.transaction(() => {
      if (!node.parent_id) {
        db.prepare(`DELETE FROM storefront_categories WHERE organization_id = ? AND parent_id = ?`).run(orgId, id);
      }
      db.prepare(`DELETE FROM storefront_categories WHERE id = ? AND organization_id = ?`).run(id, orgId);
    });
    tx();
  }
}

export default StorefrontCategoryService;
