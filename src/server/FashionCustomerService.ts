import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { JWT_SECRET } from "./config/secret.js";
import { NotificationService } from "./NotificationService.js";
import { FashionStudioService } from "./FashionStudioService.js";

/**
 * Conta de cliente do Provador Virtual (Fashion AI Studio, FAS-1 / ADR-035).
 *
 * Decisões de produto (confirmadas pelo usuário na ADR-034):
 *  - a vitrine continua 100% anônima para navegar e comprar; a conta só
 *    existe para quem quer o provador — e o cadastro vira LEAD no CRM;
 *  - menor de 18 não cria conta: o gate de idade recusa com a orientação de
 *    usar a conta do responsável (guardian_approval entra no consentimento).
 *
 * SEGURANÇA — segredo derivado, não o JWT_SECRET:
 * o requireAuth do painel (middleware/auth.ts) aceita QUALQUER token assinado
 * com JWT_SECRET que contenha organizationId — e muitas rotas do painel
 * autorizam só pelo organizationId. Se o token do cliente do provador usasse
 * o mesmo segredo, um cadastro público de loja viraria acesso ao painel
 * administrativo da organização. Por isso este serviço assina com um segredo
 * DERIVADO (sha256 do JWT_SECRET + sufixo): a verificação do staff falha por
 * assinatura, e vice-versa — os dois mundos não se cruzam nem por engano.
 */
const FASHION_JWT_SECRET = crypto.createHash("sha256").update(`${JWT_SECRET}:fashion_customer_v1`).digest("hex");

