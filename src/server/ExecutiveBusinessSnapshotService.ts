import { BusinessGoalService, EXECUTIVE_PILLARS, type ExecutivePillar } from "./BusinessGoalService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { ExecutiveVisionService } from "./ExecutiveVisionService.js";
import { FalaTuHomeService } from "./FalaTuHomeService.js";

/**
 * Executive Business Snapshot (ADR-190 F4, CEO Operating Layer — a primitiva central).
 *
 * Responde a pergunta do North Star (§4): "Como está minha empresa?" → 3 PILARES
 * (comercial/operações/financeiro), cada um com indicadores + metas + exceções +
 * prioridades, mais missões em voo e a visão declarada pelo dono.
 *
 * NATUREZA (D1): serviço FINO, READ-ONLY, determinístico, COMPOSIÇÃO PURA sobre o
 * que já existe — não é motor, não persiste, não cacheia de novo (o V2.read já
 * cacheia por baixo quando o Evidence Layer está ligado). Zero tabela nova.
 *
 * HONESTIDADE (RN-CEO-11 / §8/§10/§31): indicador sem fonte → `value:null`,
 * `basis:'unknown'`, `availability:'unavailable'` (NUNCA 0). Um pilar sem
 * nenhum indicador disponível, meta ou exceção fica `health:'unknown'` — não "ok".
 * A IA (Diretor) apenas NARRA este JSON; nunca calcula KPI nem inventa (§43).
 *
 * DINHEIRO (§73/RN-CEO-13): a rota é owner/admin; `includeMoney:false` REDIGE
 * qualquer valor em BRL (indicador/meta/impacto) pra superfícies de menor
 * privilégio (ex.: Fala Tu de um usuário não-dono) reusarem a mesma primitiva.
 */

const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

// D2 — mapa DETERMINÍSTICO domínio→pilar. Conservador: só o que é claramente
// comercial ou financeiro sai de "operações"; o resto (a operação é o "resto"
// honesto) e qualquer domínio não mapeado caem em `operations`. As exceções não
// mapeadas ainda aparecem no bloco global de atenção (nada some).
const DOMAIN_PILLAR: Record<string, ExecutivePillar> = {
  sales: "commercial", comercial: "commercial", content: "commercial", social: "commercial",
  crm: "commercial", marketing: "commercial", leads: "commercial",
  finance: "finance", receivables: "finance", cobranca: "finance", billing: "finance", cost: "finance",
};
function pillarForDomain(domain: string): ExecutivePillar {
  return DOMAIN_PILLAR[String(domain || "").toLowerCase()] || "operations";
}

const isBrl = (unit: any) => String(unit || "").toUpperCase() === "BRL";

export interface ExecutivePillarView {
  pillar: ExecutivePillar;
  health: "ok" | "attention" | "critical" | "unknown";
  indicators: any[];
  goals: any[];
  exceptions: any[];
  priorities: any[];
}

export interface ExecutiveSnapshot {
  organization: { id: string };
  period: { month: string };
  generatedAt: string;
  vision: any;
  pillars: Record<ExecutivePillar, ExecutivePillarView>;
  missions: any;
  attention: { total: number; bySeverity: Record<string, number> };
  schemaVersion: number;
}

