/**
 * RetailAfternoonBriefService — PARCIAL DAS 16h por loja e rede (PRD Fase 1, F1.6b).
 *
 * "Quanto cada loja vendeu até agora, quanto falta pra meta do dia, quanto foi em dinheiro e se está
 * abaixo do ritmo habitual deste horário." Fonte do "vendido": o PDV venda a venda (`retail_pdv_sales`,
 * Alterdata VendaMalote — sync a cada ~15 min): é o PARCIAL OPERACIONAL do caixa, NÃO a venda oficial da
 * folha (essa só existe no fechamento noturno). O texto rotula a origem.
 *
 * Honestidade (F1.0 — nada vira 0 por falta de dado):
 *  - meta do dia não cadastrada → "—" (atingimento e falta = não calculado); meta 0 → N/A;
 *  - loja sem NENHUMA venda do PDV sincronizada hoje → "—" (não afirmamos R$ 0,00: pode ser sync atrasado);
 *  - dinheiro: só soma se o PDV informou a forma de pagamento em TODAS as vendas; senão "—"/não calculado;
 *  - rede: total com loja sem dado NÃO é total ("Não calculado"); o parcial das lojas com dado vai à parte;
 *  - "abaixo do ritmo" só com histórico suficiente (≥3 mesmos dias da semana com hora de venda confiável
 *    em ≥80% das vendas) — comparação com a média histórica ACUMULADA até o mesmo horário, tratada como
 *    HIPÓTESE (estimativa com confiança), nunca fato.
 * Entrega: WhatsApp pra owner/admin com telefone (dinheiro é role-gated §73), janela 16h–18h (SP), opt-in
 * por org, dedupe por dia, `send` injetado (testável sem rede). Determinístico, sem LLM. Isola por org.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";
import { onlyDigits } from "./phoneMatch.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { RetailDayBriefService } from "./RetailDayBriefService.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { combineMetrics, estimate, formatMetric, known, ratioMetric, unknown, notComputed, notApplicable, type Metric } from "../lib/metric.js";

export const CUTOFF_HOUR = 16;
const WINDOW_START = 16, WINDOW_END = 18;          // exclusivo — hora de São Paulo
const HISTORY_DAYS = 4, MIN_HISTORY_DAYS = 3;      // mesmos dias da semana
const MIN_TIMED_RATIO = 0.8;                       // fração de vendas com hora confiável p/ o dia valer no histórico
const BELOW_PACE_RATIO = 0.85;                     // abaixo de 85% da média histórica = "abaixo do ritmo"
const STALE_SYNC_MIN = 90;

export type StorePartial = {
  storeId: string; storeName: string;
  meta: Metric; vendido: Metric; atingimento: Metric; falta: Metric; dinheiro: Metric;
  pace: { status: "below" | "ok" | "above" | "insufficient_history"; expected: Metric; historyDays: number; message: string | null };
  salesCount: number;
  /** S6 — meta do MÊS × fechamentos já enviados até ontem (null = sem meta mensal cadastrada → a linha não aparece). */
  mes: { goal: number; sold: number | null; falta: number | null; closedDays: number } | null;
};
export type AfternoonSnapshot = {
  date: string; cutoffHour: number; source: "pdv"; dataAsOf: string | null; stale: boolean;
  stores: StorePartial[];
  network: { meta: Metric; vendido: Metric; atingimento: Metric; falta: Metric; dinheiro: Metric; partialVendido: number | null };
};

