import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailStoreCostService } from "./RetailStoreCostService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { logAuthEvent } from "./auditLog.js";
import { todaySP } from "./spDate.js";

/**
 * StrategicPlanService — ADR-205 F4.4: plano de período (mês/trimestre/ano) escrito pelo DONO + acompanhamento "plano × realizado".
 *
 * É a INTENÇÃO humana, não uma previsão: o dono registra (a) a meta de faturamento do período, (b) o orçamento por categoria e (c) o calendário de eventos estratégicos
 * (coleção nova, Black Friday, abertura de loja) com o impacto de caixa que ELE declara. O sistema guarda versões, e deriva por query o quanto já foi realizado.
 * Não projeta o futuro, não sugere meta, não calcula "o que deveria ser" — para "e se?" existe o `ScenarioEngine` (F4.1); para decisões, `StrategicDecisionService` (F4.2).
 *
 * Regras (RN-F4):
 *  - Plano = decisão humana (RN-F4-2): só owner/admin cria, revisa, ativa e encerra. Nada aqui executa (RN-F4-1) — sem ação, tarefa, pedido, mensagem ou sinal.
 *  - Versionado e append-only (RN-F4-4, convenção nº 9): revisar cria a versão N+1 e as anteriores ficam; nada é apagado.
 *  - Realizado SEMPRE derivado (RN-004): faturamento dos fechamentos das lojas; orçamento das contas a pagar lançadas na categoria. Sem fonte → `null`, nunca 0 (RN-F4-6).
 *  - Orçamento só enxerga o que foi LANÇADO como conta a pagar com a categoria do plano — gasto não lançado não existe para o sistema, e isso é dito.
 *  - "Ritmo esperado" é uma régua LINEAR de calendário (dias decorridos ÷ dias do período), declarada como régua — não é previsão nem leva sazonalidade em conta.
 *  - Impacto de caixa dos eventos é DECLARADO pelo dono; somado à parte e rotulado, nunca misturado ao caixa projetado.
 *  - Texto livre é dado do dono (truncado, sem controle), nunca instrução.
 */
export type PeriodType = "month" | "quarter" | "year";
export type PlanStatus = "draft" | "active" | "closed";
export type LineKind = "revenue_target" | "budget" | "event";
export const BUDGET_CATEGORIES = ["compras", "marketing", "pessoal", "estoque", "aluguel", "outros"] as const;
const PERIOD_TYPES: PeriodType[] = ["month", "quarter", "year"];
const MAX_LINES = 60;
const PACE_BAND_PCT = 10;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const isOwner = (actor: any) => !!actor?.userId && ["owner", "admin"].includes(String(actor?.role || ""));
const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const clean = (v: unknown, max: number): string | null => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return s || null; };
const isDate = (s: any) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNum = (d: string) => Math.floor(Date.parse(d + "T00:00:00Z") / 86400e3);

export function periodRange(type: PeriodType, key: string): { from: string; to: string } | null {
  if (type === "month") { const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key); if (!m) return null; const y = +m[1], mo = +m[2]; return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(lastDay(y, mo))}` }; }
  if (type === "quarter") { const m = /^(\d{4})-Q([1-4])$/.exec(key); if (!m) return null; const y = +m[1], q = +m[2], a = (q - 1) * 3 + 1, b = a + 2; return { from: `${y}-${pad(a)}-01`, to: `${y}-${pad(b)}-${pad(lastDay(y, b))}` }; }
  const m = /^(\d{4})$/.exec(key); if (!m) return null; return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
}
const monthsIn = (from: string, to: string) => { const out: string[] = []; let [y, m] = from.slice(0, 7).split("-").map(Number); const [ty, tm] = to.slice(0, 7).split("-").map(Number); while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } } return out; };
const previousKey = (type: PeriodType, key: string): string => {
  if (type === "year") return String(+key - 1);
  if (type === "quarter") { const [y, q] = key.split("-Q").map(Number); return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`; }
  const [y, m] = key.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
};

type LineInput = { kind: LineKind; label?: string; category?: string; amount?: number; eventDate?: string; cashImpact?: number | null; note?: string };

