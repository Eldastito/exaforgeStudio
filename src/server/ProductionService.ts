import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * ProductionService (Supervisor de Produção IA — fatia 1, ADR-141 / PRD §…).
 *
 * Fundação: PRODUTO FABRICADO + LISTA DE MATERIAIS (BOM). Reusa o catálogo
 * (`products_services`) e o estoque (`inventory_items`) para os materiais. O
 * cálculo de NECESSIDADE de materiais é DETERMINÍSTICO (PRD: "cálculos de
 * necessidade e atraso são determinísticos") — para produzir N unidades,
 * quanto de cada material é preciso e quanto falta ante o estoque. Sem ordens
 * de produção ainda (fatia seguinte). Isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class ProductionService {
  // ── Produto fabricado ──
  static createProduct(orgId: string, input: { productServiceId: string; name?: string }): { ok: boolean; id?: string; error?: string } {
    const ps = db.prepare("SELECT id, name FROM products_services WHERE id = ? AND organization_id = ?").get(input.productServiceId, orgId) as any;
    if (!ps) return { ok: false, error: "Produto acabado não encontrado no catálogo." };
    const existing = db.prepare("SELECT id FROM manufactured_products WHERE organization_id = ? AND product_service_id = ?").get(orgId, input.productServiceId) as any;
    if (existing) return { ok: true, id: existing.id };
    const id = randomUUID();
    db.prepare("INSERT INTO manufactured_products (id, organization_id, product_service_id, name) VALUES (?, ?, ?, ?)")
      .run(id, orgId, input.productServiceId, String(input.name || ps.name || "Produto").slice(0, 160));
    return { ok: true, id };
  }
  static listProducts(orgId: string): any[] {
    return db.prepare(`SELECT mp.*, ps.name AS product_name FROM manufactured_products mp JOIN products_services ps ON ps.id = mp.product_service_id AND ps.organization_id = mp.organization_id WHERE mp.organization_id = ? AND mp.active = 1 ORDER BY mp.name`).all(orgId) as any[];
  }

  // ── Lista de materiais (BOM) ──
  static createBom(orgId: string, manufacturedProductId: string, name?: string): { ok: boolean; id?: string; error?: string } {
    const mp = db.prepare("SELECT id FROM manufactured_products WHERE id = ? AND organization_id = ?").get(manufacturedProductId, orgId) as any;
    if (!mp) return { ok: false, error: "Produto fabricado não encontrado." };
    const id = randomUUID();
    db.prepare("INSERT INTO bill_of_materials (id, organization_id, manufactured_product_id, name) VALUES (?, ?, ?, ?)").run(id, orgId, manufacturedProductId, String(name || "Padrão").slice(0, 120));
    return { ok: true, id };
  }

  static addBomItem(orgId: string, bomId: string, input: { materialProductServiceId: string; quantity: number; unit?: string }): { ok: boolean; id?: string; error?: string } {
    const bom = db.prepare("SELECT id FROM bill_of_materials WHERE id = ? AND organization_id = ?").get(bomId, orgId) as any;
    if (!bom) return { ok: false, error: "BOM não encontrada." };
    const mat = db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ?").get(input.materialProductServiceId, orgId) as any;
    if (!mat) return { ok: false, error: "Material não encontrado no catálogo." };
    const qty = Number(input.quantity);
    if (!(qty > 0)) return { ok: false, error: "Quantidade por unidade deve ser > 0." };
    const existing = db.prepare("SELECT id FROM bom_items WHERE organization_id = ? AND bom_id = ? AND material_product_service_id = ?").get(orgId, bomId, input.materialProductServiceId) as any;
    if (existing) { db.prepare("UPDATE bom_items SET quantity = ?, unit = ? WHERE id = ?").run(round2(qty), input.unit || null, existing.id); return { ok: true, id: existing.id }; }
    const id = randomUUID();
    db.prepare("INSERT INTO bom_items (id, organization_id, bom_id, material_product_service_id, quantity, unit) VALUES (?, ?, ?, ?, ?, ?)").run(id, orgId, bomId, input.materialProductServiceId, round2(qty), input.unit || null);
    return { ok: true, id };
  }

  static getBom(orgId: string, bomId: string): any | null {
    const bom = db.prepare("SELECT * FROM bill_of_materials WHERE id = ? AND organization_id = ?").get(bomId, orgId) as any;
    if (!bom) return null;
    bom.items = db.prepare(`SELECT bi.*, ps.name AS material_name FROM bom_items bi JOIN products_services ps ON ps.id = bi.material_product_service_id AND ps.organization_id = bi.organization_id WHERE bi.organization_id = ? AND bi.bom_id = ? ORDER BY ps.name`).all(orgId, bomId);
    return bom;
  }

  /**
   * Necessidade de materiais para produzir `quantity` unidades: por material,
   * `required = perUnit × quantity`, o saldo em estoque e a FALTA. Determinístico.
   */
  static materialRequirements(orgId: string, bomId: string, quantity: number): any {
    const bom = this.getBom(orgId, bomId);
    if (!bom) return null;
    const qty = Math.max(0, Number(quantity) || 0);
    const items = bom.items.map((it: any) => {
      const inv = db.prepare("SELECT COALESCE(SUM(quantity_available),0) q FROM inventory_items WHERE organization_id = ? AND product_service_id = ?").get(orgId, it.material_product_service_id) as any;
      const onHand = Number(inv?.q) || 0;
      const required = round2(Number(it.quantity) * qty);
      const shortage = round2(Math.max(0, required - onHand));
      return { materialId: it.material_product_service_id, materialName: it.material_name, unit: it.unit || null, perUnit: Number(it.quantity), required, onHand, shortage };
    });
    return { bomId, quantity: qty, items, hasShortage: items.some((i: any) => i.shortage > 0), shortageCount: items.filter((i: any) => i.shortage > 0).length };
  }
}

export default ProductionService;
