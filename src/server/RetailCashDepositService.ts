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
    // Semanas FECHADAS (travadas) que tocam o mês — pra marcar cada dia como locked.
    const closed = this.weekClosings(orgId, storeId, month);
    const isLocked = (date: string) => closed.some((w) => w.weekStart <= date && w.weekEnd >= date);
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
        locked: isLocked(date), // dia dentro de uma semana FECHADA (congelado)
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
      weekClosings: closed, // semanas fechadas (travadas) que tocam o mês
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
    if (this.isWeekClosed(orgId, storeId, input.date)) throw new Error("week_closed"); // semana fechada — reabra pra lançar
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
    const dep = db.prepare(`SELECT store_id, deposit_date FROM retail_cash_deposits WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (dep && this.isWeekClosed(orgId, dep.store_id, dep.deposit_date)) throw new Error("week_closed"); // semana fechada — reabra pra excluir
    const info = db.prepare(`DELETE FROM retail_cash_deposits WHERE organization_id = ? AND id = ?`).run(orgId, id);
    if (info.changes > 0) { try { logAuthEvent(orgId, actorId || "system", dep?.store_id || "cash", "RETAIL_CASH_DEPOSIT_REMOVED", { id }); } catch { /* noop */ } return true; }
    return false;
  }

  /** Ajuste manual do dinheiro de um dia (o "pode ajustar"). amount null = limpa. */
  static setDayOverride(orgId: string, storeId: string, date: string, amount: number | null, actorId?: string): void {
    if (!isDate(date)) throw new Error("date (YYYY-MM-DD) obrigatório");
    if (this.isWeekClosed(orgId, storeId, date)) throw new Error("week_closed"); // semana fechada — reabra pra ajustar
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

  // ── Fechamento SEMANAL travado (pedido do cliente) ─────────────────────────

  /** Um `date` (YYYY-MM-DD) cai dentro de alguma semana FECHADA desta loja? */
  static isWeekClosed(orgId: string, storeId: string, date: string): boolean {
    if (!isDate(date)) return false;
    return !!db.prepare(
      `SELECT 1 FROM retail_cash_week_closings
        WHERE organization_id = ? AND store_id = ? AND week_start <= ? AND week_end >= ? LIMIT 1`
    ).get(orgId, storeId, date, date);
  }

  /** Fechamentos que TOCAM o mês (a semana pode começar no mês anterior). */
  static weekClosings(orgId: string, storeId: string, month: string): any[] {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const [y, m] = month.split("-").map(Number);
    const mStart = `${month}-01`, mEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const rows = db.prepare(
      `SELECT * FROM retail_cash_week_closings
        WHERE organization_id = ? AND store_id = ? AND week_start <= ? AND week_end >= ?
        ORDER BY week_start`
    ).all(orgId, storeId, mEnd, mStart) as any[];
    return rows.map((w) => ({
      id: w.id, weekStart: w.week_start, weekEnd: w.week_end,
      totalCash: r2(w.total_cash), totalDeposited: r2(w.total_deposited),
      depositor: w.depositor || null, receiptUrl: w.receipt_url || null, notes: w.notes || null,
      closedAt: w.closed_at || null,
    }));
  }

  /**
   * FECHA (trava) a semana [weekStart..weekEnd] da loja: snapshot do dinheiro e do
   * depositado, quem assinou e o comprovante. Idempotência dura: UNIQUE(org,store,
   * week_start) — refechar a MESMA semana falha (`week_already_closed`). Depois de
   * fechada, os dias do intervalo ficam congelados (ver isWeekClosed nos mutadores).
   */
  static closeWeek(orgId: string, storeId: string, input: {
    weekStart: string; weekEnd: string; depositor?: string | null; receiptUrl?: string | null; notes?: string | null;
  }, actorId?: string): any {
    if (!storeId) throw new Error("storeId obrigatório");
    if (!isDate(input.weekStart) || !isDate(input.weekEnd)) throw new Error("weekStart/weekEnd (YYYY-MM-DD) obrigatórios");
    if (input.weekEnd < input.weekStart) throw new Error("weekEnd deve ser >= weekStart");
    if (db.prepare(`SELECT 1 FROM retail_cash_week_closings WHERE organization_id = ? AND store_id = ? AND week_start = ? LIMIT 1`).get(orgId, storeId, input.weekStart)) {
      throw new Error("week_already_closed");
    }
    // Snapshot do dinheiro efetivo (fechamento + override) e do depositado no intervalo.
    let totalCash = 0;
    for (const { amount } of this.cashOn(orgId, storeId, input.weekStart, input.weekEnd).values()) totalCash = r2(totalCash + amount);
    const totalDeposited = r2((db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM retail_cash_deposits
        WHERE organization_id = ? AND store_id = ? AND deposit_date BETWEEN ? AND ?`
    ).get(orgId, storeId, input.weekStart, input.weekEnd) as any)?.s);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_cash_week_closings (id, organization_id, store_id, week_start, week_end, total_cash, total_deposited, depositor, receipt_url, notes, closed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, storeId, input.weekStart, input.weekEnd, totalCash, totalDeposited,
      (input.depositor || "").trim() || null, (input.receiptUrl || "").trim() || null, (input.notes || "").trim() || null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_CASH_WEEK_CLOSED", { weekStart: input.weekStart, weekEnd: input.weekEnd, totalCash, totalDeposited }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_cash_week_closings WHERE id = ?`).get(id);
  }

  /** REABRE (destrava) uma semana fechada — só o dono/admin (imposto na rota). */
  static reopenWeek(orgId: string, storeId: string, weekStart: string, actorId?: string): boolean {
    const info = db.prepare(`DELETE FROM retail_cash_week_closings WHERE organization_id = ? AND store_id = ? AND week_start = ?`).run(orgId, storeId, weekStart);
    if (info.changes > 0) { try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_CASH_WEEK_REOPENED", { weekStart }); } catch { /* noop */ } return true; }
    return false;
  }
}
