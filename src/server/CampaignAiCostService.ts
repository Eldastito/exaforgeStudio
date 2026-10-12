import db from "./db.js";
import { usageContext, currentUsageContext } from "./usageContext.js";
import { StorefrontAttributionService } from "./StorefrontAttributionService.js";

/**
 * CampaignAiCostService (ADR-207 F8) — quanto a IA custou POR CAMPANHA, e o que sobra da margem depois dela.
 *
 * NÃO cria medidor novo: o ledger `ai_usage_log` (ADR-154) já grava `cost_cents` e `request_id` (a correlação,
 * PRD 1). Aqui só (a) MARCAM-SE as chamadas de IA do Estúdio com `request_id = 'campaign:<slug>'` quando o dono
 * informa a campanha e (b) LÊ-SE o ledger, cruzando com o funil da F1 pelo mesmo slug de campanha.
 *
 * Regras:
 *  - Só conta o que foi MARCADO. Gasto de IA sem campanha (atendimento, Fala Tu, etc.) aparece à parte como
 *    "sem campanha" — nunca é rateado por palpite (sem dado ≠ zero; fato ≠ estimativa).
 *  - Margem depois da IA = margem paga (fato, F1) − custo de IA da campanha; se a margem é desconhecida, null.
 *  - Custo de IA vem do ledger, cuja tarifa é ESTIMADA por tabela de preço (não é fatura do provedor): o relatório
 *    declara isso. Vídeo (Veo) não grava custo no ledger hoje → não entra (declarado).
 *  - A IA não calcula nada aqui: só soma/subtração determinística. Dinheiro: a ROTA é do dono/administrador.
 *  - Marcar é best-effort e nunca quebra o fluxo: sem campanha válida, a chamada roda exatamente como antes.
 */
export class CampaignAiCostService {
  /** Slug canônico da campanha (mesmo formato dos links curtos da F5). null se vazio/inválido. */
  static slug(v: unknown): string | null {
    const s = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return s || null;
  }

  static tag(campaign: unknown): string | null {
    const s = this.slug(campaign);
    return s ? `campaign:${s}` : null;
  }

  /** Executa `fn` com as chamadas de IA marcadas na campanha. Sem campanha válida, roda `fn` sem alterar o contexto. */
  static async withCampaign<T>(campaign: unknown, fn: () => Promise<T>): Promise<T> {
    const tag = this.tag(campaign);
    if (!tag) return fn();
    const cur = currentUsageContext();
    if (!cur.orgId) return fn();                 // sem org no contexto o ledger nem grava: não finge marcar
    return usageContext.run({ ...cur, correlationId: tag }, fn);
  }

  static report(orgId: string, opts: { days?: number } = {}) {
    const days = Math.min(Math.max(Math.trunc(Number(opts.days) || 30), 1), 365);
    const since = `-${days} days`;

    const tagged = db.prepare(
      `SELECT request_id AS tag, COALESCE(SUM(cost_cents),0) AS cents, COUNT(*) AS calls
         FROM ai_usage_log
        WHERE organization_id = ? AND request_id LIKE 'campaign:%' AND created_at >= datetime('now', ?)
        GROUP BY request_id`
    ).all(orgId, since) as { tag: string; cents: number; calls: number }[];
    const total = db.prepare(
      `SELECT COALESCE(SUM(cost_cents),0) AS cents, COUNT(*) AS calls FROM ai_usage_log
        WHERE organization_id = ? AND created_at >= datetime('now', ?)`
    ).get(orgId, since) as { cents: number; calls: number };

    // Funil da F1 agregado por campanha (mesmo slug). Margem só é "fato" se TODAS as linhas da campanha a conhecem.
    const funnel = StorefrontAttributionService.funnel(orgId, { days });
    const byCamp = new Map<string, { paidOrders: number; revenuePaid: number; marginPaid: number | null; marginUnknown: boolean }>();
    for (const r of funnel.attributed) {
      const s = this.slug(r.campaign);
      if (!s) continue;
      const e = byCamp.get(s) || { paidOrders: 0, revenuePaid: 0, marginPaid: 0, marginUnknown: false };
      e.paidOrders += r.paidOrders; e.revenuePaid += r.revenuePaid;
      if (r.paidOrders > 0) {
        if (r.marginPaid == null) e.marginUnknown = true; else e.marginPaid = (e.marginPaid ?? 0) + r.marginPaid;
      }
      byCamp.set(s, e);
    }

    const slugs = new Set<string>([...tagged.map((t) => t.tag.slice("campaign:".length)), ...byCamp.keys()]);
    const aiBy = new Map(tagged.map((t) => [t.tag.slice("campaign:".length), t]));
    const campaigns = [...slugs].map((campaign) => {
      const ai = aiBy.get(campaign);
      const f = byCamp.get(campaign);
      const aiCostCents = ai ? ai.cents : null;                      // sem chamada marcada = sem dado (null), não "R$ 0"
      const marginPaid = f && f.paidOrders > 0 && !f.marginUnknown ? Math.round((f.marginPaid ?? 0) * 100) / 100 : null;
      const marginAfterAi = marginPaid != null && aiCostCents != null ? Math.round((marginPaid - aiCostCents / 100) * 100) / 100 : null;
      return {
        campaign, aiCostCents, aiCalls: ai ? ai.calls : null,
        paidOrders: f ? f.paidOrders : 0,
        revenuePaid: f ? Math.round(f.revenuePaid * 100) / 100 : 0,
        marginPaid, marginAfterAi,
      };
    }).sort((a, b) => (b.aiCostCents ?? -1) - (a.aiCostCents ?? -1) || b.revenuePaid - a.revenuePaid);

    const taggedCents = tagged.reduce((s, t) => s + t.cents, 0);
    return {
      days, basis: "ledger_estimate" as const,
      note: "Custo de IA estimado pela tabela de preços do ledger (não é a fatura do provedor). Só conta chamadas do Estúdio marcadas com a campanha; vídeo não entra.",
      campaigns,
      withoutCampaign: { aiCostCents: Math.max(0, total.cents - taggedCents), aiCalls: Math.max(0, total.calls - tagged.reduce((s, t) => s + t.calls, 0)) },
      totalAiCostCents: total.cents,
    };
  }
}

export default CampaignAiCostService;
