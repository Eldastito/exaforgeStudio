/**
 * ManagerialCashFlowService — ADR-200 F2 (D2): Fluxo de Caixa pelo MÉTODO INDIRETO.
 *
 * A PONTE que revela "lucro ≠ caixa" (RN-FIN-4): parte do RESULTADO do DRE (competência) e ajusta
 * pelas VARIAÇÕES DE CAPITAL DE GIRO no período pra chegar no caixa:
 *
 *   Fluxo operacional = Resultado (DRE) − Δ contas a receber − Δ estoque + Δ contas a pagar
 *   Fluxo financiamento = aportes − retiradas (sócios)
 *   Variação de caixa ESPERADA = operacional + financiamento
 *   Variação de caixa REAL      = eventos do Motor de Caixa no período
 *   A CONCILIAR                 = real − esperada   (o que o modelo não explica; RN-FIN-3, explícito)
 *
 * INTUIÇÃO: vendeu no fiado (↑ a receber) ou comprou mercadoria (↑ estoque) → lucrou mas o dinheiro
 * NÃO entrou; comprou fiado (↑ a pagar) → gastou mas o dinheiro ainda não saiu. É exatamente o gap
 * do CFO. Reusa o Motor de Caixa (NÃO o substitui — RN-FIN-2) e o Balanço (F1) pros Δ.
 *
 * HONESTIDADE (RN-FIN-5): Δ a receber / Δ a pagar são RECONSTRUÍDOS por data (precisos). Δ estoque vem
 * dos `stock_movements` valorados a custo (entrada − saída); orgs sem movimento registrado (ex.:
 * estoque alimentado direto pela Alterdata) → Δ estoque `não medido`, que cai no "a conciliar" com
 * caveat — nunca inventa. Determinístico, isolado por org.
 */
import db from "./db.js";
import { ManagerialDreService } from "./ManagerialDreService.js";
import { ManagerialBalanceSheetService } from "./ManagerialBalanceSheetService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}
/** Último dia do mês anterior (= saldo de ABERTURA do período). */
function prevMonthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 0)); // dia 0 do mês = último dia do anterior
  return d.toISOString().slice(0, 10);
}

export interface ManagerialCashFlow {
  period: string;
  from: string;
  to: string;                        // fim efetivo (hoje, se mês corrente)
  resultado: number;                 // resultado operacional do DRE (competência)
  capitalDeGiro: {
    deltaReceber: number;            // ↑ reduz caixa
    deltaEstoque: number | null;     // ↑ reduz caixa (null = não medido)
    deltaPagar: number;              // ↑ aumenta caixa
    estoqueMeasured: boolean;
  };
  fluxoOperacional: number | null;   // null se o Δ estoque não medido impede a conta cheia? não — ver nota
  financiamento: { aportes: number; retiradas: number; total: number };
  variacaoEsperada: number;
  variacaoReal: number;              // Motor de Caixa (cash_events no período)
  aConciliar: number;                // real − esperada
  caveats: string[];
  disclaimer: string;
}

const DISCLAIMER = "Fluxo de caixa gerencial (método indireto) — derivado dos seus registros, não substitui a contabilidade oficial.";

