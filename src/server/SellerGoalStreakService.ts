/**
 * SellerGoalStreakService — meses CONSECUTIVOS abaixo da meta, por PESSOA (PRD Fase 1, F1.5).
 *
 * Estende (não duplica) o `RetailCommissionRaceService.sellerGoalSignals` (que é por LOJA): aqui a
 * unidade é a pessoa na REDE — vendas e cotas somadas em todas as lojas onde ela atuou, já pela
 * identidade canônica (F1.1b). Mesma escala 🟡/🟠/🔴 e mesmo motor de placar mensal
 * (`sellerPeriodScoreboard`), só agregado por pessoa.
 *
 * Contagem (só meses FECHADOS — o mês corrente nunca conta):
 *   bateu a meta → encerra a sequência; abaixo → +1; mês NÃO ELEGÍVEL → é NEUTRO (nem conta, nem
 *   quebra: a sequência atravessa). Não elegível = sem meta válida (inclui "ainda não contratado":
 *   sem cota no mês) OU ausência (férias/afastamento) cobrindo o mês inteiro. Nunca vira "meta não batida".
 * Escala: 1º mês 🟡 acompanhamento · 2º 🟠 avisar o gestor · 3º+ 🔴 prioridade gerencial.
 *
 * Honestidade (F1.0): atingimento é `Metric` (meta ausente → não calculado / N/A, nunca 0%). Sinal nominal
 * só para pessoa IDENTIFICADA (nome confirmado) — matrícula pendente ("Vendedor não identificado")
 * NUNCA gera alerta sobre alguém. O sinal leva só % (sem R$ — dinheiro é role-gated, §73).
 * Publica em `business_signals` (conv. nº 12; sem tabela de alerta), self-healing quando a sequência quebra.
 * Alerta proativo é OPT-IN por org (nomeia pessoas): `retail_seller_goal_streak_enabled`.
 */
import db from "./db.js";
import { RetailCommissionRaceService } from "./RetailCommissionRaceService.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";
import { RetailSellerAbsenceService } from "./RetailSellerAbsenceService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ratioMetric, known, formatMetric, type Metric } from "../lib/metric.js";

export type StreakLevel = "none" | "attention" | "critical" | "action";
export type MonthStatus = "met" | "below" | "no_goal" | "absent";
const LEVELS: StreakLevel[] = ["none", "attention", "critical", "action"];
const COLORS: Record<StreakLevel, string | null> = { none: null, attention: "yellow", critical: "orange", action: "red" };
// Fração do mês coberta por ausência a partir da qual o mês deixa de ser elegível (PRD: "férias completas" = 100%).
export const ABSENCE_INELIGIBLE_RATIO = 1;
const SOURCE = "SellerGoalStreakService";
const MONTH_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export type PersonMonth = { month: string; status: MonthStatus; attainment: Metric; reason: string | null; absentDays: number; daysInMonth: number };
export type PersonStreak = {
  personKey: string; sellerId: string | null; name: string; identified: boolean;
  streak: number; level: StreakLevel; color: string | null; offerAnalysis: boolean;
  months: PersonMonth[];                 // do mais recente pro mais antigo
};

