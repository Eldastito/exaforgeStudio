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
 *  - **Dinheiro do dia vem do fechamento, LÍQUIDO das despesas** (RN-I-001).
 *    A soma dos itens 'dinheiro' dos fechamentos não-rejeitados da loja no dia
 *    MENOS as despesas do dia (pagas do próprio caixa — details_json). É a
 *    conta do malote que a gerente fazia à mão: R$ 200 em dinheiro − R$ 32 de
 *    despesa → malote R$ 168, sem precisar ajustar. O gerente ainda pode
 *    SOBRESCREVER um dia via `retail_cash_day_override` (o "pode ajustar").
 *  - **Saldo = entrou − depositado** (RN-I-002). Saldo corrente por dia é
 *    cumulativo (dinheiro acumulado − depósitos acumulados), robusto a depósito
 *    parcial/arredondado. Cobre a virada de mês via saldo inicial (tudo antes
 *    do 1º dia do mês).
 *  - **RETIRADA de malote × DEPÓSITO bancário** (RN-I-003). Nem toda loja
 *    deposita no banco: em algumas o dono/portador pega o dinheiro em mão. As
 *    duas coisas BAIXAM o "em caixa a depositar" (dinheiro que saiu do caixa),
 *    então `saldoBefore`/saldo do dia somam AMBAS; o que muda é o RELATÓRIO —
 *    `totalDeposited` (banco) e `totalWithdrawn` (mão) são separados, nunca
 *    misturados. `kind` = 'deposito' (default/legado) | 'retirada'.
 *  - **Isolamento multi-tenant** — toda query filtra organization_id + store_id.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { validateImageBase64 } from "./mediaValidation.js";

const r2 = (x: any) => Math.round((Number(x) || 0) * 100) / 100;
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// OCR do comprovante injetável (teste offline) — espelha __setClosingExtractorForTests.
type DepositExtractor = (base64: string, mimetype: string) => Promise<string>;
let _depositExtractor: DepositExtractor | null = null;
export function __setDepositExtractorForTests(fn: DepositExtractor | null): void { _depositExtractor = fn; }

export class RetailCashDepositService {
  /**
   * Despesas do dia por dia (saem do caixa em dinheiro — details_json do
   * fechamento). Usa o total derivado quando existe; senão soma o array
   * `despesas` (fechamento antigo, antes do campo derivado).
   */
  private static despesasByDay(orgId: string, storeId: string, start: string, end: string): Map<string, number> {
    const rows = db.prepare(
      `SELECT closing_date AS d,
              COALESCE(SUM(COALESCE(
                json_extract(details_json, '$.derived.totalDespesas'),
                (SELECT SUM(COALESCE(json_extract(j.value, '$.valor'), 0)) FROM json_each(details_json, '$.despesas') j),
                0)), 0) AS despesas
         FROM retail_daily_closings
        WHERE organization_id = ? AND store_id = ? AND closing_date BETWEEN ? AND ?
          AND status != 'rejected' AND details_json IS NOT NULL
        GROUP BY closing_date`
    ).all(orgId, storeId, start, end) as any[];
    const out = new Map<string, number>();
    for (const r of rows) { const v = r2(r.despesas); if (v > 0) out.set(String(r.d), v); }
    return out;
  }

  /**
   * Dinheiro do fechamento por dia, LÍQUIDO das despesas do dia (a conta do
   * malote: itens 'dinheiro' − despesas). Dia só com despesa fica negativo —
   * o dinheiro saiu do caixa acumulado.
   */
  private static autoCash(orgId: string, storeId: string, start: string, end: string): Map<string, { gross: number; despesas: number; net: number }> {
    const rows = db.prepare(
      `SELECT c.closing_date AS d, COALESCE(SUM(i.informed_amount), 0) AS cash
         FROM retail_daily_closings c
         JOIN retail_daily_closing_items i ON i.closing_id = c.id AND i.payment_method = 'dinheiro'
        WHERE c.organization_id = ? AND c.store_id = ? AND c.closing_date BETWEEN ? AND ? AND c.status != 'rejected'
        GROUP BY c.closing_date`
    ).all(orgId, storeId, start, end) as any[];
    const out = new Map<string, { gross: number; despesas: number; net: number }>();
    for (const r of rows) { const g = r2(r.cash); out.set(String(r.d), { gross: g, despesas: 0, net: g }); }
    for (const [d, v] of this.despesasByDay(orgId, storeId, start, end)) {
      const cur = out.get(d) || { gross: 0, despesas: 0, net: 0 };
      cur.despesas = v;
      cur.net = r2(cur.gross - v);
      out.set(d, cur);
    }
    return out;
  }

