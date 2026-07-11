import db from "./db.js";
import { randomUUID } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { AnalyticsService } from "./AnalyticsService.js";
import { CampaignService } from "./CampaignService.js";
import { ProspectResearchService } from "./ProspectResearchService.js";

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
  /** SLA por canal (ADR-026): { channel_id: segundos }. Canal ausente herda slow_response_seconds. */
  sla_by_channel: Record<string, number>;
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
  sla_by_channel: {},
};

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

// SLA por canal (ADR-026): só entradas com segundos válidos (10s a 24h) são
// gravadas — um valor torto nunca vira um limiar absurdo no cálculo do IVC.
function sanitizeSlaByChannel(raw: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [channelId, v] of Object.entries(raw)) {
      const n = Number(v);
      if (channelId && Number.isFinite(n) && n >= 10 && n <= 86400) out[channelId] = Math.round(n);
    }
  }
  return out;
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
  /**
   * Status da auditoria-trial de 14 dias (GTM). O relógio começa quando a empresa
   * conecta o 1º canal — alinhado com "conecta → mede ao vivo". Calculado a partir
   * do canal conectado mais antigo (sem coluna extra, sem hooks de escrita —
   * idempotente). Antes de qualquer canal, o trial é "not_started".
   */
  static getTrialStatus(orgId: string) {
    const TOTAL = 14;
    let startedAt: string | null = null;
    try {
      const row = db.prepare(
        `SELECT MIN(created_at) AS started FROM channels
         WHERE organization_id = ? AND status NOT IN ('disabled','disconnected')`
      ).get(orgId) as any;
      startedAt = row?.started || null;
    } catch (e) { /* noop */ }

    if (!startedAt) {
      return { status: 'not_started' as const, totalDays: TOTAL, day: 0, elapsed: 0, daysRemaining: TOTAL, pct: 0, startedAt: null };
    }

    let elapsed = 0;
    try {
      const r = db.prepare(`SELECT (julianday('now') - julianday(?)) AS d`).get(startedAt) as any;
      elapsed = Math.max(0, Math.floor(Number(r?.d ?? 0)));
    } catch (e) { /* noop */ }

    const completed = elapsed >= TOTAL;
    const day = Math.min(TOTAL, elapsed + 1);           // dia 1 já no primeiro dia
    const daysRemaining = Math.max(0, TOTAL - elapsed);
    const pct = Math.min(100, Math.round((Math.min(elapsed, TOTAL) / TOTAL) * 100));

    return {
      status: (completed ? 'completed' : 'active') as 'completed' | 'active',
      totalDays: TOTAL,
      day,
      elapsed,
      daysRemaining,
      pct,
      startedAt,
    };
  }

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
      sla_by_channel: (() => { try { return JSON.parse(row.sla_by_channel_json || "{}") || {}; } catch { return {}; } })(),
    };
  }

  static saveConfig(orgId: string, patch: Partial<RicConfig>): RicConfig {
    const cur = this.getConfig(orgId);
    const next = { ...cur, ...patch };
    db.prepare(`
      INSERT INTO revenue_intelligence_config (
        organization_id, prob_lead_slow_response, prob_quote_no_response, prob_abandoned, prob_inactive,
        slow_response_seconds, quote_stale_hours, inactive_days, attribution_window_days,
        custom_ticket_amount, weight_atendimento, weight_comercial, weight_operacional, sla_by_channel_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
        sla_by_channel_json = excluded.sla_by_channel_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      orgId,
      next.prob_lead_slow_response, next.prob_quote_no_response, next.prob_abandoned, next.prob_inactive,
      next.slow_response_seconds, next.quote_stale_hours, next.inactive_days, next.attribution_window_days,
      next.custom_ticket_amount, next.weight_atendimento, next.weight_comercial, next.weight_operacional,
      JSON.stringify(sanitizeSlaByChannel(next.sla_by_channel)),
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

  /** ROI = receita recuperada ÷ custo mensal do plano. Null se sem plano. */
  private static calculateRoi(orgId: string, recovered: number): { value: number; planCost: number } | null {
    try {
      const o = db.prepare(
        `SELECT os.plan_id, p.price FROM organization_settings os LEFT JOIN plans p ON p.id = os.plan_id WHERE os.organization_id = ?`
      ).get(orgId) as any;
      const cost = Number(o?.price || 0);
      if (!cost || cost <= 0) return null;
      return { value: Math.round((recovered / cost) * 100) / 100, planCost: cost };
    } catch { return null; }
  }

  /**
   * RRI — Receita Recuperada por fluxos do ZappFlow. Atribuição por janela: se
   * houve uma ação nossa (nudge de abandono, lembrete de PIX, cadência) e o
   * pedido foi PAGO no período de atribuição depois disso, conta como recuperado.
   */
  private static recoveredRevenue(orgId: string, period: Period, cfg: RicConfig) {
    const dateFilter = periodFilter(period, "o.created_at");
    const window = cfg.attribution_window_days;

    // Coleta (pedido, valor) por fonte e DEPOIS atribui cada pedido a UMA única
    // fonte (por prioridade) — evita contar o mesmo pedido em mais de um fluxo
    // (abandono + PIX + cadência), que inflava a Receita Recuperada.
    const rows: { key: string; orderId: string; amount: number }[] = [];

    // 1) Carrinho/conversa abandonada: nudge → pedido pago na janela.
    try {
      const r = db.prepare(`
        SELECT DISTINCT o.id AS id, o.total_amount AS amt
        FROM orders o JOIN tickets t ON t.id = o.ticket_id
        WHERE o.organization_id = ?
          AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND t.abandoned_nudged_at IS NOT NULL
          AND o.created_at >= t.abandoned_nudged_at
          AND o.created_at <= datetime(t.abandoned_nudged_at, ?)
          ${dateFilter}
      `).all(orgId, `+${window} days`) as any[];
      for (const x of r) rows.push({ key: "abandoned_cart", orderId: String(x.id), amount: Number(x.amt || 0) });
    } catch (e) { /* noop */ }

    // 2) Lembrete de PIX: pedidos com reminder_count > 0 pagos após o lembrete.
    try {
      const r = db.prepare(`
        SELECT o.id AS id, o.total_amount AS amt
        FROM orders o
        WHERE o.organization_id = ?
          AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND COALESCE(o.pix_reminder_count, 0) > 0
          AND o.paid_at IS NOT NULL
          AND (o.pix_last_reminder_at IS NULL OR o.paid_at >= o.pix_last_reminder_at)
          ${dateFilter}
      `).all(orgId) as any[];
      for (const x of r) rows.push({ key: "pix_reminder", orderId: String(x.id), amount: Number(x.amt || 0) });
    } catch (e) { /* noop */ }

    // 3) Cadências/Follow-up: pedido pago de contato com cadência na janela.
    try {
      const r = db.prepare(`
        SELECT DISTINCT o.id AS id, o.total_amount AS amt
        FROM orders o JOIN contact_cadences cc ON cc.contact_id = o.contact_id AND cc.organization_id = o.organization_id
        WHERE o.organization_id = ?
          AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND o.created_at >= cc.started_at
          AND o.created_at <= datetime(cc.started_at, ?)
          ${dateFilter}
      `).all(orgId, `+${window} days`) as any[];
      for (const x of r) rows.push({ key: "cadence", orderId: String(x.id), amount: Number(x.amt || 0) });
    } catch (e) { /* noop */ }

    // Atribuição única por pedido (prioridade: abandono > PIX > cadência).
    const PRIORITY = ["abandoned_cart", "pix_reminder", "cadence"];
    const byOrder = new Map<string, { key: string; amount: number }>();
    for (const key of PRIORITY) {
      for (const row of rows) {
        if (row.key === key && !byOrder.has(row.orderId)) byOrder.set(row.orderId, { key, amount: row.amount });
      }
    }
    const agg: Record<string, { orders: number; amount: number }> = {
      abandoned_cart: { orders: 0, amount: 0 }, pix_reminder: { orders: 0, amount: 0 }, cadence: { orders: 0, amount: 0 },
    };
    for (const v of byOrder.values()) { agg[v.key].orders++; agg[v.key].amount += v.amount; }

    const sources = [
      { key: "abandoned_cart", label: "Carrinho/conversa abandonada", orders: agg.abandoned_cart.orders, amount: money(agg.abandoned_cart.amount) },
      { key: "pix_reminder", label: "Lembrete progressivo de PIX", orders: agg.pix_reminder.orders, amount: money(agg.pix_reminder.amount) },
      { key: "cadence", label: "Cadência / follow-up", orders: agg.cadence.orders, amount: money(agg.cadence.amount) },
    ];
    const total = money(sources.reduce((sum, s) => sum + s.amount, 0));

    return {
      total,
      sources,
      attributionWindowDays: window,
      note: "Atribuição por janela: pedido pago após uma ação do ZappFlow no período (cada pedido conta uma vez).",
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
    // RRI (Revenue Recovery Index) = recuperada ÷ recuperável × 100. Mede a
    // EFICÁCIA da recuperação. null quando não há base recuperável (evita /0).
    const rri = loss.recoverable > 0 ? round1((recovered.total / loss.recoverable) * 100) : null;

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
        recovered: recovered.total,       // receita efetivamente recuperada
        rri,                              // índice de recuperação (% recuperada/recuperável)
        roi: this.calculateRoi(orgId, recovered.total),
        ticket: loss.ticket,
        formula: loss.formula,
      },
      lossSources: loss.sources,
      recoveredSources: recovered.sources,
      attributionWindowDays: recovered.attributionWindowDays,
      config: cfg,
      // Prospect AI (ADR-079, Fase E): inteligência de prospecção no RIC —
      // nichos com maior resposta, mensagem champion, aprendizados e receita
      // potencial/ganha originada pela prospecção. Best-effort: sem dados ou
      // módulo desativado → null, sem derrubar o snapshot.
      prospect: (() => {
        try { return ProspectResearchService.ricSummary(orgId); } catch { return null; }
      })(),
    };
  }

  /**
   * Resolve os CONTATOS por trás de uma fonte de perda (para a ação de
   * recuperação) + uma mensagem padrão adequada à fonte. Mesma lógica das
   * queries da Perda Estimada, agora retornando ids em vez de contagem.
   */
  static lossContacts(orgId: string, sourceKey: string, cfg?: RicConfig): { contactIds: string[]; label: string; defaultMessage: string } {
    const c = cfg || this.getConfig(orgId);
    let ids: string[] = [], label = "", defaultMessage = "";
    if (sourceKey === "slow_response") {
      label = "Leads com 1ª resposta lenta";
      defaultMessage = "Oi {nome}! Vi que você falou com a gente e talvez não tenha tido o retorno tão rápido quanto merece 😊 Posso te ajudar agora?";
      try {
        const r = db.prepare(`
          SELECT DISTINCT tk.contact_id AS cid FROM tickets tk
          JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type='contact' GROUP BY ticket_id) fc ON fc.ticket_id=tk.id
          JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE sender_type IN ('bot','agent') GROUP BY ticket_id) fb ON fb.ticket_id=tk.id
          WHERE tk.organization_id=? AND (julianday(fb.t)-julianday(fc.t))*86400.0 >= ?
        `).all(orgId, c.slow_response_seconds) as any[];
        ids = r.map(x => String(x.cid)).filter(Boolean);
      } catch (e) { /* noop */ }
    } else if (sourceKey === "stale_quotes") {
      label = "Orçamentos sem retorno";
      defaultMessage = "Olá {nome}! Passando para saber se ficou alguma dúvida sobre o orçamento que enviamos. Posso ajudar a fechar? 🙂";
      try {
        const r = db.prepare(`SELECT DISTINCT contact_id AS cid FROM quotes WHERE organization_id=? AND status='sent' AND sent_at <= datetime('now', ?) AND contact_id IS NOT NULL`).all(orgId, `-${c.quote_stale_hours} hours`) as any[];
        ids = r.map(x => String(x.cid)).filter(Boolean);
      } catch (e) { /* noop */ }
    } else if (sourceKey === "abandoned") {
      label = "Conversas abandonadas";
      defaultMessage = "Oi {nome}! Ficamos no meio de uma conversa por aqui 😊 Ainda quer seguir? Posso te ajudar a finalizar agora.";
      try {
        const r = db.prepare(`SELECT DISTINCT contact_id AS cid FROM tickets WHERE organization_id=? AND abandoned_nudged_at IS NOT NULL AND contact_id IS NOT NULL`).all(orgId) as any[];
        ids = r.map(x => String(x.cid)).filter(Boolean);
      } catch (e) { /* noop */ }
    } else if (sourceKey === "inactive") {
      label = "Clientes inativos com histórico";
      defaultMessage = "Olá {nome}! Sentimos sua falta por aqui 😊 Preparamos novidades que podem te interessar. Posso te mostrar?";
      try {
        const r = db.prepare(`SELECT id AS cid FROM contacts WHERE organization_id=? AND purchase_count > 0 AND (last_purchase_at IS NULL OR last_purchase_at < datetime('now', ?)) AND COALESCE(marketing_opt_out,0)=0`).all(orgId, `-${c.inactive_days} days`) as any[];
        ids = r.map(x => String(x.cid)).filter(Boolean);
      } catch (e) { /* noop */ }
    } else {
      throw new Error("Fonte de recuperação inválida.");
    }
    return { contactIds: ids, label, defaultMessage };
  }

  /**
   * Cria a AÇÃO DE RECUPERAÇÃO de uma fonte de perda: monta uma campanha de
   * recuperação (rascunho) para aqueles contatos e registra a ação. Não envia
   * nada — fica em rascunho para o usuário revisar e disparar (guardrail).
   */
  static createRecoveryAction(orgId: string, sourceKey: string, userId?: string): { id: string; campaignId: string; contacts: number; label: string } {
    const cfg = this.getConfig(orgId);
    const { contactIds, label, defaultMessage } = this.lossContacts(orgId, sourceKey, cfg);
    if (!contactIds.length) throw new Error("Não há contatos elegíveis para esta ação no momento.");
    const camp = CampaignService.createCampaignForContacts(orgId, {
      name: `Recuperação · ${label}`, message: defaultMessage, contactIds, createdBy: userId || "ric",
    });
    if (!camp.id || !camp.total) throw new Error("Nenhum contato com WhatsApp válido (ou todos em opt-out).");
    const id = randomUUID();
    db.prepare(`INSERT INTO ric_recovery_actions (id, organization_id, source_key, label, contacts_count, campaign_id, action_type, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'campaign', 'created', ?)`)
      .run(id, orgId, sourceKey, label, camp.total, camp.id, userId || null);
    return { id, campaignId: camp.id, contacts: camp.total, label };
  }

  /**
   * Persiste o snapshot diário de hoje para uso em séries históricas (chamado
   * pelo Scheduler). Idempotente: não sobrescreve se já existir.
   */
  static snapshotDaily(orgId: string): void {
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.prepare(
      `SELECT id FROM ric_daily_snapshots WHERE organization_id = ? AND snapshot_date = ?`
    ).get(orgId, today);
    if (existing) return; // already snapped today
    const snap = this.getSnapshot(orgId, 'month');
    if (!snap) return;
    db.prepare(
      `INSERT INTO ric_daily_snapshots (id, organization_id, snapshot_date, iqr_score, estimated_loss, recoverable, recovered, atendimento_score, comercial_score, operacional_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(), orgId, today,
      snap.iqr?.score || 0,
      snap.money?.estimatedLoss || 0,
      snap.money?.recoverable || 0,
      snap.money?.recovered || 0,
      snap.drivers?.atendimento?.score || 0,
      snap.drivers?.comercial?.score || 0,
      snap.drivers?.operacional?.score || 0,
    );
  }

  /**
   * Retorna a série histórica de snapshots diários dos últimos N dias.
   */
  static getTrendSeries(orgId: string, days: number = 30): any[] {
    return db.prepare(
      `SELECT snapshot_date, iqr_score, estimated_loss, recoverable, recovered, atendimento_score, comercial_score, operacional_score FROM ric_daily_snapshots WHERE organization_id = ? AND snapshot_date >= date('now', ?) ORDER BY snapshot_date ASC`
    ).all(orgId, `-${days} days`);
  }

  /**
   * Top 5 ações prioritárias — derivadas server-side das fontes de perda,
   * ordenadas por R$ em jogo. Responde "o que priorizar hoje?".
   */
  static getTopActions(orgId: string, period: string = 'month'): any[] {
    const snap = this.getSnapshot(orgId, period as Period);
    if (!snap) return [];
    const sources = (snap.lossSources || [])
      .filter((s: any) => s.amount > 0)
      .sort((a: any, b: any) => b.amount - a.amount);
    const verbs: Record<string, string> = {
      slow_response: 'Acelerar resposta inicial',
      stale_quotes: 'Retomar orçamentos pendentes',
      abandoned: 'Recuperar conversas abandonadas',
      inactive: 'Reativar clientes inativos',
    };
    return sources.slice(0, 5).map((s: any, i: number) => ({
      rank: i + 1,
      sourceKey: s.key,
      action: verbs[s.key] || s.label,
      label: s.label,
      amount: s.amount,
      contactsCount: s.count || 0,
      impactPercent: snap.money?.estimatedLoss > 0
        ? Math.round(s.amount / snap.money.estimatedLoss * 100)
        : 0,
    }));
  }

  /**
   * Lista as ações de recuperação e ATUALIZA o desfecho de cada uma de forma
   * idempotente: receita recuperada = pedidos pagos dos contatos da campanha,
   * após o disparo, dentro da janela de atribuição.
   */
  static listRecoveryActions(orgId: string, limit = 30): any[] {
    const actions = db.prepare(`SELECT * FROM ric_recovery_actions WHERE organization_id=? ORDER BY created_at DESC LIMIT ?`).all(orgId, limit) as any[];
    const cfg = this.getConfig(orgId);
    for (const a of actions) {
      if (a.status === "dismissed") continue;
      try {
        const camp = db.prepare(`SELECT status, started_at FROM campaigns WHERE id=? AND organization_id=?`).get(a.campaign_id, orgId) as any;
        if (!camp || !camp.started_at) continue; // ainda em rascunho (não disparada)
        const r = db.prepare(`
          SELECT COUNT(DISTINCT o.id) AS n, COALESCE(SUM(o.total_amount),0) AS amt
          FROM orders o
          JOIN campaign_recipients cr ON cr.contact_id = o.contact_id AND cr.campaign_id = ?
          WHERE o.organization_id = ?
            AND o.status IN ('pago','em_preparo','entregue','concluido')
            AND o.created_at >= ?
            AND o.created_at <= datetime(?, ?)
        `).get(a.campaign_id, orgId, camp.started_at, camp.started_at, `+${cfg.attribution_window_days} days`) as any;
        const orders = Number(r?.n || 0), amount = money(Number(r?.amt || 0));
        const status = orders > 0 ? "converted" : "sent";
        if (orders !== a.recovered_orders || amount !== a.recovered_amount || status !== a.status) {
          db.prepare(`UPDATE ric_recovery_actions SET recovered_orders=?, recovered_amount=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(orders, amount, status, a.id);
          a.recovered_orders = orders; a.recovered_amount = amount; a.status = status;
        }
      } catch (e) { /* noop */ }
    }
    return actions;
  }
}