export class ManagerialCashFlowService {
  /** Δ estoque a custo no período pelos movimentos (entrada − saída); null se não há movimento. */
  private static deltaEstoque(orgId: string, from: string, to: string): { value: number | null; measured: boolean } {
    try {
      const r = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'entrada' THEN quantity * COALESCE(unit_cost,0) ELSE 0 END),0) AS entrada,
          COALESCE(SUM(CASE WHEN type = 'saida'   THEN quantity * COALESCE(unit_cost,0) ELSE 0 END),0) AS saida,
          COUNT(*) AS n
        FROM stock_movements
        WHERE organization_id = ? AND type IN ('entrada','saida')
          AND date(created_at) >= date(?) AND date(created_at) <= date(?)
      `).get(orgId, from, to) as any;
      if (!(Number(r?.n) > 0)) return { value: null, measured: false };
      return { value: round2((Number(r.entrada) || 0) - (Number(r.saida) || 0)), measured: true };
    } catch { return { value: null, measured: false }; }
  }

  /** Variação REAL de caixa no período (eventos do Motor de Caixa). */
  private static variacaoRealCaixa(orgId: string, from: string, to: string): number {
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END),0) AS net
          FROM cash_events WHERE organization_id = ? AND date(event_date) >= date(?) AND date(event_date) <= date(?)
      `).get(orgId, from, to) as any;
      return round2(r?.net);
    } catch { return 0; }
  }

  /** Aportes − retiradas (financiamento dos sócios) no período. */
  private static financiamento(orgId: string, from: string, to: string): { aportes: number; retiradas: number; total: number } {
    const outflow = ["pro_labore", "distribuicao", "despesa_pessoal", "emprestimo_socio"];
    try {
      const marks = outflow.map(() => "?").join(",");
      const ret = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND kind IN (${marks}) AND date(draw_date) >= date(?) AND date(draw_date) <= date(?)`).get(orgId, ...outflow, from, to) as any;
      const ap = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND kind = 'despesa_empresarial' AND date(draw_date) >= date(?) AND date(draw_date) <= date(?)`).get(orgId, from, to) as any;
      const aportes = round2(ap?.s), retiradas = round2(ret?.s);
      return { aportes, retiradas, total: round2(aportes - retiradas) };
    } catch { return { aportes: 0, retiradas: 0, total: 0 }; }
  }

  /** Fluxo de caixa gerencial pelo método indireto (period = YYYY-MM; padrão = mês corrente). */
  static indirect(orgId: string, period = new Date().toISOString().slice(0, 7)): ManagerialCashFlow {
    const { from, to } = monthBounds(period);
    const today = new Date().toISOString().slice(0, 10);
    const isCurrent = period === today.slice(0, 7);
    const fim = isCurrent && today < to ? today : to;             // mês corrente: até hoje
    const inicio = prevMonthEnd(period);

    const resultado = round2(Number((ManagerialDreService.monthly(orgId, period).linhas as any).resultadoOperacional) || 0);

    // Δ capital de giro — a receber / a pagar RECONSTRUÍDOS por data (reusa o Balanço F1).
    const bIni = ManagerialBalanceSheetService.snapshot(orgId, inicio);
    const bFim = ManagerialBalanceSheetService.snapshot(orgId, fim);
    const deltaReceber = round2(bFim.ativo.contasReceber - bIni.ativo.contasReceber);
    const deltaPagar = round2(bFim.passivo.contasPagar - bIni.passivo.contasPagar);
    const est = this.deltaEstoque(orgId, from, fim);

    // Fluxo operacional: resultado − Δreceber − Δestoque + Δpagar (Δestoque=0 quando não medido — o
    // efeito real dele fica no "a conciliar", com caveat; nunca inventa o número).
    const fluxoOperacional = round2(resultado - deltaReceber - (est.value || 0) + deltaPagar);
    const fin = this.financiamento(orgId, from, fim);
    const variacaoEsperada = round2(fluxoOperacional + fin.total);
    const variacaoReal = this.variacaoRealCaixa(orgId, from, fim);
    const aConciliar = round2(variacaoReal - variacaoEsperada);

    const caveats: string[] = [];
    if (!est.measured) caveats.push("Δ estoque NÃO medido (sem movimentos de estoque no período — ex.: estoque alimentado direto pela Alterdata). O efeito do estoque no caixa cai em 'a conciliar'.");
    if (isCurrent) caveats.push("Mês corrente — o período vai só até hoje; as variações ainda estão se formando.");
    if (Math.abs(aConciliar) > 0) caveats.push("A linha 'a conciliar' é a diferença entre o caixa esperado (método indireto) e o real (Motor de Caixa) — inclui investimentos, timing e o que os registros não explicam. É gerencial, não um Razão contábil.");

    return {
      period, from, to: fim,
      resultado,
      capitalDeGiro: { deltaReceber, deltaEstoque: est.value, deltaPagar, estoqueMeasured: est.measured },
      fluxoOperacional,
      financiamento: fin,
      variacaoEsperada,
      variacaoReal,
      aConciliar,
      caveats,
      disclaimer: DISCLAIMER,
    };
  }
}

export default ManagerialCashFlowService;
