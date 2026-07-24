import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * SalesPatternMemory — o domínio de VENDAS aprende sobre o motor genérico
 * (PatternMemoryService). Detectores determinísticos sobre order_items × orders:
 *   - produto_queda_giro_recorrente: produto cujo GIRO (unidades/mês) cai mês a mês;
 *   - categoria_queda_giro_recorrente: o mesmo, agregado por categoria de produto.
 *
 * Validados, viram sinais 'sales' que fluem para o Pareto, o briefing, o Diretor
 * e a tela de Insights — para reagir cedo (preço/vitrine/campanha) antes do giro
 * secar de vez.
 */

const MIN_EVIDENCE = 3; // nº mínimo de quedas mês-a-mês na janela
const DOMAIN = "sales";
const HANDLED_TYPES = ["produto_queda_giro_recorrente", "categoria_queda_giro_recorrente"];
const NON_SALE = ["cancelado", "reembolso", "devolucao"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Conta as quedas mês-a-mês de uma série (já ordenada por mês).
function declineOf(series: number[]): { declines: number; first: number; last: number } {
  let declines = 0;
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1]) declines++;
  return { declines, first: series[0], last: series[series.length - 1] };
}

export class SalesPatternMemory {
  /** Constrói a série mensal por chave e devolve os candidatos em queda recorrente. */
  private static declineCandidates(
    rows: any[],
    make: (key: string, series: number[], d: { declines: number; first: number; last: number }) => PatternCandidate,
  ): PatternCandidate[] {
    const byKey = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byKey.get(r.k) || [];
      arr.push(Number(r.units) || 0);
      byKey.set(r.k, arr);
    }
    const out: PatternCandidate[] = [];
    for (const [key, series] of byKey) {
      if (series.length < MIN_EVIDENCE + 1) continue; // ≥4 meses p/ ter ≥3 quedas
      const d = declineOf(series);
      if (d.declines < MIN_EVIDENCE) continue;
      out.push(make(key, series, d));
    }
    return out;
  }

  /** Produto com queda de giro recorrente (unidades/mês caindo). */
  static detectProductGiroDecline(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT oi.product_service_id AS k, strftime('%Y-%m', o.created_at) AS ym, SUM(oi.quantity) AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.organization_id = oi.organization_id
        WHERE o.organization_id = ? AND oi.product_service_id IS NOT NULL
          AND o.status NOT IN ('${NON_SALE.join("','")}')
          AND date(o.created_at) BETWEEN ? AND ?
        GROUP BY k, ym ORDER BY k, ym`
    ).all(orgId, from, asOf) as any[];
    return this.declineCandidates(rows, (pid, series, d) => {
      const name = (db.prepare("SELECT name FROM products_services WHERE id = ? AND organization_id = ?").get(pid, orgId) as any)?.name || "produto";
      return {
        scopeId: String(pid), scopeName: name,
        patternType: "produto_queda_giro_recorrente", patternKey: "giro",
        evidenceCount: d.declines, confidence: clamp01(d.declines / (series.length - 1)),
        impactAmount: d.first - d.last > 0 ? round2(d.first - d.last) : null, impactUnit: "units",
        evidence: { product: name, declines: d.declines, months: series.length, firstUnits: d.first, lastUnits: d.last, from, to: asOf },
        fallbackDescription: `Giro de ${name} em queda recorrente: ${d.declines} meses de queda (de ${d.first} para ${d.last} un/mês) — reagir com preço/vitrine/campanha antes de secar.`,
      };
    });
  }

  /** Categoria com queda de giro recorrente (unidades/mês caindo). */
  static detectCategoryGiroDecline(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT COALESCE(ps.category, 'Sem categoria') AS k, strftime('%Y-%m', o.created_at) AS ym, SUM(oi.quantity) AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.organization_id = oi.organization_id
         LEFT JOIN products_services ps ON ps.id = oi.product_service_id AND ps.organization_id = oi.organization_id
        WHERE o.organization_id = ?
          AND o.status NOT IN ('${NON_SALE.join("','")}')
          AND date(o.created_at) BETWEEN ? AND ?
        GROUP BY k, ym ORDER BY k, ym`
    ).all(orgId, from, asOf) as any[];
    return this.declineCandidates(rows, (cat, series, d) => ({
      scopeId: cat, scopeName: cat,
      patternType: "categoria_queda_giro_recorrente", patternKey: "giro",
      evidenceCount: d.declines, confidence: clamp01(d.declines / (series.length - 1)),
      impactAmount: d.first - d.last > 0 ? round2(d.first - d.last) : null, impactUnit: "units",
      evidence: { category: cat, declines: d.declines, months: series.length, firstUnits: d.first, lastUnits: d.last, from, to: asOf },
      fallbackDescription: `Giro da categoria "${cat}" em queda recorrente: ${d.declines} meses de queda (de ${d.first} para ${d.last} un/mês) — rever mix, preço e exposição da categoria.`,
    }));
  }

  /** Um passe de aprendizado do domínio de vendas (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 26) * 7);
    const candidates = [
      ...this.detectProductGiroDecline(orgId, from, asOf),
      ...this.detectCategoryGiroDecline(orgId, from, asOf),
    ];
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "SalesPatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default SalesPatternMemory;
