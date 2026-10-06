/**
 * SellerDiagnosisService — "Analisar desempenho" do vendedor (PRD Fase 1 §18, S5).
 *
 * Antes, o sinal `seller_goal_streak` prometia "cruza vendas, ticket e peças da pessoa" — e nada fazia isso. Este serviço cumpre a
 * promessa: compara a janela atual com a janela ANTERIOR de mesmo tamanho (vendas, nº de vendas, peças, ticket médio, P.A., dias
 * escalados, loja) e separa o que é FATO do que é HIPÓTESE.
 *
 * Regras:
 *  - read-only e determinístico (sem LLM, sem tabela nova, não cria ação nem alerta). Isola por organization_id.
 *  - FATO = número lido do sistema. HIPÓTESE = leitura possível desses números, rotulada `hypothesis`, NUNCA promovida a causa.
 *  - null ≠ zero: sem nº de vendas não há ticket/P.A. (null); sem escala cadastrada não se diz "trabalhou N dias".
 *  - dado insuficiente (sem vendas em NENHUMA janela) → `enough:false` e o motivo; não inventa diagnóstico.
 *  - nunca diz "culpa" da pessoa: hipóteses descrevem o número, não o motivo humano.
 */
import db from "./db.js";
import { RetailCommissionService } from "./RetailCommissionService.js";
import { RetailSellerIdentityService, normalizeAlias } from "./RetailSellerIdentityService.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (iso: string, d: number) => { const t = new Date(`${iso}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

export type WindowFacts = {
  start: string; end: string;
  sales: number | null; orders: number | null; pecas: number | null;
  ticket: number | null; pa: number | null;
  scheduledDays: number | null; salesPerDay: number | null;
};
export type DiagnosisFinding = { kind: "fact" | "hypothesis"; text: string };
export type SellerDiagnosis = {
  found: boolean; error?: string;
  seller?: { id: string; name: string; matricula: string };
  store?: string | null;
  enough: boolean; reason?: string;
  current?: WindowFacts; previous?: WindowFacts;
  findings: DiagnosisFinding[];
  // ADR-204 F3.5 — o FATOR que a leitura das hipóteses aponta, em forma legível por máquina (aditivo; o texto das findings não muda).
  // `days|orders|ticket|pa` = o número que acompanhou a queda; `unclear` = nenhum fator único; `none` = vendas não caíram;
  // `insufficient` = sem base para comparar. É HIPÓTESE (nunca causa comprovada) — quem usa continua rotulando assim.
  driver?: "days" | "orders" | "ticket" | "pa" | "unclear" | "none" | "insufficient";
  deltasPct?: { sales: number | null; orders: number | null; ticket: number | null; pa: number | null; days: number | null };
};

export class SellerDiagnosisService {
  private static facts(orgId: string, seller: any, start: string, end: string): WindowFacts {
    const norm = normalizeAlias(seller.name);
    const row = RetailCommissionService.combinedSalesBySeller(orgId, start, end).find((r) =>
      (r.matricula && String(r.matricula) === String(seller.matricula)) ||
      (seller.user_id && r.sellerUserId === seller.user_id) ||
      (norm && normalizeAlias(r.sellerName) === norm));
    const keys = [`mat:${seller.matricula}`, seller.user_id ? `user:${seller.user_id}` : null, norm ? `nom:${String(seller.name).trim().toLowerCase()}` : null].filter(Boolean) as string[];
    let scheduled: number | null = null;
    try {
      const ph = keys.map(() => "?").join(",");
      const r = db.prepare(`SELECT COUNT(DISTINCT work_date) AS c FROM retail_schedule_entries WHERE organization_id = ? AND status = 'work' AND work_date >= ? AND work_date <= ? AND seller_key IN (${ph})`).get(orgId, start, end, ...keys) as any;
      scheduled = Number(r?.c) > 0 ? Number(r.c) : null;           // sem escala cadastrada ≠ 0 dias
    } catch { scheduled = null; }
    const sales = row ? round2(row.sales) : null;
    const orders = row && row.orders > 0 ? row.orders : null;
    const pecas = row && row.pecas > 0 ? row.pecas : null;
    return {
      start, end, sales, orders, pecas,
      ticket: sales != null && orders ? round2(sales / orders) : null,
      pa: pecas != null && orders ? round2(pecas / orders) : null,
      scheduledDays: scheduled,
      salesPerDay: sales != null && scheduled ? round2(sales / scheduled) : null,
    };
  }