  /** Ajustes manuais do dinheiro do dia (sobrescrevem o do fechamento). */
  private static overrides(orgId: string, storeId: string, start: string, end: string): Map<string, number> {
    const rows = db.prepare(
      `SELECT cash_date AS d, amount FROM retail_cash_day_override
        WHERE organization_id = ? AND store_id = ? AND cash_date BETWEEN ? AND ?`
    ).all(orgId, storeId, start, end) as any[];
    return new Map(rows.map((r) => [String(r.d), r2(r.amount)]));
  }

  /**
   * Dinheiro efetivo do dia (override tem prioridade sobre o fechamento).
   * `amount` é o LÍQUIDO (dinheiro − despesas); `gross`/`despesas` mostram a
   * conta pra conferência quando o valor vem do fechamento.
   */
  private static cashOn(orgId: string, storeId: string, start: string, end: string): Map<string, { amount: number; source: "fechamento" | "ajuste"; gross?: number; despesas?: number }> {
    const auto = this.autoCash(orgId, storeId, start, end);
    const ov = this.overrides(orgId, storeId, start, end);
    const out = new Map<string, { amount: number; source: "fechamento" | "ajuste"; gross?: number; despesas?: number }>();
    for (const [d, a] of auto) out.set(d, { amount: a.net, gross: a.gross, despesas: a.despesas, source: "fechamento" });
    for (const [d, a] of ov) out.set(d, { amount: a, source: "ajuste" });
    return out;
  }

