/**
 * TodayCockpitService (ADR-203 F2.3 / PRD Fase 2 §4-§6) — o "Hoje" como COCKPIT por exceção.
 * COMPÕE, não recalcula (RN-F2-4, PRD §39): `FalaTuHomeService.home` (decisões, riscos, metas, resolvido),
 * `RetailAfternoonBriefService.snapshot` (parcial do PDV + meta do mês + carimbo de frescor),
 * `RetailExceptionSignalService` (sem escala / vendedores a identificar) e `SignalLanguage.presentSignal`
 * (causa e verbo em linguagem de dono). Sem tabela nova, sem motor novo.
 *
 * Regras:
 *  - RN-F2-9: no máximo 3 PRIORIDADES, cada uma com CAUSA (o fato que a gerou) e VERBO específico.
 *    O que passa de 3 vira só uma contagem (`moreCount`) — nunca uma lista de alertas.
 *  - RN-F2-6/7: zero ≠ desconhecido ≠ estimativa — números saem como `{state, text}` (Metric); o parcial do PDV
 *    leva "último dado às HH:MM" e `stale` quando atrasado (>90 min) ou nunca sincronizado.
 *  - D4: sem meta diária inventada — mostra a META DO MÊS e o que já foi fechado + o parcial do dia.
 *  - Dinheiro role-gated (§73): sem visão completa do negócio, `network` vem null (e o valor recuperado, também).
 *  - Escopo de loja (ADR-173): usuário preso a lojas só vê as dele. Isolado por org.
 *  - Honesto: nada vira prioridade por falta de dado; org sem varejo → `network` null.
 */
import db from "./db.js";
import { FalaTuHomeService } from "./FalaTuHomeService.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { RetailAfternoonBriefService } from "./RetailAfternoonBriefService.js";
import { RetailExceptionSignalService } from "./RetailExceptionSignalService.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";
import { presentSignal } from "./SignalLanguage.js";
import { formatMetric, type Metric } from "../lib/metric.js";

export const MAX_PRIORITIES = 3;

export interface TodayPriority {
  id: string;
  kind: "decision" | "risk" | "exception" | "goal" | "signal";
  title: string;          // o que está acontecendo, específico
  cause: string;          // o fato que gerou (nunca inventado)
  verb: string;           // verbo específico: "Aprovar", "Cadastrar a escala de Bangu"...
  viewMode: string;       // para onde o verbo leva
  severity: string | null;
  weight: number;
}
export interface MetricText { state: string; text: string; reason: string | null }
export interface TodayNetwork {
  date: string;
  freshness: { dataAsOf: string | null; hhmm: string | null; stale: boolean };
  monthGoal: MetricText;       // soma das metas mensais cadastradas
  monthClosed: MetricText;     // vendido nos dias JÁ fechados (fechamento enviado)
  monthRemaining: MetricText;
  todayPartial: MetricText;    // parcial do PDV até agora — NÃO é fechamento
  coverage: { stores: number; withMonthGoal: number; withClosing: number };
  scoped: boolean;             // true = o usuário vê só parte das lojas (gerente de loja)
}
export interface TodayCockpit {
  greeting: string;
  todayLine: string;
  calm: boolean;                       // sem exceção crítica → tela calma (§12)
  priorities: TodayPriority[];         // ≤ 3
  moreCount: number;                   // quantas ficaram de fora (só contagem)
  network: TodayNetwork | null;        // só visão completa + org com lojas
  resolved: { count: number; valueRecovered: MetricText | null; windowHours: 24 };
  generatedAt: string;
}

export const mt = (m: Metric): MetricText => ({ state: m.state, text: formatMetric(m), reason: (m as any).reason ?? null });
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

