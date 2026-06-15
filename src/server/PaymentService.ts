import db from "./db.js";
import { OrdersService } from "./OrdersService.js";
import { NotificationService } from "./NotificationService.js";
import { ReservationService } from "./ReservationService.js";
import { SubscriptionService } from "./SubscriptionService.js";
import { CadenceService } from "./CadenceService.js";
import { CustomerProfileService } from "./CustomerProfileService.js";

/**
 * Camada de recebimento de pagamentos — genérica e multi-tenant.
 *
 * Cada organização configura COMO recebe (Pix manual com a própria chave, ou um
 * gateway com token). O webhook de confirmação (chamado pelo gateway) marca o
 * pedido como pago e avança o status para 'pago' (o que baixa o estoque, via
 * OrdersService.updateStatus).
 *
 * Não amarra nenhum provedor específico: provider='pix_manual' funciona já;
 * provider='mercadopago'/'custom' podem ser plugados depois sem mudar o resto.
 */
export class PaymentService {
  static getSettings(orgId: string): any {
    const o = db.prepare(`
      SELECT pay_enabled, pay_provider, pay_pix_key, pay_pix_name, pay_pix_city,
             pay_instructions, pay_gateway_token, pay_webhook_secret,
             pix_reminder_enabled, pix_reminder_minutes, pix_reminder_message,
             reservation_deposit_percent
      FROM organization_settings WHERE organization_id = ?
    `).get(orgId) as any;
    return o || {};
  }

  /** Config pública (sem segredos) — para a UI exibir. */
  static getPublicSettings(orgId: string) {
    const o = this.getSettings(orgId);
    return {
      enabled: !!o.pay_enabled,
      provider: o.pay_provider || 'pix_manual',
      pixKey: o.pay_pix_key || '',
      pixName: o.pay_pix_name || '',
      pixCity: o.pay_pix_city || '',
      instructions: o.pay_instructions || '',
      hasGatewayToken: !!o.pay_gateway_token,
      hasWebhookSecret: !!o.pay_webhook_secret,
      pixReminderEnabled: !!o.pix_reminder_enabled,
      pixReminderMinutes: o.pix_reminder_minutes || 30,
      pixReminderMessage: o.pix_reminder_message || '',
      reservationDepositPercent: o.reservation_deposit_percent || 0,
    };
  }

  static updateSettings(orgId: string, p: any) {
    db.prepare(`
      UPDATE organization_settings SET
        pay_enabled = ?, pay_provider = ?, pay_pix_key = ?, pay_pix_name = ?,
        pay_pix_city = ?, pay_instructions = ?
      WHERE organization_id = ?
    `).run(
      p.enabled ? 1 : 0, p.provider || 'pix_manual', p.pixKey || null, p.pixName || null,
      p.pixCity || null, p.instructions || null, orgId
    );
    // Lembrete de PIX não pago (opt-in). Minutos com piso de 5 e teto de 1440.
    if (p.pixReminderEnabled !== undefined || p.pixReminderMinutes !== undefined || p.pixReminderMessage !== undefined) {
      const mins = Math.min(1440, Math.max(5, parseInt(String(p.pixReminderMinutes ?? 30), 10) || 30));
      db.prepare(`UPDATE organization_settings SET pix_reminder_enabled = ?, pix_reminder_minutes = ?, pix_reminder_message = ? WHERE organization_id = ?`)
        .run(p.pixReminderEnabled ? 1 : 0, mins, (p.pixReminderMessage || '').trim() || null, orgId);
    }
    // Token/segredo só são gravados quando enviados (não apagam sem querer).
    if (typeof p.gatewayToken === 'string' && p.gatewayToken) {
      db.prepare(`UPDATE organization_settings SET pay_gateway_token = ? WHERE organization_id = ?`).run(p.gatewayToken, orgId);
    }
    // Sinal de reservas (% de 0 a 100).
    if (p.reservationDepositPercent !== undefined) {
      const pct = Math.min(100, Math.max(0, parseInt(String(p.reservationDepositPercent), 10) || 0));
      db.prepare(`UPDATE organization_settings SET reservation_deposit_percent = ? WHERE organization_id = ?`).run(pct, orgId);
    }
  }

