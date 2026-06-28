import db from "./db.js";
import { AnalyticsService } from "./AnalyticsService.js";

type Period = "today" | "week" | "month" | "all";

interface RicConfig {
  prob_lead_slow_response: number;
  prob_quote_no_response: number;
  prob_abandoned: number;
  prob_inactive: number;
  slow_response_seconds: number;
  quote_stale_hours: number;
  inactive_days: number;
  attribution_window_days: number;
  custom_ticket_amount: number | null;
  weight_atendimento: number;
  weight_comercial: number;
  weight_operacional: number;
}

const DEFAULT_CONFIG: RicConfig = {
  prob_lead_slow_response: 0.35,
  prob_quote_no_response: 0.50,
  prob_abandoned: 0.60,
  prob_inactive: 0.40,
  slow_response_seconds: 300,
  quote_stale_hours: 72,
  inactive_days: 60,
  attribution_window_days: 14,
  custom_ticket_amount: null,
  weight_atendimento: 40,
  weight_comercial: 40,
  weight_operacional: 20,
};

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function money(v: number): number {
  return Math.round(v * 100) / 100;
}

// Janela do período em SQL (sobre uma coluna created_at). Igual ao AnalyticsService.
function periodFilter(period: Period, col = "created_at"): string {
  if (period === "today") return `AND date(${col}) = date('now')`;
  if (period === "week") return `AND ${col} >= datetime('now', '-7 days')`;
  if (period === "month") return `AND ${col} >= datetime('now', '-30 days')`;
  return "";
}

/**
 * Revenue Intelligence Service — IQR (Índice de Qualidade da Receita) com 3
 * drivers transparentes, Perda Estimada configurável, IRR (recuperável) e RRI
 * (recuperado por fluxos do ZappFlow). Não inventa nada: cada número vem do
 * banco do tenant e o "porquê" acompanha o índice.
 *
 * Princípio de honestidade: probabilidades são CONSERVADORAS por padrão e a
 * fórmula é configurável por organização. A Perda é sempre rotulada como
 * "potencial em risco" no front, com a premissa visível.
 */
export class RevenueIntelligenceService {
  static getConfig(orgId: string): RicConfig {
    const row = db.prepare(
      `SELECT * FROM revenue_intelligence_config WHERE organization_id = ?`
    ).get(orgId) as any;
    if (!row) return { ...DEFAULT_CONFIG };
    return {
      prob_lead_slow_response: row.prob_lead_slow_response ?? DEFAULT_CONFIG.prob_lead_slow_response,
      prob_quote_no_response: row.prob_quote_no_response ?? DEFAULT_CONFIG.prob_quote_no_response,
      prob_abandoned: row.prob_abandoned ?? DEFAULT_CONFIG.prob_abandoned,
      prob_inactive: row.prob_inactive ?? DEFAULT_CONFIG.prob_inactive,
      slow_response_seconds: row.slow_response_seconds ?? DEFAULT_CONFIG.slow_response_seconds,
      quote_stale_hours: row.quote_stale_hours ?? DEFAULT_CONFIG.quote_stale_hours,
      inactive_days: row.inactive_days ?? DEFAULT_CONFIG.inactive_days,
      attribution_window_days: row.attribution_window_days ?? DEFAULT_CONFIG.attribution_window_days,
      custom_ticket_amount: row.custom_ticket_amount ?? null,
      weight_atendimento: row.weight_atendimento ?? DEFAULT_CONFIG.weight_atendimento,
      weight_comercial: row.weight_comercial ?? DEFAULT_CONFIG.weight_comercial,
      weight_operacional: row.weight_operacional ?? DEFAULT_CONFIG.weight_operacional,
    };
  }