export class TodayCockpitService {
  static build(orgId: string, user: any, opts: { now?: Date } = {}): TodayCockpit {
    const now = opts.now || new Date();
    const home = FalaTuHomeService.home(orgId, user, { now });
    const full = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const { dateSP } = FalaTuBriefingDigestService.spParts(now);

    const cands: TodayPriority[] = [];

    // 1) Decisões que esperam VOCÊ (aprovações) — topo da fila.
    for (const a of home.approvals.items) {
      if (!a.canApprove) continue;   // quem não pode decidir não recebe como prioridade (a decisão não é dele)
      cands.push({ id: `dec:${a.actionId}`, kind: "decision", title: String(a.title || "Decisão pendente"), cause: String(a.why || "Está esperando a sua aprovação para andar."), verb: "Aprovar ou recusar", viewMode: "falatu", severity: null, weight: 100 });
    }

    // 2) Sinais de risco/crítico e oportunidade — linguagem de dono via presentSignal.
    for (const h of home.highlights) {
      if (h.source !== "signal") continue;
      const row = db.prepare(`SELECT signal_type, domain, evidence_json, severity FROM business_signals WHERE id = ? AND organization_id = ?`).get(h.id, orgId) as any;
      if (!row) continue;
      let evidence: any = {}; try { evidence = JSON.parse(row.evidence_json || "{}"); } catch { /* evidência ilegível: segue sem */ }
      const p = presentSignal({ signalType: row.signal_type, domain: row.domain, evidence, severity: row.severity });
      const critical = row.severity === "critical";
      cands.push({ id: `sig:${h.id}`, kind: critical || row.severity === "risk" ? "risk" : "signal", title: p.title, cause: p.meaning, verb: p.actionLabel, viewMode: "saude", severity: row.severity, weight: critical ? 90 : row.severity === "risk" ? 75 : 40 + Math.min(20, Math.round((h.score || 0) / 10)) });
    }

    // 3) Exceções operacionais com dono (varejo) — respeitando o escopo de loja.
    const role = String(user?.role || "");
    const uid = String(user?.userId || user?.id || "");
    let exceptions: ReturnType<typeof RetailExceptionSignalService.items> = [];
    try { if (RetailExceptionSignalService.enabled(orgId)) exceptions = RetailExceptionSignalService.items(orgId, dateSP); } catch { /* sem varejo */ }
    for (const e of exceptions) {
      if (e.type === "retail_store_no_schedule") {
        if (!RetailStoreScopeService.canAccessStore(orgId, uid, role, e.storeId)) continue;
        cands.push({ id: `exc:noschedule:${e.storeId}`, kind: "exception", title: e.text, cause: "Sem escala cadastrada para hoje, não dá para saber quem atende na loja.", verb: `Cadastrar a escala de ${e.storeName}`, viewMode: "retailops", severity: "attention", weight: 70 });
      } else if (full || role === "owner" || role === "admin") {
        cands.push({ id: "exc:unidentified", kind: "exception", title: e.text, cause: "Há vendas no PDV de matrículas sem pessoa confirmada, a comissão fica sem dono.", verb: e.count === 1 ? "Identificar o vendedor" : `Identificar os ${e.count} vendedores`, viewMode: "retailops", severity: "attention", weight: 65 });
      }
    }

    // 4) Metas fora do ritmo (gestor).
    for (const g of home.goals?.items || []) {
      if (g.paceStatus === "behind") {
        cands.push({ id: `goal:${g.metric}`, kind: "goal", title: `Meta de ${g.label} em ${Math.round(g.attainmentPct)}%`, cause: "O ritmo atual não alcança a meta do período.", verb: `Rever o plano de ${g.label}`, viewMode: "dashboard", severity: "attention", weight: 50 });
      }
    }

    cands.sort((a, b) => b.weight - a.weight);
    const seen = new Set<string>();
    const unique = cands.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    const priorities = unique.slice(0, MAX_PRIORITIES);

    return {
      greeting: home.greeting,
      todayLine: home.attention.todayLine,
      calm: priorities.length === 0 && !home.attention.hasCriticalException,
      priorities,
      moreCount: Math.max(0, unique.length - priorities.length),
      network: full ? this.network(orgId, user, dateSP, now) : null,
      resolved: {
        count: home.resolvedSinceYesterday.count,
        valueRecovered: full && (home.resolvedSinceYesterday.valueRecovered ?? 0) > 0
          ? { state: "value", text: brl(home.resolvedSinceYesterday.valueRecovered as number), reason: null } : null,
        windowHours: 24,
      },
      generatedAt: now.toISOString(),
    };
  }

  /** Rede: meta do MÊS + fechado + parcial do dia com frescor. null se a org não tem lojas de varejo. */
  private static network(orgId: string, user: any, date: string, now: Date): TodayNetwork | null {
    try {
      const nStores = Number((db.prepare(`SELECT COUNT(*) n FROM retail_stores WHERE organization_id = ? AND active = 1`).get(orgId) as any)?.n) || 0;
      if (!nStores) return null;
      const role = String(user?.role || ""), uid = String(user?.userId || user?.id || "");
      const snap = RetailAfternoonBriefService.snapshot(orgId, date, { cutoffHour: 24, now });
      const stores = snap.stores.filter((s) => RetailStoreScopeService.canAccessStore(orgId, uid, role, s.storeId));
      const withGoal = stores.filter((s) => s.mes);
      const closed = withGoal.filter((s) => (s.mes?.closedDays || 0) > 0 && s.mes?.sold !== null);
      const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
      const partialStores = stores.map((s) => s.vendido);
      const known = partialStores.filter((m) => m.state === "value");
      const m = (state: string, text: string, reason: string | null = null): MetricText => ({ state, text, reason });
      const monthGoal = withGoal.length ? m("value", brl(sum(withGoal.map((s) => s.mes!.goal)))) : m("unknown", "—", "nenhuma meta mensal cadastrada");
      // fechado/falta só somam quando TODAS as lojas com meta já têm fechamento — senão seria "vendeu 0" disfarçado
      const allClosed = withGoal.length > 0 && closed.length === withGoal.length;
      return {
        date,
        freshness: RetailAfternoonBriefService.freshness(orgId, now),
        monthGoal,
        monthClosed: allClosed ? m("value", brl(sum(closed.map((s) => s.mes!.sold as number)))) : m("unknown", "—", withGoal.length ? `${withGoal.length - closed.length} loja(s) sem fechamento enviado no mês` : "sem meta mensal"),
        monthRemaining: allClosed ? m("value", brl(sum(closed.map((s) => s.mes!.falta as number)))) : m("not_computed", "Não calculado", "faltam fechamentos"),
        todayPartial: known.length === 0 ? m("unknown", "—", "sem vendas do PDV sincronizadas hoje")
          : m(known.length === partialStores.length ? "value" : "estimate", brl(sum(known.map((x) => x.value as number))) + (known.length === partialStores.length ? "" : " (parcial: nem todas as lojas)"), null),
        coverage: { stores: stores.length, withMonthGoal: withGoal.length, withClosing: closed.length },
        scoped: stores.length < snap.stores.length,
      };
    } catch { return null; }
  }
}

export default TodayCockpitService;
