import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Programa de indicação (cupom de desconto na próxima compra).
 * - Cada contato tem um CÓDIGO compartilhável.
 * - Quem usa um código (indicado) ganha um cupom de boas-vindas para a 1ª compra.
 * - Quando o indicado PAGA a primeira compra, quem indicou ganha um cupom de
 *   recompensa para a próxima compra.
 */
export class ReferralService {
  static config(orgId: string): { enabled: boolean; rewardPercent: number; welcomePercent: number } {
    try {
      const o = db.prepare(`SELECT referral_enabled, referral_reward_percent, referral_welcome_percent FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
      return {
        enabled: !!o.referral_enabled,
        rewardPercent: Math.min(90, Math.max(1, o.referral_reward_percent || 10)),
        welcomePercent: Math.min(90, Math.max(1, o.referral_welcome_percent || 10)),
      };
    } catch (e) { return { enabled: false, rewardPercent: 10, welcomePercent: 10 }; }
  }

  /** Gera um código curto, legível e único na organização. */
  private static genCode(orgId: string): string {
    const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem caracteres ambíguos
    for (let tries = 0; tries < 20; tries++) {
      let c = "";
      for (let i = 0; i < 6; i++) c += alpha[Math.floor(Math.random() * alpha.length)];
      const exists = db.prepare(`SELECT 1 FROM referral_codes WHERE organization_id = ? AND code = ?`).get(orgId, c);
      if (!exists) return c;
    }
    return uuidv4().slice(0, 8).toUpperCase();
  }

  /** Código de indicação do contato (cria se ainda não existir). */
  static getOrCreateCode(orgId: string, contactId: string): string {
    const existing = db.prepare(`SELECT code FROM referral_codes WHERE organization_id = ? AND contact_id = ? LIMIT 1`).get(orgId, contactId) as any;
    if (existing?.code) return existing.code;
    const code = this.genCode(orgId);
    db.prepare(`INSERT INTO referral_codes (id, organization_id, contact_id, code) VALUES (?, ?, ?, ?)`).run(uuidv4(), orgId, contactId, code);
    return code;
  }

  /** Resolve o dono de um código de indicação. */
  static ownerOfCode(orgId: string, code: string): string | null {
    const r = db.prepare(`SELECT contact_id FROM referral_codes WHERE organization_id = ? AND code = ?`).get(orgId, (code || "").trim().toUpperCase()) as any;
    return r?.contact_id || null;
  }

  /** Cupom ATIVO mais recente do contato (para aplicar no próximo pedido). */
  static activeCoupon(orgId: string, contactId: string): any | null {
    return db.prepare(`SELECT * FROM coupons WHERE organization_id = ? AND owner_contact_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1`).get(orgId, contactId) as any || null;
  }

  /** Marca um cupom como usado, vinculado ao pedido. */
  static redeem(orgId: string, couponId: string, orderId: string): void {
    db.prepare(`UPDATE coupons SET status = 'used', used_order_id = ?, used_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(orderId, couponId, orgId);
  }

  /**
   * Aplica um código de indicação a um contato (o indicado). Cria o cupom de
   * boas-vindas e registra a relação. Retorna o % de desconto ou null se inválido.
   */
  static applyCode(orgId: string, code: string, referredContactId: string): { welcomePercent: number; referrerContactId: string } | null {
    const cfg = this.config(orgId);
    if (!cfg.enabled) return null;
    const referrer = this.ownerOfCode(orgId, code);
    if (!referrer || referrer === referredContactId) return null; // inválido ou auto-indicação

    // Já foi indicado antes? Não aplica de novo.
    const contact = db.prepare(`SELECT referred_by_contact_id FROM contacts WHERE id = ?`).get(referredContactId) as any;
    if (contact?.referred_by_contact_id) return null;
    // Já comprou antes? Boas-vindas é só para novos.
    const bought = db.prepare(`SELECT 1 FROM orders WHERE organization_id = ? AND contact_id = ? AND status NOT IN ('cancelado') LIMIT 1`).get(orgId, referredContactId);
    if (bought) return null;

    db.prepare(`UPDATE contacts SET referred_by_contact_id = ? WHERE id = ?`).run(referrer, referredContactId);
    db.prepare(`INSERT INTO coupons (id, organization_id, owner_contact_id, kind, discount_percent, source_contact_id) VALUES (?, ?, ?, 'referral_welcome', ?, ?)`)
      .run(uuidv4(), orgId, referredContactId, cfg.welcomePercent, referrer);
    return { welcomePercent: cfg.welcomePercent, referrerContactId: referrer };
  }

  /**
   * Recompensa quem indicou, quando o indicado PAGA a primeira compra. Cria o
   * cupom de recompensa (uma vez). Retorna o contato do indicador + % ou null.
   */
  static rewardReferrerIfDue(orgId: string, referredContactId: string): { referrerContactId: string; rewardPercent: number } | null {
    const cfg = this.config(orgId);
    if (!cfg.enabled) return null;
    const contact = db.prepare(`SELECT referred_by_contact_id FROM contacts WHERE id = ?`).get(referredContactId) as any;
    const referrer = contact?.referred_by_contact_id;
    if (!referrer) return null;
    // Recompensa só uma vez por indicação.
    const already = db.prepare(`SELECT 1 FROM coupons WHERE organization_id = ? AND owner_contact_id = ? AND source_contact_id = ? AND kind = 'referral_reward' LIMIT 1`).get(orgId, referrer, referredContactId);
    if (already) return null;
    db.prepare(`INSERT INTO coupons (id, organization_id, owner_contact_id, kind, discount_percent, source_contact_id) VALUES (?, ?, ?, 'referral_reward', ?, ?)`)
      .run(uuidv4(), orgId, referrer, cfg.rewardPercent, referredContactId);
    return { referrerContactId: referrer, rewardPercent: cfg.rewardPercent };
  }
}
