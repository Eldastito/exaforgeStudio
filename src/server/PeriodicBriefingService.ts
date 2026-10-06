import db from "./db.js";
import { ResultsStoryService } from "./ResultsStoryService.js";
import { RetailForecastService } from "./RetailForecastService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";
import { InterventionEffectivenessService } from "./InterventionEffectivenessService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { todaySP } from "./spDate.js";

/**
 * PeriodicBriefingService — ADR-204 F3.10 (briefing SEMANAL comercial e MENSAL).
 *
 * COMPÕE, read-only, o que o negócio já sabe (resultado × meta da rede e das lojas, previsão do mês, vendedores que mais
 * caíram, metas, impacto das ações, prioridades) — NÃO recalcula nada e não cria motor/tabela/canal novo. A entrega usa o que existe:
 * `publish` grava UM sinal SEM dinheiro no `business_signals` (conv. nº 12), que flui sozinho pro Smart Inbox/"Hoje"/push/WhatsApp com
 * quiet-hours e limiar do `FalaTuProactiveService`. O texto completo (com R$) é lido sob demanda e role-gated (§73).
 *
 * Regras: cada seção que não tem fonte/dado diz POR QUÊ (`available:false` + reason) — nunca preenche; seção de dinheiro vira
 * `restricted` pra quem não tem visão completa; impacto é "associado" (F3.8), "o que funciona" só com amostra (F3.7); mensal olha o mês
 * FECHADO anterior; só publica quando há ALGO a dizer (loja abaixo / meta fora do ritmo / prioridade) e uma vez por período; opt-in
 * `periodic_briefing_enabled` (default 0 — conv. nº 10). Não cobre (declarado em `notCovered`): margem confiável, estoque, clientes, campanhas.
 */
export type BriefingPeriod = "week" | "month";
export interface BriefingSection { key: string; title: string; available: boolean; restricted: boolean; reason: string | null; lines: string[] }
export interface PeriodicBriefing {
  period: BriefingPeriod; periodKey: string; asOf: string; restricted: boolean;
  sections: BriefingSection[]; notCovered: Array<{ topic: string; reason: string }>;
  summary: { storesBelow: number | null; goalsBehind: number | null; priorities: number }; notable: boolean; text: string; generatedAt: string;
}

