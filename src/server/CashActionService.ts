import db from "./db.js";
import { randomUUID } from "crypto";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";

/**
 * Motor de Caixa — Alerta → Ação → Medição (ADR-125 Fatia 3).
 *
 * Fecha o ciclo "entender → decidir → EXECUTAR → MEDIR". Quando a projeção
 * aponta ruptura, o sistema SUGERE ações concretas para cobrir o rombo — cada
 * uma ancorada em dado real (recebível existe, conta a pagar existe), no máximo
 * 3, priorizadas por impacto. A IA sugere; o LOJISTA decide (ADR-091 §6): nada
 * executa sozinho. Ao concluir, registra o impacto MEDIDO — semente do Impact
 * Ledger (esperado × realizado). Determinístico (zero-token), isolado por org.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const KINDS = ["cobrar_receber", "postergar_pagar", "reduzir_compra", "campanha", "outro"] as const;
type Kind = (typeof KINDS)[number];

export class CashActionService {
  /**
   * Sugere ações para cobrir a primeira ruptura de caixa. Ephemeral (não
   * persiste): só vira registro quando o lojista aplica.
   */
  static suggest(orgId: string, minCash = 0) {
    const fc = CashForecastService.forecast(orgId, { minCash });
    if (!fc.firstRisk) return { firstRisk: null, shortfall: 0, actions: [] as any[] };
    const shortfall = round2(minCash - fc.firstRisk.ending); // quanto falta para não furar
    const actions: { kind: Kind; title: string; rationale: string; expectedImpact: number; grounded: boolean }[] = [];
    let remaining = shortfall;

    // 1) Cobrar o que já é seu (recebíveis + fiado) — dinheiro mais rápido.
    const aReceber = FinancialLedgerService.summary(orgId).aReceber;
    if (aReceber > 0 && remaining > 0) {
      const impact = round2(Math.min(remaining, aReceber));
      actions.push({ kind: "cobrar_receber", title: `Cobrar ${brl(impact)} a receber`, rationale: `Você tem ${brl(aReceber)} em aberto (fiado + contas a receber). Cobrar com cortesia acelera a entrada e reduz o rombo previsto.`, expectedImpact: impact, grounded: true });
      remaining = round2(remaining - impact);
    }

    // 2) Postergar/negociar contas que vencem ATÉ o fim da semana da ruptura
    // (a conta que causa o rombo vence dentro dessa semana, não antes dela).
    const riskWeekEnd = addDaysStr(fc.firstRisk.weekStart, 6);
    const payBefore = round2((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payables WHERE organization_id = ? AND status = 'open' AND due_date <= ?").get(orgId, riskWeekEnd) as any).s);
    if (payBefore > 0 && remaining > 0) {
      const impact = round2(Math.min(remaining, payBefore));
      actions.push({ kind: "postergar_pagar", title: `Negociar/postergar ${brl(impact)} em contas`, rationale: `Há ${brl(payBefore)} vencendo até a semana crítica (${fc.firstRisk.weekStart}). Renegociar prazo com fornecedores alivia o caixa.`, expectedImpact: impact, grounded: true });
      remaining = round2(remaining - impact);
    }

    // 3) Se ainda falta, acelerar vendas (meta, não número derivado de dado).
    if (remaining > 0) {
      actions.push({ kind: "campanha", title: `Gerar ${brl(remaining)} em vendas novas`, rationale: `Depois de cobrar e renegociar, ainda faltam ${brl(remaining)} para o caixa não furar. Uma campanha para clientes com maior propensão pode cobrir a diferença.`, expectedImpact: remaining, grounded: false });
    }

    return { firstRisk: fc.firstRisk, shortfall, actions: actions.slice(0, 3) };
  }

  /**
   * Persiste uma ação aceita pelo lojista (nunca executa nada por conta).
   * `decisionActionId` é uma ponte OPCIONAL (ADR-136 C2b) para o ledger
   * unificado; nulo por padrão — nada do fluxo atual muda.
   */
  static create(orgId: string, input: { kind: string; title: string; rationale?: string; expectedImpact?: number; baselineShortfall?: number; createdBy?: string; decisionActionId?: string }) {
    const kind = (KINDS as readonly string[]).includes(input.kind) ? input.kind : "outro";
    if (!input.title) return { ok: false as const, error: "title_required" };
    const id = randomUUID();
    db.prepare(`INSERT INTO cash_actions (id, organization_id, kind, title, rationale, expected_impact, baseline_shortfall, status, created_by, decision_action_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`)
      .run(id, orgId, kind, String(input.title).slice(0, 160), input.rationale || null, round2(input.expectedImpact || 0), round2(input.baselineShortfall || 0), input.createdBy || null, input.decisionActionId || null);
    return { ok: true as const, id };
  }

  /**
   * Conclui a ação registrando o impacto MEDIDO (esperado × realizado). Quando
   * a ação está vinculada a uma decisão unificada (`decision_action_id`),
   * espelha o outcome no ledger unificado (ADR-136 C2b) — sem alterar o
   * comportamento legado quando não há vínculo.
   */
  static complete(orgId: string, id: string, resultAmount: number) {
    const a = db.prepare("SELECT * FROM cash_actions WHERE organization_id = ? AND id = ? AND status = 'accepted'").get(orgId, id) as any;
    if (!a) return { ok: false as const, error: "not_found_or_resolved" };
    db.prepare("UPDATE cash_actions SET status = 'done', result_amount = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(round2(resultAmount), id);
    if (a.decision_action_id) {
      try {
        OutcomeMeasurementService.record(orgId, a.decision_action_id, {
          expectedValue: Number(a.expected_impact) || 0,
          realizedValue: round2(resultAmount),
          basis: "estimate",
          measurementMethod: "self_reported",
          evidence: { source: "cash_action.complete", cash_action_id: id, kind: a.kind },
        });
      } catch (e) { /* ponte aditiva — nunca bloqueia a conclusão do caixa */ }
    }
    return { ok: true as const };
  }

  static dismiss(orgId: string, id: string) {
    const info = db.prepare("UPDATE cash_actions SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ? AND status = 'accepted'").run(orgId, id);
    return { ok: info.changes > 0 };
  }

  /** Impact Ledger: ações registradas + totais esperado/realizado. */
  static ledger(orgId: string) {
    const items = db.prepare("SELECT id, kind, title, rationale, expected_impact, result_amount, status, created_at, resolved_at FROM cash_actions WHERE organization_id = ? AND status IN ('accepted','done') ORDER BY created_at DESC LIMIT 50").all(orgId) as any[];
    const expected = round2(items.reduce((s, a) => s + (a.status !== "dismissed" ? Number(a.expected_impact) || 0 : 0), 0));
    const realized = round2(items.filter((a) => a.status === "done").reduce((s, a) => s + (Number(a.result_amount) || 0), 0));
    const done = items.filter((a) => a.status === "done").length;
    return { items, expected, realized, done, open: items.length - done };
  }

  static overview(orgId: string, minCash = 0) {
    return { suggestions: this.suggest(orgId, minCash), ledger: this.ledger(orgId) };
  }
}

function brl(n: number) { return `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`; }
function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export default CashActionService;
