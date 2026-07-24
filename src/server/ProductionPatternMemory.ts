import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * ProductionPatternMemory — o PRIMEIRO domínio a "aprender" sobre o motor genérico
 * (PatternMemoryService). Prova que um domínio novo passa a ter memória de padrões
 * escrevendo SÓ o seu detector determinístico — todo o resto (regra de recorrência,
 * confiança, decaimento, publicação de sinais, eficácia por tipo) é reusado.
 *
 * Detector: PRODUTO com atraso de produção RECORRENTE — ordens prometidas que
 * furaram o prazo (entregues tarde, ou ainda abertas depois do prazo) com
 * frequência na janela. Vira o padrão "producao_atrasada_recorrente" por produto,
 * que, validado, publica-se como sinal de produção e flui para o Pareto/briefing/
 * Diretor/Insights como qualquer outro sinal.
 */

const MIN_EVIDENCE = 3;
const DOMAIN = "production";
const HANDLED_TYPES = ["producao_atrasada_recorrente"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class ProductionPatternMemory {
  /** Detecta atraso de produção recorrente por produto na janela [from, asOf]. */
  static detect(orgId: string, from: string, asOf: string): PatternCandidate[] {
    // "Atrasada" = prometida no período e ou entregue tarde (date(completed_at) > promised_date)
    // ou ainda aberta com o prazo já vencido (status não terminal e promised_date < asOf).
    const rows = db.prepare(
      `SELECT manufactured_product_id AS pid,
              SUM(CASE
                    WHEN completed_at IS NOT NULL AND date(completed_at) > promised_date THEN 1
                    WHEN completed_at IS NULL AND status NOT IN ('done','cancelled') AND promised_date < ? THEN 1
                    ELSE 0 END) AS late,
              COUNT(*) AS total
         FROM production_orders
        WHERE organization_id = ? AND promised_date IS NOT NULL
          AND promised_date BETWEEN ? AND ?
        GROUP BY manufactured_product_id`
    ).all(asOf, orgId, from, asOf) as any[];

    const out: PatternCandidate[] = [];
    for (const r of rows) {
      const late = Number(r.late) || 0;
      const total = Number(r.total) || 0;
      if (late < MIN_EVIDENCE) continue;
      const name = (db.prepare("SELECT name FROM manufactured_products WHERE id = ? AND organization_id = ?").get(r.pid, orgId) as any)?.name || "produto";
      const confidence = clamp01(late / Math.max(1, total));
      out.push({
        scopeId: String(r.pid), scopeName: name,
        patternType: "producao_atrasada_recorrente", patternKey: "atraso",
        evidenceCount: late, confidence, impactAmount: late, impactUnit: "orders",
        evidence: { product: name, late, total, from, to: asOf },
        fallbackDescription: `Atraso de produção recorrente em ${name}: ${late} de ${total} ordens furaram o prazo na janela — provável gargalo de capacidade ou de material.`,
      });
    }
    return out;
  }

  /** Um passe de aprendizado do domínio de produção (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 8) * 7);
    const candidates = this.detect(orgId, from, asOf);
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "ProductionPatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default ProductionPatternMemory;
