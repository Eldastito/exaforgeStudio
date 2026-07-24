import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * FinancePatternMemory — o domínio FINANCEIRO aprende sobre o motor genérico
 * (PatternMemoryService). Detectores determinísticos sobre o Caixa (payables /
 * receivables):
 *   - cliente_pagamento_atrasado_recorrente: cliente que recebe fiado e paga
 *     fora do prazo com frequência (risco de inadimplência / caixa);
 *   - categoria_despesa_estoura_recorrente: categoria de despesa cujo gasto
 *     mensal estoura o próprio normal em vários meses (custo fora de controle).
 *
 * Validados, viram sinais 'finance' que fluem para o Pareto, o Diretor e a tela
 * de Insights. (No briefing do WhatsApp o bloco de operação exclui 'finance'
 * para não duplicar as prioridades da Central de Saúde — de propósito.)
 */

const MIN_EVIDENCE = 3;
const DOMAIN = "finance";
const HANDLED_TYPES = ["cliente_pagamento_atrasado_recorrente", "categoria_despesa_estoura_recorrente"];
const OVERRUN_FACTOR = 1.2; // mês "estoura" quando passa 1,2× a média da categoria
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class FinancePatternMemory {
  /** Cliente que paga atrasado recorrente (recebíveis quitados após o vencimento). */
  static detectLatePayingCustomer(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT contact_id,
              SUM(CASE WHEN date(received_at) > due_date THEN 1 ELSE 0 END) AS late,
              COUNT(*) AS total
         FROM receivables
        WHERE organization_id = ? AND status = 'received' AND contact_id IS NOT NULL
          AND received_at IS NOT NULL AND date(received_at) BETWEEN ? AND ?
        GROUP BY contact_id`
    ).all(orgId, from, asOf) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const late = Number(r.late) || 0;
      const total = Number(r.total) || 0;
      if (late < MIN_EVIDENCE) continue;
      const name = (db.prepare("SELECT name FROM contacts WHERE id = ? AND organization_id = ?").get(r.contact_id, orgId) as any)?.name || "cliente";
      out.push({
        scopeId: String(r.contact_id), scopeName: name,
        patternType: "cliente_pagamento_atrasado_recorrente", patternKey: "atraso_pagamento",
        evidenceCount: late, confidence: clamp01(late / Math.max(1, total)),
        impactAmount: late, impactUnit: "payments",
        evidence: { customer: name, late, total, from, to: asOf },
        fallbackDescription: `Cliente ${name} paga atrasado com frequência: ${late} de ${total} recebimentos quitados após o vencimento na janela — rever prazo/limite ou exigir garantia.`,
      });
    }
    return out;
  }

  /** Categoria de despesa que estoura recorrente (gasto mensal acima do próprio normal). */
  static detectExpenseCategoryOverrun(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT COALESCE(category, 'Sem categoria') AS category,
              strftime('%Y-%m', due_date) AS ym,
              SUM(amount) AS total
         FROM payables
        WHERE organization_id = ? AND due_date BETWEEN ? AND ?
        GROUP BY category, ym`
    ).all(orgId, from, asOf) as any[];

    // Agrupa os totais mensais por categoria.
    const byCat = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byCat.get(r.category) || [];
      arr.push(Number(r.total) || 0);
      byCat.set(r.category, arr);
    }

    const out: PatternCandidate[] = [];
    for (const [category, months] of byCat) {
      if (months.length < MIN_EVIDENCE) continue;
      const avg = months.reduce((s, v) => s + v, 0) / months.length;
      if (avg <= 0) continue;
      const overMonths = months.filter((v) => v > avg * OVERRUN_FACTOR).length;
      if (overMonths < MIN_EVIDENCE) continue;
      const peak = Math.max(...months);
      out.push({
        scopeId: category, scopeName: category,
        patternType: "categoria_despesa_estoura_recorrente", patternKey: "estouro",
        evidenceCount: overMonths, confidence: clamp01(overMonths / months.length),
        impactAmount: round2(peak - avg), impactUnit: "BRL",
        evidence: { category, overMonths, totalMonths: months.length, avgMonthly: round2(avg), peakMonthly: round2(peak), from, to: asOf },
        fallbackDescription: `Despesa de "${category}" estoura recorrente: ${overMonths} de ${months.length} meses acima do normal (média ${round2(avg)}, pico ${round2(peak)}) — revisar contratos/consumo da categoria.`,
      });
    }
    return out;
  }

  /** Um passe de aprendizado do domínio financeiro (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 26) * 7); // janela maior (semestral) p/ finanças
    const candidates = [
      ...this.detectLatePayingCustomer(orgId, from, asOf),
      ...this.detectExpenseCategoryOverrun(orgId, from, asOf),
    ];
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "FinancePatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default FinancePatternMemory;