export class ExecutiveBusinessSnapshotService {
  /** Composição read-only → snapshot executivo por pilar. Nunca inventa (RN-CEO-11). */
  static read(orgId: string, opts: { period?: string; includeMoney?: boolean } = {}): ExecutiveSnapshot {
    const includeMoney = opts.includeMoney !== false; // default expõe R$ (rota owner/admin)
    const period = opts.period || new Date().toISOString().slice(0, 7);

    // Descritores por pilar (F1) + metas ativas (progress) + exceções (attention) +
    // prioridades (ImpactPrioritization) — todos best-effort, isolados por falha.
    const byPillarDesc = BusinessGoalService.metricsByPillar();
    const goalsAll = safe(() => BusinessGoalService.progress(orgId).goals, [] as any[]);
    const attention = safe(
      () => BusinessSignalService.attention(orgId, { limit: 200 }),
      { total: 0, bySeverity: { critical: 0, risk: 0, attention: 0, info: 0 }, byDomain: {}, items: [] as any[] } as any,
    );
    const priorities = safe(
      () => ImpactPrioritizationService.prioritize(orgId, { globalLimit: 3 }),
      { global: [] as any[], byDomain: {} } as any,
    );

    const pillars = {} as Record<ExecutivePillar, ExecutivePillarView>;
    for (const p of EXECUTIVE_PILLARS) {
      // Indicadores — leitura HONESTA via measure() (sem fonte → value:null).
      const indicators = byPillarDesc[p]
        .map((d) => BusinessGoalService.measure(orgId, d.metricKey))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => this.redactReading(r, includeMoney));

      // Metas do pilar — agrupa pela procedência de pilar do próprio metric.
      const goals = goalsAll
        .filter((g) => BusinessGoalService.describe(g.metric)?.pillar === p)
        .map((g) => this.redactGoal(g, includeMoney));

      // Exceções (do feed de atenção) e prioridades cujo domínio mapeia neste pilar.
      const exceptions = (attention.items || [])
        .filter((it: any) => pillarForDomain(it.domain) === p)
        .map((it: any) => this.redactSignal(it, includeMoney));
      const prio = (priorities.global || [])
        .filter((x: any) => pillarForDomain(x.domain) === p)
        .map((x: any) => this.projectPriority(x, includeMoney));

      pillars[p] = { pillar: p, health: this.pillarHealth(indicators, goals, exceptions), indicators, goals, exceptions, priorities: prio };
    }

    return {
      organization: { id: orgId },
      period: { month: period },
      generatedAt: new Date().toISOString(),
      vision: safe(() => ExecutiveVisionService.get(orgId), null),
      pillars,
      missions: safe(() => FalaTuHomeService.missionsBlock(orgId), null),
      attention: { total: attention.total || 0, bySeverity: attention.bySeverity || {} },
      schemaVersion: 1,
    };
  }

  /** Saúde QUALITATIVA do pilar — rollup determinístico de FATOS já derivados (não é KPI/IA).
   *  Sem indicador disponível, meta ou exceção → `unknown` (null≠zero: pilar vazio não é "ok"). */
  private static pillarHealth(indicators: any[], goals: any[], exceptions: any[]): ExecutivePillarView["health"] {
    if (exceptions.some((e) => e.severity === "critical")) return "critical";
    if (exceptions.some((e) => e.severity === "risk") || goals.some((g) => g.paceStatus === "behind")) return "attention";
    const hasSignal = indicators.some((i) => i.availability === "available") || goals.length > 0 || exceptions.length > 0;
    return hasSignal ? "ok" : "unknown";
  }

  private static redactReading(r: any, includeMoney: boolean): any {
    if (includeMoney || !isBrl(r.unit)) return r;
    return { ...r, value: null, redacted: true };
  }

  private static redactGoal(g: any, includeMoney: boolean): any {
    if (includeMoney || !isBrl(g.unit)) return g;
    return { ...g, target: null, current: null, remaining: null, expectedByNow: null, baseline: null, redacted: true };
  }

  private static redactSignal(it: any, includeMoney: boolean): any {
    if (includeMoney || !isBrl(it.impactUnit)) return it;
    return { ...it, impactAmount: null, redacted: true };
  }

  /** Projeta o item priorizado pra moldura executiva (subconjunto estável; redige R$). */
  private static projectPriority(x: any, includeMoney: boolean): any {
    const impact = x.impact && (includeMoney || !isBrl(x.impact.unit))
      ? x.impact
      : x.impact ? { amount: null, unit: x.impact.unit, redacted: true } : null;
    return {
      signalId: x.signalId, domain: x.domain, type: x.signalType, score: x.score,
      impactLevel: x.impactLevel, impactLevelLabel: x.impactLevelLabel,
      fact: x.fact, interpretation: x.interpretation, basis: x.basis,
      recommendedAction: x.recommendedAction, impact,
    };
  }
}

export default ExecutiveBusinessSnapshotService;
