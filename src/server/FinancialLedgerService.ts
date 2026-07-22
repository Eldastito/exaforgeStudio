import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * Motor de Caixa — Livro-caixa (ADR-125 Fatia 1).
 *
 * Princípio inegociável: VENDA ≠ LUCRO ≠ CAIXA. Só dinheiro que ENTROU de fato
 * (cash_events) forma o caixa; recebível (fiado, pedido a receber) fica em
 * `receivables`/no razão do fiado e NÃO infla o caixa até quitar. Determinístico
 * (zero-token) e isolado por organization_id.
 *
 * Reuso sem digitação dupla (ADR-125 D5): `syncFromSales` reconcilia pedidos já
 * PAGOS (core `orders` status 'pago' e `comigo_orders` à vista) como entradas de
 * caixa — modelo "pull", sem tocar nos fluxos de pagamento. O fiado do Comigo
 * continua com o razão como fonte da verdade e é apenas REFLETIDO em "a receber".
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
function daysAgo(n: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export type CashDirection = "in" | "out";

export class FinancialLedgerService {
  // ── Contas ──────────────────────────────────────────────────────────────────
  static ensureDefaultAccount(orgId: string): string {
    const found = db.prepare("SELECT id FROM cash_accounts WHERE organization_id = ? AND active = 1 ORDER BY created_at LIMIT 1").get(orgId) as any;
    if (found?.id) return found.id;
    const id = randomUUID();
    db.prepare("INSERT INTO cash_accounts (id, organization_id, name, type, opening_balance, current_balance) VALUES (?, ?, 'Caixa', 'caixa', 0, 0)").run(id, orgId);
    return id;
  }

  static accounts(orgId: string) {
    return db.prepare("SELECT id, name, type, opening_balance, current_balance, active FROM cash_accounts WHERE organization_id = ? ORDER BY created_at").all(orgId) as any[];
  }

  static createAccount(orgId: string, input: { name: string; type?: string; openingBalance?: number }) {
    const id = randomUUID();
    const open = round2(input.openingBalance || 0);
    const type = ["caixa", "banco", "carteira_digital"].includes(String(input.type)) ? input.type : "caixa";
    db.prepare("INSERT INTO cash_accounts (id, organization_id, name, type, opening_balance, current_balance) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, orgId, String(input.name || "Conta").slice(0, 80), type, open, open);
    return db.prepare("SELECT id, name, type, opening_balance, current_balance, active FROM cash_accounts WHERE id = ?").get(id);
  }

  static cashOnHand(orgId: string): number {
    const r = db.prepare("SELECT COALESCE(SUM(current_balance),0) s FROM cash_accounts WHERE organization_id = ? AND active = 1").get(orgId) as any;
    return round2(r.s);
  }

  // ── Fatos de caixa ──────────────────────────────────────────────────────────
  /** Registra uma entrada/saída de caixa. Idempotente quando há `sourceId`. */
  static recordEvent(orgId: string, p: { direction: CashDirection; amount: number; eventDate?: string; accountId?: string; sourceType?: string; sourceId?: string; confidence?: string; note?: string; createdBy?: string }) {
    const amount = round2(p.amount);
    if (!(amount > 0)) return { ok: false as const, error: "invalid_amount" };
    if (p.direction !== "in" && p.direction !== "out") return { ok: false as const, error: "invalid_direction" };
    const accountId = p.accountId || this.ensureDefaultAccount(orgId);
    const eventDate = isDate(p.eventDate) ? p.eventDate! : today();
    const id = randomUUID();
    const info = db.prepare(
      `INSERT OR IGNORE INTO cash_events (id, organization_id, direction, amount, event_date, account_id, source_type, source_id, confidence, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, p.direction, amount, eventDate, accountId, p.sourceType || "manual", p.sourceId || null, p.confidence || "confirmed", p.note || null, p.createdBy || null);
    if (info.changes === 0) return { ok: true as const, deduped: true };
    const delta = p.direction === "in" ? amount : -amount;
    db.prepare("UPDATE cash_accounts SET current_balance = ROUND(current_balance + ?, 2) WHERE organization_id = ? AND id = ?").run(delta, orgId, accountId);
    return { ok: true as const, id, amount, direction: p.direction };
  }

  /** Caixa realizado (dinheiro que de fato entrou/saiu) numa janela. */
  static realizedCash(orgId: string, from: string, to: string) {
    const rows = db.prepare(
      "SELECT direction, COALESCE(SUM(amount),0) s FROM cash_events WHERE organization_id = ? AND event_date BETWEEN ? AND ? GROUP BY direction"
    ).all(orgId, from, to) as any[];
    const inflow = round2(rows.find((r) => r.direction === "in")?.s || 0);
    const outflow = round2(rows.find((r) => r.direction === "out")?.s || 0);
    return { from, to, inflow, outflow, net: round2(inflow - outflow) };
  }

  // ── Contas a pagar ────────────────────────────────────────────────────────
  static addPayable(orgId: string, input: { description: string; amount: number; dueDate: string; category?: string; supplierName?: string; recurrence?: string; createdBy?: string }) {
    if (!input.description || !isDate(input.dueDate) || !(round2(input.amount) > 0)) return { ok: false as const, error: "invalid_payable" };
    const id = randomUUID();
    const rec = ["none", "weekly", "monthly"].includes(String(input.recurrence)) ? input.recurrence : "none";
    db.prepare(`INSERT INTO payables (id, organization_id, description, category, supplier_name, amount, due_date, recurrence, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(id, orgId, String(input.description).slice(0, 160), input.category || null, input.supplierName || null, round2(input.amount), input.dueDate, rec, input.createdBy || null);
    return { ok: true as const, id };
  }

  static listPayables(orgId: string, status = "open") {
    return db.prepare("SELECT * FROM payables WHERE organization_id = ? AND status = ? ORDER BY due_date").all(orgId, status) as any[];
  }

  /** Marca a conta como paga → gera a SAÍDA de caixa (idempotente por source). */
  static payPayable(orgId: string, id: string, opts: { accountId?: string; date?: string; createdBy?: string } = {}) {
    const p = db.prepare("SELECT * FROM payables WHERE organization_id = ? AND id = ? AND status = 'open'").get(orgId, id) as any;
    if (!p) return { ok: false as const, error: "not_found_or_paid" };
    db.prepare("UPDATE payables SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    this.recordEvent(orgId, { direction: "out", amount: p.amount, eventDate: opts.date || today(), accountId: opts.accountId, sourceType: "payable", sourceId: id, note: p.description, createdBy: opts.createdBy });
    return { ok: true as const };
  }

  // ── Contas a receber ──────────────────────────────────────────────────────
  static addReceivable(orgId: string, input: { description: string; amount: number; dueDate: string; contactId?: string; probability?: number; sourceType?: string; sourceId?: string; createdBy?: string }) {
    if (!input.description || !isDate(input.dueDate) || !(round2(input.amount) > 0)) return { ok: false as const, error: "invalid_receivable" };
    const id = randomUUID();
    const prob = Math.max(0, Math.min(1, input.probability == null ? 1 : Number(input.probability)));
    const info = db.prepare(`INSERT OR IGNORE INTO receivables (id, organization_id, contact_id, description, amount, due_date, probability, status, source_type, source_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .run(id, orgId, input.contactId || null, String(input.description).slice(0, 160), round2(input.amount), input.dueDate, prob, input.sourceType || "manual", input.sourceId || null, input.createdBy || null);
    if (info.changes === 0) return { ok: true as const, deduped: true };
    return { ok: true as const, id };
  }

  static listReceivables(orgId: string, status = "open") {
    return db.prepare("SELECT * FROM receivables WHERE organization_id = ? AND status = ? ORDER BY due_date").all(orgId, status) as any[];
  }

  /** Marca o recebível como recebido → gera a ENTRADA de caixa (idempotente). */
  static receiveReceivable(orgId: string, id: string, opts: { accountId?: string; date?: string; createdBy?: string } = {}) {
    const r = db.prepare("SELECT * FROM receivables WHERE organization_id = ? AND id = ? AND status = 'open'").get(orgId, id) as any;
    if (!r) return { ok: false as const, error: "not_found_or_received" };
    db.prepare("UPDATE receivables SET status = 'received', received_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    this.recordEvent(orgId, { direction: "in", amount: r.amount, eventDate: opts.date || today(), accountId: opts.accountId, sourceType: "receivable", sourceId: id, note: r.description, createdBy: opts.createdBy });
    return { ok: true as const };
  }

  /** Total do fiado do Comigo em aberto (fonte da verdade: razão do fiado). */
  static fiadoOutstanding(orgId: string): number {
    try {
      const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind='debt'").get(orgId) as any).s;
      const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind='payment'").get(orgId) as any).s;
      return round2(debt - paid);
    } catch { return 0; }
  }

  // ── Reconciliação de vendas pagas → entrada de caixa (D5, modelo pull) ───────
  /** Cria os eventos de caixa que faltam para pedidos JÁ pagos. Idempotente. */
  static syncFromSales(orgId: string) {
    let created = 0;
    try {
      const coreOrders = db.prepare("SELECT id, total_amount, created_at FROM orders WHERE organization_id = ? AND status = 'pago'").all(orgId) as any[];
      for (const o of coreOrders) {
        const r = this.recordEvent(orgId, { direction: "in", amount: Number(o.total_amount) || 0, eventDate: String(o.created_at || today()).slice(0, 10), sourceType: "order", sourceId: o.id, note: "Venda paga" });
        if (r.ok && !("deduped" in r)) created++;
      }
    } catch { /* tabela pode não existir em alguns ambientes */ }
    try {
      // Comigo à vista (paid_via ≠ fiado) = caixa; fiado fica em "a receber".
      const comigo = db.prepare("SELECT id, total, COALESCE(paid_at, created_at) dt FROM comigo_orders WHERE organization_id = ? AND status = 'paid' AND (paid_via IS NULL OR paid_via <> 'fiado')").all(orgId) as any[];
      for (const o of comigo) {
        const r = this.recordEvent(orgId, { direction: "in", amount: Number(o.total) || 0, eventDate: String(o.dt || today()).slice(0, 10), sourceType: "comigo_order", sourceId: o.id, note: "Venda paga (Balcão)" });
        if (r.ok && !("deduped" in r)) created++;
      }
    } catch { /* noop */ }
    return { created };
  }

  // ── Resumo / overview ───────────────────────────────────────────────────────
  static summary(orgId: string) {
    this.syncFromSales(orgId); // reflete vendas pagas antes de somar
    const caixaAtual = this.cashOnHand(orgId);
    const aPagar = round2((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payables WHERE organization_id = ? AND status = 'open'").get(orgId) as any).s);
    const recebManual = round2((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM receivables WHERE organization_id = ? AND status = 'open'").get(orgId) as any).s);
    const fiado = this.fiadoOutstanding(orgId);
    const t = today();
    return {
      caixaAtual,
      aPagar,
      aReceber: round2(recebManual + fiado),
      aReceberDetalhe: { manual: recebManual, fiado },
      realizadoHoje: this.realizedCash(orgId, t, t),
      realizado7d: this.realizedCash(orgId, daysAgo(6), t),
    };
  }

  static overview(orgId: string) {
    this.ensureDefaultAccount(orgId);
    return {
      summary: this.summary(orgId),
      accounts: this.accounts(orgId),
      payables: this.listPayables(orgId, "open"),
      receivables: this.listReceivables(orgId, "open"),
      recentEvents: db.prepare("SELECT id, direction, amount, event_date, source_type, confidence, note FROM cash_events WHERE organization_id = ? ORDER BY event_date DESC, created_at DESC LIMIT 15").all(orgId),
    };
  }
}

export default FinancialLedgerService;
