import db from "./db.js";
import { randomUUID } from "crypto";
import { ComigoPricingService } from "./ComigoPricingService.js";

/**
 * ZappFlow Comigo — Balcão PDV (ADR-111 D4) + fiado com limite e lista negra
 * (ADR-112 / ADR-113).
 *
 * O Balcão é a superfície do OPERADOR: abre pedido, adiciona itens (por toque),
 * cobra (Pix "recebi" / dinheiro / fiado). O fiado é decisão do operador — NUNCA
 * do autoatendimento (o pay-first do Mesa/QR fica intacto).
 *
 * Regras de fiado:
 * - exige cliente identificado (nome + telefone → cria contato na hora);
 * - limite por cliente: se a venda estoura, AVISA e o dono libera (override),
 *   registrando `over_limit` (ADR-112 D2);
 * - lista negra: bloqueia o fiado (linha dura, sem override); `block_all_sales`
 *   suspende até a venda à vista (ADR-113 D2);
 * - fiado é "a receber", não caixa (ADR-112 D3): vira dívida no razão do fiado,
 *   não entra como pagamento recebido.
 *
 * Tudo isolado por organization_id.
 */

export type PayVia = "cash" | "pix_manual" | "fiado";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class BalcaoService {
  // ── Cliente do fiado (reusa contacts via canal sintético "Balcão") ──────────
  static ensureFiadoContact(orgId: string, name: string, phone: string): string {
    let channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider = 'balcao'`).get(orgId) as any;
    if (!channel) {
      const chId = randomUUID();
      db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'balcao', 'Balcão', 'balcao', 'connected')`)
        .run(chId, orgId);
      channel = { id: chId };
    }
    const identifier = String(phone || "").trim() || String(name || "").trim();
    const existing = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?`).get(orgId, channel.id, identifier) as any;
    if (existing) return existing.id;
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channel.id, String(name || "").trim() || "Cliente", identifier);
    return contactId;
  }

  // ── Ficha de crédito + saldo do fiado ───────────────────────────────────────
  static creditProfile(orgId: string, contactId: string) {
    const row = db.prepare("SELECT * FROM comigo_customer_credit WHERE organization_id = ? AND contact_id = ?").get(orgId, contactId) as any;
    if (row) return row;
    const def = db.prepare("SELECT comigo_fiado_default_limit FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return { organization_id: orgId, contact_id: contactId, credit_limit: Number(def?.comigo_fiado_default_limit) || 0, blacklisted: 0, block_all_sales: 0 };
  }

  static balanceOf(orgId: string, contactId: string): number {
    const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind = 'debt'").get(orgId, contactId) as any).s;
    const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind = 'payment'").get(orgId, contactId) as any).s;
    return round2(debt - paid);
  }

  /**
   * Avalia se uma venda no fiado de `amount` pode fechar. Retorna a decisão para
   * o Balcão mostrar o aviso certo (sem decidir sozinho — o dono libera).
   */
  static checkFiado(orgId: string, contactId: string, amount: number) {
    const c = this.creditProfile(orgId, contactId);
    const balance = this.balanceOf(orgId, contactId);
    const projected = round2(balance + (Number(amount) || 0));
    const limit = Number(c.credit_limit) || 0;
    if (c.blacklisted) return { blocked: true, reason: "blacklist", balance, limit, projected, overLimit: false };
    const overLimit = limit > 0 ? projected > limit : false;
    return { blocked: false, reason: overLimit ? "over_limit" : null, balance, limit, projected, overLimit };
  }

  // ── Ciclo do pedido ─────────────────────────────────────────────────────────
  static openOrder(orgId: string, opts: { sessionAlias?: string; contactId?: string; consumo?: string } = {}): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO comigo_orders (id, organization_id, contact_id, session_alias, status, consumo, total) VALUES (?, ?, ?, ?, 'open', ?, 0)`)
      .run(id, orgId, opts.contactId || null, opts.sessionAlias || null, opts.consumo === "viagem" ? "viagem" : "local");
    return id;
  }

  /** Custo unitário do item: usa a ficha de preço (se o produto tiver uma) ou o valor informado. */
  private static costFor(orgId: string, productId?: string | null, fallback = 0): number {
    if (!productId) return round2(fallback);
    const recipe = db.prepare("SELECT id FROM comigo_recipes WHERE organization_id = ? AND product_id = ?").get(orgId, productId) as any;
    if (recipe) {
      const c = ComigoPricingService.computeForRecipe(orgId, recipe.id);
      if (c) return c.breakdown.unitCost;
    }
    return round2(fallback);
  }

  static addItem(orgId: string, orderId: string, item: { productId?: string; name: string; qty?: number; unitPrice: number; unitCostSnapshot?: number }) {
    const order = db.prepare("SELECT id, status FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, orderId) as any;
    if (!order) throw new Error("order_not_found");
    if (order.status !== "open") throw new Error("order_not_open");
    const qty = Number(item.qty) || 1;
    const unitPrice = round2(item.unitPrice);
    const unitCost = this.costFor(orgId, item.productId, item.unitCostSnapshot || 0);
    const itemId = randomUUID();
    db.prepare(`INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(itemId, orderId, item.productId || null, String(item.name).trim(), qty, unitPrice, unitCost);
    this.recomputeTotal(orderId);
    return itemId;
  }

  private static recomputeTotal(orderId: string) {
    const total = (db.prepare("SELECT COALESCE(SUM(qty * unit_price),0) t FROM comigo_order_items WHERE order_id = ?").get(orderId) as any).t;
    db.prepare("UPDATE comigo_orders SET total = ? WHERE id = ?").run(round2(total), orderId);
  }

  /**
   * Cobra o pedido. `override` libera fiado acima do limite OU venda a cliente
   * com `block_all_sales`. Fiado exige contato (via contactId no pedido ou nos
   * dados do cliente). Retorna a decisão; quando precisa de aviso, devolve
   * `{ needsOverride, reason, ... }` sem fechar — o Balcão confirma e repete.
   */
  static pay(orgId: string, orderId: string, opts: { paidVia: PayVia; customer?: { name: string; phone: string }; override?: boolean; actorId?: string }) {
    const order = db.prepare("SELECT * FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, orderId) as any;
    if (!order) throw new Error("order_not_found");
    if (order.status !== "open") throw new Error("order_not_open");
    const amount = round2(order.total);

    // Resolve o contato quando há um (obrigatório no fiado).
    let contactId: string | null = order.contact_id || null;
    if (opts.paidVia === "fiado" && !contactId) {
      if (!opts.customer?.name && !opts.customer?.phone) return { ok: false, error: "fiado_requires_customer" };
      contactId = this.ensureFiadoContact(orgId, opts.customer!.name, opts.customer!.phone);
      db.prepare("UPDATE comigo_orders SET contact_id = ? WHERE id = ?").run(contactId, orderId);
    }

    // Suspensão total (lista negra com block_all_sales) — vale p/ qualquer forma.
    if (contactId) {
      const c = this.creditProfile(orgId, contactId);
      if (c.blacklisted && c.block_all_sales && !opts.override) {
        return { ok: false, needsOverride: true, reason: "blocked_all", message: "Cliente na lista negra — venda suspensa." };
      }
    }

    if (opts.paidVia === "fiado") {
      const chk = this.checkFiado(orgId, contactId!, amount);
      if (chk.blocked) return { ok: false, error: "blacklisted", message: "Cliente na lista negra — fiado suspenso.", ...chk };
      if (chk.overLimit && !opts.override) {
        return { ok: false, needsOverride: true, reason: "over_limit", message: `Já deve R$ ${chk.balance.toFixed(2)} (limite R$ ${chk.limit.toFixed(2)}). Essa venda leva a R$ ${chk.projected.toFixed(2)}.`, ...chk };
      }
      const over = chk.overLimit ? 1 : 0;
      db.prepare(`INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, order_id, kind, amount, over_limit, created_by) VALUES (?, ?, ?, ?, 'debt', ?, ?, ?)`)
        .run(randomUUID(), orgId, contactId, orderId, amount, over, opts.actorId || null);
      // Fiado = pedido entregue mas a RECEBER: fecha o pedido, não é caixa.
      db.prepare("UPDATE comigo_orders SET status = 'done', paid_via = 'fiado', over_limit = ? WHERE id = ?").run(over, orderId);
      return { ok: true, paidVia: "fiado", receivable: true, overLimit: !!over, contactId };
    }

    // À vista (dinheiro / Pix "recebi") = caixa recebido.
    db.prepare("UPDATE comigo_orders SET status = 'paid', paid_via = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(opts.paidVia === "cash" ? "cash" : "pix_manual", orderId);
    return { ok: true, paidVia: opts.paidVia, receivable: false };
  }

  /** Recebimento do fiado (total ou parcial) — abate o saldo do cliente. */
  static settleFiado(orgId: string, contactId: string, amount: number, note?: string, actorId?: string) {
    const amt = round2(amount);
    if (!(amt > 0)) throw new Error("invalid_amount");
    db.prepare(`INSERT INTO comigo_fiado_ledger (id, organization_id, contact_id, kind, amount, note, created_by) VALUES (?, ?, ?, 'payment', ?, ?, ?)`)
      .run(randomUUID(), orgId, contactId, amt, note || null, actorId || null);
    return { balance: this.balanceOf(orgId, contactId) };
  }

  // ── Lista negra / limite (ADR-113) ──────────────────────────────────────────
  private static upsertCredit(orgId: string, contactId: string, patch: Record<string, any>) {
    const existing = db.prepare("SELECT id FROM comigo_customer_credit WHERE organization_id = ? AND contact_id = ?").get(orgId, contactId) as any;
    if (!existing) {
      const def = db.prepare("SELECT comigo_fiado_default_limit FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      db.prepare(`INSERT INTO comigo_customer_credit (id, organization_id, contact_id, credit_limit) VALUES (?, ?, ?, ?)`)
        .run(randomUUID(), orgId, contactId, Number(def?.comigo_fiado_default_limit) || 0);
    }
    const cols = Object.keys(patch);
    if (!cols.length) return;
    db.prepare(`UPDATE comigo_customer_credit SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND contact_id = ?`)
      .run(...cols.map((c) => patch[c]), orgId, contactId);
  }

  static setBlacklist(orgId: string, contactId: string, on: boolean, reason?: string, source: "manual" | "suggested" = "manual") {
    this.upsertCredit(orgId, contactId, {
      blacklisted: on ? 1 : 0,
      blacklisted_at: on ? new Date().toISOString() : null,
      blacklisted_reason: on ? (reason || null) : null,
      blacklist_source: on ? source : null,
    });
  }

  static setCreditLimit(orgId: string, contactId: string, limit: number) {
    this.upsertCredit(orgId, contactId, { credit_limit: Math.max(0, Number(limit) || 0) });
  }

  static setBlockAllSales(orgId: string, contactId: string, on: boolean) {
    this.upsertCredit(orgId, contactId, { block_all_sales: on ? 1 : 0 });
  }

  // ── Resumo do dia: caixa × a receber (ADR-112 D3) ───────────────────────────
  static totalReceivable(orgId: string): number {
    const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind='debt'").get(orgId) as any).s;
    const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind='payment'").get(orgId) as any).s;
    return Math.max(0, round2(debt - paid));
  }

  /**
   * Caixa = só o RECEBIDO (à vista + fiado quitado). Fiado em aberto é "a
   * receber", NÃO infla o caixa (senão o termômetro mente). Ticket médio deriva
   * das vendas do dia (à vista + o que foi anotado no fiado).
   */
  static daySummary(orgId: string, date: string) {
    const cash = db.prepare("SELECT COALESCE(SUM(total),0) s, COUNT(*) c FROM comigo_orders WHERE organization_id = ? AND status='paid' AND paid_via IN ('cash','pix_manual') AND date(paid_at) = ?").get(orgId, date) as any;
    const settled = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind='payment' AND date(created_at) = ?").get(orgId, date) as any).s;
    const fiado = db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) c FROM comigo_fiado_ledger WHERE organization_id = ? AND kind='debt' AND date(created_at) = ?").get(orgId, date) as any;
    const vendasHoje = round2(cash.s + fiado.s);
    const pedidosHoje = (cash.c || 0) + (fiado.c || 0);
    return {
      date,
      caixaHoje: round2(cash.s + settled),
      aReceber: this.totalReceivable(orgId),
      vendasHoje,
      pedidosHoje,
      ticketMedio: pedidosHoje ? round2(vendasHoje / pedidosHoje) : 0,
    };
  }
}

export default BalcaoService;
