import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailOnlineReserveService } from "./RetailOnlineReserveService.js";

/**
 * Retirada na loja (ADR-207 F3) — "retire hoje", SÓ quando dá pra segurar a peça.
 *
 * Regra que manda em tudo (RN-CG: não prometer o que não se consegue entregar):
 *  o ZapFlow NUNCA oferece nem aceita retirada de uma peça sem conseguir RESERVÁ-LA
 *  naquele instante. Por isso a retirada reaproveita o pool de reserva online que o
 *  dono já define por loja/produto (ADR-143 — `retail_online_reserve`) e o mesmo
 *  `recordSale` atômico (sem oversell). Sem pool definido para a peça → disponível 0
 *  → a loja NÃO aparece como opção. Não inventamos saldo a partir do ERP (a qualidade
 *  do estoque Alterdata é do dono, que escolhe quais lojas e quais peças liberar).
 *
 * - Opt-in em 2 níveis: `pickup_enabled` da empresa E da loja (default 0 nos dois),
 *   e depende da reserva online ligada (`online_store_reserve`). Qualquer um faltando
 *   = a vitrine não mostra retirada (0-regressão).
 * - A reserva é feita na MESMA transação que cria o pedido; falhou → o pedido não nasce.
 * - Validade (`pickup_reserve_minutes`): pedido de retirada que não pagou até lá é
 *   cancelado e a reserva volta pro pool. O cancelamento é feito AQUI (não via
 *   `OrdersService.updateStatus`) porque a vitrine nunca reservou em `inventory_items`
 *   — chamar o `release` de lá abateria a reserva de OUTRO pedido. Só solta o que este
 *   serviço realmente reservou (`RetailOnlineReserveService.releaseByOrder`).
 * - Pedido pago nunca expira (a varredura só olha `aguardando_pagamento`).
 */

export interface PickupItem { productId: string; qty: number; }

const trunc = (n: any) => Math.trunc(Number(n) || 0);
const MIN_MINUTES = 15;
const MAX_MINUTES = 1440;
const DEFAULT_MINUTES = 120;

