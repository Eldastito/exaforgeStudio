import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * OperationalItemService — CONTROLER (PRD-E-007, Fatia 1c).
 *
 * Classificação OPERACIONAL do item (§7): dá FINALIDADE ao item (revenda,
 * consumo, MRO, EPI, serviço…), separa unidade de COMPRA da de CONSUMO com
 * conversão de embalagem, e amarra vínculos-padrão às dimensões do CONTROLER
 * (centro de custo e localização). Aditivo e opt-in — itens existentes nascem
 * 'resale' com consumo desligado (§30.2). Determinístico, auditável, isolado.
 */

const ITEM_TYPES = [
  "resale", "raw_material", "packaging", "consumable", "office_supply", "cleaning_supply",
  "mro", "ppe", "spare_part", "fuel", "asset_low_value", "service", "utility", "subscription", "other_operational",
];
const CRITICALITY = ["baixa", "normal", "alta", "critica"];
const clean = (s: any) => (s == null ? null : String(s).trim() || null);
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

// Campos da classificação expostos (o resto do produto fica no CatalogService).
const FIELDS = `id, name, operational_item_type, consumption_control_enabled, default_uom, purchase_uom,
  conversion_factor, default_cost_center_id, default_location_id, criticality,
  requires_request, requires_return, requires_recipient_ack`;

export interface ClassificationInput {
  operationalItemType?: string;
  consumptionControlEnabled?: boolean;
  defaultUom?: string | null;
  purchaseUom?: string | null;
  conversionFactor?: number;
  defaultCostCenterId?: string | null;
  defaultLocationId?: string | null;
  criticality?: string;
  requiresRequest?: boolean;
  requiresReturn?: boolean;
  requiresRecipientAck?: boolean;
}

export class OperationalItemService {
  static readonly ITEM_TYPES = ITEM_TYPES;

  static get(orgId: string, productId: string): any {
    return db.prepare(`SELECT ${FIELDS} FROM products_services WHERE id = ? AND organization_id = ?`).get(productId, orgId) || null;
  }

  static list(orgId: string, opts: { type?: string; consumptionControlled?: boolean } = {}): any[] {
    let sql = `SELECT ${FIELDS} FROM products_services WHERE organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.type) { sql += " AND operational_item_type = ?"; params.push(opts.type); }
    if (opts.consumptionControlled != null) { sql += " AND consumption_control_enabled = ?"; params.push(opts.consumptionControlled ? 1 : 0); }
    sql += " ORDER BY name";
    return db.prepare(sql).all(...params) as any[];
  }

  /** Define/atualiza a classificação operacional de um item (merge sobre o atual). */
  static classify(orgId: string, productId: string, input: ClassificationInput, actorId?: string): any {
    const cur = db.prepare("SELECT * FROM products_services WHERE id = ? AND organization_id = ?").get(productId, orgId) as any;
    if (!cur) throw new Error("Produto não encontrado na organização.");

    const itemType = input.operationalItemType != null ? String(input.operationalItemType) : cur.operational_item_type || "resale";
    if (!ITEM_TYPES.includes(itemType)) throw new Error(`Tipo operacional inválido. Use um de: ${ITEM_TYPES.join(", ")}.`);

    const criticality = input.criticality != null ? String(input.criticality) : cur.criticality || "normal";
    if (!CRITICALITY.includes(criticality)) throw new Error(`Criticidade inválida. Use: ${CRITICALITY.join(", ")}.`);

    const conversion = input.conversionFactor != null ? round4(input.conversionFactor) : (cur.conversion_factor != null ? Number(cur.conversion_factor) : 1);
    if (!(conversion > 0)) throw new Error("Fator de conversão deve ser maior que zero.");

    const costCenterId = input.defaultCostCenterId !== undefined ? clean(input.defaultCostCenterId) : cur.default_cost_center_id;
    if (costCenterId && !db.prepare("SELECT id FROM cost_centers WHERE id = ? AND organization_id = ?").get(costCenterId, orgId)) throw new Error("Centro de custo não encontrado na organização.");
    const locationId = input.defaultLocationId !== undefined ? clean(input.defaultLocationId) : cur.default_location_id;
    if (locationId && !db.prepare("SELECT id FROM inventory_locations WHERE id = ? AND organization_id = ?").get(locationId, orgId)) throw new Error("Localização não encontrada na organização.");

    const bit = (v: any, prev: any) => v == null ? (prev ? 1 : 0) : (v ? 1 : 0);
    const consumption = bit(input.consumptionControlEnabled, cur.consumption_control_enabled);
    // Serviço/assinatura/utilidade não têm saldo físico → consumo controlado não se aplica.
    const noStock = ["service", "utility", "subscription"].includes(itemType);
    const consumptionFinal = noStock ? 0 : consumption;

    db.prepare(`UPDATE products_services SET
        operational_item_type = ?, consumption_control_enabled = ?, default_uom = ?, purchase_uom = ?,
        conversion_factor = ?, default_cost_center_id = ?, default_location_id = ?, criticality = ?,
        requires_request = ?, requires_return = ?, requires_recipient_ack = ?
      WHERE id = ? AND organization_id = ?`).run(
      itemType, consumptionFinal,
      input.defaultUom !== undefined ? clean(input.defaultUom) : cur.default_uom,
      input.purchaseUom !== undefined ? clean(input.purchaseUom) : cur.purchase_uom,
      conversion, costCenterId, locationId, criticality,
      bit(input.requiresRequest, cur.requires_request), bit(input.requiresReturn, cur.requires_return), bit(input.requiresRecipientAck, cur.requires_recipient_ack),
      productId, orgId,
    );
    try { logAuthEvent(orgId, actorId || "system", productId, "ITEM_CLASSIFY", { itemType, consumption: consumptionFinal }); } catch { /* noop */ }
    return this.get(orgId, productId);
  }

  /** Converte uma quantidade da unidade de COMPRA para a de CONSUMO (× fator). */
  static purchaseToConsumption(orgId: string, productId: string, purchaseQty: number): number {
    const it = this.get(orgId, productId);
    if (!it) throw new Error("Produto não encontrado na organização.");
    const factor = Number(it.conversion_factor) || 1;
    return round4(Number(purchaseQty) * factor);
  }

  /** Converte da unidade de CONSUMO para a de COMPRA (÷ fator). */
  static consumptionToPurchase(orgId: string, productId: string, consumptionQty: number): number {
    const it = this.get(orgId, productId);
    if (!it) throw new Error("Produto não encontrado na organização.");
    const factor = Number(it.conversion_factor) || 1;
    return round4(Number(consumptionQty) / factor);
  }
}

export default OperationalItemService;
