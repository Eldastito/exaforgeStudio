/**
 * Retail Ops — MALOTE / controle de DEPÓSITO do dinheiro (ADR-083 Fase I).
 *
 * Fluxo da rede: cada loja acumula o DINHEIRO (caixa) do dia — que já vem do
 * fechamento diário (forma de pagamento 'dinheiro') — e o gerente deposita no
 * banco periodicamente (toda segunda, em geral), registrando valor, data, quem
 * depositou e a FOTO do comprovante. O dono CONFERE: o dinheiro que entrou foi
 * depositado? O saldo "em caixa" é o que ainda falta depositar.
 *
 * Decisões:
 *  - **Dinheiro do dia vem do fechamento** (RN-I-001). A soma dos itens
 *    'dinheiro' dos fechamentos não-rejeitados da loja no dia. O gerente pode
 *    SOBRESCREVER um dia via `retail_cash_day_override` (o "pode ajustar").
 *  - **Saldo = entrou − depositado** (RN-I-002). Saldo corrente por dia é
 *    cumulativo (dinheiro acumulado − depósitos acumulados), robusto a depósito
 *    parcial/arredondado. Cobre a virada de mês via saldo inicial (tudo antes
 *    do 1º dia do mês).
 *  - **Isolamento multi-tenant** — toda query filtra organization_id + store_id.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const r2 = (x: any) => Math.round((Number(x) || 0) * 100) / 100;
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export class RetailCashDepositService {
  /** Dinheiro do fechamento por dia (soma dos itens 'dinheiro', não-rejeitados). */
  private static autoCash(orgId: string, storeId: string, start: string, end: string): Map<string, number> {
    const rows = db.prepare(
      `SELECT c.closing_date AS d, COALESCE(SUM(i.informed_amount), 0) AS cash
         FROM retail_daily_closings c
         JOIN retail_daily_closing_items i ON i.closing_id = c.id AND i.payment_method = 'dinheiro'
        WHERE c.organization_id = ? AND c.store_id = ? AND c.closing_date BETWEEN ? AND ? AND c.status != 'rejected'
        GROUP BY c.closing_date`
    ).all(orgId, storeId, start, end) as any[];
    return new Map(rows.map((r) => [String(r.d), r2(r.cash)]));
  }

  /** Ajustes manuais do dinheiro do dia (sobrescrevem o do fechamento). */
  private static overrides(orgId: string, storeId: string, start: string, end: string): Map<string, number> {
    const rows = db.prepare(
      `SELECT cash_date AS d, amount FROM retail_cash_day_override
        WHERE organization_id = ? AND store_id = ? AND cash_date BETWEEN ? AND ?`
    ).all(orgId, storeId, start, end) as any[];
    return new Map(rows.map((r) => [String(r.d), r2(r.amount)]));
  }

  /** Dinheiro efetivo do dia (override tem prioridade sobre o fechamento). */
  private static cashOn(orgId: string, storeId: string, start: string, end: string): Map<string, { amount: number; source: "fechamento" | "ajuste" }> {
    const auto = this.autoCash(orgId, storeId, start, end);
    const ov = this.overrides(orgId, storeId, start, end);
    const out = new Map<string, { amount: number; source: "fechamento" | "ajuste" }>();
    for (const [d, a] of auto) out.set(d, { amount: a, source: "fechamento" });
    for (const [d, a] of ov) out.set(d, { amount: a, source: "ajuste" });
    return out;
  }

  /** Saldo (dinheiro − depósitos) de TUDO antes de `date` — carrega a virada. */
  private static saldoBefore(orgId: string, storeId: string, date: string): number {
    const cash = r2((db.prepare(
      `SELECT COALESCE(SUM(i.informed_amount), 0) AS s FROM retail_daily_closings c
         JOIN retail_daily_closing_items i ON i.closing_id = c.id AND i.payment_method = 'dinheiro'
        WHERE c.organization_id = ? AND c.store_id = ? AND c.closing_date < ? AND c.status != 'rejected'`
    ).get(orgId, storeId, date) as any)?.s);
    // Override antes do mês: substitui o dinheiro do fechamento naquele dia.
    const ovRows = db.prepare(`SELECT cash_date AS d, amount FROM retail_cash_day_override WHERE organization_id = ? AND store_id = ? AND cash_date < ?`).all(orgId, storeId, date) as any[];
    let ovDelta = 0;
    for (const r of ovRows) {
      const auto = r2((db.prepare(
        `SELECT COALESCE(SUM(i.informed_amount), 0) AS s FROM retail_daily_closings c
           JOIN retail_daily_closing_items i ON i.closing_id = c.id AND i.payment_method = 'dinheiro'
          WHERE c.organization_id = ? AND c.store_id = ? AND c.closing_date = ? AND c.status != 'rejected'`
      ).get(orgId, storeId, String(r.d)) as any)?.s);
      ovDelta += r2(r.amount) - auto; // troca o auto pelo override
    }
    const dep = r2((db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ? AND deposit_date < ?`).get(orgId, storeId, date) as any)?.s);
    return r2(cash + ovDelta - dep);
  }

  /**
   * Planilha do MÊS por loja (o "malote"): por dia o dinheiro, o saldo corrente
   * (em caixa a depositar) e o depósito daquele dia (se houve). Mais os totais
   * de conferência.
   */
  static monthLedger(orgId: string, storeId: string, month: string): any {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const [y, m] = month.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const start = `${month}-01`, end = `${month}-${String(days).padStart(2, "0")}`;

    const cash = this.cashOn(orgId, storeId, start, end);
    const deposits = db.prepare(
      `SELECT id, deposit_date, amount, period_start, period_end, depositor, receipt_url, notes
         FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ? AND deposit_date BETWEEN ? AND ?
        ORDER BY deposit_date, created_at`
    ).all(orgId, storeId, start, end) as any[];
    const depByDate = new Map<string, any[]>();
    for (const d of deposits) { const k = String(d.deposit_date); (depByDate.get(k) || depByDate.set(k, []).get(k)!).push(d); }

    const saldoInicial = this.saldoBefore(orgId, storeId, start);
    let saldo = saldoInicial, totalCash = 0, totalDep = 0;
    const rows: any[] = [];
    for (let dd = 1; dd <= days; dd++) {
      const date = `${month}-${String(dd).padStart(2, "0")}`;
      const c = cash.get(date);
      const cashAmt = c ? c.amount : 0;
      saldo = r2(saldo + cashAmt);
      totalCash = r2(totalCash + cashAmt);
      const deps = depByDate.get(date) || [];
      const depTotal = r2(deps.reduce((a, x) => a + Number(x.amount || 0), 0));
      saldo = r2(saldo - depTotal);
      totalDep = r2(totalDep + depTotal);
      rows.push({
        date, day: dd,
        cash: cashAmt, cashSource: c?.source || null,
        deposits: deps.map((x) => ({ id: x.id, amount: r2(x.amount), depositor: x.depositor || null, receiptUrl: x.receipt_url || null, periodStart: x.period_start || null, periodEnd: x.period_end || null, notes: x.notes || null })),
        saldo, // dinheiro em caixa (ainda não depositado) ao fim do dia
      });
    }
    return {
      month, storeId, days,
      saldoInicial: r2(saldoInicial),
      totalCash: r2(totalCash),
      totalDeposited: r2(totalDep),
      saldoFinal: r2(saldoInicial + totalCash - totalDep), // em caixa a depositar
      rows,
      deposits: deposits.map((x) => ({ id: x.id, date: String(x.deposit_date), amount: r2(x.amount), depositor: x.depositor || null, receiptUrl: x.receipt_url || null, periodStart: x.period_start || null, periodEnd: x.period_end || null, notes: x.notes || null })),
    };
  }

  /** Registra um depósito (valor, data, quem, comprovante). Só owner/gerente. */
  static registerDeposit(orgId: string, storeId: string, input: {
    date: string; amount: number; depositor?: string | null; periodStart?: string | null; periodEnd?: string | null; receiptUrl?: string | null; notes?: string | null;
  }, actorId?: string): any {
    if (!storeId) throw new Error("storeId obrigatório");
    if (!isDate(input.date)) throw new Error("date (YYYY-MM-DD) obrigatório");
    const amount = r2(input.amount);
    if (!(amount > 0)) throw new Error("valor do depósito deve ser maior que zero");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_cash_deposits (id, organization_id, store_id, deposit_date, amount, period_start, period_end, depositor, receipt_url, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, storeId, input.date, amount,
      isDate(input.periodStart) ? input.periodStart : null,
      isDate(input.periodEnd) ? input.periodEnd : null,
      (input.depositor || "").trim() || null,
      (input.receiptUrl || "").trim() || null,
      (input.notes || "").trim() || null,
      actorId || null);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_CASH_DEPOSIT", { date: input.date, amount }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_cash_deposits WHERE id = ?`).get(id);
  }

  /** Anexa/atualiza a foto do comprovante de um depósito já registrado. */
  static setReceipt(orgId: string, id: string, receiptUrl: string): boolean {
    const info = db.prepare(`UPDATE retail_cash_deposits SET receipt_url = ? WHERE organization_id = ? AND id = ?`).run(receiptUrl, orgId, id);
    return info.changes > 0;
  }

  static removeDeposit(orgId: string, id: string, actorId?: string): boolean {
    const dep = db.prepare(`SELECT store_id FROM retail_cash_deposits WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    const info = db.prepare(`DELETE FROM retail_cash_deposits WHERE organization_id = ? AND id = ?`).run(orgId, id);
    if (info.changes > 0) { try { logAuthEvent(orgId, actorId || "system", dep?.store_id || "cash", "RETAIL_CASH_DEPOSIT_REMOVED", { id }); } catch { /* noop */ } return true; }
    return false;
  }

  /** Ajuste manual do dinheiro de um dia (o "pode ajustar"). amount null = limpa. */
  static setDayOverride(orgId: string, storeId: string, date: string, amount: number | null, actorId?: string): void {
    if (!isDate(date)) throw new Error("date (YYYY-MM-DD) obrigatório");
    if (amount == null) {
      db.prepare(`DELETE FROM retail_cash_day_override WHERE organization_id = ? AND store_id = ? AND cash_date = ?`).run(orgId, storeId, date);
      return;
    }
    db.prepare(
      `INSERT INTO retail_cash_day_override (id, organization_id, store_id, cash_date, amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, cash_date) DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP`
    ).run(randomUUID(), orgId, storeId, date, r2(amount), actorId || null);
  }
}
