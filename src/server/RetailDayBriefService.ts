/**
 * RetailDayBriefService — cota da MANHÃ e fechamento da NOITE por loja (PRD Fase 1, F1.6a + F1.6c).
 *
 * Pedido do gestor da rede: de manhã, "quanto cada loja tem que vender hoje" (a cota por loja); à noite,
 * por loja "venda, cota, dinheiro e o acumulado da semana e do mês". A parcial das 16h é a F1.6b
 * (`RetailAfternoonBriefService`); aqui ficam os outros dois momentos, com a mesma honestidade.
 *
 * Fontes (nada novo é criado — só leitura sobre o que a rede já alimenta):
 *  - cota: `retail_store_quotas` (cota do dia por loja);
 *  - venda da noite: a FOLHA do fechamento (`retail_daily_closings`) na fonte OFICIAL da org
 *    (`RetailSalesPolicy` — TOULON = folha). NÃO é o parcial do caixa: à noite a venda oficial já existe;
 *  - dinheiro: `details_json.dinheiro` do fechamento detalhado.
 *
 * Honestidade (F1.0 — nada vira 0 por falta de dado):
 *  - loja sem cota cadastrada → "—" (nunca "R$ 0"); rede só soma quando TODA loja ativa tem cota;
 *  - fechamento ainda não lançado (ou sem valor) → "aguardando fechamento" ("—"), nunca "vendeu R$ 0";
 *  - dinheiro sem detalhe no fechamento → "—";
 *  - acumulado da semana/mês só é TOTAL quando não falta fechamento de nenhum dia com cota; se faltar, o
 *    parcial aparece rotulado ("parcial — faltam N dias") e o atingimento não é calculado.
 * Entrega da noite (F1.6d): UM resumo POR HORÁRIO DE FECHAMENTO. Lojas de shopping fecham em horários diferentes (TOULON: Avenida
 * Brasil 19h, demais 22h) — cada loja vai no resumo do SEU horário (`retail_stores.closing_brief_time`, HH:MM de SP; vazio = 22:30 da
 * rede): ex. 19:30 só Avenida Brasil; 22:30 as demais + o bloco 'Rede' (o último horário do dia fecha a rede toda). Loja que não abre
 * naquele dia (closed_weekdays — Av. Brasil aos domingos) sai do dia: nem resumo, nem 'aguardando', nem trava o total da rede.
 * WhatsApp pra owner/admin com telefone (dinheiro é role-gated §73), opt-in por org, dedupe por (usuário, dia, horário) — a chave
 * `brief_date` guarda `YYYY-MM-DD#HH:MM` (sem mudar o schema), janela de 3h a partir do horário, `send` injetado (testável sem
 * rede). Determinístico, sem LLM. Isola por org.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";
import { onlyDigits } from "./phoneMatch.js";
import { officialSaleSourceOf, officialSaleSql } from "./RetailSalesPolicy.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { RetailMonthlyGoalService } from "./RetailMonthlyGoalService.js";
import { RetailExceptionSignalService } from "./RetailExceptionSignalService.js";
import { combineMetrics, formatMetric, known, ratioMetric, unknown, notComputed, type Metric } from "../lib/metric.js";

export const DEFAULT_NIGHT_TIME = "22:30";         // padrão da rede (lojas sem closing_brief_time) — hora de São Paulo
const SLOT_WINDOW_MIN = 180;                        // envia até 3h depois do horário (se o servidor estava fora do ar), sem passar da meia-noite
const CLOSED_OK = "('received','extracted','needs_review','reconciled','divergent','approved')";

const round2 = (n: number) => Math.round(n * 100) / 100;
const brl = (m: Metric) => formatMetric(m, { unit: "brl" }).replace(/,00(?=$| —)/, "");
const brlN = (n: number) => brl(known(round2(n), { unit: "brl" }));
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T12:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
/** Segunda-feira da semana (Brasil: semana seg–dom) que contém a data. */
export function weekStartOf(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();            // 0=dom
  return addDays(date, -((dow + 6) % 7));
}