  static diagnose(orgId: string, sellerId: string, refDate: string, windowDays = 30): SellerDiagnosis {
    const base = RetailSellerIdentityService.canonicalSeller(orgId, sellerId);
    if (!base) return { found: false, error: "Vendedor não encontrado.", enough: false, findings: [] };
    const days = Math.max(7, Math.min(90, Math.floor(windowDays)));
    const cEnd = refDate, cStart = addDays(refDate, -(days - 1));
    const pEnd = addDays(cStart, -1), pStart = addDays(pEnd, -(days - 1));
    const current = this.facts(orgId, base, cStart, cEnd);
    const previous = this.facts(orgId, base, pStart, pEnd);
    const store = RetailSellerIdentityService.storeOn(orgId, base.id, refDate)?.storeName ?? null;
    const out: SellerDiagnosis = { found: true, seller: { id: base.id, name: base.name || `Matrícula ${base.matricula}`, matricula: String(base.matricula) }, store, enough: true, current, previous, findings: [] };

    if (current.sales == null && previous.sales == null) {
      return { ...out, driver: "insufficient", enough: false, reason: "Não há vendas registradas para esta pessoa nos últimos dois períodos — não dá para diagnosticar sem dados.", findings: [] };
    }
    const f = out.findings;
    const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);
    const fmt = (v: number, money = false) => v.toLocaleString("pt-BR", { minimumFractionDigits: money ? 2 : 0, maximumFractionDigits: 2 });
    const cmp = (label: string, c: number | null, p: number | null, money = false) => {
      if (c == null || p == null || p === 0) return null;
      const d = pct(c, p);
      f.push({ kind: "fact", text: `${label}: ${money ? "R$ " : ""}${fmt(c, money)} contra ${money ? "R$ " : ""}${fmt(p, money)} no período anterior (${d >= 0 ? "+" : ""}${d}%).` });
      return d;
    };
    const dSales = cmp("Vendas", current.sales, previous.sales, true);
    const dOrders = cmp("Nº de vendas", current.orders, previous.orders);
    const dTicket = cmp("Ticket médio", current.ticket, previous.ticket, true);
    const dPa = cmp("Peças por venda (P.A.)", current.pa, previous.pa);
    const dDays = cmp("Dias escalados", current.scheduledDays, previous.scheduledDays);
    if (current.sales != null && previous.sales == null) f.push({ kind: "fact", text: "Não há vendas no período anterior para comparar." });
    if (current.sales == null && previous.sales != null) f.push({ kind: "fact", text: "Sem vendas registradas no período atual (havia no anterior)." });
    if (current.scheduledDays == null) f.push({ kind: "fact", text: "Não há escala cadastrada: não sei quantos dias a pessoa trabalhou." });
    if (store) f.push({ kind: "fact", text: `Alocada hoje na loja ${store}.` });

    out.deltasPct = { sales: dSales, orders: dOrders, ticket: dTicket, pa: dPa, days: dDays };
    out.driver = dSales == null ? "insufficient" : dSales >= 0 ? "none" : "unclear";
    // hipóteses — só quando o número sustenta; sempre rotuladas, nunca causa comprovada
    if (dSales != null && dSales < 0) {
      if (dDays != null && dDays <= -15 && (dTicket == null || dTicket > -10)) { out.driver = "days"; f.push({ kind: "hypothesis", text: "A queda parece acompanhar menos dias escalados (ticket estável). Vale conferir escala/ausências." }); }
      else if (dOrders != null && dOrders <= -15 && (dTicket == null || dTicket > -10)) { out.driver = "orders"; f.push({ kind: "hypothesis", text: "A queda parece vir de menos vendas fechadas, não de vendas menores. Pode ser menos fluxo ou menos conversão." }); }
      else if (dTicket != null && dTicket <= -15 && (dOrders == null || dOrders > -10)) { out.driver = "ticket"; f.push({ kind: "hypothesis", text: "O número de vendas se manteve, mas o ticket caiu. Pode ser mix de produtos ou menos venda adicional." }); }
      else if (dPa != null && dPa <= -15) { out.driver = "pa"; f.push({ kind: "hypothesis", text: "As peças por venda caíram. Pode haver espaço para trabalhar venda adicional." }); }
      else { out.driver = "unclear"; f.push({ kind: "hypothesis", text: "Não há um fator único que explique a queda nos números disponíveis — não vou apontar causa." }); }
    }

    return out;
  }
}

export default SellerDiagnosisService;