export class StorePickupService {
  // ── Configuração (dono/admin) ────────────────────────────────────────────────
  static settings(orgId: string): { enabled: boolean; reserveEnabled: boolean; offerable: boolean; reserveMinutes: number; readyNotice: boolean } {
    let enabled = false; let minutes = DEFAULT_MINUTES; let readyNotice = false;
    try {
      const r = db.prepare("SELECT pickup_enabled, pickup_reserve_minutes, pickup_ready_notice_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      enabled = !!Number(r?.pickup_enabled);
      readyNotice = !!Number(r?.pickup_ready_notice_enabled);
      const m = trunc(r?.pickup_reserve_minutes);
      if (m >= MIN_MINUTES && m <= MAX_MINUTES) minutes = m;
    } catch { /* coluna ausente → desligado */ }
    const reserveEnabled = RetailOnlineReserveService.isEnabled(orgId);
    return { enabled, reserveEnabled, offerable: enabled && reserveEnabled, reserveMinutes: minutes, readyNotice };
  }

  static setSettings(orgId: string, patch: { enabled?: boolean; reserveMinutes?: number; readyNotice?: boolean }): ReturnType<typeof StorePickupService.settings> {
    if (patch.enabled !== undefined) {
      db.prepare("UPDATE organization_settings SET pickup_enabled = ? WHERE organization_id = ?").run(patch.enabled ? 1 : 0, orgId);
    }
    if (patch.readyNotice !== undefined) {
      db.prepare("UPDATE organization_settings SET pickup_ready_notice_enabled = ?, pickup_ready_notice_enabled_at = CASE WHEN ? = 1 AND COALESCE(pickup_ready_notice_enabled, 0) = 0 THEN CURRENT_TIMESTAMP ELSE pickup_ready_notice_enabled_at END WHERE organization_id = ?").run(patch.readyNotice ? 1 : 0, patch.readyNotice ? 1 : 0, orgId);
      try { logAuthEvent(orgId, "system", orgId, patch.readyNotice ? "PICKUP_READY_NOTICE_ENABLED" : "PICKUP_READY_NOTICE_DISABLED", {}); } catch { /* noop */ }
    }
    if (patch.reserveMinutes !== undefined) {
      const m = trunc(patch.reserveMinutes);
      if (m < MIN_MINUTES || m > MAX_MINUTES) throw new Error(`A validade da reserva deve ficar entre ${MIN_MINUTES} e ${MAX_MINUTES} minutos.`);
      db.prepare("UPDATE organization_settings SET pickup_reserve_minutes = ? WHERE organization_id = ?").run(m, orgId);
    }
    return this.settings(orgId);
  }

  /** Liga/desliga a retirada numa loja da rede. A loja precisa ser da empresa e estar ativa. */
  static setStore(orgId: string, storeId: string, enabled: boolean): { id: string; name: string; pickupEnabled: boolean } {
    const st = db.prepare("SELECT id, name FROM retail_stores WHERE id = ? AND organization_id = ? AND active = 1").get(storeId, orgId) as any;
    if (!st) throw new Error("Loja não encontrada.");
    db.prepare("UPDATE retail_stores SET pickup_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(enabled ? 1 : 0, storeId, orgId);
    try { logAuthEvent(orgId, "system", storeId, enabled ? "STORE_PICKUP_ENABLED" : "STORE_PICKUP_DISABLED", {}); } catch { /* noop */ }
    return { id: st.id, name: st.name, pickupEnabled: enabled };
  }

  /** Lojas ativas da empresa com o estado da retirada (visão do dono). */
  static adminStores(orgId: string): Array<{ id: string; name: string; city: string | null; pickupEnabled: boolean }> {
    const rows = db.prepare("SELECT id, name, city, pickup_enabled FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
    return rows.map((r) => ({ id: r.id, name: r.name, city: r.city || null, pickupEnabled: !!Number(r.pickup_enabled) }));
  }

  // ── Vitrine pública ──────────────────────────────────────────────────────────
  private static pickupStores(orgId: string): any[] {
    return db.prepare("SELECT id, name, city, address FROM retail_stores WHERE organization_id = ? AND active = 1 AND pickup_enabled = 1 ORDER BY name").all(orgId) as any[];
  }

  /**
   * Itens do carrinho no formato reservável. Peso/volume (qtd fracionada) não tem
   * reserva → o carrinho inteiro fica sem retirada (nunca prometer o que não reserva).
   */
  static cartForPickup(orgId: string, rawItems: any[]): { items: PickupItem[]; reason: string | null } {
    const agg = new Map<string, number>();
    for (const it of Array.isArray(rawItems) ? rawItems : []) {
      const p = db.prepare("SELECT id, sale_mode FROM products_services WHERE id = ? AND organization_id = ? AND active = 1").get(it?.productId, orgId) as any;
      if (!p) continue;
      const mode = p.sale_mode || "unit";
      if (mode === "weight" || mode === "volume") return { items: [], reason: "item_sem_retirada" };
      const qty = Math.max(1, trunc(it?.quantity) || 1);
      agg.set(p.id, (agg.get(p.id) || 0) + qty);
    }
    if (!agg.size) return { items: [], reason: "carrinho_vazio" };
    return { items: Array.from(agg, ([productId, qty]) => ({ productId, qty })), reason: null };
  }

  /** Cada loja de retirada x este carrinho: só `canFulfill` quando TODA peça tem reserva disponível. */
  static availability(orgId: string, items: PickupItem[]): Array<{ id: string; name: string; city: string | null; address: string | null; canFulfill: boolean }> {
    if (!this.settings(orgId).offerable) return [];
    this.expireOverdue(orgId);
    return this.pickupStores(orgId).map((s) => ({
      id: s.id, name: s.name, city: s.city || null, address: s.address || null,
      canFulfill: items.length > 0 && items.every((i) => RetailOnlineReserveService.available(orgId, s.id, i.productId, null) >= i.qty),
    }));
  }

  /**
   * Pré-checagem amigável (a garantia real é o `reserveInTx`). Devolve a loja pra mostrar
   * no pedido; nunca aceita loja fora da lista de retirada da empresa.
   */
  static gate(orgId: string, storeId: string, items: PickupItem[]): { ok: true; store: { id: string; name: string } } | { ok: false; reason: string; message: string } {
    if (!this.settings(orgId).offerable) return { ok: false, reason: "retirada_indisponivel", message: "Retirada na loja indisponível no momento." };
    const store = this.pickupStores(orgId).find((s) => s.id === storeId);
    if (!store) return { ok: false, reason: "loja_invalida", message: "Escolha uma loja válida para retirada." };
    if (!items.length) return { ok: false, reason: "item_sem_retirada", message: "Algum item do carrinho não permite retirada na loja." };
    this.expireOverdue(orgId);
    const short = items.filter((i) => RetailOnlineReserveService.available(orgId, storeId, i.productId, null) < i.qty);
    if (short.length) return { ok: false, reason: "sem_estoque_na_loja", message: "Alguma peça não está mais disponível para retirada nesta loja." };
    return { ok: true, store: { id: store.id, name: store.name } };
  }

  /**
   * Reserva as peças do pedido na loja — CHAMAR DENTRO da transação que cria o pedido.
   * Lança `PICKUP_UNAVAILABLE:` se qualquer coisa impedir (o pedido inteiro é desfeito).
   * `skipped`/0 gravado também é falha: sem baixa pendente registrada, não houve reserva.
   */
  static reserveInTx(orgId: string, orderId: string, storeId: string, items: PickupItem[]): void {
    const r = RetailOnlineReserveService.recordSale(orgId, {
      orderId, storeId, items: items.map((i) => ({ productId: i.productId, variantId: null, qty: i.qty })),
    });
    if (r.ok === false) throw new Error("PICKUP_UNAVAILABLE:sem_estoque_na_loja");
    if (r.skipped || r.deduped || !(Number(r.recorded) > 0)) throw new Error("PICKUP_UNAVAILABLE:reserva_nao_registrada");
    const row = db.prepare("SELECT COUNT(*) c FROM retail_online_writeback WHERE organization_id = ? AND order_id = ? AND status = 'pending'").get(orgId, orderId) as any;
    if (!(Number(row?.c) > 0)) throw new Error("PICKUP_UNAVAILABLE:reserva_nao_registrada");
  }

  /** Marca o pedido como retirada e fixa a validade da reserva (mesma transação do pedido). */
  static stampOrder(orgId: string, orderId: string, storeId: string): { reserveMinutes: number } {
    const { reserveMinutes } = this.settings(orgId);
    db.prepare(
      "UPDATE orders SET fulfillment_method = 'pickup', pickup_store_id = ?, reserve_expires_at = datetime('now', ?) WHERE id = ? AND organization_id = ?"
    ).run(storeId, `+${reserveMinutes} minutes`, orderId, orgId);
    return { reserveMinutes };
  }

  // ── Validade da reserva ──────────────────────────────────────────────────────
  /**
   * Cancela pedidos de retirada NÃO pagos cuja reserva venceu e devolve as peças ao pool.
   * Idempotente. Com `orgId` limita a uma empresa (usado antes de cada consulta de
   * disponibilidade, p/ a vitrine nunca mostrar peça presa em reserva vencida).
   */
  static expireOverdue(orgId?: string): { expired: number } {
    const rows = (orgId
      ? db.prepare("SELECT id, organization_id FROM orders WHERE fulfillment_method = 'pickup' AND status = 'aguardando_pagamento' AND reserve_expires_at IS NOT NULL AND reserve_expires_at <= datetime('now') AND organization_id = ?").all(orgId)
      : db.prepare("SELECT id, organization_id FROM orders WHERE fulfillment_method = 'pickup' AND status = 'aguardando_pagamento' AND reserve_expires_at IS NOT NULL AND reserve_expires_at <= datetime('now')").all()) as any[];
    let expired = 0;
    for (const o of rows) {
      try {
        const done = db.transaction(() => {
          const upd = db.prepare(
            "UPDATE orders SET status = 'cancelado', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status = 'aguardando_pagamento' AND fulfillment_method = 'pickup'"
          ).run(o.id, o.organization_id);
          if (upd.changes === 0) return false; // pagou/mudou no meio: não mexe
          RetailOnlineReserveService.releaseByOrder(o.organization_id, o.id);
          return true;
        })();
        if (done) {
          expired++;
          try { logAuthEvent(o.organization_id, "system", o.id, "STORE_PICKUP_RESERVE_EXPIRED", {}); } catch { /* noop */ }
        }
      } catch { /* um pedido com problema não trava os outros */ }
    }
    return { expired };
  }

  /** Passe do Scheduler: libera reservas vencidas de todas as empresas. */
  static pass(): { expired: number } {
    try { return this.expireOverdue(); } catch { return { expired: 0 }; }
  }
}

export default StorePickupService;
