import db from "./db.js";
import { randomUUID } from "crypto";
import { ComigoMesaService } from "./ComigoMesaService.js";

/**
 * ZappFlow Comigo — Boosts de divulgação (ADR-123 / ADR-088 D8).
 *
 * Impulsos de crescimento em um toque, ZERO-TOKEN (viral: cada link/post que a
 * pessoa manda é propaganda). Post do dia (mais vendidos) + compartilhar
 * cardápio (link do Mesa/QR). Isolado por organization_id.
 */

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace(".", ",")}`;

export class ComigoBoostService {
  private static businessName(orgId: string): string {
    const o = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return (o?.business_name || "").trim() || "meu negócio";
  }

  /** Legenda pronta com os mais vendidos (fallback: produtos ativos). */
  static postDoDia(orgId: string): { caption: string; items: { name: string; price: number }[] } {
    let items = db.prepare(`
      SELECT ps.name AS name, ps.price AS price, SUM(oi.qty) AS q
      FROM comigo_order_items oi
      JOIN comigo_orders o ON o.id = oi.order_id
      JOIN products_services ps ON ps.id = oi.product_id
      WHERE o.organization_id = ? AND o.status IN ('paid','done') AND oi.product_id IS NOT NULL AND ps.active = 1
      GROUP BY oi.product_id ORDER BY q DESC LIMIT 4
    `).all(orgId) as any[];
    if (!items.length) {
      items = db.prepare("SELECT name, price FROM products_services WHERE organization_id = ? AND active = 1 AND price IS NOT NULL ORDER BY name ASC LIMIT 4").all(orgId) as any[];
    }
    const list = items.map((i) => ({ name: i.name, price: Number(i.price) || 0 }));
    const linhas = list.map((i) => `• ${i.name} — ${brl(i.price)}`).join("\n");
    const caption = list.length
      ? `🔥 Hoje na ${this.businessName(orgId)}!\n${linhas}\n\nChama no Whats que eu já preparo pra você 😋📲`
      : `😋 Passa aqui na ${this.businessName(orgId)}! Chama no Whats pra ver as novidades de hoje 📲`;
    return { caption, items: list };
  }

  /** Link do cardápio (Mesa/QR) + texto convidativo pro WhatsApp. */
  static catalogoShare(orgId: string): { link: string; text: string } {
    const token = ComigoMesaService.ensureToken(orgId);
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    const link = base ? `${base}/mesa/${token}` : `/mesa/${token}`;
    const text = `Olha só o meu cardápio 😋 dá pra escolher, pedir e pagar por aqui, rapidinho:\n${link}`;
    return { link, text };
  }

  static list(orgId: string) {
    return {
      post: this.postDoDia(orgId),
      catalogo: this.catalogoShare(orgId),
    };
  }

  static use(orgId: string, key: string, actorId?: string) {
    const boost = ["post", "catalogo"].includes(key) ? key : null;
    if (!boost) return { ok: false, error: "unknown_boost" };
    db.prepare("INSERT INTO comigo_boost_log (id, organization_id, boost_key, created_by) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), orgId, boost, actorId || null);
    return { ok: true };
  }
}

export default ComigoBoostService;