  /** Gera (ou regenera) o segredo do webhook de pagamento da organização. */
  static rotateWebhookSecret(orgId: string): string {
    const secret = 'whpay_' + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    db.prepare(`UPDATE organization_settings SET pay_webhook_secret = ? WHERE organization_id = ?`).run(secret, orgId);
    return secret;
  }

  /** Texto de cobrança que a IA/atendente envia ao cliente (Pix manual). */
  static buildChargeMessage(orgId: string, amount: number): string | null {
    const o = this.getSettings(orgId);
    if (!o.pay_enabled || (o.pay_provider || 'pix_manual') !== 'pix_manual' || !o.pay_pix_key) return null;
    const val = `R$ ${Number(amount || 0).toFixed(2)}`;
    const lines = [
      `Para concluir, o pagamento é via *Pix* (${val}):`,
      `🔑 Chave: *${o.pay_pix_key}*`,
    ];
    if (o.pay_pix_name) lines.push(`👤 ${o.pay_pix_name}`);
    if (o.pay_instructions) lines.push(`\n${o.pay_instructions}`);
    lines.push(`\nApós pagar, é só enviar o comprovante aqui. 🙏`);
    return lines.join('\n');
  }

  // ===== Mercado Pago (PIX dinâmico com confirmação automática) =====
  private static MP_API = "https://api.mercadopago.com";

  /** URL pública do webhook de pagamento (para o gateway notificar). */
  private static notificationUrl(orgId: string): string | null {
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    if (!base) return null;
    const o = this.getSettings(orgId);
    let secret = o.pay_webhook_secret as string | undefined;
    // Garante um segredo para casar a notificação com a organização.
    if (!secret) secret = this.rotateWebhookSecret(orgId);
    return `${base}/api/webhooks/payment?secret=${secret}`;
  }

  /**
   * Cria (ou reaproveita) uma cobrança PIX dinâmica no Mercado Pago para um
   * pedido. Retorna o "copia e cola", a imagem do QR e o link, ou null se não
   * for possível (sem token, etc.). Idempotente por pedido enquanto pendente.
   */
  static async createMercadoPagoPix(
    orgId: string,
    p: { orderId: string; amount: number; contactName?: string; contactId?: string }
  ): Promise<{ id: string; qrCode: string; qrCodeBase64: string; ticketUrl: string } | null> {
    const charge = await this._mpPix(orgId, {
      reference: p.orderId, amount: p.amount, contactName: p.contactName, contactId: p.contactId,
      description: `Pedido #${String(p.orderId).slice(0, 8)}`, idemKey: `order-${p.orderId}`,
    });
    if (!charge) return null;
    // Vincula a cobrança ao pedido (campos específicos de orders).
    try {
      db.prepare(`UPDATE orders SET payment_external_id = ?, payment_method = 'mercadopago', payment_link = ? WHERE id = ?`)
        .run(charge.id, charge.ticketUrl || null, p.orderId);
    } catch (e) { /* noop */ }
    return charge;
  }

