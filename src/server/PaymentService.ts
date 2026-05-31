import db from "./db.js";
import { OrdersService } from "./OrdersService.js";

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
             pay_instructions, pay_gateway_token, pay_webhook_secret
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
    // Token/segredo só são gravados quando enviados (não apagam sem querer).
    if (typeof p.gatewayToken === 'string' && p.gatewayToken) {
      db.prepare(`UPDATE organization_settings SET pay_gateway_token = ? WHERE organization_id = ?`).run(p.gatewayToken, orgId);
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
    return true;
  }
}
