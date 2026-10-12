import { CampaignStockGuardService } from "./CampaignStockGuardService.js";
import { randomUUID } from "crypto";
import db from "./db.js";
import { ChannelEconomicsService } from "./ChannelEconomicsService.js";
import { CampaignAiCostService } from "./CampaignAiCostService.js";

/**
 * PaidMediaService (ADR-207 F10) — mídia paga, ETAPA 1: inteligência e conta, SEM API de anúncios.
 *
 * O ZapFlow NÃO cria, NÃO altera e NÃO pausa anúncio. Faz duas coisas:
 *  1) `plan`  — "quanto posso pagar para conseguir uma venda sem destruir a margem?": CAC máximo, ROAS/POAS mínimos e ponto
 *     de equilíbrio, a partir da margem de CONTRIBUIÇÃO online do produto (ChannelEconomicsService — mesma conta da F6/F7) e do
 *     lucro mínimo que O DONO exige. Cenários só com CPC/conversão que o dono informar (nenhuma faixa inventada).
 *  2) `results` — o que a campanha REALMENTE deu: o dono lança o gasto (manual, a plataforma de anúncios é dele) e o sistema
 *     cruza com os pedidos pagos da campanha (F1), a contribuição de cada pedido (incl. desconto e frete subsidiado) e o custo
 *     de IA (F8): ROAS, lucro real e POAS.
 *
 * Regras: fato ≠ estimativa (plano e cenários são ESTIMATIVA; resultado vem de pedidos pagos reais) · sem dado ≠ zero (custo da
 * peça desconhecido → contribuição/lucro/POAS = null, nunca 0) · a IA não calcula: tudo aqui é aritmética determinística ·
 * "custo por pedido pago" NÃO é CAC de cliente novo (não sabemos quem já comprou antes; declarado) · dinheiro só dono/admin
 * (rota) · conversão/CPC do passado não é promessa.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_MONEY = 10_000_000;
const MAX_ENTRIES_PER_ORG = 5000;

export interface Scenario { label: string; cpc: number; conversionPct: number }

export class PaidMediaService {
  // ───────── 1. plano ─────────
  static plan(orgId: string, input: { productId: string; minProfitPerSale: number; budget?: number | null; fixedCampaignCost?: number | null; scenarios?: Scenario[] }) {
    const minProfit = Number(input.minProfitPerSale);
    if (!(minProfit > 0) || minProfit > MAX_MONEY) throw new Error("Informe o lucro mínimo que você exige por venda (maior que zero).");
    const budget = input.budget == null ? null : Number(input.budget);
    if (budget != null && (!(budget > 0) || budget > MAX_MONEY)) throw new Error("Orçamento de mídia inválido.");
    const fixed = input.fixedCampaignCost == null ? 0 : Number(input.fixedCampaignCost);
    if (!(fixed >= 0) || fixed > MAX_MONEY) throw new Error("Custo fixo da campanha inválido.");
    const e = ChannelEconomicsService.productEconomics(orgId, String(input.productId || ""), "online");
    if (!e) throw new Error("Produto não encontrado.");

    const base: any = {
      basis: "estimate" as const,
      note: "Estimativa com a margem de contribuição online do produto e os números que você informou. Não é garantia de resultado.",
      product: { id: e.productId, name: e.name, price: e.price },
      quality: e.quality, missing: e.missing, notModeled: e.notModeled,
      minProfitPerSale: round2(minProfit),
    };
    // ADR-207 F12: avisa se o produto tem pouco/nenhum saldo vendável — não impulsionar o que não dá para entregar. Não bloqueia a conta.
    const stock = CampaignStockGuardService.status(orgId, e.productId);
    if (stock) {
      base.stock = { state: stock.state, units: stock.units };
      if (stock.state === "out") base.warnings = ["Produto esgotado na vitrine: não impulsione antes de repor."];
      else if (stock.state === "low") base.warnings = [`Restam só ${stock.units} unidade(s) vendáveis: o anúncio pode esgotar o produto rápido.`];
    }
    const contribution = e.contribution.amount;
    if (contribution == null) return { ...base, viable: null, reason: "contribution_unknown", message: `Sem número: falta ${e.missing.join(", ") || "dado"}. Não dá para calcular o limite de mídia.`, contributionPerSale: null };
    base.contributionPerSale = round2(contribution);
    base.contributionIsUpperBound = !!e.contribution.upperBound;     // custo do canal incompleto → a margem real pode ser menor

    const maxCac = round2(contribution - minProfit);
    if (!(maxCac > 0)) {
      return { ...base, viable: false, reason: "margin_below_required_profit", maxCac: null, message: "A margem de contribuição deste produto não cobre o lucro mínimo que você exige — qualquer gasto de mídia por venda deixa o lucro abaixo do exigido." };
    }
    const out: any = {
      ...base, viable: true, maxCac,
      minRoasAtMaxCac: round2(e.price / maxCac),           // ROAS mínimo para ainda ganhar o lucro mínimo
      breakEvenRoas: round2(e.price / contribution),       // ROAS em que a mídia consome toda a contribuição (lucro zero)
      minPoas: round2(minProfit / maxCac),                 // lucro ÷ mídia quando o CAC está no teto
      breakEvenCostPerSale: round2(contribution),          // acima disso, cada venda dá prejuízo
    };
    if (budget != null) {
      const total = budget + fixed;
      out.budget = round2(budget); out.fixedCampaignCost = round2(fixed);
      out.salesToBreakEven = Math.ceil(total / contribution);
      out.revenueToBreakEven = round2(out.salesToBreakEven * e.price);
      out.salesAtMaxCac = Math.floor(budget / maxCac);     // quantas vendas o orçamento compra se o CAC ficar NO teto
    }
    const sc = (input.scenarios || []).slice(0, 3);
    if (sc.length) {
      if (budget == null) throw new Error("Para simular cenários, informe o orçamento de mídia.");
      out.scenarios = sc.map((s) => {
        const cpc = Number(s.cpc), conv = Number(s.conversionPct);
        if (!(cpc > 0) || !(conv > 0) || conv > 100) throw new Error("Cenário inválido: informe CPC e conversão (%) maiores que zero.");
        const orders = Math.floor((budget / cpc) * (conv / 100) + 1e-9);   // folga de ponto flutuante: 1000/1*4% não pode virar 39
        const cac = round2(cpc * 100 / conv);
        const revenue = round2(orders * e.price);
        const profit = round2(orders * contribution - budget - fixed);
        return {
          label: String(s.label || "cenário").slice(0, 30), cpc: round2(cpc), conversionPct: conv,
          visits: Math.floor(budget / cpc), orders, cac, withinMaxCac: cac <= maxCac,
          revenue, profit, roas: round2(revenue / budget), poas: round2(profit / (budget + fixed)),
        };
      });
    }
    return out;
  }

  // ───────── 2. gasto real (lançado pelo dono) ─────────
  static addSpend(orgId: string, input: { campaign: string; amount: number; spentOn?: string; note?: string }, actorId?: string | null) {
    const campaign = CampaignAiCostService.slug(input.campaign);
    if (!campaign) throw new Error("Informe a campanha (o mesmo nome do link).");
    const amount = Number(input.amount);
    if (!(amount > 0) || amount > MAX_MONEY) throw new Error("Informe o valor gasto (maior que zero).");
    const day = input.spentOn ? String(input.spentOn).slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Error("Data inválida (use AAAA-MM-DD).");
    if ((db.prepare("SELECT COUNT(*) n FROM campaign_ad_spend WHERE organization_id = ?").get(orgId) as any).n >= MAX_ENTRIES_PER_ORG) throw new Error("Limite de lançamentos atingido.");
    const id = randomUUID();
    db.prepare("INSERT INTO campaign_ad_spend (id, organization_id, campaign, amount, spent_on, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, campaign, round2(amount), day, String(input.note || "").replace(/[\u0000-\u001f\s]+/g, " ").trim().slice(0, 200) || null, actorId || null);
    return { id, campaign, amount: round2(amount), spentOn: day };
  }

  static removeSpend(orgId: string, id: string): boolean {
    return db.prepare("DELETE FROM campaign_ad_spend WHERE id = ? AND organization_id = ?").run(id, orgId).changes > 0;
  }

  static listSpend(orgId: string, opts: { campaign?: string; limit?: number } = {}) {
    const lim = Math.min(Math.max(Math.trunc(Number(opts.limit) || 50), 1), 200);
    const camp = opts.campaign ? CampaignAiCostService.slug(opts.campaign) : null;
    return db.prepare(`SELECT id, campaign, amount, spent_on AS spentOn, note FROM campaign_ad_spend WHERE organization_id = ? ${camp ? "AND campaign = ?" : ""} ORDER BY spent_on DESC, rowid DESC LIMIT ?`)
      .all(...(camp ? [orgId, camp, lim] : [orgId, lim])) as any[];
  }

  // ───────── 3. resultado real ─────────
  static results(orgId: string, opts: { days?: number } = {}) {
    const days = Math.min(Math.max(Math.trunc(Number(opts.days) || 30), 1), 365);
    const spend = db.prepare(
      `SELECT campaign, SUM(amount) AS spend, COUNT(*) AS entries FROM campaign_ad_spend
        WHERE organization_id = ? AND spent_on >= date('now', ?) GROUP BY campaign`
    ).all(orgId, `-${days} days`) as { campaign: string; spend: number; entries: number }[];

    type Agg = { paidOrders: number; revenuePaid: number; contribution: number; contributionKnown: boolean; partial: boolean };
    const byCamp = new Map<string, Agg>();
    const orders = db.prepare(
      `SELECT id, total_amount, discount_amount, shipping_absorbed, attr_campaign FROM orders
        WHERE organization_id = ? AND created_by = 'storefront' AND attr_campaign IS NOT NULL AND created_at >= datetime('now', ?)
          AND status NOT IN ('cancelado','reembolso','devolucao') AND (payment_status = 'paid' OR status IN ('pago','em_preparo','entregue','concluido'))`
    ).all(orgId, `-${days} days`) as any[];
    for (const o of orders) {
      const slug = CampaignAiCostService.slug(o.attr_campaign);
      if (!slug) continue;
      const a = byCamp.get(slug) || { paidOrders: 0, revenuePaid: 0, contribution: 0, contributionKnown: true, partial: false };
      a.paidOrders += 1; a.revenuePaid += Number(o.total_amount || 0);
      const items = (db.prepare("SELECT product_service_id AS productId, quantity AS qty, unit_price AS unitPrice FROM order_items WHERE order_id = ? AND organization_id = ?").all(o.id, orgId) as any[])
        .map((i) => ({ productId: i.productId || null, qty: Number(i.qty) || 1, unitPrice: Number(i.unitPrice) || 0 }));
      const c = ChannelEconomicsService.orderContribution(orgId, items, Number(o.discount_amount) || 0);
      if (c.contribution == null) a.contributionKnown = false;
      else { a.contribution += c.contribution - Math.max(0, Number(o.shipping_absorbed) || 0); if (c.quality === "partial") a.partial = true; }
      byCamp.set(slug, a);
    }

    const ai = new Map(CampaignAiCostService.report(orgId, { days }).campaigns.map((c) => [c.campaign, c.aiCostCents]));
    const slugs = new Set<string>([...spend.map((s) => s.campaign), ...byCamp.keys()]);
    const spendBy = new Map(spend.map((s) => [s.campaign, s]));
    const campaigns = [...slugs].map((campaign) => {
      const s = spendBy.get(campaign), a = byCamp.get(campaign);
      const spent = s ? round2(s.spend) : null;                                 // sem lançamento = não sabemos (null), não "R$ 0"
      const aiCents = ai.get(campaign) ?? null;
      const paidOrders = a ? a.paidOrders : 0;
      const revenuePaid = a ? round2(a.revenuePaid) : 0;
      const contribution = a && paidOrders > 0 && a.contributionKnown ? round2(a.contribution) : null;
      const profit = contribution != null && spent != null ? round2(contribution - spent - (aiCents ?? 0) / 100) : null;
      return {
        campaign, spend: spent, entries: s ? s.entries : 0, paidOrders, revenuePaid,
        roas: spent != null && spent > 0 && paidOrders > 0 ? round2(revenuePaid / spent) : null,
        contribution, contributionIsUpperBound: !!(a && a.partial),
        aiCost: aiCents != null ? round2(aiCents / 100) : null,
        profit, poas: profit != null && spent != null && spent > 0 ? round2(profit / spent) : null,
        costPerPaidOrder: spent != null && paidOrders > 0 ? round2(spent / paidOrders) : null,
      };
    }).sort((x, y) => (y.spend ?? -1) - (x.spend ?? -1) || y.revenuePaid - x.revenuePaid);

    return {
      days, basis: "paid_orders" as const,
      note: "Gasto lançado por você × pedidos PAGOS da campanha (link com o mesmo nome). \"Custo por pedido pago\" não é o custo de um cliente novo — não sabemos quem já comprou antes. Lucro = contribuição dos pedidos − mídia − IA; sem custo da peça, fica em branco.",
      campaigns,
    };
  }
}

export default PaidMediaService;