  static saveConfig(orgId: string, patch: Partial<RicConfig>): RicConfig {
    const cur = this.getConfig(orgId);
    const next = { ...cur, ...patch };
    db.prepare(`
      INSERT INTO revenue_intelligence_config (
        organization_id, prob_lead_slow_response, prob_quote_no_response, prob_abandoned, prob_inactive,
        slow_response_seconds, quote_stale_hours, inactive_days, attribution_window_days,
        custom_ticket_amount, weight_atendimento, weight_comercial, weight_operacional, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(organization_id) DO UPDATE SET
        prob_lead_slow_response = excluded.prob_lead_slow_response,
        prob_quote_no_response = excluded.prob_quote_no_response,
        prob_abandoned = excluded.prob_abandoned,
        prob_inactive = excluded.prob_inactive,
        slow_response_seconds = excluded.slow_response_seconds,
        quote_stale_hours = excluded.quote_stale_hours,
        inactive_days = excluded.inactive_days,
        attribution_window_days = excluded.attribution_window_days,
        custom_ticket_amount = excluded.custom_ticket_amount,
        weight_atendimento = excluded.weight_atendimento,
        weight_comercial = excluded.weight_comercial,
        weight_operacional = excluded.weight_operacional,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      orgId,
      next.prob_lead_slow_response, next.prob_quote_no_response, next.prob_abandoned, next.prob_inactive,
      next.slow_response_seconds, next.quote_stale_hours, next.inactive_days, next.attribution_window_days,
      next.custom_ticket_amount, next.weight_atendimento, next.weight_comercial, next.weight_operacional,
    );
    return next;
  }

  /**
   * Ticket médio para a engine de Perda. Usa override do cliente; senão usa o
   * AOV histórico (orders faturados, mesmo escopo do AnalyticsService).
   */
  private static ticketAmount(orgId: string, cfg: RicConfig): { value: number; source: "custom" | "history" | "fallback" } {
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
      if (aov > 0) return { value: money(aov), source: "history" };
    } catch (e) { /* noop */ }
    return { value: 0, source: "fallback" };
  }

  /**
   * Driver ATENDIMENTO (0-100): qualidade da janela de resposta + abandono.
   * Quanto mais lento/abandonado, menor o score.
   */
  private static driverAtendimento(orgId: string, period: Period, m: any, cfg: RicConfig) {
    // 1ª resposta: ideal <= slow_response_seconds; 0 pts se >= 10x esse limite.
    const frt = Number(m.averageFirstResponseTime || 0);
    const ideal = cfg.slow_response_seconds; // ex.: 300s
    const ceiling = ideal * 10;               // ex.: 3000s
    let respScore = 100;
    if (frt > ideal) {
      const over = (frt - ideal) / (ceiling - ideal);
      respScore = clamp(100 - over * 100);
    }

    // Abandono: % de tickets que precisaram de "cutucão" (proxy direto de
    // conversa sem resposta nossa). Quanto maior, pior.
    const totalTickets = Number(m.totalTickets || 0);
    const nudged = Number(m?.hospitality?.abandonedNudged || 0);
    const abandonRate = totalTickets > 0 ? (nudged / totalTickets) * 100 : 0;
    const abandonScore = clamp(100 - abandonRate * 2); // 50% abandono => 0

    // Sem-resposta crítica: leads ainda em 'novo_lead' há > 4h sem 1 mensagem nossa.
    let stalledLeads = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM tickets t
        WHERE t.organization_id = ? AND t.status = 'open' AND t.stage = 'novo_lead'
          AND t.created_at <= datetime('now','-4 hours')
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.ticket_id = t.id AND m.sender_type IN ('bot','agent')
          )
      `).get(orgId) as any;
      stalledLeads = Number(r?.n || 0);
    } catch (e) { /* noop */ }
    const stalledScore = stalledLeads === 0 ? 100 : clamp(100 - stalledLeads * 5); // 20 leads parados => 0