export class FashionCustomerService {
  /** Idade em anos completos a partir de um ISO yyyy-mm-dd. null = data inválida. */
  static ageFromBirthDate(birthDate: string, now = new Date()): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate || "").trim());
    if (!m) return null;
    const d = new Date(`${birthDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    let age = now.getUTCFullYear() - d.getUTCFullYear();
    const beforeBirthday =
      now.getUTCMonth() < d.getUTCMonth() ||
      (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
    if (beforeBirthday) age--;
    return age >= 0 && age < 130 ? age : null;
  }

  static register(orgId: string, params: { name: string; email: string; phone?: string | null; password: string; birthDate: string }):
    { ok: true; customerId: string; token: string } | { ok: false; error: string } {
    const name = String(params.name || "").trim().slice(0, 120);
    const email = String(params.email || "").trim().toLowerCase().slice(0, 160);
    const password = String(params.password || "");
    if (!name) return { ok: false, error: "Informe seu nome." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Informe um e-mail válido." };
    if (password.length < 8) return { ok: false, error: "A senha precisa ter pelo menos 8 caracteres." };

    const age = this.ageFromBirthDate(params.birthDate);
    if (age === null) return { ok: false, error: "Informe sua data de nascimento (dd/mm/aaaa)." };
    if (age < 18) {
      // Decisão do usuário (ADR-034): menor não cria conta própria — usa a do
      // responsável. A mensagem orienta sem julgar nem coletar mais nada.
      return { ok: false, error: "O provador virtual é para maiores de 18 anos. Se você é menor, peça a um responsável para criar a conta dele e te acompanhar." };
    }

    const existing = db.prepare(`SELECT id FROM storefront_customers WHERE organization_id = ? AND email = ? AND deleted_at IS NULL`).get(orgId, email);
    if (existing) return { ok: false, error: "Já existe uma conta com este e-mail nesta loja. Entre com sua senha." };

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);
    const phone = params.phone ? String(params.phone).replace(/\D/g, "").slice(0, 20) || null : null;
    const contactId = this.createLead(orgId, { name, email, phone });
    db.prepare(
      `INSERT INTO storefront_customers (id, organization_id, name, email, phone, password_hash, birth_date, contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, name, email, phone, hash, params.birthDate, contactId);

    FashionStudioService.recordEvent(orgId, "FashionCustomerRegistered", { leadCreated: !!contactId }, id);
    return { ok: true, customerId: id, token: this.signToken(orgId, id) };
  }

  static login(orgId: string, email: string, password: string): { ok: true; customerId: string; token: string; name: string } | { ok: false; error: string } {
    const row = db.prepare(
      `SELECT id, name, password_hash FROM storefront_customers WHERE organization_id = ? AND email = ? AND deleted_at IS NULL`
    ).get(orgId, String(email || "").trim().toLowerCase()) as any;
    // Mesma mensagem para conta inexistente e senha errada (não confirma e-mails).
    if (!row || !bcrypt.compareSync(String(password || ""), row.password_hash)) {
      return { ok: false, error: "E-mail ou senha incorretos." };
    }
    db.prepare(`UPDATE storefront_customers SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    return { ok: true, customerId: row.id, token: this.signToken(orgId, row.id), name: row.name };
  }

  private static signToken(orgId: string, customerId: string): string {
    return jwt.sign({ kind: "fashion_customer", fashionCustomerId: customerId, organizationId: orgId }, FASHION_JWT_SECRET, { expiresIn: "7d" });
  }

  /** Verifica o token do cliente do provador. null = inválido/expirado/de outro tipo. */
  static verifyToken(token: string): { customerId: string; organizationId: string } | null {
    let decoded: any;
    try {
      decoded = jwt.verify(token, FASHION_JWT_SECRET);
    } catch (e: any) {
      // Assinatura inválida/expirada = segredo divergente entre assinar e
      // verificar (segredo instável / instâncias com segredos diferentes).
      console.warn(`[FashionAuth] token recusado na verificação JWT: ${e?.name || "erro"} — ${e?.message || ""}`);
      return null;
    }
    if (decoded?.kind !== "fashion_customer" || !decoded.fashionCustomerId || !decoded.organizationId) {
      console.warn(`[FashionAuth] token sem os campos esperados (kind=${decoded?.kind}).`);
      return null;
    }
    const row = db.prepare(`SELECT id FROM storefront_customers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
      .get(decoded.fashionCustomerId, decoded.organizationId);
    if (!row) {
      // Assinatura OK mas a conta não existe NESTE banco: o /me foi atendido
      // por uma instância diferente da que emitiu o token (múltiplas réplicas
      // com bancos SQLite separados). Rode UMA única instância.
      console.warn(`[FashionAuth] token válido, mas conta ausente neste banco (customer=${decoded.fashionCustomerId}, org=${decoded.organizationId}) — provável múltiplas instâncias/bancos.`);
      return null;
    }
    return { customerId: decoded.fashionCustomerId, organizationId: decoded.organizationId };
  }

  static getCustomer(orgId: string, customerId: string): { id: string; name: string; email: string } | null {
    const row = db.prepare(`SELECT id, name, email FROM storefront_customers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`).get(customerId, orgId) as any;
    return row || null;
  }

  /**
   * O cadastro do provador vira LEAD no CRM (decisão do usuário): garante um
   * canal sintético "Loja Virtual" na organização e cria o contato nele.
   * Best-effort — nunca bloqueia o registro se o CRM falhar.
   */
  private static createLead(orgId: string, params: { name: string; email: string; phone: string | null }): string | null {
    try {
      let channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider = 'storefront'`).get(orgId) as any;
      if (!channel) {
        const chId = uuidv4();
        db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'storefront', 'Loja Virtual', 'loja-virtual', 'connected')`)
          .run(chId, orgId);
        channel = { id: chId };
      }
      const identifier = params.phone || params.email;
      const existing = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?`).get(orgId, channel.id, identifier) as any;
      if (existing) return existing.id;
      const contactId = uuidv4();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(contactId, orgId, channel.id, params.name, identifier, params.email);
      try { NotificationService.newLead(orgId, params.name, "storefront"); } catch { /* noop */ }
      return contactId;
    } catch (e) {
      console.error("[FashionCustomer] Falha ao criar lead no CRM (registro segue normal):", e);
      return null;
    }
  }
}
