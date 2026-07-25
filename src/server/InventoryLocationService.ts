import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * InventoryLocationService — CONTROLER (PRD-E-007, Fatia 1b).
 *
 * Registro de LOCALIZAÇÕES de estoque (onde o material fisicamente está) e o
 * saldo por local × produto × variação. Aditivo: NÃO toca o agregado legado
 * `inventory_items` — a reconciliação entra na fatia de consumo. Determinístico,
 * auditável, isolado por organization_id.
 *
 * O saldo de um local só muda por primitivas GOVERNADAS:
 *   - receive(): material entra num local (compra/recebimento/entrada técnica);
 *   - transfer(): move entre locais (débito atômico na origem, crédito no destino).
 * Não há edição direta de saldo em fluxo humano (princípio do ledger, §4.1).
 */

const TYPES = ["almoxarifado", "filial", "sala", "veiculo", "maquina", "custodia_colaborador", "manutencao", "limpeza", "outro"];
const clean = (s: any) => (s == null ? null : String(s).trim() || null);
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface LocationInput {
  name: string;
  type?: string;
  code?: string | null;
  storeId?: string | null;
  departmentId?: string | null;
  responsibleUserId?: string | null;
  active?: boolean;
}

export class InventoryLocationService {
  static get(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM inventory_locations WHERE id = ? AND organization_id = ?").get(id, orgId) || null;
  }

  static list(orgId: string, opts: { includeInactive?: boolean; type?: string } = {}): any[] {
    let sql = "SELECT * FROM inventory_locations WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (!opts.includeInactive) sql += " AND active = 1";
    if (opts.type) { sql += " AND type = ?"; params.push(opts.type); }
    sql += " ORDER BY name";
    return db.prepare(sql).all(...params) as any[];
  }