const monthLabel = (ym: string) => MONTH_PT[Number(ym.slice(5, 7)) - 1] || ym;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class SellerGoalStreakService {
  /** Meses fechados (YYYY-MM) estritamente antes do mês do refDate, do mais recente pro mais antigo. */
  private static closedMonths(refDate: string, monthsBack: number): string[] {
    let y = Number(refDate.slice(0, 4)), m = Number(refDate.slice(5, 7));
    const out: string[] = [];
    for (let i = 0; i < Math.max(1, Math.min(24, monthsBack)); i++) { m -= 1; if (m === 0) { m = 12; y -= 1; } out.push(`${y}-${String(m).padStart(2, "0")}`); }
    return out;
  }

  static assess(orgId: string, refDate: string, opts: { monthsBack?: number } = {}): { refDate: string; months: string[]; people: PersonStreak[]; skippedUnidentified: number } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate)) throw new Error("refDate deve ser YYYY-MM-DD");
    const months = this.closedMonths(refDate, opts.monthsBack ?? 6);
    const stores = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    const ctx = RetailSellerIdentityService.context(orgId);

    type Acc = { key: string; sellerId: string | null; name: string; identified: boolean; byMonth: Map<string, { sales: number; quota: number }> };
    const people = new Map<string, Acc>();
    for (const ym of months) {
      const end = RetailCommissionRaceService.monthRange(ym).end;
      for (const st of stores) {
        let sellers: any[] = [];
        try { sellers = RetailCommissionRaceService.sellerPeriodScoreboard(orgId, st.id, end).sellers || []; } catch { sellers = []; }
        for (const s of sellers) {
          const res = ctx.resolve({ matricula: s.matricula || null, name: s.sellerName });
          const identified = res.status === "identified" && !!res.seller?.name;
          const key = identified ? `seller:${res.seller!.id}` : String(s.sellerKey);
          let acc = people.get(key);
          if (!acc) { acc = { key, sellerId: identified ? res.seller!.id : null, name: identified ? String(res.seller!.name) : String(s.sellerName), identified, byMonth: new Map() }; people.set(key, acc); }
          const cur = acc.byMonth.get(ym) || { sales: 0, quota: 0 };
          cur.sales += Number(s.month?.sales || 0);
          cur.quota += Number(s.month?.quota || 0);   // pessoa em N lojas: a meta do mês é a soma das cotas
          acc.byMonth.set(ym, cur);
        }
      }
    }

    const out: PersonStreak[] = [];
    let skipped = 0;
    for (const acc of people.values()) {
      const monthsOut: PersonMonth[] = [];
      let streak = 0, broken = false;
      for (const ym of months) {                       // mais recente → mais antigo
        const v = acc.byMonth.get(ym) || { sales: 0, quota: 0 };
        const [yy, mm] = ym.split("-").map(Number);
        const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        const absentDays = acc.sellerId ? RetailSellerAbsenceService.daysAbsentInMonth(orgId, acc.sellerId, ym, ctx) : 0;
        const attainment = ratioMetric(known(v.sales, { unit: "brl" }), v.quota > 0 ? known(v.quota, { unit: "brl" }) : known(0, { unit: "brl" }));
        let status: MonthStatus, reason: string | null = null;
        if (v.quota <= 0) { status = "no_goal"; reason = "sem meta válida no mês"; }
        else if (absentDays / daysInMonth >= ABSENCE_INELIGIBLE_RATIO) { status = "absent"; reason = "férias/afastamento no mês inteiro"; }
        else if (v.sales >= v.quota) status = "met";
        else status = "below";
        monthsOut.push({ month: ym, status, attainment, reason, absentDays, daysInMonth });
        if (broken) continue;
        if (status === "met") broken = true;            // bateu → encerra
        else if (status === "below") streak += 1;       // abaixo → +1
        // no_goal / absent → neutro: a sequência atravessa
      }
      const level = LEVELS[Math.min(streak, 3)];
      if (streak > 0 && !acc.identified) skipped += 1;
      out.push({ personKey: acc.key, sellerId: acc.sellerId, name: acc.name, identified: acc.identified, streak, level, color: COLORS[level], offerAnalysis: streak >= 2, months: monthsOut });
    }
    out.sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name));
    return { refDate, months, people: out, skippedUnidentified: skipped };
  }

  /** Texto para o gestor (briefing/FalaTu): só pessoas com sequência ≥ 1 e IDENTIFICADAS; sem R$. */
  static briefText(a: { people: PersonStreak[] }): string | null {
    const list = a.people.filter((p) => p.streak >= 1 && p.identified);
    if (!list.length) return null;
    const head = (p: PersonStreak) => p.streak === 1 ? "🟡 1º mês abaixo da meta" : p.streak === 2 ? "🟠 2º mês consecutivo abaixo da meta" : `🔴 ${p.streak}º mês consecutivo abaixo da meta`;
    const lines: string[] = ["Atenção com desempenho"];
    for (const p of list) {
      lines.push("", p.name, `${head(p)}.`);
      // os `streak` meses abaixo mais recentes (os anteriores a um mês que bateu a meta não fazem parte da sequência)
      const shown = p.months.filter((m) => m.status === "below").slice(0, Math.min(p.streak, 3)).reverse();
      for (const m of shown) lines.push(`${cap(monthLabel(m.month))} — ${formatMetric(m.attainment, { unit: "pct" })}`);
      if (p.offerAnalysis) lines.push(`Para ver onde está perdendo resultado, peça: "analisar desempenho de ${p.name}".`);
    }
    return lines.join("\n");
  }

  /** Publica/atualiza/resolve os sinais nominais no ledger. Só IDENTIFICADOS; sem R$; idempotente. */
  static publish(orgId: string, refDate: string): { published: number; resolved: number; skippedUnidentified: number } {
    const a = this.assess(orgId, refDate);
    const keep = new Set<string>();
    let published = 0;
    for (const p of a.people) {
      if (p.streak < 1 || !p.identified || !p.sellerId) continue;
      const dedupeKey = `seller_goal_streak|${p.sellerId}`;
      keep.add(dedupeKey);
      const below = p.months.filter((m) => m.status === "below").slice(0, p.streak);
      BusinessSignalService.publish(orgId, {
        domain: "retail_ops", signalType: "seller_goal_streak",
        severity: p.level === "action" ? "risk" : p.level === "critical" ? "attention" : "info",
        basis: "fact", confidence: 0.9,
        occurredAt: refDate, sourceService: SOURCE, sourceEntityType: "seller", sourceEntityId: p.sellerId,
        evidence: {
          seller: p.name, streak: p.streak, level: p.level, color: p.color, offerAnalysis: p.offerAnalysis,
          months: below.map((m) => ({ month: m.month, attainmentPct: m.attainment.value })),
          note: "meses fechados consecutivos abaixo da meta; meses sem meta ou com ausência não contam nem quebram a sequência",
        },
        dedupeKey,
      });
      try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
      published += 1;
    }
    // self-healing: quem saiu da sequência (bateu a meta) tem o sinal resolvido
    let resolved = 0;
    const open = db.prepare(`SELECT dedupe_key FROM business_signals WHERE organization_id = ? AND source_service = ? AND status = 'open'`).all(orgId, SOURCE) as any[];
    for (const o of open) {
      if (keep.has(o.dedupe_key)) continue;
      try { const r = BusinessSignalService.resolveByDedupe(orgId, o.dedupe_key); if (r?.ok) resolved += 1; } catch { /* noop */ }
    }
    return { published, resolved, skippedUnidentified: a.skippedUnidentified };
  }

  static enabled(orgId: string): boolean {
    try { return (db.prepare(`SELECT retail_seller_goal_streak_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.e === 1; } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare(`UPDATE organization_settings SET retail_seller_goal_streak_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    return on;
  }

  private static lastRun = new Map<string, string>();
  /** Scheduler: 1x por dia por org, só orgs que ligaram o alerta. Best-effort. */
  static pass(now = new Date()): void {
    const today = now.toISOString().slice(0, 10);
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE retail_seller_goal_streak_enabled = 1`).all() as any[]; } catch { return; }
    for (const o of orgs) {
      if (this.lastRun.get(o.organization_id) === today) continue;
      try { this.publish(o.organization_id, today); this.lastRun.set(o.organization_id, today); }
      catch (e) { console.error("[SellerGoalStreak] pass falhou", o.organization_id, e); }
    }
  }
}

export default SellerGoalStreakService;
