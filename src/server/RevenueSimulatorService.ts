import db from "./db.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";

type Period = "today" | "week" | "month" | "all";

interface Assumption {
  key: string;
  label: string;
  value: number;
  editable: boolean;
  source: "history" | "assumption";
  note?: string;
}

interface SimResult {
  lever: "response_time" | "followup";
  baseline: Record<string, number>;
  target: Record<string, number>;
  delta: {
    conversionPpt?: number;       // pontos percentuais
    extraSales?: number;
    extraRevenue: number;         // R$/mês
  };
  assumptions: Assumption[];
  dataSource: "history" | "assumption" | "mixed";
  guardrail: string;              // mensagem de credibilidade visível ao cliente
  formula: string;
}

const MIN_SAMPLE_HISTORY = 30;

/**
 * Revenue Simulator — "Revenue Digital Twin" do PRD em versão leve (1-2 alavancas).
 *
 * Regra de ouro: quando houver dado suficiente, simulamos a partir da curva
 * histórica do PRÓPRIO tenant. Sem amostra (<30 fechamentos), caímos em
 * premissas DEFAULT explícitas e EDITÁVEIS — nunca um número "duro" como certeza.
 * O `guardrail` retornado diz exatamente o que é history e o que é premissa,
 * para o front exibir um banner honesto (protege a marca contra "promessa
 * inflada que não bate").
 */
export class RevenueSimulatorService {
  private static round1(v: number): number {
    return Math.round(v * 10) / 10;
  }

  private static money(v: number): number {
    return Math.round(v * 100) / 100;
  }

  /** Ticket médio usado nas projeções. Override > AOV histórico > 0. */
  private static ticket(orgId: string): { value: number; source: "custom" | "history" | "fallback" } {
    const cfg = RevenueIntelligenceService.getConfig(orgId);
    if (cfg.custom_ticket_amount && cfg.custom_ticket_amount > 0) {
      return { value: cfg.custom_ticket_amount, source: "custom" };
    }
    try {
      const r = db.prepare(`
        SELECT AVG(total_amount) AS aov
        FROM orders
        WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido')
      `).get(orgId) as any;
      const aov = Number(r?.aov || 0);
      if (aov > 0) return { value: this.money(aov), source: "history" };
    } catch (e) { /* noop */ }
    return { value: 0, source: "fallback" };
  }

  /**
   * Curva histórica de conversão por bucket de tempo de 1ª resposta. Devolve
   * um mapa { bucketSeconds: { tickets, sales, conversionPct } } se houver
   * amostra mínima; senão null.
   *
   * Buckets escolhidos para casar com a configuração `slow_response_seconds`
   * (default 300s): <=60, <=300, <=900, <=1800, >1800.
   */
  private static historicalResponseCurve(orgId: string): { buckets: any[]; sample: number } | null {
    try {
      const rows = db.prepare(`
        SELECT
          tk.id,
          (julianday(fb.t) - julianday(fc.t)) * 86400.0 AS resp_sec,
          EXISTS (
            SELECT 1 FROM ticket_closures cl
            WHERE cl.ticket_id = tk.id AND cl.result_status = 'sucesso'
          ) AS won
        FROM tickets tk
        JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type = 'contact' GROUP BY ticket_id) fc ON fc.ticket_id = tk.id
        JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type IN ('bot','agent') GROUP BY ticket_id) fb ON fb.ticket_id = tk.id
        WHERE tk.organization_id = ?
          AND julianday(fb.t) > julianday(fc.t)
      `).all(orgId) as any[];
      if (!rows || rows.length < MIN_SAMPLE_HISTORY) return null;

      const BUCKETS = [
        { upTo: 60, label: "≤ 1 min" },
        { upTo: 300, label: "≤ 5 min" },
        { upTo: 900, label: "≤ 15 min" },
        { upTo: 1800, label: "≤ 30 min" },
        { upTo: Infinity, label: "> 30 min" },
      ];
      const buckets = BUCKETS.map(b => ({ ...b, tickets: 0, sales: 0, conversionPct: 0 }));
      for (const r of rows) {
        const sec = Number(r.resp_sec || 0);
        const won = !!r.won;
        const bk = buckets.find(b => sec <= b.upTo)!;
        bk.tickets++;
        if (won) bk.sales++;
      }
      buckets.forEach(b => {
        b.conversionPct = b.tickets > 0 ? this.round1((b.sales / b.tickets) * 100) : 0;
      });
      return { buckets, sample: rows.length };
    } catch (e) {
      return null;
    }
  }

