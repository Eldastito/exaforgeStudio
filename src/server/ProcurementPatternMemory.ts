import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * ProcurementPatternMemory — o domínio de COMPRAS aprende sobre o motor genérico
 * (PatternMemoryService). Segunda prova de que a extração pegou: um domínio novo
 * ganha memória de padrões escrevendo SÓ os seus detectores determinísticos.
 *
 * Detectores (por fornecedor, na janela):
 *   - fornecedor_divergencia_recorrente: recebimentos com divergência com frequência
 *     (falta, avaria, item errado, nota ausente) — risco de conferência/qualidade;
 *   - fornecedor_atraso_recorrente: entregas fora do prazo prometido (received_at
 *     depois de confirmed_at + delivery_days) com frequência.
 *
 * Validados, viram sinais do domínio "procurement" que fluem para o Pareto, o
 * briefing, o Diretor e a tela de Insights como qualquer outro sinal.
 */

const MIN_EVIDENCE = 3;
const DOMAIN = "procurement";
const HANDLED_TYPES = ["fornecedor_divergencia_recorrente", "fornecedor_atraso_recorrente"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class ProcurementPatternMemory {
  /** Divergência de recebimento recorrente por fornecedor. */
  static detectDivergenceRecurrence(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT COALESCE(po.supplier_contact_id, 'name:' || COALESCE(po.supplier_name,'?')) AS sup,
              MAX(po.supplier_name) AS sup_name,
              SUM(CASE WHEN gr.has_divergence = 1 THEN 1 ELSE 0 END) AS divergent,
              COUNT(*) AS total
         FROM goods_receipts gr
         JOIN purchase_orders po ON po.id = gr.purchase_order_id AND po.organization_id = gr.organization_id
        WHERE gr.organization_id = ? AND date(gr.created_at) BETWEEN ? AND ?
        GROUP BY sup`
    ).all(orgId, from, asOf) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const divergent = Number(r.divergent) || 0;
      const total = Number(r.total) || 0;
      if (divergent < MIN_EVIDENCE) continue;
      const name = r.sup_name || "fornecedor";
      out.push({
        scopeId: String(r.sup), scopeName: name,
        patternType: "fornecedor_divergencia_recorrente", patternKey: "divergencia",
        evidenceCount: divergent, confidence: clamp01(divergent / Math.max(1, total)),
        impactAmount: divergent, impactUnit: "receipts",
        evidence: { supplier: name, divergent, total, from, to: asOf },
        fallbackDescription: `Divergência de recebimento recorrente com ${name}: ${divergent} de ${total} recebimentos divergiram na janela — reforçar conferência e cobrar o fornecedor.`,
      });
    }
    return out;
  }

  /** Atraso de entrega recorrente por fornecedor (prazo prometido furado). */
  static detectLateDeliveryRecurrence(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT COALESCE(supplier_contact_id, 'name:' || COALESCE(supplier_name,'?')) AS sup,
              MAX(supplier_name) AS sup_name,
              SUM(CASE WHEN confirmed_at IS NOT NULL AND delivery_days IS NOT NULL
                        AND julianday(date(received_at)) > julianday(date(confirmed_at)) + delivery_days THEN 1 ELSE 0 END) AS late,
              COUNT(*) AS received
         FROM purchase_orders
        WHERE organization_id = ? AND received_at IS NOT NULL AND date(received_at) BETWEEN ? AND ?
        GROUP BY sup`
    ).all(orgId, from, asOf) as any[];
    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const late = Number(r.late) || 0;
      const received = Number(r.received) || 0;
      if (late < MIN_EVIDENCE) continue;
      const name = r.sup_name || "fornecedor";
      out.push({
        scopeId: String(r.sup), scopeName: name,
        patternType: "fornecedor_atraso_recorrente", patternKey: "atraso",
        evidenceCount: late, confidence: clamp01(late / Math.max(1, received)),
        impactAmount: late, impactUnit: "orders",
        evidence: { supplier: name, late, received, from, to: asOf },
        fallbackDescription: `Atraso de entrega recorrente com ${name}: ${late} de ${received} pedidos chegaram fora do prazo prometido na janela — renegociar prazo ou buscar alternativa.`,
      });
    }
    return out;
  }

  /** Um passe de aprendizado do domínio de compras (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 8) * 7);
    const candidates = [
      ...this.detectDivergenceRecurrence(orgId, from, asOf),
      ...this.detectLateDeliveryRecurrence(orgId, from, asOf),
    ];
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "ProcurementPatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default ProcurementPatternMemory;