  /**
   * Saldo (dinheiro líquido − depósitos) de TUDO antes de `date` — carrega a
   * virada. Líquido = itens 'dinheiro' − despesas dos fechamentos (mesma conta
   * do autoCash, agregada).
   */
  private static saldoBefore(orgId: string, storeId: string, date: string): number {
    const cash = r2((db.prepare(
      `SELECT COALESCE(SUM(i.informed_amount), 0) AS s FROM retail_daily_closings c
         JOIN retail_daily_closing_items i ON i.closing_id = c.id AND i.payment_method = 'dinheiro'
        WHERE c.organization_id = ? AND c.store_id = ? AND c.closing_date < ? AND c.status != 'rejected'`
    ).get(orgId, storeId, date) as any)?.s);
    const desp = r2((db.prepare(
      `SELECT COALESCE(SUM(COALESCE(
                json_extract(details_json, '$.derived.totalDespesas'),
                (SELECT SUM(COALESCE(json_extract(j.value, '$.valor'), 0)) FROM json_each(details_json, '$.despesas') j),
                0)), 0) AS s
         FROM retail_daily_closings
        WHERE organization_id = ? AND store_id = ? AND closing_date < ?
          AND status != 'rejected' AND details_json IS NOT NULL`
    ).get(orgId, storeId, date) as any)?.s);
    // Override antes do mês: substitui o dinheiro LÍQUIDO do fechamento naquele dia.
    const ovRows = db.prepare(`SELECT cash_date AS d, amount FROM retail_cash_day_override WHERE organization_id = ? AND store_id = ? AND cash_date < ?`).all(orgId, storeId, date) as any[];
    let ovDelta = 0;
    for (const r of ovRows) {
      const d = String(r.d);
      const autoNet = this.autoCash(orgId, storeId, d, d).get(d)?.net || 0;
      ovDelta += r2(r.amount) - autoNet; // troca o auto (líquido) pelo override
    }
    const dep = r2((db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ? AND deposit_date < ?`).get(orgId, storeId, date) as any)?.s);
    return r2(cash - desp + ovDelta - dep);
  }

  /**
   * Planilha do MÊS por loja (o "malote"): por dia o dinheiro LÍQUIDO (bruto do
   * fechamento − despesas do dia, com a quebra em cashGross/cashDespesas), o
   * saldo corrente (em caixa a depositar) e o depósito daquele dia (se houve).
   * Mais os totais de conferência.
   */
  static monthLedger(orgId: string, storeId: string, month: string): any {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const [y, m] = month.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const start = `${month}-01`, end = `${month}-${String(days).padStart(2, "0")}`;

    const cash = this.cashOn(orgId, storeId, start, end);
    const deposits = db.prepare(
      `SELECT id, deposit_date, amount, period_start, period_end, depositor, receipt_url, notes, COALESCE(kind, 'deposito') AS kind
         FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ? AND deposit_date BETWEEN ? AND ?
        ORDER BY deposit_date, created_at`
    ).all(orgId, storeId, start, end) as any[];
    const depByDate = new Map<string, any[]>();
    for (const d of deposits) { const k = String(d.deposit_date); (depByDate.get(k) || depByDate.set(k, []).get(k)!).push(d); }

    const saldoInicial = this.saldoBefore(orgId, storeId, start);
    // Semanas FECHADAS (travadas) que tocam o mês — pra marcar cada dia como locked.
    const closed = this.weekClosings(orgId, storeId, month);
    const isLocked = (date: string) => closed.some((w) => w.weekStart <= date && w.weekEnd >= date);
    let saldo = saldoInicial, totalCash = 0, totalDeposited = 0, totalWithdrawn = 0;
    const rows: any[] = [];
    for (let dd = 1; dd <= days; dd++) {
      const date = `${month}-${String(dd).padStart(2, "0")}`;
      const c = cash.get(date);
      const cashAmt = c ? c.amount : 0;
      saldo = r2(saldo + cashAmt);
      totalCash = r2(totalCash + cashAmt);
      const deps = depByDate.get(date) || [];
      // Depósito (banco) e retirada (mão) baixam o caixa igual — o saldo desce
      // por AMBOS; só o relatório os separa (RN-I-003).
      const depSum = r2(deps.filter((x) => x.kind !== "retirada").reduce((a, x) => a + Number(x.amount || 0), 0));
      const retSum = r2(deps.filter((x) => x.kind === "retirada").reduce((a, x) => a + Number(x.amount || 0), 0));
      saldo = r2(saldo - depSum - retSum);
      totalDeposited = r2(totalDeposited + depSum);
      totalWithdrawn = r2(totalWithdrawn + retSum);
      rows.push({
        date, day: dd,
        cash: cashAmt, cashSource: c?.source || null,
        // A conta do malote pra conferência: bruto do fechamento − despesas.
        cashGross: c?.source === "fechamento" ? (c.gross ?? null) : null,
        cashDespesas: c?.source === "fechamento" ? (c.despesas ?? null) : null,
        deposits: deps.map((x) => ({ id: x.id, amount: r2(x.amount), kind: x.kind || "deposito", depositor: x.depositor || null, receiptUrl: x.receipt_url || null, periodStart: x.period_start || null, periodEnd: x.period_end || null, notes: x.notes || null })),
        saldo, // dinheiro em caixa (ainda não baixado) ao fim do dia
        locked: isLocked(date), // dia dentro de uma semana FECHADA (congelado)
      });
    }
    return {
      month, storeId, days,
      saldoInicial: r2(saldoInicial),
      totalCash: r2(totalCash),
      totalDeposited: r2(totalDeposited),
      totalWithdrawn: r2(totalWithdrawn),
      saldoFinal: r2(saldoInicial + totalCash - totalDeposited - totalWithdrawn), // em caixa a depositar/retirar
      rows,
      deposits: deposits.map((x) => ({ id: x.id, date: String(x.deposit_date), amount: r2(x.amount), kind: x.kind || "deposito", depositor: x.depositor || null, receiptUrl: x.receipt_url || null, periodStart: x.period_start || null, periodEnd: x.period_end || null, notes: x.notes || null })),
      weekClosings: closed, // semanas fechadas (travadas) que tocam o mês
    };
  }

  /**
   * Registra uma BAIXA do caixa (valor, data, quem, comprovante). Só owner/
   * gerente. `kind`: 'deposito' (banco, default/legado) ou 'retirada' (dinheiro
   * pego em mão). As duas baixam o "em caixa a depositar".
   */
  static registerDeposit(orgId: string, storeId: string, input: {
    date: string; amount: number; depositor?: string | null; periodStart?: string | null; periodEnd?: string | null; receiptUrl?: string | null; notes?: string | null; kind?: "deposito" | "retirada";
  }, actorId?: string): any {
    if (!storeId) throw new Error("storeId obrigatório");
    if (!isDate(input.date)) throw new Error("date (YYYY-MM-DD) obrigatório");
    const amount = r2(input.amount);
    if (!(amount > 0)) throw new Error("valor deve ser maior que zero");
    const kind = input.kind === "retirada" ? "retirada" : "deposito";
    if (this.isWeekClosed(orgId, storeId, input.date)) throw new Error("week_closed"); // semana fechada — reabra pra lançar
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_cash_deposits (id, organization_id, store_id, deposit_date, amount, period_start, period_end, depositor, receipt_url, notes, created_by, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, storeId, input.date, amount,
      isDate(input.periodStart) ? input.periodStart : null,
      isDate(input.periodEnd) ? input.periodEnd : null,
      (input.depositor || "").trim() || null,
      (input.receiptUrl || "").trim() || null,
      (input.notes || "").trim() || null,
      actorId || null, kind);
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_CASH_DEPOSIT", { date: input.date, amount, kind }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_cash_deposits WHERE id = ?`).get(id);
  }

  /**
   * Ingestão do comprovante pelo WHATSAPP (pedido do dono, 19/09/2026 — "eles
   * fazem depósito e mandam comprovante, tinha que aparecer aqui"). A gerente
   * manda a FOTO do comprovante com legenda de depósito → OCR (o MESMO
   * `extractDepositFromImage` do scan da tela) lê valor+data → registra via
   * `registerDeposit` (invariantes preservadas: valor>0, semana fechada trava).
   * Guardrails:
   *  - NUNCA inventa: valor ilegível → não registra (retorna `unreadable`;
   *    o caller orienta a mandar o valor em texto);
   *  - DEDUPE anti-conta-dupla: mesmo (loja, data, valor) já registrado →
   *    `duplicate` (reenvio do mesmo comprovante não dobra o depositado);
   *  - comprovante salvo em /media (mesmo storage do scan da tela) best-effort;
   *  - `amountOverride` cobre o caminho TEXTO ("depositei 1.500") sem foto.
   */
  static async submitFromWhatsApp(orgId: string, storeId: string, input: {
    imageBase64?: string; imageMime?: string; amountOverride?: number | null;
    fallbackDate: string; senderId: string; contactId?: string | null;
  }): Promise<{ status: "registered" | "duplicate" | "unreadable" | "week_closed"; deposit?: any; amount?: number; date?: string }> {
    let amount: number | null = input.amountOverride ?? null;
    let date: string = input.fallbackDate;
    let receiptUrl: string | null = null;

    if (input.imageBase64) {
      // Salva o comprovante (best-effort; conteúdo validado por magic bytes).
      try {
        const v = validateImageBase64(input.imageBase64);
        if (v) {
          const dir = path.join(process.env.DATA_DIR || process.cwd(), "media");
          fs.mkdirSync(dir, { recursive: true });
          const name = `${randomUUID()}.${v.ext}`;
          fs.writeFileSync(path.join(dir, name), v.buffer);
          receiptUrl = `/media/${name}`;
        }
      } catch { /* sem foto salva, o depósito ainda pode ser registrado */ }
      // OCR — valor e data do comprovante (não inventa: null quando ilegível).
      if (amount == null) {
        try {
          const extractor = _depositExtractor || (async (b: string, m: string) => (await import("./llm.js")).extractDepositFromImage(b, m));
          const parsed = JSON.parse((await extractor(input.imageBase64, input.imageMime || "image/jpeg")) || "{}");
          const v = Number(parsed?.valor);
          if (Number.isFinite(v) && v > 0) amount = r2(v);
          if (isDate(parsed?.data)) date = String(parsed.data);
        } catch { /* OCR falhou → unreadable abaixo */ }
      }
    }
    if (!(Number(amount) > 0)) return { status: "unreadable" };

    // Dedupe: o MESMO comprovante reenviado (loja+data+valor) não dobra o depositado.
    const dup = db.prepare(
      `SELECT id FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ? AND deposit_date = ? AND amount = ? LIMIT 1`
    ).get(orgId, storeId, date, r2(amount)) as any;
    if (dup) return { status: "duplicate", amount: r2(amount!), date };

    try {
      const dep = this.registerDeposit(orgId, storeId, {
        date, amount: Number(amount), receiptUrl,
        notes: `via WhatsApp (${String(input.senderId || "").slice(0, 40)})`,
      }, input.contactId || undefined);
      return { status: "registered", deposit: dep, amount: r2(amount!), date };
    } catch (e: any) {
      if (e?.message === "week_closed") return { status: "week_closed", amount: r2(amount!), date };
      throw e;
    }
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
      totalCash: r2(w.total_cash), totalDeposited: r2(w.total_deposited), totalWithdrawn: r2(w.total_withdrawn),
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
    // O intervalo é LIVRE (o malote do cliente é semanal num dia variável —
    // ex.: dia 1 → dia 8), mas um dia não pode pertencer a DOIS fechamentos:
    // reabrir é por week_start, e períodos sobrepostos deixariam dias
    // meio-travados. Mesmo start = refechar (idempotência dura, erro antigo).
    const overlap = db.prepare(
      `SELECT week_start, week_end FROM retail_cash_week_closings
        WHERE organization_id = ? AND store_id = ? AND week_start <= ? AND week_end >= ? LIMIT 1`
    ).get(orgId, storeId, input.weekEnd, input.weekStart) as any;
    if (overlap) {
      if (overlap.week_start === input.weekStart) throw new Error("week_already_closed");
      throw new Error(`Período se sobrepõe ao fechamento já feito de ${overlap.week_start} a ${overlap.week_end} — reabra-o primeiro ou escolha outro intervalo.`);
    }
    // Snapshot do dinheiro efetivo (fechamento + override) e das baixas no
    // intervalo, separando depósito (banco) de retirada (mão) — RN-I-003.
    let totalCash = 0;
    for (const { amount } of this.cashOn(orgId, storeId, input.weekStart, input.weekEnd).values()) totalCash = r2(totalCash + amount);
    const totalDeposited = r2((db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM retail_cash_deposits
        WHERE organization_id = ? AND store_id = ? AND deposit_date BETWEEN ? AND ? AND COALESCE(kind, 'deposito') != 'retirada'`
    ).get(orgId, storeId, input.weekStart, input.weekEnd) as any)?.s);
    const totalWithdrawn = r2((db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM retail_cash_deposits
        WHERE organization_id = ? AND store_id = ? AND deposit_date BETWEEN ? AND ? AND COALESCE(kind, 'deposito') = 'retirada'`
    ).get(orgId, storeId, input.weekStart, input.weekEnd) as any)?.s);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_cash_week_closings (id, organization_id, store_id, week_start, week_end, total_cash, total_deposited, total_withdrawn, depositor, receipt_url, notes, closed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, storeId, input.weekStart, input.weekEnd, totalCash, totalDeposited, totalWithdrawn,
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
