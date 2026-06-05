import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

export type Interval = "monthly" | "weekly" | "yearly";

// Assinaturas / cobrança recorrente. O tenant cria PLANOS (mensalidade, clube),
// atribui a CLIENTES (subscriptions) e cada ciclo gera uma FATURA
// (subscription_invoices). A cobrança automática vive no Scheduler (Fase 2B-2).
export class SubscriptionService {
  /** Avança uma data por um intervalo (monthly/weekly/yearly × count). */
  static addInterval(from: Date, interval: Interval, count = 1): Date {
    const d = new Date(from);
    const n = Math.max(1, count || 1);
    if (interval === "weekly") d.setDate(d.getDate() + 7 * n);
    else if (interval === "yearly") d.setFullYear(d.getFullYear() + n);
    else d.setMonth(d.getMonth() + n); // monthly (default)
    return d;
  }

  // ---- Planos ----
  static listPlans(orgId: string): any[] {
    return db.prepare("SELECT * FROM subscription_plans WHERE organization_id = ? ORDER BY active DESC, name ASC").all(orgId) as any[];
  }
  static createPlan(orgId: string, p: { name: string; description?: string; amount?: number; interval?: Interval; interval_count?: number }): { id: string } {
    const id = uuidv4();
    const interval = ["monthly", "weekly", "yearly"].includes(String(p.interval)) ? p.interval : "monthly";
    db.prepare(
      `INSERT INTO subscription_plans (id, organization_id, name, description, amount, interval, interval_count, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(id, orgId, String(p.name).trim(), p.description || null, Number(p.amount || 0), interval, Math.max(1, Number(p.interval_count) || 1));
    return { id };
  }
  static updatePlan(orgId: string, id: string, p: any): void {
    const cur = db.prepare("SELECT * FROM subscription_plans WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!cur) return;
    db.prepare(
      `UPDATE subscription_plans SET name = ?, description = ?, amount = ?, interval = ?, interval_count = ?, active = ? WHERE id = ? AND organization_id = ?`
    ).run(
      p.name ?? cur.name, p.description ?? cur.description, p.amount ?? cur.amount,
      ["monthly", "weekly", "yearly"].includes(String(p.interval)) ? p.interval : cur.interval,
      p.interval_count ? Math.max(1, Number(p.interval_count)) : cur.interval_count,
      p.active === undefined ? cur.active : (p.active ? 1 : 0), id, orgId
    );
  }

  // ---- Assinaturas ----
  static subscribe(orgId: string, p: { planId: string; contactId: string; startDate?: string; createdBy?: string }): { id: string } {
    const plan = db.prepare("SELECT * FROM subscription_plans WHERE id = ? AND organization_id = ?").get(p.planId, orgId) as any;
    if (!plan) throw new Error("plan_not_found");
    const start = p.startDate ? new Date(p.startDate) : new Date();
    if (isNaN(start.getTime())) throw new Error("invalid_date");
    const id = uuidv4();
    db.prepare(
      `INSERT INTO subscriptions (id, organization_id, plan_id, contact_id, status, amount, interval, interval_count, start_date, next_charge_at, created_by)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, plan.id, p.contactId, plan.amount, plan.interval, plan.interval_count, start.toISOString(), start.toISOString(), p.createdBy || "owner");
    return { id };
  }
  static setStatus(orgId: string, id: string, status: string): void {
    if (!["active", "paused", "past_due", "cancelled"].includes(status)) throw new Error("invalid_status");
    db.prepare("UPDATE subscriptions SET status = ? WHERE id = ? AND organization_id = ?").run(status, id, orgId);
  }
  static list(orgId: string): any[] {
    return db.prepare(
      `SELECT s.*, pl.name AS plan_name, c.name AS contact_name
         FROM subscriptions s
         LEFT JOIN subscription_plans pl ON pl.id = s.plan_id
         LEFT JOIN contacts c ON c.id = s.contact_id
        WHERE s.organization_id = ?
        ORDER BY s.created_at DESC LIMIT 1000`
    ).all(orgId) as any[];
  }

