/**
 * ConnectedFinancialsService — ADR-200 F3 (D3): a CONEXÃO dos três demonstrativos (o valor do CFO).
 *
 * Junta DRE (competência) + Balanço (o que está preso) + Fluxo de Caixa indireto (o que sobrou no
 * banco) e NARRA a diferença: "Você lucrou R$X (DRE), mas R$Z ficou preso em estoque/recebíveis
 * (Balanço), então o caixa só variou R$Y (Fluxo)". É o "ver o filme completo" — responde por que
 * lucrou e não tem dinheiro.
 *
 * A PONTE (RN-FIN-4): o gap `lucro − caixa gerado` é DECOMPOSTO nas variações de capital de giro que
 * a F2 já calcula (Δ a receber, Δ estoque, Δ a pagar) + financiamento + "a conciliar". Sem número
 * novo — só a leitura conectada (RN-FIN-2, derivado).
 *
 * Publica na espinha (`business_signals`, conv. nº 12) o sinal `financials/lucro_sem_caixa` quando é
 * MATERIAL (lucrou mas o dinheiro não veio) — cedo o bastante pro dono reagir. Advisory/hipótese
 * (impactAmount null, RN-FIN-5 — o número vai na evidência, não inventa dinheiro medido). Self-healing.
 *
 * Guardrails RN-FIN: 1 (gerencial≠contábil) · 2 (derivado, sem 2º motor — compõe DRE+Balanço+Fluxo) ·
 * 4 (a ponte é o método indireto) · 5 (não inventa) · 7 (isolado por org) · 8 (narrativa determinística;
 * a camada LLM opcional é F5).
 */
import db from "./db.js";
import { ManagerialDreService } from "./ManagerialDreService.js";
import { ManagerialBalanceSheetService } from "./ManagerialBalanceSheetService.js";
import { ManagerialCashFlowService } from "./ManagerialCashFlowService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const brl = (n: number) => `R$ ${Number(n || 0).toFixed(2).replace(".", ",")}`;

export interface ConnectedFinancials {
  period: string;
  dre: any;
  balance: any;
  cashflow: any;
  ponte: {
    lucro: number;              // resultado do DRE (competência)
    caixaGerado: number;        // variação REAL de caixa no período (Motor de Caixa)
    preso: number;              // capital de giro travado (a receber + estoque) — do Balanço
    gap: number;                // lucro − caixa gerado (o que NÃO virou dinheiro)
    decomposicao: {
      deltaReceber: number;
      deltaEstoque: number | null;
      deltaPagar: number;
      financiamento: number;
      aConciliar: number;
    };
    lucroSemCaixa: boolean;     // lucrou mas o dinheiro não veio (material)
  };
  narrativa: string;
  caveats: string[];
  disclaimer: string;
}

const DISCLAIMER = "Leitura financeira conectada (gerencial e educativa) — não substitui a contabilidade oficial.";

export class ConnectedFinancialsService {
  /** Regra do "lucro sem caixa": lucrou de verdade, mas o caixa não acompanhou (material). */
  private static isLucroSemCaixa(lucro: number, caixaGerado: number): boolean {
    if (!(lucro > 0)) return false;                 // sem lucro não é o caso do CFO
    const gap = lucro - caixaGerado;
    if (!(gap > 0)) return false;                   // caixa acompanhou ou superou → ok
    return caixaGerado <= 0 || gap >= lucro * 0.3;  // caixa negativo, ou ≥30% do lucro não virou dinheiro
  }