  private static assertValid(orgId: string, input: LocationInput, selfId?: string): { name: string; type: string; code: string | null; storeId: string | null; departmentId: string | null; responsibleUserId: string | null } {
    const name = clean(input.name);
    if (!name) throw new Error("Localização exige nome.");
    const type = clean(input.type) || "almoxarifado";
    if (!TYPES.includes(type)) throw new Error(`Tipo de localização inválido. Use um de: ${TYPES.join(", ")}.`);
    const code = clean(input.code);
    if (code) {
      const dup = db.prepare("SELECT id FROM inventory_locations WHERE organization_id = ? AND code = ? AND id <> ?").get(orgId, code, selfId || "") as any;
      if (dup) throw new Error(`Já existe localização com o código '${code}'.`);
    }
    const departmentId = clean(input.departmentId);
    if (departmentId && !db.prepare("SELECT id FROM business_departments WHERE id = ? AND organization_id = ?").get(departmentId, orgId)) throw new Error("Departamento não encontrado na organização.");
    const responsibleUserId = clean(input.responsibleUserId);
    if (responsibleUserId && !db.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ?").get(responsibleUserId, orgId)) throw new Error("Responsável (usuário) não encontrado na organização.");
    return { name, type, code, storeId: clean(input.storeId), departmentId, responsibleUserId };
  }

  static create(orgId: string, input: LocationInput, actorId?: string): any {
    const v = this.assertValid(orgId, input);
    const id = randomUUID();
    db.prepare(`INSERT INTO inventory_locations (id, organization_id, name, type, code, store_id, department_id, responsible_user_id, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(id, orgId, v.name, v.type, v.code, v.storeId, v.departmentId, v.responsibleUserId);
    try { logAuthEvent(orgId, actorId || "system", id, "INVENTORY_LOCATION_CREATE", { name: v.name, type: v.type }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, input: LocationInput, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Localização não encontrada.");
    const v = this.assertValid(orgId, input, id);
    const active = input.active == null ? existing.active : (input.active ? 1 : 0);
    db.prepare(`UPDATE inventory_locations SET name = ?, type = ?, code = ?, store_id = ?, department_id = ?, responsible_user_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND organization_id = ?`).run(v.name, v.type, v.code, v.storeId, v.departmentId, v.responsibleUserId, active, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "INVENTORY_LOCATION_UPDATE", { name: v.name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static setActive(orgId: string, id: string, active: boolean, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Localização não encontrada.");
    db.prepare("UPDATE inventory_locations SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(active ? 1 : 0, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, active ? "INVENTORY_LOCATION_ACTIVATE" : "INVENTORY_LOCATION_DEACTIVATE", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  // ── Saldos por local ────────────────────────────────────────────────────────
  static balances(orgId: string, opts: { locationId?: string; productId?: string } = {}): any[] {
    let sql = "SELECT * FROM inventory_location_balances WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.locationId) { sql += " AND location_id = ?"; params.push(opts.locationId); }
    if (opts.productId) { sql += " AND product_service_id = ?"; params.push(opts.productId); }
    sql += " ORDER BY updated_at DESC";
    return db.prepare(sql).all(...params) as any[];
  }

  static balanceOf(orgId: string, locationId: string, productId: string, variantId?: string | null): number {
    const r = db.prepare("SELECT quantity FROM inventory_location_balances WHERE organization_id = ? AND location_id = ? AND product_service_id = ? AND COALESCE(variant_id,'') = ?")
      .get(orgId, locationId, productId, variantId || "") as any;
    return r ? Number(r.quantity) : 0;
  }

  /** Débito/crédito idempotente por linha (uso interno das primitivas governadas). */
  private static applyDelta(orgId: string, locationId: string, productId: string, variantId: string | null, delta: number): void {
    const existing = db.prepare("SELECT id, quantity FROM inventory_location_balances WHERE organization_id = ? AND location_id = ? AND product_service_id = ? AND COALESCE(variant_id,'') = ?")
      .get(orgId, locationId, productId, variantId || "") as any;
    if (existing) {
      db.prepare("UPDATE inventory_location_balances SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(round2(Number(existing.quantity) + delta), existing.id);
    } else {
      db.prepare("INSERT INTO inventory_location_balances (id, organization_id, location_id, product_service_id, variant_id, quantity) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, locationId, productId, variantId, round2(delta));
    }
  }

  private static assertLocation(orgId: string, locationId: string): any {
    const loc = this.get(orgId, locationId);
    if (!loc) throw new Error("Localização não encontrada na organização.");
    if (!loc.active) throw new Error("Localização inativa.");
    return loc;
  }

  /** Material entra num local (recebimento/entrada técnica). Quantidade > 0. */
  static receive(orgId: string, input: { locationId: string; productId: string; variantId?: string | null; quantity: number }, actorId?: string): { ok: true; balance: number } {
    const qty = round2(input.quantity);
    if (!(qty > 0)) throw new Error("Quantidade deve ser positiva.");
    this.assertLocation(orgId, input.locationId);
    if (!db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ?").get(input.productId, orgId)) throw new Error("Produto não encontrado na organização.");
    const variantId = clean(input.variantId);
    this.applyDelta(orgId, input.locationId, input.productId, variantId, qty);
    try { logAuthEvent(orgId, actorId || "system", input.locationId, "INVENTORY_LOCATION_RECEIVE", { productId: input.productId, quantity: qty }); } catch { /* noop */ }
    return { ok: true, balance: this.balanceOf(orgId, input.locationId, input.productId, variantId) };
  }

  /** Material SAI de um local (retirada para consumo). Débito; valida saldo. */
  static issue(orgId: string, input: { locationId: string; productId: string; variantId?: string | null; quantity: number }, actorId?: string): { ok: true; balance: number } {
    const qty = round2(input.quantity);
    if (!(qty > 0)) throw new Error("Quantidade deve ser positiva.");
    this.assertLocation(orgId, input.locationId);
    const variantId = clean(input.variantId);
    const available = this.balanceOf(orgId, input.locationId, input.productId, variantId);
    if (available < qty) throw new Error(`Saldo insuficiente no local (disponível ${available}, pedido ${qty}).`);
    this.applyDelta(orgId, input.locationId, input.productId, variantId, -qty);
    try { logAuthEvent(orgId, actorId || "system", input.locationId, "INVENTORY_LOCATION_ISSUE", { productId: input.productId, quantity: qty }); } catch { /* noop */ }
    return { ok: true, balance: this.balanceOf(orgId, input.locationId, input.productId, variantId) };
  }

  /** Move quantidade entre dois locais (débito atômico na origem, crédito no destino). */
  static transfer(orgId: string, input: { fromLocationId: string; toLocationId: string; productId: string; variantId?: string | null; quantity: number }, actorId?: string): { ok: true; fromBalance: number; toBalance: number } {
    const qty = round2(input.quantity);
    if (!(qty > 0)) throw new Error("Quantidade deve ser positiva.");
    if (input.fromLocationId === input.toLocationId) throw new Error("Origem e destino devem ser diferentes.");
    this.assertLocation(orgId, input.fromLocationId);
    this.assertLocation(orgId, input.toLocationId);
    const variantId = clean(input.variantId);
    const available = this.balanceOf(orgId, input.fromLocationId, input.productId, variantId);
    if (available < qty) throw new Error(`Saldo insuficiente na origem (disponível ${available}, pedido ${qty}).`);
    const tx = db.transaction(() => {
      this.applyDelta(orgId, input.fromLocationId, input.productId, variantId, -qty);
      this.applyDelta(orgId, input.toLocationId, input.productId, variantId, qty);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", input.fromLocationId, "INVENTORY_LOCATION_TRANSFER", { to: input.toLocationId, productId: input.productId, quantity: qty }); } catch { /* noop */ }
    return { ok: true, fromBalance: this.balanceOf(orgId, input.fromLocationId, input.productId, variantId), toBalance: this.balanceOf(orgId, input.toLocationId, input.productId, variantId) };
  }
}

export default InventoryLocationService;