/** Lojas ativas que ABREM na data (closed_weekdays — ex.: Avenida Brasil não abre aos domingos). Fecha nada de loja fechada entra no dia. */
function storesOpenOn(orgId: string, date: string, cols = "id, name"): any[] {
  const all = db.prepare(`SELECT ${cols} FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
  return all.filter((s) => { try { return !RetailClosingService.isStoreClosedOnDate(orgId, s.id, date); } catch { return true; } });
}
/** Minutos do dia em São Paulo. */
function spMinutes(now: Date): { dateSP: string; min: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "0";
  return { dateSP: `${g("year")}-${g("month")}-${g("day")}`, min: Number(g("hour")) * 60 + Number(g("minute")) };
}
const hhmmToMin = (t: string) => { const m = String(t).match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** `cotaBasis`: de onde veio o denominador — `meta_mensal` (PRD §12, cadastrada) ou `cotas_diarias` (soma das cotas do período). */
export type Period = { venda: Metric; cota: Metric; atingimento: Metric; partial: number | null; missingDays: number; cotaBasis?: "meta_mensal" | "cotas_diarias" };
export type NightStore = { storeId: string; storeName: string; venda: Metric; cota: Metric; atingimento: Metric; dinheiro: Metric; week: Period; month: Period };
export type NightSnapshot = {
  date: string; weekStart: string; monthStart: string; source: "folha" | "system";
  stores: NightStore[]; network: { venda: Metric; cota: Metric; atingimento: Metric; dinheiro: Metric; partialVenda: number | null; week: Period; month: Period; storesHit: number | null; storesBelow: number | null; storesNoData: number };
};
export type MorningQuotas = { date: string; stores: Array<{ storeId: string; storeName: string; meta: Metric }>; network: { meta: Metric; partialMeta: number | null }; withoutQuota: string[] };

export class RetailDayBriefService {
  // ── F1.6a — cota da manhã ──────────────────────────────────────────────────
  /** null = a org não cadastrou NENHUMA cota pra hoje (não há o que dizer; o resumo da manhã segue igual). */
  static morningQuotas(orgId: string, date: string): MorningQuotas | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const stores = storesOpenOn(orgId, date);
    const quotas = new Map((db.prepare(`SELECT store_id, quota_amount FROM retail_store_quotas WHERE organization_id = ? AND quota_date = ?`).all(orgId, date) as any[]).map((q) => [q.store_id, Number(q.quota_amount)]));
    const rows = stores.map((s) => ({
      storeId: s.id as string, storeName: s.name as string,
      meta: quotas.has(s.id) && Number.isFinite(quotas.get(s.id)) ? known(round2(quotas.get(s.id) as number), { unit: "brl", source: "cota do dia" }) : unknown("cota do dia não cadastrada", { unit: "brl" }),
    }));
    if (!rows.some((r) => r.meta.state === "value")) return null;
    const net = combineMetrics(rows.map((r) => r.meta), { unit: "brl" });
    return { date, stores: rows, network: { meta: net.fact, partialMeta: net.partialFact }, withoutQuota: rows.filter((r) => r.meta.state !== "value").map((r) => r.storeName) };
  }

  /**
   * Exceções realmente importantes do dia (PRD §9): "<loja> está sem escala" e "N vendedores ainda precisam ser
   * identificados". Honesto: só fala de escala se a org USA escala (há alguma entrada cadastrada) — org sem escala não é cobrada.
   */
  static morningExceptions(orgId: string, date: string): string[] {
    // Fonte única (S4c-2): a mesma definição que gera os assuntos da Central de Saúde. Org sem escala não é cobrada; folga geral não é "sem escala".
    try { return RetailExceptionSignalService.items(orgId, date).map((x) => x.text); } catch { return []; }
  }

  /** Linhas pro resumo da manhã (vazio quando não há cota cadastrada — 0-regressão). */
  static morningLines(orgId: string, date: string): string[] {
    let q: MorningQuotas | null = null;
    try { q = this.morningQuotas(orgId, date); } catch { return []; }
    if (!q) return [];
    const lines = ["*🎯 Meta de hoje por loja:*"];
    for (const s of q.stores) if (s.meta.state === "value") lines.push(`• ${s.storeName}: ${brl(s.meta)}`);
    if (q.network.meta.state === "value") lines.push(`• Rede: ${brl(q.network.meta)}`);
    else if (q.network.partialMeta !== null) lines.push(`• Rede (só lojas com meta): ${brlN(q.network.partialMeta)}`);
    if (q.withoutQuota.length) lines.push(`Sem meta do dia cadastrada: ${q.withoutQuota.join(", ")}.`);
    const ex = this.morningExceptions(orgId, date);
    if (ex.length) lines.push("", ...ex.map((e) => `⚠️ ${e}`));
    return lines;
  }

  // ── F1.6c — fechamento da noite ────────────────────────────────────────────
  private static period(dates: string[], closingByDate: Map<string, number>, quotaByDate: Map<string, number>): Period {
    let venda = 0, cota = 0, haveClosing = 0, haveQuota = 0, missing = 0, closedNoQuota = 0;
    for (const d of dates) {
      const q = quotaByDate.get(d);
      const c = closingByDate.get(d);
      if (c !== undefined) { venda += c; haveClosing += 1; if (q === undefined) closedNoQuota += 1; }
      if (q !== undefined) { cota += q; haveQuota += 1; if (c === undefined && q > 0) missing += 1; }
    }
    const partial = haveClosing ? round2(venda) : null;
    const vendaM = !haveClosing ? unknown("sem fechamento no período", { unit: "brl" })
      : missing > 0 ? notComputed(`faltam fechamentos de ${missing} dia(s)`, { unit: "brl" })
      : known(round2(venda), { unit: "brl", source: "fechamento (folha)" });
    // Dia VENDIDO sem cota cadastrada: somar a venda dele e não a cota inflaria o atingimento (ex.: 188%). Cota parcial ≠ cota → não calcula.
    const cotaM = !haveQuota ? unknown("cota não cadastrada no período", { unit: "brl" })
      : closedNoQuota > 0 ? notComputed(`faltam cotas de ${closedNoQuota} dia(s) com fechamento`, { unit: "brl" })
      : known(round2(cota), { unit: "brl", source: "cota" });
    return { venda: vendaM, cota: cotaM, atingimento: ratioMetric(vendaM, cotaM, { unit: "pct" }), partial, missingDays: missing };
  }

  /** Troca o denominador do mês pela META MENSAL cadastrada (PRD §12). Sem meta → período intacto (soma das cotas diárias). */
  private static withGoal(p: Period, goal: number | null | undefined): Period {
    if (goal === null || goal === undefined || !(goal > 0)) return { ...p, cotaBasis: p.cota.state === "value" ? "cotas_diarias" : undefined };
    const cota = known(round2(goal), { unit: "brl", source: "meta mensal" });
    return { ...p, cota, atingimento: ratioMetric(p.venda, cota, { unit: "pct" }), cotaBasis: "meta_mensal" };
  }

  /**
   * S6 — o MÊS até ontem por loja, para o parcial das 16h (que só tem a meta do DIA): meta mensal cadastrada × fechamentos JÁ ENVIADOS
   * do mês (1º até `date`-1). É FATO do que foi enviado — dia sem fechamento não vira "vendeu 0", e por isso não calcula atingimento %.
   * Sem meta mensal → `goal` null (a linha não aparece). Isola por org.
   */
  static monthToDate(orgId: string, date: string): Map<string, { goal: number | null; sold: number; closedDays: number }> {
    const monthStart = `${date.slice(0, 7)}-01`;
    const out = new Map<string, { goal: number | null; sold: number; closedDays: number }>();
    if (date <= monthStart) return out;                                   // dia 1: ainda não há mês fechado
    const end = addDays(date, -1);
    const off = officialSaleSql(officialSaleSourceOf(orgId));
    const rows = db.prepare(
      `SELECT store_id, closing_date, ${off} AS total FROM retail_daily_closings
        WHERE organization_id = ? AND closing_date BETWEEN ? AND ? AND status IN ${CLOSED_OK}`,
    ).all(orgId, monthStart, end) as any[];
    const goals = RetailMonthlyGoalService.map(orgId, date.slice(0, 7));
    for (const r of rows) {
      const t = Number(r.total);
      if (!Number.isFinite(t) || t <= 0) continue;
      const cur = out.get(r.store_id) || { goal: goals.get(r.store_id) ?? null, sold: 0, closedDays: 0 };
      cur.sold = round2(cur.sold + t); cur.closedDays += 1;
      out.set(r.store_id, cur);
    }
    for (const [storeId, g] of goals) if (!out.has(storeId)) out.set(storeId, { goal: g, sold: 0, closedDays: 0 });
    return out;
  }

  static nightSnapshot(orgId: string, date: string): NightSnapshot {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const source = officialSaleSourceOf(orgId);
    const off = officialSaleSql(source);
    const monthStart = `${date.slice(0, 7)}-01`;
    const weekStart = weekStartOf(date);
    const from = weekStart < monthStart ? weekStart : monthStart;
    const stores = storesOpenOn(orgId, date);

    const closings = db.prepare(
      `SELECT store_id, closing_date, ${off} AS total, details_json FROM retail_daily_closings
        WHERE organization_id = ? AND closing_date BETWEEN ? AND ? AND status IN ${CLOSED_OK}`,
    ).all(orgId, from, date) as any[];
    const quotas = db.prepare(`SELECT store_id, quota_date, quota_amount FROM retail_store_quotas WHERE organization_id = ? AND quota_date BETWEEN ? AND ?`).all(orgId, from, date) as any[];

    const closingBy = new Map<string, Map<string, number>>(); const detailsBy = new Map<string, any>(); const quotaBy = new Map<string, Map<string, number>>();
    for (const c of closings) {
      const t = Number(c.total);
      if (!Number.isFinite(t) || t <= 0) continue;                       // fechamento sem valor ainda ≠ vendeu 0
      if (!closingBy.has(c.store_id)) closingBy.set(c.store_id, new Map());
      closingBy.get(c.store_id)!.set(c.closing_date, t);
      if (c.closing_date === date) detailsBy.set(c.store_id, c.details_json);
    }
    for (const q of quotas) {
      const a = Number(q.quota_amount);
      if (!Number.isFinite(a)) continue;
      if (!quotaBy.has(q.store_id)) quotaBy.set(q.store_id, new Map());
      quotaBy.get(q.store_id)!.set(q.quota_date, a);
    }
    const range = (a: string, b: string) => { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
    const weekDates = range(weekStart, date), monthDates = range(monthStart, date);

    const goals = RetailMonthlyGoalService.map(orgId, date.slice(0, 7));
    const out: NightStore[] = stores.map((s) => {
      const cl = closingBy.get(s.id) || new Map<string, number>(), qu = quotaBy.get(s.id) || new Map<string, number>();
      const t = cl.get(date);
      const venda = t !== undefined ? known(round2(t), { unit: "brl", source: "fechamento (folha)" }) : unknown("aguardando fechamento", { unit: "brl" });
      const qd = qu.get(date);
      const cota = qd !== undefined ? known(round2(qd), { unit: "brl", source: "cota do dia" }) : unknown("cota do dia não cadastrada", { unit: "brl" });
      let dinheiro: Metric = unknown(t !== undefined ? "o fechamento não detalhou o dinheiro" : "aguardando fechamento", { unit: "brl" });
      try {
        const d = JSON.parse(detailsBy.get(s.id) ?? "null");
        if (t !== undefined && d && d.dinheiro !== undefined && d.dinheiro !== null && Number.isFinite(Number(d.dinheiro))) dinheiro = known(round2(Number(d.dinheiro)), { unit: "brl", source: "fechamento (folha)" });
      } catch { /* sem detalhe */ }
      return { storeId: s.id, storeName: s.name, venda, cota, atingimento: ratioMetric(venda, cota, { unit: "pct" }), dinheiro, week: this.period(weekDates, cl, qu), month: this.withGoal(this.period(monthDates, cl, qu), goals.get(s.id)) };
    });

    const sumPeriod = (pick: (s: NightStore) => Period): Period => {
      const v = combineMetrics(out.map((s) => pick(s).venda), { unit: "brl" });
      const c = combineMetrics(out.map((s) => pick(s).cota), { unit: "brl" });
      return { venda: v.fact, cota: c.fact, atingimento: ratioMetric(v.fact, c.fact, { unit: "pct" }), partial: v.partialFact, missingDays: out.reduce((a, s) => a + pick(s).missingDays, 0) };
    };
    // Mês da REDE: só usa a meta mensal quando TODA loja aberta tem a sua (misturar meta e soma-de-cotas seria denominador inconsistente).
    let netMonth = sumPeriod((s) => s.month);
    if (out.length && out.every((s) => s.month.cotaBasis === "meta_mensal")) {
      netMonth = this.withGoal(netMonth, round2(out.reduce((a, s) => a + (s.month.cota.state === "value" ? Number(s.month.cota.value) : 0), 0)));
    }
    // Lojas que bateram a meta do dia × abaixo (só com venda E cota conhecidas — sem dado nunca vira "abaixo").
    let hit = 0, below = 0, noData = 0;
    for (const s of out) {
      if (s.venda.state === "value" && s.cota.state === "value" && Number(s.cota.value) > 0) { if (Number(s.venda.value) >= Number(s.cota.value)) hit++; else below++; } else noData++;
    }
    const nv = combineMetrics(out.map((s) => s.venda), { unit: "brl" });
    const nc = combineMetrics(out.map((s) => s.cota), { unit: "brl" });
    const nd = combineMetrics(out.map((s) => s.dinheiro), { unit: "brl" });
    return {
      date, weekStart, monthStart, source, stores: out,
      network: { venda: nv.fact, cota: nc.fact, dinheiro: nd.fact, partialVenda: nv.partialFact, atingimento: ratioMetric(nv.fact, nc.fact, { unit: "pct" }), week: sumPeriod((s) => s.week), month: netMonth, storesHit: hit + below > 0 ? hit : null, storesBelow: hit + below > 0 ? below : null, storesNoData: noData },
    };
  }

  private static periodText(label: string, p: Period): string {
    if (p.venda.state === "value") {
      const at = p.atingimento.state === "value" ? ` (${formatMetric(p.atingimento, { unit: "pct" })})` : "";
      return `${label}: ${brl(p.venda)} de ${brl(p.cota)}${at}`;
    }
    if (p.venda.state === "not_computed" && p.partial !== null) return `${label}: ${brlN(p.partial)} — parcial, ${p.venda.reason || "faltam fechamentos"}${p.cotaBasis === "meta_mensal" ? ` (meta do mês ${brl(p.cota)})` : ""}`;
    return `${label}: —`;
  }

  /**
   * Mensagem (linguagem do gestor, sem termos técnicos). `opts.storeIds` = só essas lojas (o resumo do horário delas);
   * `opts.withNetwork` = inclui o bloco "Rede" (só no último horário do dia — é quando todas já fecharam). Sem opts = tudo (prévia).
   */
  static nightText(s: NightSnapshot, opts: { storeIds?: string[]; withNetwork?: boolean } = {}): string {
    const lines: string[] = [`Fechamento do dia — ${ddmm(s.date)}`];
    const block = (title: string, x: { venda: Metric; cota: Metric; atingimento: Metric; dinheiro: Metric; week: Period; month: Period }) => {
      const venda = x.venda.state === "unknown" ? "aguardando fechamento" : brl(x.venda);
      lines.push("", title, `Venda: ${venda}`, `Cota: ${brl(x.cota)}`, `Atingimento: ${formatMetric(x.atingimento, { unit: "pct" })}`, `Dinheiro: ${brl(x.dinheiro)}`, this.periodText("Semana", x.week), this.periodText("Mês", x.month));
    };
    const only = opts.storeIds ? new Set(opts.storeIds) : null;
    for (const st of s.stores) if (!only || only.has(st.storeId)) block(st.storeName, st);
    if (opts.withNetwork !== false) {
      block("Rede", s.network);
      if (s.network.storesHit !== null && s.network.storesBelow !== null) lines.push(`Lojas que bateram a meta: ${s.network.storesHit} · abaixo da meta: ${s.network.storesBelow}${s.network.storesNoData ? ` · sem dado: ${s.network.storesNoData}` : ""}`);
      if (s.network.venda.state === "not_computed" && s.network.partialVenda !== null) lines.push(`(Vendido nas lojas com fechamento: ${brlN(s.network.partialVenda)})`);
    }
    lines.push("", `Origem: ${s.source === "folha" ? "fechamento (folha) de cada loja" : "fechamento de cada loja"}.`);
    return lines.join("\n");
  }

  /** Horários de resumo do dia: lojas (abertas na data) agrupadas por `closing_brief_time` (vazio = padrão da rede), em ordem. O último fecha a rede. */
  static slots(orgId: string, date: string): Array<{ time: string; min: number; storeIds: string[]; last: boolean }> {
    const rows = storesOpenOn(orgId, date, "id, name, closing_brief_time");
    const by = new Map<string, string[]>();
    for (const r of rows) {
      const t = hhmmToMin(r.closing_brief_time) !== null ? String(r.closing_brief_time) : DEFAULT_NIGHT_TIME;
      const key = t.padStart(5, "0");
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(r.id);
    }
    const list = Array.from(by.entries()).map(([time, storeIds]) => ({ time, min: hhmmToMin(time) as number, storeIds })).sort((a, b) => a.min - b.min);
    return list.map((x, i) => ({ ...x, last: i === list.length - 1 }));
  }

  // ── entrega da noite ───────────────────────────────────────────────────────
  static enabled(orgId: string): boolean {
    try { return (db.prepare(`SELECT retail_night_brief_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.e === 1; } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare(`UPDATE organization_settings SET retail_night_brief_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    return on;
  }
  /**
   * Quem recebe o resumo da REDE (venda/cota/dinheiro de todas as lojas): owner e admin SEM loja atribuída, com telefone. Gerente de loja
   * (admin COM loja, ADR-173) fica de fora — senão a trava por loja seria furada pelo WhatsApp.
   */
  static recipients(orgId: string): Array<{ userId: string; phone: string }> {
    const rows = db.prepare(`SELECT id, phone, role FROM users WHERE organization_id = ? AND role IN ('owner', 'admin') AND COALESCE(global_status, 'active') = 'active'`).all(orgId) as any[];
    return rows
      .filter((r) => RetailStoreScopeService.allowed(orgId, r.id, r.role).unrestricted)
      .map((r) => ({ userId: r.id, phone: onlyDigits(r.phone) }))
      .filter((r) => r.phone);
  }
  private static alreadySent(orgId: string, userId: string, date: string): boolean {
    return !!db.prepare(`SELECT 1 FROM retail_night_brief_deliveries WHERE organization_id = ? AND user_id = ? AND brief_date = ?`).get(orgId, userId, date);
  }
  private static markSent(orgId: string, userId: string, date: string): void {
    try { db.prepare(`INSERT INTO retail_night_brief_deliveries (id, organization_id, user_id, brief_date) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, userId, date); }
    catch (e: any) { if (e?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e; }
  }
  /** Só há o que dizer se alguma loja tem cota ou fechamento no dia. */
  static hasContent(s: NightSnapshot): boolean {
    return s.stores.some((st) => st.cota.state === "value" || st.venda.state === "value");
  }

  /**
   * Um passe (chamado a cada ~5 min pelo Scheduler). Para cada horário do dia cujo momento já chegou (e não passou de 3h), monta o
   * resumo SÓ das lojas daquele horário (+ "Rede" no último) e envia a owner/admin com telefone — uma vez por (usuário, dia, horário).
   * Só marca como enviado DEPOIS do envio (falhou → retenta no próximo passe). `force` (prévia/manual) envia todos os horários, sem janela/dedupe.
   */
  /** §13 — o fechamento da noite continua em conversa: destaca a loja de menor atingimento ainda abaixo da meta (senão nenhuma → o FalaTu pergunta a loja). */
  private static seedConversation(orgId: string, userId: string, stores: NightStore[], now: Date): void {
    try {
      const lowest = [...stores].filter((st) => st.atingimento.state === "value" && (st.atingimento.value as number) < 100)
        .sort((a, b) => (a.atingimento.value as number) - (b.atingimento.value as number))[0];
      import("./FalaTuConversationService.js").then((m) => m.FalaTuConversationService.seedFromBriefing(orgId, userId, { tool: "vendas_por_loja", args: { period: "hoje" }, storeId: lowest?.storeId ?? null }, now.getTime())).catch(() => {});
    } catch { /* noop */ }
  }

  static async runPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any; force?: boolean }): Promise<{ sent: number; skipped: number; reasons: string[] }> {
    const out = { sent: 0, skipped: 0, reasons: [] as string[] };
    if (!this.enabled(orgId)) return out;
    const { dateSP, min } = spMinutes(opts.now);
    const slots = this.slots(orgId, dateSP);
    const due = opts.force ? slots : slots.filter((sl) => min >= sl.min && min < Math.min(sl.min + SLOT_WINDOW_MIN, 1440));
    if (!due.length) return out;
    const snap = this.nightSnapshot(orgId, dateSP);
    const recipients = this.recipients(orgId);
    for (const sl of due) {
      const mine = snap.stores.filter((st) => sl.storeIds.includes(st.storeId));
      if (!mine.some((st) => st.cota.state === "value" || st.venda.state === "value")) { out.skipped += 1; out.reasons.push("no_content"); continue; }
      const text = this.nightText(snap, { storeIds: sl.storeIds, withNetwork: sl.last });
      const key = `${dateSP}#${sl.time}`;
      for (const r of recipients) {
        if (!opts.force && this.alreadySent(orgId, r.userId, key)) { out.skipped += 1; out.reasons.push("already_sent"); continue; }
        await opts.send(r.phone, text);            // só marca DEPOIS do envio (falhou → retenta no próximo passe)
        this.markSent(orgId, r.userId, key);
        this.seedConversation(orgId, r.userId, mine, opts.now);
        out.sent += 1;
      }
    }
    if (!out.sent && !out.skipped) out.reasons.push("no_recipient");
    return out;
  }
}

export default RetailDayBriefService;
