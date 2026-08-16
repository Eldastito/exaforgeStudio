/**
 * RetailFloorReplenishmentService — reposição na ruptura (PRD Moda/TOULON; ADR-176).
 *
 * Quando o cliente pede uma peça que NÃO tem na loja mas EXISTE na rede (ruptura
 * RECUPERÁVEL), o vendedor dispara, num toque, um pedido de TRANSFERÊNCIA da loja
 * doadora. Hoje o scan já mostra as lojas que têm a peça (RetailFloorScanService),
 * mas o "pedir" só aparecia no dia seguinte como agregado (network_recovery). Aqui
 * o pedido é IMEDIATO e ACIONÁVEL: publica um business_signal (ADR-136, dedupe —
 * NUNCA tabela de alerta paralela, convenção nº 12) apontando loja doadora × peça,
 * pra operação/loja separar e enviar.
 *
 * Guardrails:
 *  - RN-176-001 (tenant/escopo): orgId 1º arg; só o próprio vendedor ou gestor da
 *    loja (herda a autorização do atendimento, RN-150-005).
 *  - RN-176-002 (recuperável): só transfere o que a rede TEM agora (recalcula
 *    estoque fresco). Sem doador com saldo → NÃO inventa transferência; vira
 *    demanda de compra (já coberta por unmet_demand → Comprador IA).
 *  - RN-176-003 (fato + evidência): o sinal é FATO calculado (loja doadora, saldo)
 *    com a evidência junto — não promete venda (basis fact do PEDIDO, não do
 *    resultado). PUBLICADO ≠ REPOSTO.
 *  - RN-176-004 (idempotência): dedupe por (atendimento, scan, loja doadora) —
 *    tocar duas vezes atualiza o mesmo sinal, não cria dois.
 *  - RN-176-005 (sem peça, sem pedido): scan de EAN fora do mix (sem product_id)
 *    não vira transferência (a ação é de sortimento, não reposição).
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { RetailFloorService } from "./RetailFloorService.js";
import { RetailFloorQueueService } from "./RetailFloorShiftService.js";

type UserRef = { userId?: string; id?: string; role?: string };
const uid = (u: UserRef) => u?.userId || u?.id || null;

export class RetailFloorReplenishmentService {
  /**
   * Dispara o pedido de transferência da peça consultada num scan do atendimento.
   * `targetStoreId` opcional — se omitido, escolhe a loja doadora com MAIOR saldo.
   */
  static request(orgId: string, attendanceId: string, opts: { scanId: string; targetStoreId?: string | null }, user: UserRef): any {
    const att = db.prepare(`SELECT * FROM retail_floor_attendances WHERE organization_id = ? AND id = ?`).get(orgId, attendanceId) as any;
    if (!att) throw new Error("Atendimento não encontrado.");
    if (att.ended_at) throw new Error("Atendimento já encerrado — reposição só em atendimento ativo.");
    const self = RetailFloorQueueService.sellerForUser(orgId, uid(user));
    const isSelf = !!self && self.id === att.seller_id;
    if (!isSelf) RetailFloorService.assertStoreManager(orgId, user, att.store_id);

    const scan = db.prepare(`SELECT * FROM retail_floor_attendance_scans WHERE organization_id = ? AND id = ? AND attendance_id = ?`).get(orgId, String(opts.scanId || ""), attendanceId) as any;
    if (!scan) throw new Error("scanId não pertence a este atendimento.");
    if (!scan.product_id) throw new Error("Peça fora do mix — não há o que transferir (é caso de sortimento, não reposição).");

    // Re-resolve a variante (grade) a partir do EAN — o scan guarda o produto,
    // não a variante — pra calcular o saldo doador exato (variante > produto).
    const variantId = this.variantIdForEan(orgId, scan.ean);

    // Doadores FRESCOS: saldo POSITIVO das outras lojas agora (RN-176-002).
    const donors = this.donors(orgId, att.store_id, scan.product_id, variantId);
    if (!donors.length) throw new Error("Sem estoque na rede para transferir — vira demanda de compra.");

    let target = donors[0];
    if (opts.targetStoreId) {
      const chosen = donors.find((d) => d.storeId === opts.targetStoreId);
      if (!chosen) throw new Error("Loja escolhida não tem saldo desta peça na rede.");
      target = chosen;
    }

    // Marca o scan como transfer_requested → alimenta o agregado diário
    // network_recovery (RN-150) e reflete a intenção (idempotente).
    db.prepare(`UPDATE retail_floor_attendance_scans SET action = 'transfer_requested' WHERE organization_id = ? AND id = ?`).run(orgId, scan.id);

    const fromStore = db.prepare(`SELECT name, code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, att.store_id) as any;
    const published = BusinessSignalService.publish(orgId, {
      domain: "retail_floor", signalType: "retail_floor_replenishment_request",
      severity: "attention", basis: "fact", confidence: 0.9,
      impactAmount: target.quantity, impactUnit: "peças",
      sourceService: "RetailFloorReplenishmentService", sourceEntityType: "store", sourceEntityId: target.storeId,
      evidence: {
        product: scan.product_name || scan.ean, ean: scan.ean,
        requestedByStore: fromStore?.name || att.store_id,
        fromStore: target.storeName, fromStoreQuantity: target.quantity,
        alternatives: donors.slice(0, 5).map((d) => ({ store: d.storeName, quantity: d.quantity })),
        note: "cliente pediu peça sem estoque local, disponível na rede — pedido de transferência (PUBLICADO ≠ REPOSTO)",
      },
      // Idempotente por (atendimento, scan, loja doadora).
      dedupeKey: `retail_floor.replenishment_request|${attendanceId}|${scan.id}|${target.storeId}`,
    });
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_REPLENISHMENT_REQUEST", { attendanceId, scanId: scan.id, productId: scan.product_id, targetStoreId: target.storeId, quantity: target.quantity, signalId: published.id }); } catch { /* noop */ }

    return {
      signalId: published.id, deduped: published.deduped,
      product: scan.product_name || scan.ean,
      target: { storeId: target.storeId, storeName: target.storeName, quantity: target.quantity },
      alternatives: donors.map((d) => ({ storeId: d.storeId, storeName: d.storeName, quantity: d.quantity })),
    };
  }

  /** external_ref (EAN) → variant_id, quando a peça é de grade; senão null. */
  private static variantIdForEan(orgId: string, ean: string | null): string | null {
    if (!ean) return null;
    const v = db.prepare(`SELECT id FROM product_variants WHERE organization_id = ? AND external_ref = ? AND active = 1 LIMIT 1`).get(orgId, ean) as any;
    return v?.id || null;
  }

  /**
   * Lojas doadoras: saldo POSITIVO das OUTRAS lojas (negativo é detecção da
   * sombra, não peça vendável). Mesma regra da rede no scan (RetailFloorScanService).
   */
  private static donors(orgId: string, excludeStoreId: string, productId: string, variantId: string | null): Array<{ storeId: string; storeName: string; code: string | null; quantity: number }> {
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
    return rows.map((r) => ({ storeId: r.store_id, storeName: r.store_name, code: r.code || null, quantity: Number(r.q) }));
  }
}

export default RetailFloorReplenishmentService;