  /**
   * Cria uma cobrança PIX dinâmica genérica no Mercado Pago para uma `reference`
   * arbitrária (id de pedido OU "res:<reservaId>"). Persiste em payment_charges
   * (order_id = reference). Reaproveita cobrança pendente da mesma reference.
   */
  private static async _mpPix(
    orgId: string,
    p: { reference: string; amount: number; contactName?: string; contactId?: string; description: string; idemKey: string }
  ): Promise<{ id: string; qrCode: string; qrCodeBase64: string; ticketUrl: string } | null> {
    const o = this.getSettings(orgId);
    const token = o.pay_gateway_token as string | undefined;
    if (!token) return null;

    const existing = db.prepare(
      `SELECT id, qr_code, qr_code_base64, ticket_url FROM payment_charges
        WHERE order_id = ? AND organization_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`
    ).get(p.reference, orgId) as any;
    if (existing && existing.qr_code) {
      return { id: existing.id, qrCode: existing.qr_code, qrCodeBase64: existing.qr_code_base64 || "", ticketUrl: existing.ticket_url || "" };
    }

    const notifUrl = this.notificationUrl(orgId);
    const body: any = {
      transaction_amount: Number(Number(p.amount || 0).toFixed(2)),
      description: p.description,
      payment_method_id: "pix",
      external_reference: p.reference,
      payer: {
        email: `cliente-${(p.contactId || p.reference).toString().replace(/[^a-z0-9]/gi, "").slice(0, 12)}@checkout.exaforge.app`,
        first_name: (p.contactName || "Cliente").slice(0, 40),
      },
    };
    if (notifUrl) body.notification_url = notifUrl;

    try {
      const res = await fetch(`${this.MP_API}/v1/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Idempotency-Key": p.idemKey,
        },
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("[MercadoPago] Falha ao criar PIX:", res.status, data?.message || data);
        return null;
      }
      const tx = data?.point_of_interaction?.transaction_data || {};
      const qrCode: string = tx.qr_code || "";
      const qrCodeBase64: string = tx.qr_code_base64 || "";
      const ticketUrl: string = tx.ticket_url || "";
      const payId = String(data.id);
      if (!qrCode && !ticketUrl) {
        console.error("[MercadoPago] Resposta sem dados de PIX:", data);
        return null;
      }
      try {
        db.prepare(
          `INSERT OR REPLACE INTO payment_charges
             (id, organization_id, order_id, provider, amount, status, qr_code, qr_code_base64, ticket_url, expires_at, created_at)
           VALUES (?, ?, ?, 'mercadopago', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).run(payId, orgId, p.reference, body.transaction_amount, data.status || 'pending', qrCode, qrCodeBase64, ticketUrl, data.date_of_expiration || null);
      } catch (e) { /* noop */ }
      return { id: payId, qrCode, qrCodeBase64, ticketUrl };
    } catch (e) {
      console.error("[MercadoPago] Erro de rede ao criar PIX:", e);
      return null;
    }
  }

  /** Cria um PIX dinâmico (estruturado) para o SINAL de uma reserva — usado pela
   *  loja virtual (QR + copia-e-cola). reference "res:<id>" ⇒ webhook confirma. */
  static async createReservationPix(
    orgId: string,
    p: { reservationId: string; amount: number; contactName?: string; contactId?: string }
  ): Promise<{ id: string; qrCode: string; qrCodeBase64: string; ticketUrl: string } | null> {
    return this._mpPix(orgId, {
      reference: `res:${p.reservationId}`, amount: p.amount, contactName: p.contactName, contactId: p.contactId,
      description: `Sinal reserva #${String(p.reservationId).slice(0, 8)}`, idemKey: `res-${p.reservationId}`,
    });
  }

  /**
   * Mensagem de cobrança do SINAL de uma reserva (PIX manual ou dinâmico).
   * Para o MP dinâmico usa a reference "res:<id>" — o webhook confirma a reserva.
   */
  static async chargeForReservation(
    orgId: string,
    p: { reservationId: string; amount: number; contactName?: string; contactId?: string }
  ): Promise<string | null> {
    const o = this.getSettings(orgId);
    if (!o.pay_enabled || !(Number(p.amount) > 0)) return null;
    const provider = o.pay_provider || "pix_manual";
    const val = `R$ ${Number(p.amount || 0).toFixed(2)}`;

    if (provider === "mercadopago") {
      const charge = await this._mpPix(orgId, {
        reference: `res:${p.reservationId}`, amount: p.amount, contactName: p.contactName, contactId: p.contactId,
        description: `Sinal reserva #${String(p.reservationId).slice(0, 8)}`, idemKey: `res-${p.reservationId}`,
      });
      if (!charge) return null;
      const lines = [`Para garantir sua reserva, o *sinal* é via Pix (${val}):`];
      if (charge.qrCode) lines.push(`\n📋 *Pix copia e cola:*`, charge.qrCode);
      if (charge.ticketUrl) lines.push(`\n💳 Ou pague pelo link: ${charge.ticketUrl}`);
      lines.push(`\nAssim que o sinal cair, confirmo sua reserva automaticamente. ✅`);
      return lines.join("\n");
    }
    // pix_manual: chave estática.
    const msg = this.buildChargeMessage(orgId, p.amount);
    return msg ? msg.replace("Para concluir, o pagamento", "Para garantir sua reserva, o *sinal*") : null;
  }

