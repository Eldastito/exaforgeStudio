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
 * Entrega da noite: WhatsApp pra owner/admin com telefone (dinheiro é role-gated §73), janela 21h–23h (SP),
 * opt-in por org, dedupe por dia, `send` injetado (testável sem rede). Determinístico, sem LLM. Isola por org.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { onlyDigits } from "./phoneMatch.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { officialSaleSourceOf, officialSaleSql } from "./RetailSalesPolicy.js";
import { combineMetrics, formatMetric, known, ratioMetric, unknown, notComputed, type Metric } from "../lib/metric.js";

const NIGHT_START = 21, NIGHT_END = 23;            // exclusivo — hora de São Paulo
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

export type Period = { venda: Metric; cota: Metric; atingimento: Metric; partial: number | null; missingDays: number };
export type NightStore = { storeId: string; storeName: string; venda: Metric; cota: Metric; atingimento: Metric; dinheiro: Metric; week: Period; month: Period };
export type NightSnapshot = {
  date: string; weekStart: string; monthStart: string; source: "folha" | "system";
  stores: NightStore[]; network: { venda: Metric; cota: Metric; atingimento: Metric; dinheiro: Metric; partialVenda: number | null; week: Period; month: Period };
};
export type MorningQuotas = { date: string; stores: Array<{ storeId: string; storeName: string; meta: Metric }>; network: { meta: Metric; partialMeta: number | null }; withoutQuota: string[] };

