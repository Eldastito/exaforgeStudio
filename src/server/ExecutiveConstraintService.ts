import { ExecutiveBusinessSnapshotService } from "./ExecutiveBusinessSnapshotService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import type { ExecutivePillar } from "./BusinessGoalService.js";

/**
 * Executive Constraint & Worst-Pillar (ADR-190 F5, CEO Operating Layer).
 *
 * A F4 dá o panorama por pilar. A F5 dá a leitura COMPANY-LEVEL de "onde focar":
 * (a) o PILAR em pior forma e (b) a RESTRIÇÃO (constraint) — o desvio nº1 a
 * resolver agora. Composição PURA sobre a F4 (`ExecutiveBusinessSnapshotService`)
 * + o ranking que o `ImpactPrioritizationService` já produz (score + SLA +
 * irreversibilidade + meta ameaçada). Não é motor, não persiste, zero tabela nova.
 *
 * HONESTIDADE (RN-CEO-02/03/11): a constraint é o desvio ABERTO de MAIOR score —
 * um FATO de priorização. A afirmação de que resolvê-la "destrava o resto" é
 * HIPÓTESE (§5): sai rotulada `basis:'hypothesis'`, nunca como causa provada. Sem
 * desvio aberto → `constraint:null` e `worstPillar:null` (null≠zero — não inventa
 * um gargalo onde não há). A meta ameaçada vem de `affectedGoal` (do próprio
 * scoring), nunca fabricada.
 *
 * DINHEIRO role-gated (§73): `includeMoney:false` redige o impacto BRL da
 * constraint; a rota é owner/admin.
 */

// Severidade da saúde do pilar → ordinal (pior primeiro). `unknown` (sem dado) NÃO
// é "pior" que `ok`: é ausência de sinal, fica no fundo junto do saudável.
const HEALTH_RANK: Record<string, number> = { critical: 3, attention: 2, ok: 1, unknown: 0 };

export interface ExecutiveConstraint {
  signalId: string;
  domain: string;
  pillar: ExecutivePillar;
  type: string;
  severity: string;
  score: number;
  impactLevel: string;
  impactLevelLabel: string;
  fact: string;
  interpretation: string;
  basis: string;
  recommendedAction: string;
  impact: { amount: number | null; unit: string | null; redacted?: boolean } | null;
  threatensGoal: { metric: string; label: string; gapPct: number } | null;
  rationale: string;
}

export interface ExecutiveConstraintAssessment {
  generatedAt: string;
  worstPillar: { pillar: ExecutivePillar; health: string; criticalCount: number; riskCount: number } | null;
  constraint: ExecutiveConstraint | null;
  pillarsRanked: Array<{ pillar: ExecutivePillar; health: string; criticalCount: number; riskCount: number }>;
}

const isBrl = (u: any) => String(u || "").toUpperCase() === "BRL";
const DOMAIN_PILLAR: Record<string, ExecutivePillar> = {
  sales: "commercial", comercial: "commercial", content: "commercial", social: "commercial",
  crm: "commercial", marketing: "commercial", leads: "commercial",
  finance: "finance", receivables: "finance", cobranca: "finance", billing: "finance", cost: "finance",
};
const pillarForDomain = (d: string): ExecutivePillar => DOMAIN_PILLAR[String(d || "").toLowerCase()] || "operations";

export class ExecutiveConstraintService {
  /** Pilar em pior forma + a restrição nº1 (hipótese). Composição read-only sobre F4. */
  static assess(orgId: string, opts: { includeMoney?: boolean } = {}): ExecutiveConstraintAssessment {
    const includeMoney = opts.includeMoney !== false;
    const snap = ExecutiveBusinessSnapshotService.read(orgId, { includeMoney });

    // Ranking dos pilares: por saúde (pior primeiro), desempate por nº de exceções
    // críticas e depois de risco. Deriva do MESMO snapshot da F4 (fatos já lidos).
    const pillarsRanked = (Object.values(snap.pillars) as any[])
      .map((v) => {
        const criticalCount = v.exceptions.filter((e: any) => e.severity === "critical").length;
        const riskCount = v.exceptions.filter((e: any) => e.severity === "risk").length;
        return { pillar: v.pillar as ExecutivePillar, health: v.health as string, criticalCount, riskCount };
      })
      .sort((a, b) =>
        (HEALTH_RANK[b.health] ?? 0) - (HEALTH_RANK[a.health] ?? 0) ||
        b.criticalCount - a.criticalCount ||
        b.riskCount - a.riskCount ||
        a.pillar.localeCompare(b.pillar));

    // worstPillar só existe se há de fato algo demandando atenção (crítico/risco);
    // um pilar meramente "ok"/"unknown" no topo NÃO é um "pior pilar" honesto.
    const top = pillarsRanked[0];
    const worstPillar = top && (HEALTH_RANK[top.health] ?? 0) >= HEALTH_RANK.attention ? top : null;

    // Severidade normalizada por sinal, do próprio snapshot (o scoring não a expõe
    // no topo). Casa por id; ausente → "" (honesto, não inventa).
    const sevById = new Map<string, string>();
    for (const v of Object.values(snap.pillars) as any[]) for (const e of v.exceptions) sevById.set(e.id, e.severity);

    // Constraint = o desvio ABERTO de maior score (o topo do prioritize global).
    let constraint: ExecutiveConstraint | null = null;
    try {
      const prio = ImpactPrioritizationService.prioritize(orgId, { globalLimit: 1 });
      const c = (prio.global || [])[0];
      if (c) {
        const impact = c.impact
          ? (includeMoney || !isBrl(c.impact.unit) ? { amount: c.impact.amount, unit: c.impact.unit }
                                                    : { amount: null, unit: c.impact.unit, redacted: true })
          : null;
        constraint = {
          signalId: c.signalId, domain: c.domain, pillar: pillarForDomain(c.domain), type: c.signalType,
          severity: sevById.get(c.signalId) ?? "", score: c.score, impactLevel: c.impactLevel, impactLevelLabel: c.impactLevelLabel,
          fact: c.fact, interpretation: c.interpretation, basis: c.basis ?? null,
          recommendedAction: c.recommendedAction, impact,
          threatensGoal: c.affectedGoal ?? null,
          // HIPÓTESE (§5): é o desvio de maior prioridade — resolvê-lo primeiro é a
          // aposta, não uma causa provada de que destrava os demais.
          rationale: "hypothesis: maior prioridade entre os desvios abertos (score/SLA/irreversibilidade/meta ameaçada). Resolver primeiro é a aposta, não causa provada.",
        };
      }
    } catch { /* sem priorização disponível → constraint null (honesto) */ }

    return { generatedAt: new Date().toISOString(), worstPillar, constraint, pillarsRanked };
  }
}

export default ExecutiveConstraintService;