  /**
   * Interpola a conversão estimada para um dado tempo de resposta usando a
   * curva histórica do tenant (se houver). Retorna conversionPct e a fonte.
   */
  private static conversionFromCurve(curve: { buckets: any[] } | null, targetSec: number): { pct: number; source: "history" | "assumption"; note: string } {
    if (curve && curve.buckets.length) {
      // Pega o bucket onde target se encaixa.
      const bk = curve.buckets.find(b => targetSec <= b.upTo);
      if (bk && bk.tickets > 0) {
        return {
          pct: bk.conversionPct,
          source: "history",
          note: `Curva do próprio cliente: bucket ${bk.label} converte ${bk.conversionPct}% (n=${bk.tickets}).`,
        };
      }
    }
    // Premissa default explícita: cada -50% no tempo de resposta tende a
    // aumentar a conversão em ~10pp partindo de uma baseline de 15%. Editável.
    // Curva log-decay simplificada apenas para dar um número honesto.
    const baseline = 15;
    const refSec = 1800; // 30 min como referência "lenta"
    const ratio = Math.max(0.01, Math.min(1, targetSec / refSec));
    const lift = -10 * Math.log10(ratio);
    const pct = Math.max(5, Math.min(40, baseline + lift));
    return {
      pct: this.round1(pct),
      source: "assumption",
      note: "Sem amostra histórica suficiente (<30 closures). Usando curva log-decay padrão; ajuste no painel se sua realidade for outra.",
    };
  }

  /**
   * Simula impacto de baixar o tempo médio de 1ª resposta.
   *
   * @param targetSec   tempo de resposta-alvo em segundos
   * @param override    premissas opcionais editadas pelo usuário no front:
   *                    - assumedConversionPct?  força a conversão-alvo (ignora curva)
   *                    - leadsPerMonth?         override do volume de leads
   */
  static simulateResponseTime(orgId: string, targetSec: number, override?: { assumedConversionPct?: number; leadsPerMonth?: number }): SimResult {
    const period: Period = "month";
    const m = AnalyticsService.getMetrics(orgId, { period });
    const tk = this.ticket(orgId);
    const curve = this.historicalResponseCurve(orgId);

    const baselineSec = Number(m.averageFirstResponseTime || 0);
    const tickets = Number(m.totalTickets || 0);
    const baselineConvPct = tickets > 0 ? this.round1((Number(m.salesCount || 0) / tickets) * 100) : 0;

    const fromCurve = this.conversionFromCurve(curve, targetSec);
    const targetConvPct = override?.assumedConversionPct != null
      ? this.round1(Number(override.assumedConversionPct))
      : fromCurve.pct;

    const leadsPerMonth = override?.leadsPerMonth != null
      ? Math.max(0, Math.floor(Number(override.leadsPerMonth)))
      : tickets;

    const deltaPpt = this.round1(targetConvPct - baselineConvPct);
    const extraSales = Math.max(0, Math.round((deltaPpt / 100) * leadsPerMonth));
    const extraRevenue = this.money(extraSales * tk.value);

    const dataSource: "history" | "assumption" | "mixed" =
      override?.assumedConversionPct != null
        ? "assumption"
        : fromCurve.source;

    const assumptions: Assumption[] = [
      { key: "leadsPerMonth", label: "Leads por mês", value: leadsPerMonth, editable: true,
        source: override?.leadsPerMonth != null ? "assumption" : "history",
        note: "Tickets do último mês. Edite se a janela típica for diferente." },
      { key: "ticket", label: "Ticket médio (R$)", value: tk.value, editable: true,
        source: tk.source === "custom" ? "assumption" : (tk.source === "history" ? "history" : "assumption"),
        note: "Override em Revenue Intelligence > Configuração." },
      { key: "baselineConversionPct", label: "Conversão atual (%)", value: baselineConvPct, editable: false,
        source: "history", note: `vendas / tickets do período (n=${tickets}).` },
      { key: "targetConversionPct", label: "Conversão-alvo (%)", value: targetConvPct, editable: true,
        source: fromCurve.source, note: fromCurve.note },
    ];

    const guardrail =
      dataSource === "history"
        ? "Projeção a partir da curva histórica do próprio cliente — alta credibilidade."
        : "Projeção parte de premissas padrão porque a amostra é pequena. NÃO é promessa: cada premissa é editável.";

    return {
      lever: "response_time",
      baseline: {
        firstResponseSeconds: baselineSec,
        conversionPct: baselineConvPct,
        salesPerMonth: Number(m.salesCount || 0),
        revenuePerMonth: this.money(Number(m.paidRevenue || 0)),
      },
      target: {
        firstResponseSeconds: targetSec,
        conversionPct: targetConvPct,
      },
      delta: {
        conversionPpt: deltaPpt,
        extraSales,
        extraRevenue,
      },
      assumptions,
      dataSource,
      guardrail,
      formula: "leads × Δ conversão × ticket médio",
    };
  }

