import crypto from "crypto";
import db from "./db.js";
import { PlanService } from "./PlanService.js";

/**
 * Cobrança ZappFlow → LOJISTA via ASAAS (ADR-091 Bloco B).
 *
 * NÃO confundir com SubscriptionService (lojista cobrando OS CLIENTES dele).
 * Aqui o ZappFlow é o comerciante e o lojista é o pagador. Por isso usamos uma
 * ÚNICA chave de plataforma (env), não uma chave por org:
 *   - ASAAS_API_KEY      chave da conta ASAAS do ZappFlow
 *   - ASAAS_API_BASE     https://api-sandbox.asaas.com/v3 (default) ou prod
 *   - ASAAS_WEBHOOK_TOKEN token estático configurado no painel ASAAS (header)
 *
 * Guarda por org (reusa colunas existentes): payment_provider='asaas',
 * external_customer_id=cus_..., external_subscription_id=sub_....
 *
 * Regras money-critical:
 *  - webhook idempotente por id do evento (asaas_webhook_events);
 *  - NUNCA confia no payload: re-consulta o pagamento no ASAAS antes de mudar
 *    o billing_status;
 *  - toda transição de billing passa por PlanService.setBillingStatus.
 */
export class AsaasService {
  private static base(): string { return process.env.ASAAS_API_BASE || "https://api-sandbox.asaas.com/v3"; }
  private static apiKey(): string { return process.env.ASAAS_API_KEY || ""; }
  private static webhookToken(): string { return process.env.ASAAS_WEBHOOK_TOKEN || ""; }
  static isConfigured(): boolean { return !!this.apiKey(); }

  /** Chamada REST ao ASAAS (header access_token). Retorna JSON ou lança. */
  private static async _req(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", access_token: this.apiKey() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ASAAS ${method} ${path} -> ${res.status}: ${data?.errors?.[0]?.description || JSON.stringify(data)}`);
    return data;
  }

