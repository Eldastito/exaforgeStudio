import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

/**
 * Cadastro GERENCIADO das categorias da vitrine (menu de 2 níveis):
 * departamento (ex.: "Roupas masculinas") → categoria (ex.: "Casaco").
 *
 * Decisão de design (aditivo/reversível, reaproveita o filtro atual): o registro
 * só ORGANIZA. O produto continua com `products_services.category` (texto) = nome
 * da categoria — então todo o filtro/menu público já existente segue valendo, e o
 * departamento é derivado casando `category` (texto) com as categorias do registro.
 * Sem registro, a vitrine mantém o menu plano (0-regressão).
 *
 * Isolamento multi-tenant: `orgId` é sempre o 1º argumento e toda query filtra
 * `organization_id`.
 */
export class StorefrontCategoryService {
  /** Árvore departamentos → categorias, ordenada por `position` e nome. */
  static tree(orgId: string): Array<{ id: string; name: string; position: number; categories: Array<{ id: string; name: string; position: number }> }> {
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
        `SELECT id, name, position FROM storefront_categories
          WHERE organization_id = ? AND parent_id = ?
          ORDER BY position ASC, name COLLATE NOCASE`
      ).all(orgId, d.id) as any[]).map((c) => ({ id: c.id, name: c.name, position: c.position })),
    }));
  }

  /** Nomes das categorias de um departamento (alimenta o filtro `?department=`). */
  static categoryNames(orgId: string, departmentId: string): string[] {
    return (db.prepare(
      `SELECT name FROM storefront_categories WHERE organization_id = ? AND parent_id = ?`
    ).all(orgId, departmentId) as any[]).map((r) => r.name);
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

  /** Cria uma categoria dentro de um departamento existente. */
  static createCategory(orgId: string, departmentId: string, name: string): { id: string; name: string } {
    const n = String(name || "").trim();
    if (!n) throw new Error("Informe o nome da categoria.");
    const dept = db.prepare(
      `SELECT id FROM storefront_categories WHERE id = ? AND organization_id = ? AND parent_id IS NULL`
    ).get(departmentId, orgId) as any;
    if (!dept) throw new Error("Departamento não encontrado.");
    const existing = db.prepare(
      `SELECT id, name FROM storefront_categories WHERE organization_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE`
    ).get(orgId, departmentId, n) as any;
    if (existing) return { id: existing.id, name: existing.name };
    const id = uuidv4();
    db.prepare(`INSERT INTO storefront_categories (id, organization_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, departmentId, n, this.nextPosition(orgId, departmentId));
    return { id, name: n };
  }

  /**
   * Renomeia um departamento ou categoria. Renomear CATEGORIA cascateia para os
   * produtos que usam aquele nome (`products_services.category`) — assim o filtro
   * da vitrine continua batendo. Departamento não toca produto (é só agrupador).
   */
  static rename(orgId: string, id: string, name: string): void {
    const n = String(name || "").trim();
    if (!n) throw new Error("Informe o novo nome.");
    const node = db.prepare(`SELECT id, parent_id, name FROM storefront_categories WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!node) throw new Error("Item não encontrado.");
    const tx = db.transaction(() => {
      db.prepare(`UPDATE storefront_categories SET name = ? WHERE id = ? AND organization_id = ?`).run(n, id, orgId);
      if (node.parent_id && node.name !== n) {
        db.prepare(`UPDATE products_services SET category = ? WHERE organization_id = ? AND category = ?`).run(n, orgId, node.name);
      }
    });
    tx();
  }

  /**
   * Remove um item do REGISTRO. Departamento remove também suas categorias (só do
   * registro); o texto `category` dos produtos NÃO é apagado — eles apenas deixam
   * de estar agrupados (voltam a "Sem departamento"/menu plano). Reversível: basta
   * recriar o registro.
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
