import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * PeoplePatternMemory — o domínio de PESSOAS/EQUIPE aprende sobre o motor genérico
 * (PatternMemoryService). Detector determinístico sobre vendas por vendedor:
 *   - vendedor_queda_recorrente: vendedor cujas vendas mensais caem passo a passo
 *     (mês após mês) com frequência na janela — sinal de coaching/meta/atrito.
 *
 * Validado, vira sinal 'people' que flui para o Pareto, o briefing, o Diretor e a
 * tela de Insights. Sem PII sensível (nome do vendedor é dado operacional).
 */

const MIN_EVIDENCE = 3; // nº mínimo de quedas mês-a-mês na janela
const DOMAIN = "people";
const HANDLED_TYPES = ["vendedor_queda_recorrente"];
const NON_SALE = ["cancelado", "reembolso", "devolucao"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class PeoplePatternMemory {
  /** Vendedor com queda recorrente de vendas (meses consecutivos em declínio). */
  static detectSellerDecline(orgId: string, from: string, asOf: string): PatternCandidate[] {
    const rows = db.prepare(
      `SELECT seller_user_id AS uid, strftime('%Y-%m', created_at) AS ym, SUM(total_amount) AS total
         FROM orders
        WHERE organization_id = ? AND seller_user_id IS NOT NULL
          AND status NOT IN ('${NON_SALE.join("','")}')
          AND date(created_at) BETWEEN ? AND ?
        GROUP BY seller_user_id, ym
        ORDER BY seller_user_id, ym`
    ).all(orgId, from, asOf) as any[];

    // Monta a série mensal (ordenada) por vendedor.
    const bySeller = new Map<string, { ym: string; total: number }[]>();
    for (const r of rows) {
      const arr = bySeller.get(r.uid) || [];
      arr.push({ ym: r.ym, total: Number(r.total) || 0 });
      bySeller.set(r.uid, arr);
    }

    const out: PatternCandidate[] = [];
    for (const [uid, series] of bySeller) {
      if (series.length < MIN_EVIDENCE + 1) continue; // precisa de ≥4 meses p/ ter ≥3 passos
      let declines = 0;
      for (let i = 1; i < series.length; i++) if (series[i].total < series[i - 1].total) declines++;
      if (declines < MIN_EVIDENCE) continue;
      const first = series[0].total, last = series[series.length - 1].total;
      const drop = round2(first - last);
      const name = (db.prepare("SELECT name FROM users WHERE id = ? AND organization_id = ?").get(uid, orgId) as any)?.name || "vendedor";
      out.push({
        scopeId: String(uid), scopeName: name,
        patternType: "vendedor_queda_recorrente", patternKey: "queda",
        evidenceCount: declines, confidence: clamp01(declines / (series.length - 1)),
        impactAmount: drop > 0 ? drop : null, impactUnit: "BRL",
        evidence: { seller: name, declines, months: series.length, firstMonthly: round2(first), lastMonthly: round2(last), drop, from, to: asOf },
        fallbackDescription: `Vendas de ${name} em queda recorrente: ${declines} meses de queda na janela (de ${round2(first)} para ${round2(last)}) — conversar, entender a causa e apoiar com meta/coaching.`,
      });
    }
    return out;
  }

  /** Um passe de aprendizado do domínio de pessoas (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 26) * 7);
    const candidates = this.detectSellerDecline(orgId, from, asOf);
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "PeoplePatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default PeoplePatternMemory;