  /**
   * Mensagem de cobrança de uma FATURA de assinatura (PIX manual ou dinâmico).
   * MP dinâmico usa reference "sub:<faturaId>" — o webhook marca a fatura paga.
   */
  static async chargeForSubscription(
    orgId: string,
    p: { invoiceId: string; amount: number; contactName?: string; contactId?: string }
  ): Promise<string | null> {
    const o = this.getSettings(orgId);
    if (!o.pay_enabled || !(Number(p.amount) > 0)) return null;
    const provider = o.pay_provider || "pix_manual";
    const val = `R$ ${Number(p.amount || 0).toFixed(2)}`;

    if (provider === "mercadopago") {
      const charge = await this._mpPix(orgId, {
        reference: `sub:${p.invoiceId}`, amount: p.amount, contactName: p.contactName, contactId: p.contactId,
        description: `Mensalidade #${String(p.invoiceId).slice(0, 8)}`, idemKey: `sub-${p.invoiceId}`,
      });
      if (!charge) return null;
      const lines = [`Sua mensalidade está disponível para pagamento via *Pix* (${val}):`];
      if (charge.qrCode) lines.push(`\n📋 *Pix copia e cola:*`, charge.qrCode);
      if (charge.ticketUrl) lines.push(`\n💳 Ou pague pelo link: ${charge.ticketUrl}`);
      lines.push(`\nAssim que o pagamento cair, dou baixa automaticamente. ✅`);
      return lines.join("\n");
    }
    const msg = this.buildChargeMessage(orgId, p.amount);
    return msg ? msg.replace("Para concluir, o pagamento", "Sua mensalidade") : null;
  }