    const score = round1((respScore + abandonScore + stalledScore) / 3);
    return {
      score,
      breakdown: {
        firstResponseSec: frt,
        firstResponseScore: round1(respScore),
        abandonRatePct: round1(abandonRate),
        abandonScore: round1(abandonScore),
        stalledLeads,
        stalledLeadsScore: round1(stalledScore),
      },
    };
  }

  /**
   * Driver COMERCIAL (0-100): conversão + orçamentos parados + leads sem retorno.
   */
  private static driverComercial(orgId: string, period: Period, m: any, cfg: RicConfig) {
    const tickets = Number(m.totalTickets || 0);
    const sales = Number(m.salesCount || 0);
    const conversionPct = tickets > 0 ? (sales / tickets) * 100 : 0;
    // Conversão "saudável" varia muito por vertical. Sem benchmark ainda, usamos
    // âncora simples: 30% já é excelente (=> 100). Configurável depois.
    const convScore = clamp((conversionPct / 30) * 100);

    // Orçamentos parados: sent sem accept/decline há > quote_stale_hours.
    let staleQuotes = 0, totalSent = 0;
    try {
      const r = db.prepare(`
        SELECT
          COUNT(*) AS sent,
          SUM(CASE WHEN status = 'sent' AND sent_at <= datetime('now', ?) THEN 1 ELSE 0 END) AS stale
        FROM quotes WHERE organization_id = ?
      `).get(`-${cfg.quote_stale_hours} hours`, orgId) as any;
      totalSent = Number(r?.sent || 0);
      staleQuotes = Number(r?.stale || 0);
    } catch (e) { /* noop */ }
    const staleRate = totalSent > 0 ? (staleQuotes / totalSent) * 100 : 0;
    const quoteScore = clamp(100 - staleRate);

    // Leads sem retorno: tickets em estágios quentes ('qualificado','proposta','aguardando_pagamento')
    // sem mensagem nossa há > 24h.
    let coldDeals = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM tickets t
        WHERE t.organization_id = ? AND t.status = 'open'
          AND t.stage IN ('qualificado','proposta','aguardando_pagamento')
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.ticket_id = t.id AND m.sender_type IN ('bot','agent')
              AND m.created_at >= datetime('now','-24 hours')
          )
      `).get(orgId) as any;
      coldDeals = Number(r?.n || 0);
    } catch (e) { /* noop */ }
    const coldScore = coldDeals === 0 ? 100 : clamp(100 - coldDeals * 4); // 25 negócios frios => 0

    const score = round1((convScore + quoteScore + coldScore) / 3);
    return {
      score,
      breakdown: {
        conversionPct: round1(conversionPct),
        conversionScore: round1(convScore),
        staleQuotes,
        staleQuoteRatePct: round1(staleRate),
        staleQuoteScore: round1(quoteScore),
        coldDeals,
        coldDealsScore: round1(coldScore),
      },
    };
  }

  /**
   * Driver OPERACIONAL (0-100): carga de repasses humanos + velocidade do funil.
   * (Carga por operador e horários críticos ficam pro pós-MVP — sem dado limpo ainda.)
   */
  private static driverOperacional(orgId: string, period: Period, m: any) {
    const tickets = Number(m.totalTickets || 0);
    const handoff = Number(m.handoffCount || 0);
    const handoffRate = tickets > 0 ? (handoff / tickets) * 100 : 0;
    // Repasse pra humano é OK; muito acima de 30% sinaliza que a IA não está
    // resolvendo e a operação tá sobrecarregada.
    const handoffScore = clamp(100 - Math.max(0, handoffRate - 30) * 2);

    // Velocidade do funil: tempo médio até a venda. Quanto menor, melhor.
    const hours = Number(m.avgTimeToSaleHours || 0);
    let speedScore = 100;
    if (hours > 0) {
      // Ancora: 24h excelente (100), 168h (1 semana) ruim (0).
      speedScore = clamp(100 - ((hours - 24) / (168 - 24)) * 100);
    }

    const score = round1((handoffScore + speedScore) / 2);
    return {
      score,
      breakdown: {
        handoffRatePct: round1(handoffRate),
        handoffScore: round1(handoffScore),
        avgTimeToSaleHours: hours,
        speedScore: round1(speedScore),
      },
    };
  }

  /**
   * PERDA ESTIMADA (potencial em risco) = soma de fontes de leads impactados ×
   * probabilidade × ticket médio. Cada fonte aparece separada — o cliente vê de
   * onde vem cada R$. Conservador por padrão.
   */
  private static estimatedLoss(orgId: string, period: Period, m: any, cfg: RicConfig) {
    const dateFilter = periodFilter(period);
    const tk = this.ticketAmount(orgId, cfg);
    const ticket = tk.value;

    // 1) Leads com 1ª resposta lenta (acima de slow_response_seconds).
    let slowLeads = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT tk.id, (julianday(fb.t) - julianday(fc.t)) * 86400.0 AS resp
          FROM tickets tk
          JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type = 'contact' GROUP BY ticket_id) fc ON fc.ticket_id = tk.id
          JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type IN ('bot','agent') GROUP BY ticket_id) fb ON fb.ticket_id = tk.id
          WHERE tk.organization_id = ? ${dateFilter.replace(/created_at/g, 'tk.created_at')}
            AND (julianday(fb.t) - julianday(fc.t)) * 86400.0 >= ?
        )
      `).get(orgId, cfg.slow_response_seconds) as any;
      slowLeads = Number(r?.n || 0);
    } catch (e) { /* noop */ }

    // 2) Orçamentos enviados sem resposta (stale).
    let staleQuotes = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM quotes
        WHERE organization_id = ? AND status = 'sent'
          AND sent_at <= datetime('now', ?)
      `).get(orgId, `-${cfg.quote_stale_hours} hours`) as any;
      staleQuotes = Number(r?.n || 0);
    } catch (e) { /* noop */ }

    // 3) Conversas abandonadas no período (nudged).
    let abandoned = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM tickets
        WHERE organization_id = ? AND abandoned_nudged_at IS NOT NULL
          ${dateFilter.replace(/created_at/g, 'abandoned_nudged_at')}
      `).get(orgId) as any;
      abandoned = Number(r?.n || 0);
    } catch (e) { /* noop */ }

    // 4) Clientes inativos com histórico de compra.
    let inactive = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n FROM contacts
        WHERE organization_id = ? AND purchase_count > 0
          AND (last_purchase_at IS NULL OR last_purchase_at < datetime('now', ?))
          AND COALESCE(marketing_opt_out,0) = 0
      `).get(orgId, `-${cfg.inactive_days} days`) as any;
      inactive = Number(r?.n || 0);
    } catch (e) { /* noop */ }

    const items = [
      { key: "slow_response", label: "Leads com 1ª resposta lenta", count: slowLeads, prob: cfg.prob_lead_slow_response, recoverable: true },
      { key: "stale_quotes", label: "Orçamentos sem retorno", count: staleQuotes, prob: cfg.prob_quote_no_response, recoverable: true },
      { key: "abandoned", label: "Conversas abandonadas", count: abandoned, prob: cfg.prob_abandoned, recoverable: true },
      { key: "inactive", label: "Clientes inativos com histórico", count: inactive, prob: cfg.prob_inactive, recoverable: false },
    ].map(s => ({
      ...s,
      amount: money(s.count * s.prob * ticket),
    }));

    const totalLoss = money(items.reduce((sum, s) => sum + s.amount, 0));
    const recoverable = money(items.filter(s => s.recoverable).reduce((sum, s) => sum + s.amount, 0));

    return {
      total: totalLoss,         // perda estimada (potencial em risco)
      recoverable,              // IRR — parte com alta chance de recuperação
      sources: items,
      ticket: {
        value: ticket,
        source: tk.source,      // 'custom' | 'history' | 'fallback'
      },
      formula: "leads × probabilidade × ticket médio",
    };
  }

  /**
   * RRI — Receita Recuperada por fluxos do ZappFlow. Atribuição por janela: se
   * houve uma ação nossa (nudge de abandono, lembrete de PIX, cadência) e o
   * pedido foi PAGO no período de atribuição depois disso, conta como recuperado.
   */
  private static recoveredRevenue(orgId: string, period: Period, cfg: RicConfig) {
    const dateFilter = periodFilter(period, "o.created_at");
    const window = cfg.attribution_window_days;

    // 1) Carrinho abandonado: tickets que receberam o nudge e geraram pedido
    //    PAGO dentro da janela após o nudge.
    let abandonedAmt = 0, abandonedOrders = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT o.id) AS n, COALESCE(SUM(o.total_amount), 0) AS amt
        FROM orders o
        JOIN tickets t ON t.id = o.ticket_id
        WHERE o.organization_id = ?
          AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND t.abandoned_nudged_at IS NOT NULL
          AND o.created_at >= t.abandoned_nudged_at
          AND o.created_at <= datetime(t.abandoned_nudged_at, ?)
          ${dateFilter}
      `).get(orgId, `+${window} days`) as any;
      abandonedOrders = Number(r?.n || 0);
      abandonedAmt = money(Number(r?.amt || 0));
    } catch (e) { /* noop */ }

    // 2) Lembrete de PIX: pedidos que receberam reminder_count > 0 e foram pagos.
    //    Atribuído pelo pagamento APÓS o último lembrete.
    let pixAmt = 0, pixOrders = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(o.total_amount), 0) AS amt
        FROM orders o
        WHERE o.organization_id = ?
          AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND COALESCE(o.pix_reminder_count, 0) > 0
          AND o.paid_at IS NOT NULL
          AND (o.pix_last_reminder_at IS NULL OR o.paid_at >= o.pix_last_reminder_at)
          ${dateFilter}
      `).get(orgId) as any;
      pixOrders = Number(r?.n || 0);
      pixAmt = money(Number(r?.amt || 0));
    } catch (e) { /* noop */ }

    // 3) Cadências/Follow-up: pedidos PAGOS para contatos que tiveram cadência
    //    ativa dentro da janela antes da venda.
    let cadenceAmt = 0, cadenceOrders = 0;
    try {
      const r = db.prepare(`
        SELECT COUNT(DISTINCT o.id) AS n, COALESCE(SUM(o.total_amount), 0) AS amt
        FROM orders o
        JOIN contact_cadences cc ON cc.contact_id = o.contact_id
          AND cc.organization_id = o.organization_id
        WHERE o.organization_id = ?
          AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND o.created_at >= cc.started_at
          AND o.created_at <= datetime(cc.started_at, ?)
          ${dateFilter}
      `).get(orgId, `+${window} days`) as any;
      cadenceOrders = Number(r?.n || 0);
      cadenceAmt = money(Number(r?.amt || 0));
    } catch (e) { /* noop */ }

    const sources = [
      { key: "abandoned_cart", label: "Carrinho/conversa abandonada", orders: abandonedOrders, amount: abandonedAmt },
      { key: "pix_reminder", label: "Lembrete progressivo de PIX", orders: pixOrders, amount: pixAmt },
      { key: "cadence", label: "Cadência / follow-up", orders: cadenceOrders, amount: cadenceAmt },
    ];
    const total = money(sources.reduce((sum, s) => sum + s.amount, 0));

    return {
      total,
      sources,
      attributionWindowDays: window,
      note: "Atribuição por janela: pedido pago após uma ação do ZappFlow no período.",
    };
  }

  /**
   * Snapshot completo do RIC para o período. Esta é a fonte de verdade dos
   * números que o Diretor IA narra e que o relatório de auditoria consome.
   */
  static getSnapshot(orgId: string, period: Period = "month") {
    const cfg = this.getConfig(orgId);
    const metrics = AnalyticsService.getMetrics(orgId, { period });

    const atendimento = this.driverAtendimento(orgId, period, metrics, cfg);
    const comercial = this.driverComercial(orgId, period, metrics, cfg);
    const operacional = this.driverOperacional(orgId, period, metrics);

    // IQR = média ponderada dos 3 drivers (pesos somam 100; normalizamos).
    const totalWeight = cfg.weight_atendimento + cfg.weight_comercial + cfg.weight_operacional || 1;
    const iqr = round1((
      atendimento.score * cfg.weight_atendimento +
      comercial.score * cfg.weight_comercial +
      operacional.score * cfg.weight_operacional
    ) / totalWeight);

    const loss = this.estimatedLoss(orgId, period, metrics, cfg);
    const recovered = this.recoveredRevenue(orgId, period, cfg);

    // "Porquê" do IQR — pega o driver mais fraco como narrativa principal.
    const drivers = [
      { key: "atendimento", label: "Atendimento", score: atendimento.score, weight: cfg.weight_atendimento },
      { key: "comercial", label: "Comercial", score: comercial.score, weight: cfg.weight_comercial },
      { key: "operacional", label: "Operacional", score: operacional.score, weight: cfg.weight_operacional },
    ];
    const weakest = drivers.slice().sort((a, b) => a.score - b.score)[0];

    return {
      period,
      iqr: {
        score: iqr,
        weights: {
          atendimento: cfg.weight_atendimento,
          comercial: cfg.weight_comercial,
          operacional: cfg.weight_operacional,
        },
        weakestDriver: weakest.key,
        narrative: `IQR ${iqr} / 100. Driver mais fraco: ${weakest.label} (${weakest.score} pts).`,
      },
      drivers: {
        atendimento,
        comercial,
        operacional,
      },
      money: {
        estimatedLoss: loss.total,        // perda total (potencial em risco)
        recoverable: loss.recoverable,    // IRR — parte recuperável
        recovered: recovered.total,       // RRI — efetivamente recuperado
        ticket: loss.ticket,
        formula: loss.formula,
      },
      lossSources: loss.sources,
      recoveredSources: recovered.sources,
      attributionWindowDays: recovered.attributionWindowDays,
      config: cfg,
    };
  }
}