  /**
   * Curva histórica do follow-up: dos contatos que entraram em cadência, qual
   * a taxa de "recuperação" (responderam) e a de venda subsequente.
   */
  private static historicalFollowupCurve(orgId: string): { responsePct: number; salePct: number; sample: number } | null {
    try {
      const r = db.prepare(`
        SELECT
          COUNT(*) AS sample,
          SUM(CASE WHEN cc.last_contact_message_at IS NOT NULL AND cc.last_contact_message_at > cc.started_at THEN 1 ELSE 0 END) AS responded,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM orders o
            WHERE o.organization_id = cc.organization_id
              AND o.contact_id = cc.contact_id
              AND o.status IN ('pago','em_preparo','entregue','concluido')
              AND o.created_at >= cc.started_at
              AND o.created_at <= datetime(cc.started_at, '+14 days')
          ) THEN 1 ELSE 0 END) AS sold
        FROM contact_cadences cc
        WHERE cc.organization_id = ?
      `).get(orgId) as any;
      const sample = Number(r?.sample || 0);
      if (sample < MIN_SAMPLE_HISTORY) return null;
      return {
        responsePct: this.round1((Number(r.responded || 0) / sample) * 100),
        salePct: this.round1((Number(r.sold || 0) / sample) * 100),
        sample,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Simula impacto de cobrir mais % dos leads dormentes com follow-up.
   *
   * @param targetReachPct  % dos dormentes que passam a receber follow-up
   * @param override        { dormantLeads?, salePerFollowupPct? }
   */
  static simulateFollowup(orgId: string, targetReachPct: number, override?: { dormantLeads?: number; salePerFollowupPct?: number }): SimResult {
    const tk = this.ticket(orgId);
    const curve = this.historicalFollowupCurve(orgId);

    // Leads dormentes: tickets em estágios quentes sem resposta nossa há >24h.
    let dormant = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM tickets t
        WHERE t.organization_id = ? AND t.status = 'open'
          AND t.stage IN ('qualificado','proposta','aguardando_pagamento','novo_lead','ia_atendendo')
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.ticket_id = t.id AND m.sender_type IN ('bot','agent')
              AND m.created_at >= datetime('now','-24 hours')
          )
      `).get(orgId) as any;
      dormant = Number(r?.n || 0);
    } catch (e) { /* noop */ }
    const dormantLeads = override?.dormantLeads != null
      ? Math.max(0, Math.floor(Number(override.dormantLeads)))
      : dormant;

    // Hoje: % dormente já em cadência ativa.
    let inCadenceNow = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT cc.ticket_id) AS n FROM contact_cadences cc
        WHERE cc.organization_id = ? AND cc.status = 'active'
      `).get(orgId) as any;
      inCadenceNow = Number(r?.n || 0);
    } catch (e) { /* noop */ }
    const baselineReachPct = dormantLeads > 0 ? this.round1((inCadenceNow / dormantLeads) * 100) : 0;
    const targetPct = Math.max(0, Math.min(100, this.round1(Number(targetReachPct))));

    const salePerFollowupPct = override?.salePerFollowupPct != null
      ? Math.max(0, Math.min(100, this.round1(Number(override.salePerFollowupPct))))
      : (curve?.salePct ?? 8); // 8% default conservador
    const salePerFollowupSource: "history" | "assumption" = override?.salePerFollowupPct != null
      ? "assumption"
      : (curve ? "history" : "assumption");

    const extraReachPct = Math.max(0, targetPct - baselineReachPct);
    const extraTouched = Math.round((extraReachPct / 100) * dormantLeads);
    const extraSales = Math.max(0, Math.round((salePerFollowupPct / 100) * extraTouched));
    const extraRevenue = this.money(extraSales * tk.value);

    const dataSource: "history" | "assumption" | "mixed" = curve && !override
      ? "history"
      : (override ? "assumption" : "mixed");

    const assumptions: Assumption[] = [
      { key: "dormantLeads", label: "Leads dormentes", value: dormantLeads, editable: true,
        source: override?.dormantLeads != null ? "assumption" : "history",
        note: "Tickets em estágio quente sem resposta nossa há >24h." },
      { key: "ticket", label: "Ticket médio (R$)", value: tk.value, editable: true,
        source: tk.source === "history" ? "history" : "assumption",
        note: "Override em Revenue Intelligence > Configuração." },
      { key: "baselineReachPct", label: "% já coberto por cadência hoje", value: baselineReachPct, editable: false,
        source: "history", note: `${inCadenceNow} ticket(s) em cadência ativa.` },
      { key: "targetReachPct", label: "% alvo a cobrir", value: targetPct, editable: true,
        source: "assumption", note: "Decisão do gestor." },
      { key: "salePerFollowupPct", label: "% que vira venda no follow-up", value: salePerFollowupPct, editable: true,
        source: salePerFollowupSource,
        note: curve
          ? `Curva do próprio cliente: ${salePerFollowupPct}% das cadências iniciadas viraram venda em 14 dias (n=${curve.sample}).`
          : "Sem amostra histórica (<30 cadências). 8% é uma premissa conservadora — calibre conforme a vertical." },
    ];

    const guardrail = dataSource === "history"
      ? "Projeção a partir da curva histórica do próprio cliente — alta credibilidade."
      : "Projeção parte de premissas padrão. NÃO é promessa: cada premissa é editável.";

    return {
      lever: "followup",
      baseline: {
        dormantLeads,
        reachPct: baselineReachPct,
      },
      target: {
        reachPct: targetPct,
        extraTouched,
      },
      delta: {
        extraSales,
        extraRevenue,
      },
      assumptions,
      dataSource,
      guardrail,
      formula: "Δ cobertura × leads dormentes × % de conversão de follow-up × ticket",
    };
  }

  /** Despacha pela alavanca solicitada. */
  static simulate(orgId: string, lever: "response_time" | "followup", params: any, assumptions?: any): SimResult {
    if (lever === "response_time") {
      return this.simulateResponseTime(
        orgId,
        Number(params?.targetSeconds ?? 60),
        {
          assumedConversionPct: assumptions?.targetConversionPct,
          leadsPerMonth: assumptions?.leadsPerMonth,
        }
      );
    }
    if (lever === "followup") {
      return this.simulateFollowup(
        orgId,
        Number(params?.targetReachPct ?? 80),
        {
          dormantLeads: assumptions?.dormantLeads,
          salePerFollowupPct: assumptions?.salePerFollowupPct,
        }
      );
    }
    throw new Error(`Alavanca desconhecida: ${lever}`);
  }
}