  /**
   * Consulta um pagamento no Mercado Pago (usado pelo webhook, que recebe só o
   * id). Se aprovado, marca o pedido como pago. Retorna o status do MP.
   */
  static async syncMercadoPagoPayment(orgId: string, paymentId: string): Promise<string | null> {
    const o = this.getSettings(orgId);
    const token = o.pay_gateway_token as string | undefined;
    if (!token || !paymentId) return null;
    try {
      const res = await fetch(`${this.MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("[MercadoPago] Falha ao consultar pagamento:", res.status, data?.message || data);
        return null;
      }
      const status: string = data.status || "";
      const ref: string | undefined = data.external_reference;
      // Atualiza o status da cobrança guardada.
      try { db.prepare(`UPDATE payment_charges SET status = ? WHERE id = ?`).run(status, String(data.id)); } catch (e) { /* noop */ }
      if (status === "approved" && ref) {
        if (ref.startsWith("res:")) {
          // Sinal de reserva: confirma a reserva (não é um pedido).
          try { ReservationService.markPaid(orgId, ref.slice(4)); } catch (e) { /* noop */ }
        } else if (ref.startsWith("sub:")) {
          // Fatura de assinatura: marca a mensalidade paga.
          try { SubscriptionService.markInvoicePaid(orgId, ref.slice(4)); } catch (e) { /* noop */ }
        } else {
          this.markPaid(orgId, ref, { method: "mercadopago", externalId: String(data.id) });
        }
      }
      return status;
    } catch (e) {
      console.error("[MercadoPago] Erro de rede ao consultar pagamento:", e);
      return null;
    }
  }

  /**
   * Monta a mensagem de cobrança a enviar ao cliente ao fechar um pedido.
   * - pix_manual: chave Pix estática (texto fixo).
   * - mercadopago: cria um PIX dinâmico (copia e cola + link) que confirma sozinho.
   * Retorna null se a cobrança não está configurada/possível.
   */
  static async chargeForOrder(
    orgId: string,
    p: { orderId: string; amount: number; contactName?: string; contactId?: string }
  ): Promise<string | null> {
    const o = this.getSettings(orgId);
    if (!o.pay_enabled) return null;
    const provider = o.pay_provider || "pix_manual";

    if (provider === "mercadopago") {
      const charge = await this.createMercadoPagoPix(orgId, p);
      if (!charge) return null;
      const val = `R$ ${Number(p.amount || 0).toFixed(2)}`;
      const lines = [`Para concluir, o pagamento é via *Pix* (${val}):`];
      if (charge.qrCode) {
        lines.push(`\n📋 *Pix copia e cola:*`, charge.qrCode);
      }
      if (charge.ticketUrl) {
        lines.push(`\n💳 Ou pague pelo link: ${charge.ticketUrl}`);
      }
      lines.push(`\nAssim que o pagamento cair, confirmo por aqui automaticamente. ✅`);
      return lines.join("\n");
    }

    // pix_manual (e fallback): mensagem estática com a chave do lojista.
    return this.buildChargeMessage(orgId, p.amount);
  }

  /** Resolve a organização a partir do segredo do webhook (gateway). */
  static orgByWebhookSecret(secret: string): string | null {
    if (!secret) return null;
    const o = db.prepare(`SELECT organization_id FROM organization_settings WHERE pay_webhook_secret = ?`).get(secret) as any;
    return o?.organization_id || null;
  }

  /**
   * Marca um pedido como PAGO (idempotente) e avança o status para 'pago'
   * (baixa o estoque). Usado pelo webhook do gateway e pela confirmação manual.
   */
  static markPaid(orgId: string, orderId: string, opts: { method?: string; externalId?: string } = {}): boolean {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND organization_id = ?`).get(orderId, orgId) as any;
    if (!order) return false;
    if (order.payment_status === 'paid') return true; // idempotente
    db.prepare(`UPDATE orders SET payment_status = 'paid', payment_method = ?, payment_external_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(opts.method || order.payment_method || 'gateway', opts.externalId || order.payment_external_id || null, orderId);
    // Avança o ciclo de vida do pedido (e baixa o estoque) se ainda estava aguardando.
    if (order.status === 'aguardando_pagamento') {
      try { OrdersService.updateStatus(orgId, orderId, 'pago'); } catch (e) { /* noop */ }
    }
    // FUNIL: pagamento confirmado leva o ticket para 'pos_venda' (revive a etapa
    // de pós-venda e pode disparar uma cadência de recompra/fidelização).
    if (order.ticket_id) {
      try {
        const tk = db.prepare('SELECT stage, contact_id FROM tickets WHERE id = ? AND organization_id = ?').get(order.ticket_id, orgId) as any;
        if (tk && tk.stage !== 'pos_venda') {
          db.prepare("UPDATE tickets SET stage = 'pos_venda', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.ticket_id);
          const io = (global as any).io;
          if (io) io.to(`org:${orgId}`).emit("ticket_stage_change", { ticketId: order.ticket_id, contactId: tk.contact_id, newStage: 'pos_venda' });
          CadenceService.startForTicket(orgId, order.ticket_id, tk.contact_id, 'pos_venda');
          if (tk.contact_id) CustomerProfileService.recomputeScore(tk.contact_id);
        }
      } catch (e) { /* noop */ }
    }
    // Notifica a equipe: pagamento recebido.
    try {
      const c = order.contact_id ? db.prepare('SELECT name FROM contacts WHERE id = ?').get(order.contact_id) as any : null;
      NotificationService.paymentConfirmed(orgId, order.total_amount, c?.name);
    } catch (e) { /* noop */ }
    return true;
  }
}