const NOT_COVERED = [
  { topic: "margem confiável", reason: "não há margem por loja/período confiável como fonte única hoje" },
  { topic: "estoque", reason: "não há leitura consolidada de falta/giro da rede pronta pra compor" },
  { topic: "clientes e campanhas", reason: "depende da regra de consentimento (LGPD) e de dados de campanha ainda não definidos" },
];
const brl = (n: number) => `R$ ${(Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const SYSTEM_USER = { role: "owner", userId: "system:periodic-briefing", id: "system:periodic-briefing" };

function addDays(d: string, n: number): string { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function mondayOf(d: string): string { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); }
function lastDayOfPrevMonth(d: string): string { const t = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); t.setUTCDate(0); return t.toISOString().slice(0, 10); }
const mtText = (m: any): string | null => (m && m.state === "value" ? String(m.text) : null);

export class PeriodicBriefingService {
  static enabled(orgId: string): boolean {
    try { return !!Number((db.prepare("SELECT periodic_briefing_enabled v FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.v); } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): { enabled: boolean } {
    db.prepare("UPDATE organization_settings SET periodic_briefing_enabled = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return { enabled: on };
  }

  /** Data de referência do período: semana → ontem (SP); mês → último dia do mês FECHADO anterior. */
  static asOfFor(period: BriefingPeriod, now: Date): string {
    const today = todaySP(now);
    return period === "week" ? addDays(today, -1) : lastDayOfPrevMonth(today);
  }
  static periodKey(period: BriefingPeriod, asOf: string): string { return period === "week" ? mondayOf(asOf) : asOf.slice(0, 7); }

  static compose(orgId: string, user: any, opts: { period: BriefingPeriod; now?: Date }): PeriodicBriefing {
    const now = opts.now || new Date();
    const period = opts.period === "month" ? "month" : "week";
    const asOf = this.asOfFor(period, now);
    const full = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const sections: BriefingSection[] = [];
    const sec = (key: string, title: string, f: () => { lines: string[]; reason?: string | null; moneyOnly?: boolean }) => {
      try {
        const r = f();
        if (r.moneyOnly && !full) { sections.push({ key, title, available: true, restricted: true, reason: "Os números são do gestor.", lines: [] }); return; }
        sections.push({ key, title, available: r.lines.length > 0, restricted: false, reason: r.lines.length ? null : (r.reason || "sem dado pra concluir"), lines: r.lines });
      } catch { sections.push({ key, title, available: false, restricted: false, reason: "fonte indisponível", lines: [] }); }
    };

    let story: any = null; let storesBelow: number | null = null;
    try { story = ResultsStoryService.build(orgId, user, { date: asOf, now }); } catch { /* sem varejo */ }
    sec("resultado", period === "week" ? "Resultado da semana" : "Fechamento do mês", () => {
      if (!story?.hasRetail) return { lines: [], reason: "a empresa não tem lojas cadastradas" };
      if (story.restricted) return { lines: [], moneyOnly: true };
      const n = story.network; if (!n) return { lines: [], reason: story.headlineReason || "sem leitura da rede" };
      const p = period === "week" ? n.week : n.month;
      const v = mtText(p.venda), c = mtText(p.cota), a = mtText(p.atingimento);
      if (!v || !c || !a) return { lines: [], reason: "faltam fechamentos ou meta do período" };
      storesBelow = n.storesBelow;
      const l = [`Rede: ${v} de ${c} (${a} da meta).`];
      if (n.storesBelow) l.push(`${n.storesBelow} ${n.storesBelow === 1 ? "loja abaixo" : "lojas abaixo"} da meta no último dia fechado (${asOf.slice(8, 10)}/${asOf.slice(5, 7)}).`);
      return { lines: l, moneyOnly: true };
    });
    sec("lojas", "Lojas que pedem atenção", () => {
      const below = (story?.stores || []).filter((s: any) => s.status === "below");
      if (storesBelow == null) storesBelow = story && story.hasRetail && !story.restricted ? below.length : null;
      return { lines: below.slice(0, 5).map((s: any) => `${s.name}: ${mtText(s.month.atingimento) ? `${mtText(s.month.atingimento)} da meta do mês` : "abaixo da meta"}`), reason: "nenhuma loja abaixo da meta", moneyOnly: true };
    });
    if (period === "week") sec("previsao", "Previsão do mês", () => {
      const f = RetailForecastService.forecast(orgId, { asOf, now: now.getTime() });
      const pr = f.network?.projection; if (!pr) return { lines: [], reason: "histórico insuficiente pra projetar (não inventamos faixa)", moneyOnly: true };
      const l = [`Projeção da rede no mês: ${brl(pr.low)} a ${brl(pr.high)} (${pr.band}); central ${brl(pr.mid)}.`];
      if (f.network.storesExcluded?.length) l.push(`${f.network.storesExcluded.length} loja(s) fora da projeção por histórico insuficiente.`);
      return { lines: l, moneyOnly: true };
    });
    sec("vendedores", "Equipe — quem mais caiu", () => {
      const below = (story?.stores || []).filter((s: any) => s.status === "below").slice(0, 3);
      const l: string[] = [];
      for (const s of below) {
        const u: any = ResultsStoryService.understand(orgId, user, s.storeId, { date: asOf, now });
        for (const t of (u?.team || []).slice(0, 2)) {
          const fact = (t.findings || []).find((x: any) => x.kind === "fact");
          if (fact) l.push(`${s.name} — ${t.name}: ${fact.text}`);
        }
      }
      return { lines: l, reason: "nenhuma queda de vendedor mensurável nas lojas abaixo", moneyOnly: true };
    });
    let goalsBehind: number | null = null;
    sec("metas", "Metas", () => {
      const g = BusinessGoalService.progress(orgId).goals;
      goalsBehind = g.filter((x: any) => x.paceStatus === "behind").length;
      return { lines: g.filter((x: any) => x.paceStatus === "behind").slice(0, 5).map((x: any) => `${x.label}: ${Math.round(x.attainmentPct)}% (fora do ritmo)`), reason: g.length ? "nenhuma meta fora do ritmo" : "nenhuma meta cadastrada", moneyOnly: true };
    });
    sec("impacto", "O que o ZapFlow produziu (acumulado)", () => {
      const t: any = OutcomeMeasurementService.ledger(orgId, { limit: 500 }).totals;
      const l: string[] = [];
      if (t.count > 0) {
        l.push(`${t.count} ação(ões) com resultado medido — valores ASSOCIADOS às ações (sem grupo de controle, não é efeito causal).`);
        if (t.net.net != null) l.push(`Líquido onde o custo é conhecido: ${brl(t.net.net)} (custo ${brl(t.net.cost)}); ${t.net.costUnknownCount} medição(ões) sem custo ficam de fora.`);
        else if (t.net.costUnknownCount > 0) l.push("Nenhum custo de intervenção informado ainda — sem resultado líquido.");
      }
      const works = InterventionEffectivenessService.summary(orgId, { canSeeMoney: false }).items.filter((i) => i.verdict === "works").slice(0, 2);
      for (const w of works) l.push(`Costuma atingir o esperado: ${w.actionType} (${w.hits}/${w.sample}).`);
      return { lines: l, reason: "nenhum resultado medido ainda", moneyOnly: true };
    });
    let nPrio = 0;
    sec("prioridades", "Prioridades da próxima semana", () => {
      const p = (ImpactPrioritizationService.prioritize(orgId)?.global || []).slice(0, 3);
      nPrio = p.length;
      return { lines: p.map((x: any, i: number) => `${i + 1}. ${x.recommendedAction}${full && x.impact?.unit === "BRL" ? ` (${brl(x.impact.amount)})` : ""}`), reason: "nada urgente" };
    });

    const notable = (storesBelow || 0) > 0 || (goalsBehind || 0) > 0 || nPrio > 0;
    const text = [`*${period === "week" ? "Briefing semanal" : "Briefing mensal"}* — ${asOf.slice(8, 10)}/${asOf.slice(5, 7)}`,
      ...sections.filter((s) => s.available && !s.restricted).flatMap((s) => [`\n*${s.title}*`, ...s.lines.map((x) => `• ${x}`)]),
      ...(sections.some((s) => s.restricted) ? ["\nOs números das lojas e das metas são do gestor."] : []),
      ...(sections.some((s) => !s.available && !s.restricted) ? ["\nSem dado pra concluir: " + sections.filter((s) => !s.available && !s.restricted).map((s) => `${s.title} (${s.reason})`).join("; ") + "."] : []),
      "\nNão coberto neste briefing: " + NOT_COVERED.map((n) => n.topic).join(", ") + "."].join("\n");
    return { period, periodKey: this.periodKey(period, asOf), asOf, restricted: !full, sections, notCovered: NOT_COVERED, summary: { storesBelow, goalsBehind, priorities: nPrio }, notable, text, generatedAt: now.toISOString() };
  }

  /** Publica UM sinal SEM dinheiro por período (idempotente por dedupe_key). Só com algo a dizer. */
  static publish(orgId: string, opts: { period: BriefingPeriod; now?: Date; force?: boolean }): { published: boolean; reason?: string; periodKey?: string } {
    if (!opts.force && !this.enabled(orgId)) return { published: false, reason: "disabled" };
    const b = this.compose(orgId, SYSTEM_USER, { period: opts.period, now: opts.now });
    if (!b.notable) return { published: false, reason: "nothing_notable", periodKey: b.periodKey };
    const bits: string[] = [];
    if (b.summary.storesBelow) bits.push(`${b.summary.storesBelow} ${b.summary.storesBelow === 1 ? "loja abaixo" : "lojas abaixo"} da meta`);
    if (b.summary.goalsBehind) bits.push(`${b.summary.goalsBehind} ${b.summary.goalsBehind === 1 ? "meta fora do ritmo" : "metas fora do ritmo"}`);
    if (b.summary.priorities) bits.push(`${b.summary.priorities} ${b.summary.priorities === 1 ? "prioridade" : "prioridades"}`);
    const label = opts.period === "week" ? "Briefing semanal pronto" : "Briefing mensal pronto";
    try {
      BusinessSignalService.publish(orgId, {
        domain: "executive", signalType: opts.period === "week" ? "weekly_commercial_briefing" : "monthly_briefing", severity: "info", basis: "fact", confidence: 1,
        impactAmount: null, impactUnit: null, sourceService: "PeriodicBriefingService",
        evidence: { note: `${label}: ${bits.join(" · ")}. Veja o detalhe em Resultados → Briefing.`, period: opts.period, periodKey: b.periodKey, ...b.summary },
        dedupeKey: `periodic_briefing:${opts.period}:${b.periodKey}`,
        expiresAt: new Date((opts.now || new Date()).getTime() + (opts.period === "week" ? 7 : 31) * 86400000).toISOString(),
      });
      return { published: true, periodKey: b.periodKey };
    } catch { return { published: false, reason: "publish_failed" }; }
  }

  /** Scheduler: segunda (SP) publica o semanal; dias 1–3 publicam o mensal do mês fechado. Idempotente por período; só orgs com opt-in. */
  static pass(now: Date = new Date()): void {
    const today = todaySP(now);
    const isMonday = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) === 0;
    const day = Number(today.slice(8, 10));
    if (!isMonday && day > 3) return;
    let orgs: any[] = [];
    try { orgs = db.prepare("SELECT organization_id FROM organization_settings WHERE status = 'active' AND periodic_briefing_enabled = 1").all() as any[]; } catch { return; }
    for (const o of orgs) {
      try { if (isMonday) this.publish(o.organization_id, { period: "week", now }); if (day <= 3) this.publish(o.organization_id, { period: "month", now }); }
      catch (e) { console.error("[PeriodicBriefing] falhou", o.organization_id, e); }
    }
  }
}

export default PeriodicBriefingService;
