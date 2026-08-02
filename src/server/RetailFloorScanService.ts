/**
 * Retail Floor — Scan no atendimento + demanda não atendida (ADR-150, Fatia 5).
 *
 * O leitor do PRD original vira parte do ATENDIMENTO ATIVO: cada bipagem fica
 * ligada ao attendance (timeline do que o cliente procurou) e CONGELA o que
 * foi visto no momento — estoque local, estoque da rede e o carimbo da última
 * sincronização (RN-150-007) — o histórico não muda quando o estoque muda.
 *
 * Lookup em 2 níveis (modelo Alterdata/ADR-105):
 *  1. variante por product_variants.external_ref = EAN (grade cor×tamanho);
 *  2. produto por products_services.ean (EAN do produto, sem grade).
 *
 * Estoque: a SOMBRA por loja (retail_store_inventory, ADR-084) é a fonte —
 * local = saldo da loja do atendimento; rede = soma dos saldos POSITIVOS das
 * demais lojas (saldo negativo é detecção, não peça vendável) + lista das
 * lojas que têm a peça (base de reserva/transferência).
 *
 * Demanda não atendida (RN-150-009): SEMPRE nasce de um scan registrado —
 *  - EAN fora do catálogo → `no_assortment` (a loja não trabalha);
 *  - sem local E sem rede → `no_network_stock`;
 *  - sem local mas COM rede → NÃO é demanda (dá pra recuperar via
 *    transferência; a resposta sugere as lojas);
 *  - faltou tamanho/cor/categoria é INPUT do vendedor (o cliente pediu o que
 *    não dá pra bipar) → registerUnmet exige o scanId da peça consultada como
 *    evidência. Dedupe por (attendance, ean|produto, reason) — bipar 3x não
 *    vira 3 demandas.
 *
 * RN-150-001: orgId sempre 1º arg; tudo filtra organization_id.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { sanitizeGtin } from "./eanUtil.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailFloorService, PRODUCT_REASONS } from "./RetailFloorService.js";
import { RetailFloorQueueService } from "./RetailFloorShiftService.js";

const SCAN_ACTIONS = ["viewed", "reserved", "transfer_requested", "sold"];
// Motivos de demanda que exigem input humano (variante desejada não bipável).
const MANUAL_UNMET_REASONS = ["missing_size", "missing_color", "missing_category"];
const SYNC_STALE_HOURS = 24; // RN-150-007: acima disso a UI marca "desatualizado"

type UserRef = { userId?: string; id?: string; role?: string };
const uid = (u: UserRef) => u?.userId || u?.id || null;

export class RetailFloorScanService {
  /**
   * Bipa um EAN dentro do atendimento ATIVO: resolve produto/variante,
   * congela estoque local/rede + carimbo de sync, grava o scan e — quando a
   * ruptura é detectável pela máquina — registra a demanda não atendida.
   */
  static scan(orgId: string, attendanceId: string, rawEan: string, opts: { action?: string | null } = {}, user: UserRef): any {
    const att = this.assertActiveAttendance(orgId, attendanceId, user);
    const action = opts.action == null ? "viewed" : String(opts.action);
    if (!SCAN_ACTIONS.includes(action)) throw new Error(`action inválida (${SCAN_ACTIONS.join("|")}).`);

    const ean = sanitizeGtin(rawEan);
    if (!ean) throw new Error("Código de barras inválido.");

    // Lookup: variante (grade) primeiro, produto depois.
    let product: any = null, variant: any = null;
    const v = db.prepare(
      `SELECT v.id, v.product_service_id, v.name, v.size, v.color, p.name AS product_name, p.price AS product_price, v.price AS variant_price
         FROM product_variants v JOIN products_services p ON p.id = v.product_service_id AND p.organization_id = v.organization_id
        WHERE v.organization_id = ? AND v.external_ref = ? AND v.active = 1 LIMIT 1`
    ).get(orgId, ean) as any;
    if (v) {
      variant = { id: v.id, name: v.name, size: v.size || null, color: v.color || null };
      product = { id: v.product_service_id, name: v.product_name, price: Number(v.variant_price ?? v.product_price ?? 0) };
    } else {
      const p = db.prepare(`SELECT id, name, price FROM products_services WHERE organization_id = ? AND ean = ? LIMIT 1`).get(orgId, ean) as any;
      if (p) product = { id: p.id, name: p.name, price: Number(p.price || 0) };
    }

    const syncedAt = this.lastSyncAt(orgId);
    const syncStale = syncedAt ? (Date.now() - new Date(syncedAt.replace(" ", "T") + "Z").getTime()) > SYNC_STALE_HOURS * 3600_000 : true;

    let localStock: number | null = null, networkStock: number | null = null, otherStores: any[] = [];
    if (product) {
      localStock = this.stockAt(orgId, att.store_id, product.id, variant?.id || null);
      const net = this.networkStock(orgId, att.store_id, product.id, variant?.id || null);
      networkStock = net.total;
      otherStores = net.stores;
    }

    const scanId = randomUUID();
    db.prepare(
      `INSERT INTO retail_floor_attendance_scans (id, organization_id, attendance_id, ean, product_id, product_name, local_stock, network_stock, stock_synced_at, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(scanId, orgId, attendanceId, ean, product?.id || null, product?.name || null, localStock, networkStock, syncedAt, action);

    // Ruptura detectável pela máquina → demanda não atendida (com dedupe).
    let unmetDemand: any = null;
    if (!product) {
      unmetDemand = this.upsertUnmet(orgId, att, scanId, null, ean, "no_assortment", null);
    } else if ((localStock ?? 0) <= 0 && (networkStock ?? 0) <= 0) {
      unmetDemand = this.upsertUnmet(orgId, att, scanId, product.id, ean, "no_network_stock", null);
    }

    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_SCAN", { attendanceId, scanId, ean, found: !!product, action, localStock, networkStock, unmet: unmetDemand?.reason || null }); } catch { /* noop */ }
    return {
      scanId, ean, found: !!product,
      product, variant,
      localStock, networkStock, otherStores,
      syncedAt, syncStale,
      unmetDemand,
    };
  }

  /**
   * Demanda não atendida por INPUT do vendedor (faltou tamanho/cor/categoria —
   * o que o cliente pediu não dá pra bipar). Exige o scanId da peça consultada
   * NESTE atendimento como evidência (RN-150-009).
   */
  static registerUnmet(orgId: string, attendanceId: string, opts: { scanId: string; reason: string; size?: string | null; color?: string | null; categoryLabel?: string | null }, user: UserRef): any {
    const att = this.assertActiveAttendance(orgId, attendanceId, user);
    const reason = String(opts.reason || "");
    if (!MANUAL_UNMET_REASONS.includes(reason)) throw new Error(`reason inválida (${MANUAL_UNMET_REASONS.join("|")}); as demais a máquina detecta no scan.`);
    const scan = db.prepare(`SELECT * FROM retail_floor_attendance_scans WHERE organization_id = ? AND id = ? AND attendance_id = ?`).get(orgId, String(opts.scanId || ""), attendanceId) as any;
    if (!scan) throw new Error("scanId não pertence a este atendimento (a demanda exige a evidência da consulta).");
    const detail: any = {};
    if (opts.size) detail.size = String(opts.size).slice(0, 40);
    if (opts.color) detail.color = String(opts.color).slice(0, 40);
    if (opts.categoryLabel) detail.categoryLabel = String(opts.categoryLabel).slice(0, 80);
    if (!Object.keys(detail).length) throw new Error("Informe o que faltou (size/color/categoryLabel).");
    const row = this.upsertUnmet(orgId, att, scan.id, scan.product_id, scan.ean, reason, detail);
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_UNMET_DEMAND", { attendanceId, scanId: scan.id, reason, detail }); } catch { /* noop */ }
    return row;
  }

  /** Timeline de consultas do atendimento (o que o cliente procurou). */
  static scans(orgId: string, attendanceId: string): any[] {
    const rows = db.prepare(
      `SELECT * FROM retail_floor_attendance_scans WHERE organization_id = ? AND attendance_id = ? ORDER BY created_at, rowid`
    ).all(orgId, attendanceId) as any[];
    return rows.map((r) => ({
      id: r.id, ean: r.ean, productId: r.product_id || null, productName: r.product_name || null,
      localStock: r.local_stock != null ? Number(r.local_stock) : null,
      networkStock: r.network_stock != null ? Number(r.network_stock) : null,
      syncedAt: r.stock_synced_at || null, action: r.action, createdAt: r.created_at,
    }));
  }

  // ---- internos ----

  /** Atendimento ativo + autorização (o próprio vendedor ou gestor da loja). */
  private static assertActiveAttendance(orgId: string, attendanceId: string, user: UserRef): any {
    const att = db.prepare(`SELECT * FROM retail_floor_attendances WHERE organization_id = ? AND id = ?`).get(orgId, attendanceId) as any;
    if (!att) throw new Error("Atendimento não encontrado.");
    if (att.ended_at) throw new Error("Atendimento já encerrado — scan só em atendimento ativo.");
    const self = RetailFloorQueueService.sellerForUser(orgId, uid(user));
    const isSelf = !!self && self.id === att.seller_id;
    if (!isSelf) RetailFloorService.assertStoreManager(orgId, user, att.store_id);
    return att;
  }

  /** Saldo da loja: linha da variante quando há; senão soma das linhas do produto. */
  private static stockAt(orgId: string, storeId: string, productId: string, variantId: string | null): number {
    if (variantId) {
      const r = db.prepare(`SELECT quantity_available AS q FROM retail_store_inventory WHERE organization_id = ? AND store_id = ? AND product_service_id = ? AND variant_id = ?`).get(orgId, storeId, productId, variantId) as any;
      return Number(r?.q || 0);
    }
    const r = db.prepare(`SELECT COALESCE(SUM(quantity_available), 0) AS q FROM retail_store_inventory WHERE organization_id = ? AND store_id = ? AND product_service_id = ?`).get(orgId, storeId, productId) as any;
    return Number(r?.q || 0);
  }

  /**
   * Rede = soma dos saldos POSITIVOS das outras lojas (negativo é detecção da
   * sombra, não peça vendável) + lista das lojas com peça (reserva/transferência).
   */
  private static networkStock(orgId: string, excludeStoreId: string, productId: string, variantId: string | null): { total: number; stores: any[] } {
    const variantFilter = variantId ? "AND i.variant_id = ?" : "";
    const params: any[] = variantId ? [orgId, excludeStoreId, productId, variantId] : [orgId, excludeStoreId, productId];
    const rows = db.prepare(
      `SELECT i.store_id, s.name AS store_name, s.code, SUM(i.quantity_available) AS q
         FROM retail_store_inventory i
         JOIN retail_stores s ON s.organization_id = i.organization_id AND s.id = i.store_id AND s.active = 1
        WHERE i.organization_id = ? AND i.store_id != ? AND i.product_service_id = ? ${variantFilter}
        GROUP BY i.store_id HAVING SUM(i.quantity_available) > 0
        ORDER BY q DESC`
    ).all(...params) as any[];
    const stores = rows.map((r) => ({ storeId: r.store_id, storeName: r.store_name, code: r.code || null, quantity: Number(r.q) }));
    return { total: stores.reduce((acc, s) => acc + s.quantity, 0), stores };
  }

  /** Carimbo da última sincronização de estoque da org (RN-150-007). */
  private static lastSyncAt(orgId: string): string | null {
    const c = db.prepare(`SELECT MAX(last_synced_at) AS t FROM alterdata_sync_cursors WHERE organization_id = ?`).get(orgId) as any;
    if (c?.t) return c.t;
    // Sem conector (org nativa): o próprio updated_at da sombra é o carimbo.
    const i = db.prepare(`SELECT MAX(updated_at) AS t FROM retail_store_inventory WHERE organization_id = ?`).get(orgId) as any;
    return i?.t || null;
  }

  /** Cria a demanda com dedupe por (attendance, ean|produto, reason). */
  private static upsertUnmet(orgId: string, att: any, scanId: string, productId: string | null, ean: string | null, reason: string, detail: any | null): any {
    if (!(PRODUCT_REASONS as readonly string[]).includes(reason)) throw new Error("reason fora da taxonomia.");
    const existing = db.prepare(
      `SELECT * FROM retail_floor_unmet_demand WHERE organization_id = ? AND attendance_id = ? AND reason = ? AND COALESCE(product_id, '') = COALESCE(?, '') AND COALESCE(ean, '') = COALESCE(?, '')`
    ).get(orgId, att.id, reason, productId, ean) as any;
    if (existing) return this.shapeUnmet(existing, true);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_floor_unmet_demand (id, organization_id, store_id, attendance_id, scan_id, product_id, ean, reason, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, att.store_id, att.id, scanId, productId, ean, reason, detail ? JSON.stringify(detail) : null);
    const row = db.prepare(`SELECT * FROM retail_floor_unmet_demand WHERE id = ?`).get(id) as any;
    return this.shapeUnmet(row, false);
  }

  private static shapeUnmet(row: any, deduped: boolean) {
    return {
      id: row.id, storeId: row.store_id, attendanceId: row.attendance_id, scanId: row.scan_id || null,
      productId: row.product_id || null, ean: row.ean || null, reason: row.reason,
      detail: row.detail_json ? JSON.parse(row.detail_json) : null, deduped,
    };
  }
}

export default RetailFloorScanService;