  static assemble(orgId: string, period = new Date().toISOString().slice(0, 7)): ConnectedFinancials {
    const dre = ManagerialDreService.monthly(orgId, period);
    const cashflow = ManagerialCashFlowService.indirect(orgId, period);
    const balance = ManagerialBalanceSheetService.snapshot(orgId, cashflow.to); // fim do período

    const lucro = round2(Number(dre.linhas?.resultadoOperacional) || 0);
    const caixaGerado = round2(cashflow.variacaoReal);
    const preso = round2(balance.preso);
    const gap = round2(lucro - caixaGerado);
    const lucroSemCaixa = this.isLucroSemCaixa(lucro, caixaGerado);

    const decomposicao = {
      deltaReceber: cashflow.capitalDeGiro.deltaReceber,
      deltaEstoque: cashflow.capitalDeGiro.deltaEstoque,
      deltaPagar: cashflow.capitalDeGiro.deltaPagar,
      financiamento: cashflow.financiamento.total,
      aConciliar: cashflow.aConciliar,
    };

    // Narrativa DETERMINÍSTICA (a camada LLM é a F5).
    let narrativa: string;
    if (lucro <= 0) {
      narrativa = `No período, o resultado gerencial foi ${brl(lucro)}. O caixa variou ${brl(caixaGerado)}. ${preso > 0 ? `Há ${brl(preso)} presos em estoque/recebíveis.` : ""}`.trim();
    } else if (lucroSemCaixa) {
      const partes: string[] = [];
      if (decomposicao.deltaReceber > 0) partes.push(`${brl(decomposicao.deltaReceber)} viraram contas a receber (vendas ainda não recebidas)`);
      if ((decomposicao.deltaEstoque || 0) > 0) partes.push(`${brl(decomposicao.deltaEstoque || 0)} foram pra estoque`);
      const porque = partes.length ? ` Boa parte disso ficou preso: ${partes.join(" e ")}.` : "";
      narrativa = `Você lucrou ${brl(lucro)} no período (competência), mas o caixa só variou ${brl(caixaGerado)} — uma diferença de ${brl(gap)}.${porque} Hoje há ${brl(preso)} presos em estoque e recebíveis. Lucro no papel não é dinheiro no banco.`;
    } else {
      narrativa = `Você lucrou ${brl(lucro)} e o caixa acompanhou (variação de ${brl(caixaGerado)} no período). ${preso > 0 ? `Ainda há ${brl(preso)} em capital de giro (estoque + recebíveis).` : ""}`.trim();
    }

    const caveats = Array.from(new Set([...(balance.caveats || []), ...(cashflow.caveats || [])]));

    return {
      period, dre, balance, cashflow,
      ponte: { lucro, caixaGerado, preso, gap, decomposicao, lucroSemCaixa },
      narrativa, caveats, disclaimer: DISCLAIMER,
    };
  }

  /**
   * Sinal PROATIVO `financials/lucro_sem_caixa` quando o mês lucrou mas o dinheiro não veio (material).
   * Hipótese, impactAmount null (RN-FIN-5). Self-healing por dedupe. Best-effort.
   */
  static publishConnectionSignal(orgId: string, opts: { period?: string } = {}): { published: boolean; resolved: boolean } {
    const dedupeKey = "connected_financials:lucro_sem_caixa";
    let published = false, resolved = false;
    try {
      const c = this.assemble(orgId, opts.period);
      if (c.ponte.lucroSemCaixa) {
        BusinessSignalService.publish(orgId, {
          domain: "connected_financials",
          signalType: "lucro_sem_caixa",
          severity: "attention",
          basis: "hypothesis",
          confidence: 0.5,
          impactAmount: null,             // RN-FIN-5
          sourceService: "ConnectedFinancialsService",
          evidence: {
            period: c.period, lucro: c.ponte.lucro, caixaGerado: c.ponte.caixaGerado,
            gap: c.ponte.gap, preso: c.ponte.preso, decomposicao: c.ponte.decomposicao,
            message: c.narrativa,
          },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /**
   * Passe do Scheduler: orgs com receita no mês corrente — os DOIS fluxos (online + loja física),
   * espelhando `ResultProjectionService.pass`. Cada fonte no seu try/catch.
   */
  static pass(): void {
    const period = new Date().toISOString().slice(0, 7);
    const orgs = new Set<string>();
    try {
      for (const o of db.prepare(`SELECT DISTINCT organization_id FROM orders WHERE strftime('%Y-%m', created_at) = ? AND status IN ('pago','em_preparo','entregue','concluido')`).all(period) as any[]) if (o?.organization_id) orgs.add(o.organization_id);
    } catch { /* noop */ }
    try {
      for (const o of db.prepare(`SELECT DISTINCT organization_id FROM retail_pdv_sales WHERE substr(sale_date,1,7) = ? AND (status IS NULL OR status = 'N')`).all(period) as any[]) if (o?.organization_id) orgs.add(o.organization_id);
    } catch { /* noop */ }
    try {
      for (const o of db.prepare(`SELECT DISTINCT organization_id FROM retail_daily_closings WHERE substr(closing_date,1,7) = ? AND COALESCE(informed_total,0) > 0 AND status != 'rejected'`).all(period) as any[]) if (o?.organization_id) orgs.add(o.organization_id);
    } catch { /* noop */ }
    for (const orgId of orgs) {
      try { this.publishConnectionSignal(orgId); }
      catch (e) { console.error("[ConnectedFinancials] pass falhou", orgId, e); }
    }
  }
}

export default ConnectedFinancialsService;