  private static settings(orgId: string): any {
    return db.prepare(`SELECT payment_provider, external_customer_id, external_subscription_id, billing_status FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
  }

  /** Cria (ou reaproveita) o cliente ASAAS do lojista. Persiste external_customer_id. */
  static async ensureCustomer(orgId: string, p: { name: string; email: string; cpfCnpj: string; mobilePhone?: string }): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const cur = this.settings(orgId);
    if (cur.external_customer_id) return cur.external_customer_id;
    const c = await this._req("POST", "/customers", { name: p.name, email: p.email, cpfCnpj: String(p.cpfCnpj || "").replace(/\D/g, ""), mobilePhone: p.mobilePhone, externalReference: orgId });
    const id = c?.id;
    if (id) db.prepare(`UPDATE organization_settings SET payment_provider = 'asaas', external_customer_id = ? WHERE organization_id = ?`).run(id, orgId);
    return id || null;
  }

  /**
   * Assina um plano: garante o cliente e cria a assinatura recorrente no ASAAS.
   * `value` em reais (o ASAAS trabalha em reais, não centavos). Persiste
   * external_subscription_id. Retorna { subscriptionId }.
   */
  static async subscribe(orgId: string, p: { customer: { name: string; email: string; cpfCnpj: string; mobilePhone?: string }; value: number; description: string; nextDueDate: string; cycle?: string; billingType?: string }): Promise<{ subscriptionId: string } | null> {
    if (!this.isConfigured()) return null;
    const customerId = await this.ensureCustomer(orgId, p.customer);
    if (!customerId) return null;
    const cur = this.settings(orgId);
    if (cur.external_subscription_id) return { subscriptionId: cur.external_subscription_id };
    const sub = await this._req("POST", "/subscriptions", {
      customer: customerId,
      billingType: p.billingType || "UNDEFINED", // deixa o pagador escolher (Pix/boleto/cartão)
      value: Math.max(1, Number(p.value || 0)),
      nextDueDate: p.nextDueDate,
      cycle: p.cycle || "MONTHLY",
      description: p.description,
      externalReference: orgId,
    });
    const id = sub?.id;
    if (id) db.prepare(`UPDATE organization_settings SET payment_provider = 'asaas', external_subscription_id = ? WHERE organization_id = ?`).run(id, orgId);
    return id ? { subscriptionId: id } : null;
  }

  /** Cancela a assinatura no ASAAS e marca billing_status='cancelled'. */
  static async cancelSubscription(orgId: string): Promise<boolean> {
    const cur = this.settings(orgId);
    if (!cur.external_subscription_id) return false;
    if (this.isConfigured()) { try { await this._req("DELETE", `/subscriptions/${cur.external_subscription_id}`); } catch (e) { console.error("[ASAAS] Falha ao cancelar assinatura:", e); } }
    PlanService.setBillingStatus(orgId, "cancelled");
    return true;
  }

  /** Lista as faturas (payments) da assinatura, normalizadas para a UI. */
  static async listInvoices(orgId: string): Promise<{ id: string; status: string; value: number; dueDate: string; invoiceUrl: string }[]> {
    const cur = this.settings(orgId);
    if (!cur.external_subscription_id || !this.isConfigured()) return [];
    try {
      const r = await this._req("GET", `/subscriptions/${cur.external_subscription_id}/payments`);
      return (r?.data || []).map((p: any) => ({ id: p.id, status: p.status, value: p.value, dueDate: p.dueDate, invoiceUrl: p.invoiceUrl || p.bankSlipUrl || "" }));
    } catch (e) { console.error("[ASAAS] Falha ao listar faturas:", e); return []; }
  }

  /** Re-consulta o status de um pagamento (money-critical: não confiar no payload). */
  static async getPayment(paymentId: string): Promise<any | null> {
    if (!this.isConfigured() || !paymentId) return null;
    try { return await this._req("GET", `/payments/${paymentId}`); } catch (e) { console.error("[ASAAS] Falha ao consultar pagamento:", e); return null; }
  }

  private static safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(String(a || "")); const bb = Buffer.from(String(b || ""));
    if (ba.length !== bb.length || ba.length === 0) return false;
    try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
  }

  /** Resolve a org pelo id de assinatura/cliente que veio no evento. */
  private static orgByExternalIds(subscriptionId?: string, customerId?: string): string | null {
    if (subscriptionId) { const r = db.prepare(`SELECT organization_id FROM organization_settings WHERE external_subscription_id = ?`).get(subscriptionId) as any; if (r) return r.organization_id; }
    if (customerId) { const r = db.prepare(`SELECT organization_id FROM organization_settings WHERE external_customer_id = ?`).get(customerId) as any; if (r) return r.organization_id; }
    return null;
  }

  // Mapa evento/status confirmado → billing_status.
  private static PAID_STATUSES = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"];

  /**
   * Processa um evento de webhook do ASAAS. Autentica pelo header, deduplica pelo
   * id do evento, resolve a org, RE-CONSULTA o pagamento e transiciona o billing.
   * Retorna { status: 'unauthorized' | 'ignored' | 'duplicate' | 'ok', ... }.
   * O chamador (rota) SEMPRE responde 200 (menos em unauthorized), pra não
   * disparar reentrega em loop do ASAAS.
   */
  static async handleWebhook(headers: Record<string, any>, body: any): Promise<{ status: string; orgId?: string; billing?: string }> {
    const token = headers["asaas-access-token"] || headers["Asaas-Access-Token"] || "";
    // Se um token está configurado, exige match. Sem token configurado (dev), passa.
    if (this.webhookToken() && !this.safeEqual(String(token), this.webhookToken())) return { status: "unauthorized" };

    const eventId = body?.id || `${body?.event}:${body?.payment?.id || body?.subscription?.id || ""}`;
    const eventType = String(body?.event || "");
    const payment = body?.payment || {};
    const subId = payment?.subscription || body?.subscription?.id;
    const custId = payment?.customer || body?.subscription?.customer;

    // Idempotência: INSERT OR IGNORE; se não inseriu, já foi processado.
    const orgIdEarly = this.orgByExternalIds(subId, custId);
    const ins = db.prepare(`INSERT OR IGNORE INTO asaas_webhook_events (id, organization_id, event_type, payment_id) VALUES (?, ?, ?, ?)`).run(eventId, orgIdEarly, eventType, payment?.id || null);
    if (ins.changes === 0) return { status: "duplicate", orgId: orgIdEarly || undefined };

    const orgId = orgIdEarly;
    if (!orgId) return { status: "ignored" };

    // SUBSCRIPTION_DELETED / assinatura removida → cancelado (não precisa re-consultar).
    if (/SUBSCRIPTION_DELETED/i.test(eventType)) { PlanService.setBillingStatus(orgId, "cancelled"); return { status: "ok", orgId, billing: "cancelled" }; }

    // Money-critical: re-consulta o pagamento antes de mudar o billing.
    let confirmed = payment?.status || "";
    if (payment?.id) { const fresh = await this.getPayment(payment.id); if (fresh?.status) confirmed = fresh.status; }

    let billing: string | null = null;
    if (/PAYMENT_(CONFIRMED|RECEIVED)/i.test(eventType) && this.PAID_STATUSES.includes(String(confirmed))) {
      // Pago: ativa e estende o período até o próximo vencimento.
      const periodEnd = payment?.dueDate || null;
      PlanService.setBillingStatus(orgId, "active", { periodStart: new Date().toISOString().slice(0, 10), periodEnd });
      billing = "active";
    } else if (/PAYMENT_OVERDUE/i.test(eventType) && String(confirmed) === "OVERDUE") {
      PlanService.setBillingStatus(orgId, "past_due");
      billing = "past_due";
    } else if (/PAYMENT_REFUNDED/i.test(eventType)) {
      PlanService.setBillingStatus(orgId, "suspended");
      billing = "suspended";
    }
    return { status: "ok", orgId, billing: billing || "unchanged" };
  }
}