/** Minutos do dia a partir de "HH:MM[:SS]", "HHMM[SS]" ou ISO. null = não confiável. */
export function parseSaleMinutes(v: unknown): number | null {
  const s0 = String(v ?? "").trim();
  if (!s0) return null;
  const s = s0.includes("T") ? s0.split("T")[1] : (/^\d{4}-\d{2}-\d{2}\s/.test(s0) ? s0.split(/\s+/)[1] : s0);
  const m = s.match(/^(\d{1,2}):?(\d{2})(?::?(\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const brlNoCents = (m: Metric) => formatMetric(m, { unit: "brl" }).replace(/,00(?=$| —)/, "");

export class RetailAfternoonBriefService {
  private static payments(json: any): { dinheiro: number } | null {
    try { const p = JSON.parse(json ?? "null"); return p && typeof p === "object" && p.dinheiro !== undefined && p.dinheiro !== null && Number.isFinite(Number(p.dinheiro)) ? { dinheiro: Number(p.dinheiro) } : null; }
    catch { return null; }
  }

  /**
   * F2.1 (ADR-203, RN-F2-7): frescor do PDV para QUALQUER resposta "até agora" — "último dado confirmado às HH:MM" (hora de SP) e se está
   * ATRASADO. `dataAsOf` null = o PDV nunca sincronizou (org sem PDV: quem chama não carimba nada).
   */
  static freshness(orgId: string, now: Date = new Date()): { dataAsOf: string | null; hhmm: string | null; stale: boolean } {
    const dataAsOf = this.lastSyncAt(orgId);
    if (!dataAsOf) return { dataAsOf: null, hhmm: null, stale: false };
    const t = new Date(dataAsOf.replace(" ", "T") + (dataAsOf.includes("Z") ? "" : "Z"));
    const ms = t.getTime();
    if (!Number.isFinite(ms)) return { dataAsOf, hhmm: null, stale: true };
    const hhmm = t.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    return { dataAsOf, hhmm, stale: now.getTime() - ms > STALE_SYNC_MIN * 60_000 };
  }

  /** Data do PDV mais recente sincronizada (frescor do "até agora"). */
  private static lastSyncAt(orgId: string): string | null {
    try {
      const r = db.prepare(`SELECT MAX(last_synced_at) AS t FROM alterdata_sync_cursors WHERE organization_id = ? AND module = 'sales'`).get(orgId) as any;
      return r?.t || null;
    } catch { return null; }
  }

  private static dayRows(orgId: string, filial: string, date: string): Array<{ valor: number; min: number | null; pay: { dinheiro: number } | null }> {
    const rows = db.prepare(`SELECT valor, sale_time, payments_json FROM retail_pdv_sales WHERE organization_id = ? AND filial = ? AND sale_date = ? AND COALESCE(status, 'N') <> 'C'`).all(orgId, filial, date) as any[];
    return rows.map((r) => ({ valor: Number(r.valor) || 0, min: parseSaleMinutes(r.sale_time), pay: this.payments(r.payments_json) }));
  }

  static snapshot(orgId: string, date: string, opts: { cutoffHour?: number; now?: Date } = {}): AfternoonSnapshot {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const cutoffHour = opts.cutoffHour ?? CUTOFF_HOUR;
    const cutMin = cutoffHour * 60;
    // loja que não abre na data (closed_weekdays — Av. Brasil aos domingos) sai do dia: não vira 'sem meta' nem trava o total da rede
    const stores = (db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[]).filter((st) => { try { return !RetailClosingService.isStoreClosedOnDate(orgId, st.id, date); } catch { return true; } });
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const histDates: string[] = [];
    for (let k = 1; k <= 8 && histDates.length < 8; k++) histDates.push(new Date(Date.parse(`${date}T12:00:00Z`) - k * 7 * 86400000).toISOString().slice(0, 10));
    void dow;
    const dataAsOf = this.lastSyncAt(orgId);
    const nowMs = (opts.now || new Date()).getTime();
    const stale = !dataAsOf || (nowMs - new Date(dataAsOf.replace(" ", "T") + (dataAsOf.includes("Z") ? "" : "Z")).getTime()) > STALE_SYNC_MIN * 60_000;

    let mtd: ReturnType<typeof RetailDayBriefService.monthToDate> = new Map();
    try { mtd = RetailDayBriefService.monthToDate(orgId, date); } catch { /* sem mês: o parcial segue só com o dia */ }
    const out: StorePartial[] = [];
    for (const st of stores) {
      const q = db.prepare(`SELECT quota_amount FROM retail_store_quotas WHERE organization_id = ? AND store_id = ? AND quota_date = ?`).get(orgId, st.id, date) as any;
      const meta = q ? known(Number(q.quota_amount) || 0, { unit: "brl", source: "cota do dia" }) : unknown("meta do dia não cadastrada", { unit: "brl" });

      const all = st.code ? this.dayRows(orgId, String(st.code), date) : [];
      // "até 16h": só vendas com hora confiável ≤ corte; sem hora confiável usa o total do dia (e não compara ritmo)
      const timed = all.filter((r) => r.min !== null);
      const untimed = all.length - timed.length;
      const upTo = untimed === 0 ? all.filter((r) => (r.min as number) <= cutMin) : all;
      const vendido = all.length === 0
        ? unknown("sem vendas do PDV sincronizadas hoje", { unit: "brl", source: "pdv" })
        : known(round2(upTo.reduce((a, r) => a + r.valor, 0)), { unit: "brl", source: "pdv (parcial do caixa)" });

      // dinheiro: só com forma de pagamento em TODAS as vendas consideradas
      let dinheiro: Metric;
      if (all.length === 0) dinheiro = unknown("sem vendas do PDV sincronizadas hoje", { unit: "brl" });
      else {
        const miss = upTo.filter((r) => !r.pay).length;
        dinheiro = miss === 0 ? known(round2(upTo.reduce((a, r) => a + (r.pay as any).dinheiro, 0)), { unit: "brl", source: "pdv" })
          : miss === upTo.length ? unknown("o PDV não informou a forma de pagamento", { unit: "brl" })
          : notComputed(`forma de pagamento ausente em ${miss} de ${upTo.length} vendas`, { unit: "brl" });
      }

      const atingimento = ratioMetric(vendido, meta, { unit: "pct" });
      let falta: Metric;
      if (vendido.state !== "value" || meta.state !== "value") falta = notComputed("faltam meta ou vendas", { unit: "brl" });
      else if ((meta.value as number) === 0) falta = notApplicable("sem meta no dia", { unit: "brl" });
      else falta = known(Math.max(0, round2((meta.value as number) - (vendido.value as number))), { unit: "brl" });

      // ritmo histórico (só com histórico suficiente e hora confiável hoje)
      const days: number[] = [];
      for (const d of histDates) {
        if (days.length >= HISTORY_DAYS) break;
        const rows = st.code ? this.dayRows(orgId, String(st.code), d) : [];
        if (!rows.length) continue;
        const t = rows.filter((r) => r.min !== null);
        if (t.length / rows.length < MIN_TIMED_RATIO) continue;
        days.push(round2(t.filter((r) => (r.min as number) <= cutMin).reduce((a, r) => a + r.valor, 0)));
      }
      let pace: StorePartial["pace"];
      if (vendido.state !== "value" || untimed > 0 || days.length < MIN_HISTORY_DAYS) {
        pace = { status: "insufficient_history", expected: notComputed(days.length < MIN_HISTORY_DAYS ? "histórico insuficiente" : "hora das vendas de hoje não confiável", { unit: "brl" }), historyDays: days.length, message: null };
      } else {
        const avg = round2(days.reduce((a, b) => a + b, 0) / days.length);
        const expected = estimate(avg, { unit: "brl", confidence: Math.min(0.8, 0.2 * days.length), source: `média de ${days.length} mesmos dias da semana` });
        const v = vendido.value as number;
        const status = avg <= 0 ? "ok" : v < avg * BELOW_PACE_RATIO ? "below" : v > avg * (2 - BELOW_PACE_RATIO) ? "above" : "ok";
        pace = { status, expected, historyDays: days.length, message: status === "below" ? `${st.name} está abaixo do ritmo habitual deste horário (${days.length} mesmos dias da semana).` : null };
      }
      out.push({ storeId: st.id, storeName: st.name, meta, vendido, atingimento, falta, dinheiro, pace, salesCount: all.length, mes: (() => {
        const m = mtd.get(st.id);
        if (!m || !(m.goal! > 0)) return null;
        // sem NENHUM fechamento enviado no mês: não afirma "vendeu 0" — mostra só a meta
        return m.closedDays > 0 ? { goal: m.goal!, sold: m.sold, falta: Math.max(0, round2(m.goal! - m.sold)), closedDays: m.closedDays } : { goal: m.goal!, sold: null, falta: null, closedDays: 0 };
      })() });
    }

    const netMeta = combineMetrics(out.map((s) => s.meta), { unit: "brl" });
    const netVend = combineMetrics(out.map((s) => s.vendido), { unit: "brl" });
    const netCash = combineMetrics(out.map((s) => s.dinheiro), { unit: "brl" });
    const network = {
      meta: netMeta.fact, vendido: netVend.fact, dinheiro: netCash.fact, partialVendido: netVend.partialFact,
      atingimento: ratioMetric(netVend.fact, netMeta.fact, { unit: "pct" }),
      falta: netVend.fact.state === "value" && netMeta.fact.state === "value" ? known(Math.max(0, round2((netMeta.fact.value as number) - (netVend.fact.value as number))), { unit: "brl" }) : notComputed("faltam meta ou vendas de alguma loja", { unit: "brl" }),
    };
    return { date, cutoffHour, source: "pdv", dataAsOf, stale, stores: out, network };
  }

  /** Mensagem (linguagem do gestor, sem termos técnicos) no formato pedido pelo PRD. */
  static text(s: AfternoonSnapshot): string {
    const [y, m, d] = s.date.split("-");
    const lines: string[] = [`Parcial das ${s.cutoffHour}h — ${d}/${m}`];
    const block = (title: string, x: { meta: Metric; vendido: Metric; atingimento: Metric; falta: Metric; dinheiro: Metric }) => {
      lines.push("", title, `Meta: ${brlNoCents(x.meta)}`, `Vendido: ${brlNoCents(x.vendido)}`, `Atingimento: ${formatMetric(x.atingimento, { unit: "pct" })}`, `Falta: ${brlNoCents(x.falta)}`, `Dinheiro: ${brlNoCents(x.dinheiro)}`);
    };
    const brlN = (v: number) => formatMetric(known(v, { unit: "brl" }), { unit: "brl" }).replace(/,00(?=$| —)/, "");
    for (const st of s.stores) {
      block(`${st.storeName} — ${s.cutoffHour}h`, st);
      if (st.mes) lines.push(st.mes.sold !== null
        ? `Mês: meta ${brlN(st.mes.goal)} · fechado até ontem ${brlN(st.mes.sold)} · faltam ${brlN(st.mes.falta!)} (só fechamentos já enviados)`
        : `Mês: meta ${brlN(st.mes.goal)} · sem fechamento enviado ainda`);
    }
    block("Rede", s.network);
    if (s.network.vendido.state === "not_computed" && s.network.partialVendido !== null) lines.push(`(Vendido nas lojas com dado: ${brlNoCents(known(s.network.partialVendido, { unit: "brl" }))})`);
    const paceLines = s.stores.map((st) => st.pace.message).filter(Boolean) as string[];
    if (paceLines.length) lines.push("", "IA", ...paceLines);
    lines.push("", `Origem: caixa (PDV) — parcial, não é o fechamento.${s.stale ? " Dados do PDV podem estar desatualizados." : ""}`);
    void y;
    return lines.join("\n");
  }

  // ── entrega ────────────────────────────────────────────────────────────────
  static enabled(orgId: string): boolean {
    try { return (db.prepare(`SELECT retail_afternoon_brief_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.e === 1; } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare(`UPDATE organization_settings SET retail_afternoon_brief_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
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
    return !!db.prepare(`SELECT 1 FROM retail_afternoon_brief_deliveries WHERE organization_id = ? AND user_id = ? AND brief_date = ?`).get(orgId, userId, date);
  }
  private static markSent(orgId: string, userId: string, date: string): void {
    try { db.prepare(`INSERT INTO retail_afternoon_brief_deliveries (id, organization_id, user_id, brief_date) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, userId, date); }
    catch (e: any) { if (e?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e; }
  }

  /**
   * §13 — a mensagem das 16h continua em conversa: destaca a loja que merece o "Por quê?" (abaixo do ritmo; senão a de menor
   * atingimento ainda abaixo da meta; senão nenhuma → o FalaTu pergunta de qual loja). Best-effort: nunca derruba o envio.
   */
  private static seedConversation(orgId: string, userId: string, snap: AfternoonSnapshot, now: Date): void {
    try {
      const below = snap.stores.find((st) => st.pace.status === "below");
      const lowest = [...snap.stores].filter((st) => st.atingimento.state === "value" && (st.atingimento.value as number) < 100)
        .sort((a, b) => (a.atingimento.value as number) - (b.atingimento.value as number))[0];
      const pick = below || lowest || null;
      import("./FalaTuConversationService.js").then((m) => m.FalaTuConversationService.seedFromBriefing(orgId, userId, { tool: "vendas_por_loja", args: { period: "hoje" }, storeId: pick?.storeId ?? null }, now.getTime())).catch(() => {});
    } catch { /* noop */ }
  }

  /** Só há o que dizer se alguma loja tem meta ou vendas hoje (dia sem nada não gera mensagem). */
  static hasContent(s: AfternoonSnapshot): boolean {
    return s.stores.some((st) => st.meta.state === "value" || st.vendido.state === "value");
  }

  static async runPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any; force?: boolean }): Promise<{ sent: number; skipped: number; reasons: string[] }> {
    const out = { sent: 0, skipped: 0, reasons: [] as string[] };
    if (!this.enabled(orgId)) return out;
    const { dateSP, hourSP } = FalaTuBriefingDigestService.spParts(opts.now);
    if (!opts.force && (hourSP < WINDOW_START || hourSP >= WINDOW_END)) return out;
    const snap = this.snapshot(orgId, dateSP, { now: opts.now });
    if (!this.hasContent(snap)) { out.skipped += 1; out.reasons.push("no_content"); return out; }
    const text = this.text(snap);
    for (const r of this.recipients(orgId)) {
      if (!opts.force && this.alreadySent(orgId, r.userId, dateSP)) { out.skipped += 1; out.reasons.push("already_sent"); continue; }
      await opts.send(r.phone, text);            // só marca DEPOIS do envio (falhou → retenta no próximo tick)
      this.markSent(orgId, r.userId, dateSP);
      this.seedConversation(orgId, r.userId, snap, opts.now);
      out.sent += 1;
    }
    if (!out.sent && !out.skipped) out.reasons.push("no_recipient");
    return out;
  }
}

export default RetailAfternoonBriefService;