export class StrategicPlanService {
  private static normalizeLines(range: { from: string; to: string }, raw: any): any[] {
    if (!Array.isArray(raw)) throw bad("invalid_lines", "As linhas do plano devem ser uma lista.");
    if (raw.length > MAX_LINES) throw bad("too_many_lines", `O plano aceita no máximo ${MAX_LINES} linhas.`);
    return raw.map((l: LineInput) => {
      const kind = String(l?.kind || "") as LineKind;
      if (kind === "revenue_target") {
        const amount = Number(l.amount); if (!Number.isFinite(amount) || amount <= 0) throw bad("invalid_amount", "A meta de faturamento deve ser maior que zero.");
        return { kind, label: clean(l.label, 120) || "Faturamento", category: null, amount: round2(amount), eventDate: null, cashImpact: null, note: clean(l.note, 300) };
      }
      if (kind === "budget") {
        const category = String(l.category || "").toLowerCase();
        if (!(BUDGET_CATEGORIES as readonly string[]).includes(category)) throw bad("invalid_category", `Categoria de orçamento inválida (${BUDGET_CATEGORIES.join(", ")}).`);
        const amount = Number(l.amount); if (!Number.isFinite(amount) || amount <= 0) throw bad("invalid_amount", "O orçamento deve ser maior que zero.");
        return { kind, label: clean(l.label, 120) || category, category, amount: round2(amount), eventDate: null, cashImpact: null, note: clean(l.note, 300) };
      }
      if (kind === "event") {
        const label = clean(l.label, 120); if (!label || label.length < 3) throw bad("invalid_label", "O evento precisa de um nome (mínimo 3 letras).");
        if (!isDate(l.eventDate) || l.eventDate! < range.from || l.eventDate! > range.to) throw bad("invalid_event_date", "A data do evento deve estar dentro do período do plano (AAAA-MM-DD).");
        let cash: number | null = null;
        if (l.cashImpact !== undefined && l.cashImpact !== null && (l.cashImpact as any) !== "") { cash = Number(l.cashImpact); if (!Number.isFinite(cash)) throw bad("invalid_cash_impact", "Impacto de caixa inválido (use um número; negativo = saída)."); cash = round2(cash); }
        return { kind, label, category: null, amount: null, eventDate: l.eventDate, cashImpact: cash, note: clean(l.note, 300) };
      }
      throw bad("invalid_kind", "Tipo de linha inválido (revenue_target, budget ou event).");
    });
  }