export class RetailDayBriefService {
  // ── F1.6a — cota da manhã ──────────────────────────────────────────────────
  /** null = a org não cadastrou NENHUMA cota pra hoje (não há o que dizer; o resumo da manhã segue igual). */
  static morningQuotas(orgId: string, date: string): MorningQuotas | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const quotas = new Map((db.prepare(`SELECT store_id, quota_amount FROM retail_store_quotas WHERE organization_id = ? AND quota_date = ?`).all(orgId, date) as any[]).map((q) => [q.store_id, Number(q.quota_amount)]));
    const rows = stores.map((s) => ({
      storeId: s.id as string, storeName: s.name as string,
      meta: quotas.has(s.id) && Number.isFinite(quotas.get(s.id)) ? known(round2(quotas.get(s.id) as number), { unit: "brl", source: "cota do dia" }) : unknown("cota do dia não cadastrada", { unit: "brl" }),
    }));
    if (!rows.some((r) => r.meta.state === "value")) return null;
    const net = combineMetrics(rows.map((r) => r.meta), { unit: "brl" });
    return { date, stores: rows, network: { meta: net.fact, partialMeta: net.partialFact }, withoutQuota: rows.filter((r) => r.meta.state !== "value").map((r) => r.storeName) };
  }

  /** Linhas pro resumo da manhã (vazio quando não há cota cadastrada — 0-regressão). */
  static morningLines(orgId: string, date: string): string[] {
    let q: MorningQuotas | null = null;
    try { q = this.morningQuotas(orgId, date); } catch { return []; }
    if (!q) return [];
    const lines = ["*🎯 Cota de hoje por loja:*"];
    for (const s of q.stores) if (s.meta.state === "value") lines.push(`• ${s.storeName}: ${brl(s.meta)}`);
    if (q.network.meta.state === "value") lines.push(`• Rede: ${brl(q.network.meta)}`);
    else if (q.network.partialMeta !== null) lines.push(`• Rede (só lojas com cota): ${brlN(q.network.partialMeta)}`);
    if (q.withoutQuota.length) lines.push(`Sem cota cadastrada: ${q.withoutQuota.join(", ")}.`);
    return lines;
  }

  // ── F1.6c — fechamento da noite ────────────────────────────────────────────
  private static period(dates: string[], closingByDate: Map<string, number>, quotaByDate: Map<string, number>): Period {
    let venda = 0, cota = 0, haveClosing = 0, haveQuota = 0, missing = 0;
    for (const d of dates) {
      const q = quotaByDate.get(d);
      const c = closingByDate.get(d);
      if (c !== undefined) { venda += c; haveClosing += 1; }
      if (q !== undefined) { cota += q; haveQuota += 1; if (c === undefined && q > 0) missing += 1; }
    }
    const partial = haveClosing ? round2(venda) : null;
    const vendaM = !haveClosing ? unknown("sem fechamento no período", { unit: "brl" })
      : missing > 0 ? notComputed(`faltam fechamentos de ${missing} dia(s)`, { unit: "brl" })
      : known(round2(venda), { unit: "brl", source: "fechamento (folha)" });
    const cotaM = haveQuota ? known(round2(cota), { unit: "brl", source: "cota" }) : unknown("cota não cadastrada no período", { unit: "brl" });
    return { venda: vendaM, cota: cotaM, atingimento: ratioMetric(vendaM, cotaM, { unit: "pct" }), partial, missingDays: missing };
  }

  static nightSnapshot(orgId: string, date: string): NightSnapshot {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const source = officialSaleSourceOf(orgId);
    const off = officialSaleSql(source);
    const monthStart = `${date.slice(0, 7)}-01`;
    const weekStart = weekStartOf(date);
    const from = weekStart < monthStart ? weekStart : monthStart;
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];

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
      return { storeId: s.id, storeName: s.name, venda, cota, atingimento: ratioMetric(venda, cota, { unit: "pct" }), dinheiro, week: this.period(weekDates, cl, qu), month: this.period(monthDates, cl, qu) };
    });

    const sumPeriod = (pick: (s: NightStore) => Period): Period => {
      const v = combineMetrics(out.map((s) => pick(s).venda), { unit: "brl" });
      const c = combineMetrics(out.map((s) => pick(s).cota), { unit: "brl" });
      return { venda: v.fact, cota: c.fact, atingimento: ratioMetric(v.fact, c.fact, { unit: "pct" }), partial: v.partialFact, missingDays: out.reduce((a, s) => a + pick(s).missingDays, 0) };
    };
    const nv = combineMetrics(out.map((s) => s.venda), { unit: "brl" });
    const nc = combineMetrics(out.map((s) => s.cota), { unit: "brl" });
    const nd = combineMetrics(out.map((s) => s.dinheiro), { unit: "brl" });
    return {
      date, weekStart, monthStart, source, stores: out,
      network: { venda: nv.fact, cota: nc.fact, dinheiro: nd.fact, partialVenda: nv.partialFact, atingimento: ratioMetric(nv.fact, nc.fact, { unit: "pct" }), week: sumPeriod((s) => s.week), month: sumPeriod((s) => s.month) },
    };
  }

  private static periodText(label: string, p: Period): string {
    if (p.venda.state === "value") {
      const at = p.atingimento.state === "value" ? ` (${formatMetric(p.atingimento, { unit: "pct" })})` : "";
      return `${label}: ${brl(p.venda)} de ${brl(p.cota)}${at}`;
    }
    if (p.venda.state === "not_computed" && p.partial !== null) return `${label}: ${brlN(p.partial)} — parcial, ${p.venda.reason || "faltam fechamentos"}`;
    return `${label}: —`;
  }

  /** Mensagem (linguagem do gestor, sem termos técnicos). */
  static nightText(s: NightSnapshot): string {
    const lines: string[] = [`Fechamento do dia — ${ddmm(s.date)}`];
    const block = (title: string, x: { venda: Metric; cota: Metric; atingimento: Metric; dinheiro: Metric; week: Period; month: Period }) => {
      const venda = x.venda.state === "unknown" ? "aguardando fechamento" : brl(x.venda);
      lines.push("", title, `Venda: ${venda}`, `Cota: ${brl(x.cota)}`, `Atingimento: ${formatMetric(x.atingimento, { unit: "pct" })}`, `Dinheiro: ${brl(x.dinheiro)}`, this.periodText("Semana", x.week), this.periodText("Mês", x.month));
    };
    for (const st of s.stores) block(st.storeName, st);
    block("Rede", s.network);
    if (s.network.venda.state === "not_computed" && s.network.partialVenda !== null) lines.push(`(Vendido nas lojas com fechamento: ${brlN(s.network.partialVenda)})`);
    lines.push("", `Origem: ${s.source === "folha" ? "fechamento (folha) de cada loja" : "fechamento de cada loja"}.`);
    return lines.join("\n");
  }

  // ── entrega da noite ───────────────────────────────────────────────────────
  static enabled(orgId: string): boolean {
    try { return (db.prepare(`SELECT retail_night_brief_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.e === 1; } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare(`UPDATE organization_settings SET retail_night_brief_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    return on;
  }
  private static recipients(orgId: string): Array<{ userId: string; phone: string }> {
    const rows = db.prepare(`SELECT id, phone FROM users WHERE organization_id = ? AND role IN ('owner', 'admin') AND COALESCE(global_status, 'active') = 'active'`).all(orgId) as any[];
    return rows.map((r) => ({ userId: r.id, phone: onlyDigits(r.phone) })).filter((r) => r.phone);
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

  static async runPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any; force?: boolean }): Promise<{ sent: number; skipped: number; reasons: string[] }> {
    const out = { sent: 0, skipped: 0, reasons: [] as string[] };
    if (!this.enabled(orgId)) return out;
    const { dateSP, hourSP } = FalaTuBriefingDigestService.spParts(opts.now);
    if (!opts.force && (hourSP < NIGHT_START || hourSP >= NIGHT_END)) return out;
    const snap = this.nightSnapshot(orgId, dateSP);
    if (!this.hasContent(snap)) { out.skipped += 1; out.reasons.push("no_content"); return out; }
    const text = this.nightText(snap);
    for (const r of this.recipients(orgId)) {
      if (!opts.force && this.alreadySent(orgId, r.userId, dateSP)) { out.skipped += 1; out.reasons.push("already_sent"); continue; }
      await opts.send(r.phone, text);            // só marca DEPOIS do envio (falhou → retenta no próximo tick)
      this.markSent(orgId, r.userId, dateSP);
      out.sent += 1;
    }
    if (!out.sent && !out.skipped) out.reasons.push("no_recipient");
    return out;
  }
}

export default RetailDayBriefService;
