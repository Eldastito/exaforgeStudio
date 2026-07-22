import db from "./db.js";
import { randomUUID } from "crypto";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { ManagerialDreService } from "./ManagerialDreService.js";

/**
 * Empresa × Proprietário (ADR-129) — separa o dinheiro do dono do da empresa.
 *
 * A retirada é TIPADA. Os tipos que SAEM do caixa da empresa (pró-labore,
 * distribuição, despesa pessoal, empréstimo ao sócio) geram uma saída de caixa
 * (ADR-125, idempotente) e alimentam a linha de Retiradas da DRE (ADR-128).
 * `despesa_empresarial` paga pelo dono é APORTE (não tira do caixa). Sugere um
 * pró-labore sustentável e alerta excesso — orientativos. Zero-token, isolado.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const today = () => new Date().toISOString().slice(0, 10);

export const DRAW_KINDS = ["pro_labore", "distribuicao", "despesa_pessoal", "emprestimo_socio", "despesa_empresarial"] as const;
// Tipos que retiram dinheiro do caixa da empresa (contam como Retiradas na DRE).
export const OUTFLOW_KINDS = ["pro_labore", "distribuicao", "despesa_pessoal", "emprestimo_socio"];

export class OwnerDrawService {
  /** Registra uma retirada tipada; se sai do caixa, gera a saída (idempotente). */
  static record(orgId: string, input: { kind: string; amount: number; date?: string; note?: string; createdBy?: string }) {
    const kind = (DRAW_KINDS as readonly string[]).includes(input.kind) ? input.kind : null;
    if (!kind) return { ok: false as const, error: "invalid_kind" };
    const amount = round2(input.amount);
    if (!(amount > 0)) return { ok: false as const, error: "invalid_amount" };
    const date = isDate(input.date) ? input.date! : today();
    const id = randomUUID();
    db.prepare(`INSERT INTO owner_draws (id, organization_id, kind, amount, draw_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, kind, amount, date, input.note || null, input.createdBy || null);
    if (OUTFLOW_KINDS.includes(kind)) {
      FinancialLedgerService.recordEvent(orgId, { direction: "out", amount, eventDate: date, sourceType: "owner_draw", sourceId: id, note: `Retirada: ${kind}`, createdBy: input.createdBy });
    }
    return { ok: true as const, id, kind, amount, cashOut: OUTFLOW_KINDS.includes(kind) };
  }

  static list(orgId: string, period = new Date().toISOString().slice(0, 7)) {
    return db.prepare("SELECT id, kind, amount, draw_date, note FROM owner_draws WHERE organization_id = ? AND strftime('%Y-%m', draw_date) = ? ORDER BY draw_date DESC").all(orgId, period) as any[];
  }

  /** Total das RETIRADAS do mês (só os tipos que saem do caixa) — usado pela DRE. */
  static monthlyRetiradas(orgId: string, period: string): number {
    const marks = OUTFLOW_KINDS.map(() => "?").join(",");
    const r = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND kind IN (${marks}) AND strftime('%Y-%m', draw_date) = ?`)
      .get(orgId, ...OUTFLOW_KINDS, period) as any;
    return round2(r.s);
  }

  private static byKind(orgId: string, period: string): Record<string, number> {
    const rows = db.prepare("SELECT kind, COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND strftime('%Y-%m', draw_date) = ? GROUP BY kind").all(orgId, period) as any[];
    const out: Record<string, number> = {};
    for (const k of DRAW_KINDS) out[k] = 0;
    for (const r of rows) out[r.kind] = round2(r.s);
    return out;
  }

  /**
   * Painel Empresa × Proprietário: retiradas por tipo, % do resultado, alerta de
   * excesso, sugestão de pró-labore sustentável e impacto no capital de giro.
   */
  static summary(orgId: string, period = new Date().toISOString().slice(0, 7)) {
    const byKind = this.byKind(orgId, period);
    const retiradas = this.monthlyRetiradas(orgId, period);
    const aportes = byKind.despesa_empresarial;
    const dre = ManagerialDreService.monthly(orgId, period);
    // Resultado operacional ANTES das retiradas (a linha de retiradas é a seguir).
    const resultado = round2(dre.linhas.resultadoOperacional);
    const caixa = FinancialLedgerService.cashOnHand(orgId);

    const pctDoResultado = resultado > 0 ? round2((retiradas / resultado) * 100) : null;
    const pctDoCaixa = caixa > 0 ? round2((retiradas / caixa) * 100) : null;

    // Alerta de excesso (orientativo).
    let alerta: { nivel: "ok" | "atencao" | "excesso"; msg: string };
    if (retiradas <= 0) alerta = { nivel: "ok", msg: "Sem retiradas neste mês." };
    else if (resultado <= 0) alerta = { nivel: "excesso", msg: "Você está retirando com o resultado do mês zerado ou negativo — isso descapitaliza a empresa." };
    else if (pctDoResultado! > 70) alerta = { nivel: "excesso", msg: `Você retirou ${pctDoResultado}% do resultado do mês (acima de 70%). Cuidado para não comprometer o caixa.` };
    else if (pctDoResultado! > 50) alerta = { nivel: "atencao", msg: `As retiradas já são ${pctDoResultado}% do resultado do mês.` };
    else alerta = { nivel: "ok", msg: "Retiradas dentro de uma faixa saudável do resultado." };

    // Pró-labore sustentável: 30% do resultado do mês, limitado ao caixa.
    const proLaboreSugerido = round2(Math.max(0, Math.min(0.3 * Math.max(0, resultado), Math.max(0, caixa))));
    const premissas = [
      "Base: 30% do resultado operacional do mês.",
      "Limitado ao caixa disponível para não descapitalizar.",
      "Sugestão orientativa — você decide.",
    ];

    return {
      period,
      byKind,
      retiradas,
      aportes,
      resultado,
      caixa,
      pctDoResultado,
      pctDoCaixa,
      alerta,
      proLaboreSugerido,
      premissas,
      itens: this.list(orgId, period),
    };
  }
}

export default OwnerDrawService;