  // ---- Faturas ----
  /** Gera a fatura do ciclo atual e avança next_charge_at. Evita duplicar uma
   *  fatura pendente do mesmo período. Retorna o id da fatura (ou null). */
  static generateInvoice(orgId: string, subscriptionId: string): { id: string } | null {
    const s = db.prepare("SELECT * FROM subscriptions WHERE id = ? AND organization_id = ?").get(subscriptionId, orgId) as any;
    if (!s || s.status === "cancelled") return null;
    const periodStart = s.next_charge_at ? new Date(s.next_charge_at) : new Date();
    const periodEnd = this.addInterval(periodStart, s.interval, s.interval_count);
    // Já existe fatura pendente para este período? Não duplica.
    const dup = db.prepare(
      "SELECT id FROM subscription_invoices WHERE subscription_id = ? AND status = 'pending' AND period_start = ?"
    ).get(subscriptionId, periodStart.toISOString()) as any;
    if (dup) return { id: dup.id };

    const id = uuidv4();
    db.prepare(
      `INSERT INTO subscription_invoices (id, organization_id, subscription_id, contact_id, amount, due_date, period_start, period_end, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(id, orgId, subscriptionId, s.contact_id, s.amount, periodStart.toISOString(), periodStart.toISOString(), periodEnd.toISOString());
    // Avança o relógio da assinatura.
    db.prepare("UPDATE subscriptions SET last_charge_at = ?, next_charge_at = ? WHERE id = ?")
      .run(new Date().toISOString(), periodEnd.toISOString(), subscriptionId);
    return { id };
  }

  static markInvoicePaid(orgId: string, invoiceId: string): boolean {
    const inv = db.prepare("SELECT * FROM subscription_invoices WHERE id = ? AND organization_id = ?").get(invoiceId, orgId) as any;
    if (!inv) return false;
    if (inv.status === "paid") return true;
    db.prepare("UPDATE subscription_invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(invoiceId);
    // Se a assinatura estava em atraso, reativa.
    db.prepare("UPDATE subscriptions SET status = 'active' WHERE id = ? AND status = 'past_due'").run(inv.subscription_id);
    return true;
  }

  /** Marca que a cobrança da fatura já foi enviada (evita reenvio). */
  static setInvoiceCharged(orgId: string, invoiceId: string, ref: string): void {
    db.prepare("UPDATE subscription_invoices SET charge_ref = ? WHERE id = ? AND organization_id = ?").run(ref, invoiceId, orgId);
  }

  /** Marca a fatura como vencida e coloca a assinatura em atraso. */
  static markOverdue(orgId: string, invoiceId: string, subscriptionId: string): void {
    db.prepare("UPDATE subscription_invoices SET status = 'overdue' WHERE id = ? AND organization_id = ? AND status = 'pending'").run(invoiceId, orgId);
    db.prepare("UPDATE subscriptions SET status = 'past_due' WHERE id = ? AND organization_id = ? AND status = 'active'").run(subscriptionId, orgId);
  }

  static listInvoices(orgId: string, subscriptionId?: string): any[] {
    if (subscriptionId) {
      return db.prepare(
        "SELECT * FROM subscription_invoices WHERE organization_id = ? AND subscription_id = ? ORDER BY created_at DESC LIMIT 500"
      ).all(orgId, subscriptionId) as any[];
    }
    return db.prepare(
      `SELECT i.*, c.name AS contact_name, pl.name AS plan_name
         FROM subscription_invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id
         LEFT JOIN subscriptions s ON s.id = i.subscription_id
         LEFT JOIN subscription_plans pl ON pl.id = s.plan_id
        WHERE i.organization_id = ?
        ORDER BY i.created_at DESC LIMIT 500`
    ).all(orgId) as any[];
  }
}