  private static insertLines(orgId: string, planId: string, version: number, lines: any[]) {
    const ins = db.prepare(`INSERT INTO strategic_plan_lines (id, organization_id, plan_id, version, kind, label, category, amount, event_date, cash_impact, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of lines) ins.run(randomUUID(), orgId, planId, version, l.kind, l.label, l.category, l.amount, l.eventDate, l.cashImpact, l.note);
  }

  static create(orgId: string, actor: any, input: any) {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador cria o plano.");
    const type = String(input?.periodType || "") as PeriodType;
    if (!PERIOD_TYPES.includes(type)) throw bad("invalid_period_type", "Tipo de período inválido (month, quarter ou year).");
    const key = String(input?.periodKey || "");
    const range = periodRange(type, key);
    if (!range) throw bad("invalid_period", "Período inválido (mês AAAA-MM, trimestre AAAA-Qn, ano AAAA).");
    if (range.to < todaySP()) throw bad("invalid_period", "Esse período já terminou — o plano é para o período atual ou futuro.");
    const title = clean(input?.title, 160); if (!title || title.length < 3) throw bad("invalid_title", "Dê um título ao plano (mínimo 3 letras).");
    const lines = this.normalizeLines(range, input?.lines ?? []);
    const exists = db.prepare(`SELECT id FROM strategic_plans WHERE organization_id = ? AND period_type = ? AND period_key = ? AND status IN ('draft','active')`).get(orgId, type, key);
    if (exists) throw bad("plan_exists", "Já existe um plano em aberto para esse período — revise-o em vez de criar outro.");
    const id = randomUUID();
    db.transaction(() => {
      db.prepare(`INSERT INTO strategic_plans (id, organization_id, period_type, period_key, title, objective, status, version, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, CURRENT_TIMESTAMP)`).run(id, orgId, type, key, title, clean(input?.objective, 600), actor.userId);
      this.insertLines(orgId, id, 1, lines);
    })();
    try { logAuthEvent(orgId, actor.userId, id, "STRATEGIC_PLAN_CREATED", { periodType: type, periodKey: key, lines: lines.length }); } catch { /* noop */ }
    return this.get(orgId, id)!;
  }

  /** Revisar = nova versão (as anteriores ficam). Só plano em aberto (rascunho/ativo). */
  static revise(orgId: string, id: string, actor: any, patch: any) {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador revisa o plano.");
    const p = db.prepare(`SELECT * FROM strategic_plans WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!p) throw bad("not_found", "Plano não encontrado.");
    if (p.status === "closed") throw bad("plan_closed", "Plano encerrado não se revisa.");
    const range = periodRange(p.period_type, p.period_key)!;
    const lines = this.normalizeLines(range, patch?.lines ?? []);
    const next = p.version + 1;
    db.transaction(() => {
      this.insertLines(orgId, id, next, lines);
      db.prepare(`UPDATE strategic_plans SET version = ?, title = COALESCE(?, title), objective = CASE WHEN ? THEN ? ELSE objective END, change_note = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
        .run(next, patch?.title !== undefined ? clean(patch.title, 160) : null, patch?.objective !== undefined ? 1 : 0, clean(patch?.objective, 600), clean(patch?.changeNote, 300), orgId, id);
    })();
    try { logAuthEvent(orgId, actor.userId, id, "STRATEGIC_PLAN_REVISED", { toVersion: next, lines: lines.length }); } catch { /* noop */ }
    return this.get(orgId, id)!;
  }

  static activate(orgId: string, id: string, actor: any) {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador ativa o plano.");
    const p = db.prepare(`SELECT * FROM strategic_plans WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!p) throw bad("not_found", "Plano não encontrado.");
    if (p.status !== "draft") throw bad("invalid_state", "Só um rascunho pode ser ativado.");
    const n = (db.prepare(`SELECT COUNT(*) c FROM strategic_plan_lines WHERE organization_id = ? AND plan_id = ? AND version = ?`).get(orgId, id, p.version) as any).c;
    if (!n) throw bad("empty_plan", "Um plano sem nenhuma linha não pode ser ativado.");
    db.prepare(`UPDATE strategic_plans SET status = 'active', activated_by = ?, activated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(actor.userId, orgId, id);
    try { logAuthEvent(orgId, actor.userId, id, "STRATEGIC_PLAN_ACTIVATED", { version: p.version }); } catch { /* noop */ }
    return this.get(orgId, id)!;
  }

  static close(orgId: string, id: string, actor: any, note?: string) {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador encerra o plano.");
    const p = db.prepare(`SELECT * FROM strategic_plans WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!p) throw bad("not_found", "Plano não encontrado.");
    if (p.status === "closed") throw bad("invalid_state", "O plano já está encerrado.");
    db.prepare(`UPDATE strategic_plans SET status = 'closed', closed_at = CURRENT_TIMESTAMP, change_note = COALESCE(?, change_note), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(clean(note, 300), orgId, id);
    try { logAuthEvent(orgId, actor.userId, id, "STRATEGIC_PLAN_CLOSED", {}); } catch { /* noop */ }
    return this.get(orgId, id)!;
  }

  private static shape(orgId: string, p: any) {
    const lines = (db.prepare(`SELECT * FROM strategic_plan_lines WHERE organization_id = ? AND plan_id = ? AND version = ? ORDER BY kind, event_date, rowid`).all(orgId, p.id, p.version) as any[])
      .map((l) => ({ id: l.id, kind: l.kind, label: l.label, category: l.category, amount: l.amount, eventDate: l.event_date, cashImpact: l.cash_impact, note: l.note }));
    const versions = (db.prepare(`SELECT version, COUNT(*) AS lines, MIN(created_at) AS at FROM strategic_plan_lines WHERE organization_id = ? AND plan_id = ? GROUP BY version ORDER BY version`).all(orgId, p.id) as any[]).map((v) => ({ version: v.version, lines: v.lines, at: v.at }));
    return { id: p.id, periodType: p.period_type, periodKey: p.period_key, ...periodRange(p.period_type, p.period_key)!, title: p.title, objective: p.objective, status: p.status, version: p.version, changeNote: p.change_note ?? null, basis: "owner_plan" as const, isForecast: false, executes: false, lines, versions, createdAt: p.created_at, activatedAt: p.activated_at ?? null, closedAt: p.closed_at ?? null };
  }

  static get(orgId: string, id: string) {
    const p = db.prepare(`SELECT * FROM strategic_plans WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    return p ? this.shape(orgId, p) : null;
  }

  static list(orgId: string, f: { periodType?: string; status?: string } = {}) {
    const rows = db.prepare(`SELECT * FROM strategic_plans WHERE organization_id = ? ORDER BY period_key DESC, created_at DESC`).all(orgId) as any[];
    return rows.filter((r) => (!f.periodType || r.period_type === f.periodType) && (!f.status || r.status === f.status)).map((r) => { const s = this.shape(orgId, r); return { id: s.id, periodType: s.periodType, periodKey: s.periodKey, title: s.title, status: s.status, version: s.version, lines: s.lines.length }; });
  }

  private static revenueActual(orgId: string, from: string, to: string, upTo: string): number | null {
    let total = 0, any = false;
    for (const m of monthsIn(from, to)) { if (m + "-01" > upTo) break; const v = RetailStoreCostService.monthlyRevenueAll(orgId, m); for (const x of v.values()) { if (x > 0) { total += x; any = true; } } }
    return any ? round2(total) : null; // sem nenhum fechamento = sem dado, não "faturou zero"
  }

  /** Plano × realizado, derivado a cada leitura. Não projeta nada. */
  static track(orgId: string, id: string, opts: { asOf?: string } = {}) {
    const plan = this.get(orgId, id);
    if (!plan) throw bad("not_found", "Plano não encontrado.");
    const asOf = opts.asOf && isDate(opts.asOf) ? opts.asOf : todaySP();
    const started = asOf >= plan.from, finished = asOf > plan.to;
    const totalDays = dayNum(plan.to) - dayNum(plan.from) + 1;
    const elapsed = !started ? 0 : Math.min(totalDays, dayNum(asOf) - dayNum(plan.from) + 1);
    const elapsedPct = round2((elapsed / totalDays) * 100);
    const upTo = finished ? plan.to : asOf;

    const targets = plan.lines.filter((l) => l.kind === "revenue_target");
    const target = targets.length ? round2(targets.reduce((a, l) => a + (l.amount || 0), 0)) : null;
    const actual = started ? this.revenueActual(orgId, plan.from, plan.to, upTo) : null;
    const prevKey = previousKey(plan.periodType, plan.periodKey), prevRange = periodRange(plan.periodType, prevKey)!;
    const prevActual = this.revenueActual(orgId, prevRange.from, prevRange.to, prevRange.to);
    let paceStatus: string | null = null, progressPct: number | null = null;
    if (target != null && actual != null) {
      progressPct = round2((actual / target) * 100);
      const gap = progressPct - elapsedPct;
      paceStatus = finished ? (progressPct >= 100 ? "met" : "missed") : Math.abs(gap) <= PACE_BAND_PCT ? "on_pace" : gap > 0 ? "ahead" : "behind";
    } else if (target != null && !started) paceStatus = "not_started";
    const revenue = { target, actual, progressPct, elapsedPct, paceStatus, previousPeriod: { periodKey: prevKey, actual: prevActual }, targetVsPreviousPct: target != null && prevActual ? round2(((target - prevActual) / prevActual) * 100) : null, source: "retail_daily_closings" };

    const tracked = (() => { try { return FinancialLedgerService.tracking(orgId).payables; } catch { return false; } })();
    const budgets = plan.lines.filter((l) => l.kind === "budget").map((l) => {
      let committed: number | null = null, paid: number | null = null;
      if (tracked) {
        const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status != 'canceled' THEN amount END), 0) AS c, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS p FROM payables WHERE organization_id = ? AND LOWER(COALESCE(category, '')) = ? AND due_date >= ? AND due_date <= ?`).get(orgId, l.category, plan.from, plan.to) as any;
        committed = round2(r.c); paid = round2(r.p);
      }
      const planned = l.amount as number;
      return { label: l.label, category: l.category, planned, committed, paid, remaining: committed == null ? null : round2(planned - committed), overBudget: committed == null ? null : committed > planned };
    });

    const events = plan.lines.filter((l) => l.kind === "event").map((l) => ({ label: l.label, eventDate: l.eventDate!, cashImpact: l.cashImpact, daysUntil: dayNum(l.eventDate!) - dayNum(asOf), passed: l.eventDate! < asOf })).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
    const declared = events.filter((e) => e.cashImpact != null);
    const calendar = { events, declaredCashImpactTotal: declared.length ? round2(declared.reduce((a, e) => a + (e.cashImpact as number), 0)) : null, declaredEvents: declared.length, note: "Impacto de caixa DECLARADO pelo dono — não é projeção e não entra no caixa previsto." };

    const caveats = [
      "É o PLANO do dono (intenção), não uma previsão. O realizado vem do que o sistema consegue ver.",
      "Faturamento = fechamentos diários das lojas; sem fechamento no período o realizado fica vazio (não é zero).",
      tracked ? "Orçamento = contas a pagar LANÇADAS com a categoria do plano; gasto não lançado não aparece." : "Contas a pagar não estão sendo lançadas: o orçamento não tem como ser acompanhado.",
      "O ritmo esperado é uma régua linear de calendário — não considera sazonalidade nem foi calibrada com a história da loja.",
    ];
    if (plan.status === "draft") caveats.push("Plano ainda em rascunho (não ativado).");
    return { type: "plan_tracking" as const, isForecast: false, executes: false, planId: plan.id, periodKey: plan.periodKey, status: plan.status, version: plan.version, asOf, started, finished, revenue, budgets, calendar, caveats };
  }
}
export default StrategicPlanService;
