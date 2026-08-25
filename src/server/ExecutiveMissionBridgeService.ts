import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { MissionService } from "./MissionService.js";
import type { ExecutivePillar } from "./BusinessGoalService.js";

/**
 * Executive → Mission Bridge (ADR-190 F6, CEO Operating Layer).
 *
 * Liga a camada executiva (desvios priorizados, F4/F5) às MISSÕES (ADR-189): de um
 * desvio que AMEAÇA UMA META declarada, SUGERE a missão que a endereça — reusando
 * `MissionService`/`ImpactPrioritizationService`/`BusinessGoalService`, sem motor
 * novo. Não persiste, zero tabela nova.
 *
 * SUGERIR ≠ CRIAR (RN-CEO-06 / §5): o bridge é READ-ONLY — devolve RASCUNHOS de
 * missão (o mesmo shape que `MissionService.create` aceita), NUNCA cria. O dono
 * confirma pra virar missão de fato (pela rota/UI de missões que já existe).
 *
 * NÃO INVENTA OBJETIVO (RN-CEO-11): só sugere onde há uma META declarada ameaçada
 * (`affectedGoal` do scoring) — daí vêm `targetMetric`/`targetValue` REAIS. Desvio
 * sem meta mapeável → sem rascunho (não fabrica alvo). `basis:'hypothesis'`: a
 * missão é a aposta pra fechar o desvio, não causa provada. Missão já existente
 * pra aquela métrica → marcada `alreadyCovered` (não duplica).
 */

const DOMAIN_PILLAR: Record<string, ExecutivePillar> = {
  sales: "commercial", comercial: "commercial", content: "commercial", social: "commercial",
  crm: "commercial", marketing: "commercial", leads: "commercial",
  finance: "finance", receivables: "finance", cobranca: "finance", billing: "finance", cost: "finance",
};
const pillarForDomain = (d: string): ExecutivePillar => DOMAIN_PILLAR[String(d || "").toLowerCase()] || "operations";

export interface MissionDraft {
  title: string;
  description: string;
  targetMetric: string;
  targetValue: number;
  targetUnit: string | null;
  source: string;
  confidence: number | null;
}

export interface MissionSuggestion {
  fromConstraint: boolean;
  signalId: string;
  domain: string;
  pillar: ExecutivePillar;
  reason: string;
  basis: string;
  alreadyCovered: boolean;
  draft: MissionDraft | null;
}

export interface MissionBridgeResult {
  generatedAt: string;
  missionLayerEnabled: boolean;
  suggestions: MissionSuggestion[];
  note: string;
}

export class ExecutiveMissionBridgeService {
  /** Rascunhos de missão a partir dos desvios que ameaçam metas. Read-only, nunca cria. */
  static suggest(orgId: string, opts: { limit?: number } = {}): MissionBridgeResult {
    const limit = Math.max(1, Number(opts.limit) || 3);
    const missionLayerEnabled = safe(() => MissionService.isEnabled(orgId), false);

    // Metas declaradas → mapa metric→{target,unit} pra ancorar o alvo REAL do rascunho.
    const goals = safe(() => BusinessGoalService.progress(orgId).goals, [] as any[]);
    const goalByMetric = new Map<string, { target: number; unit: string | null; label: string }>();
    for (const g of goals) goalByMetric.set(g.metric, { target: g.target, unit: g.unit, label: g.label });

    // Missões VIVAS → dedupe por métrica-alvo (não sugere o que já está coberto). Viva =
    // qualquer status não-terminal (uma missão achieved/failed/cancelled não cobre mais).
    const TERMINAL = new Set(["achieved", "failed", "cancelled"]);
    const covered = new Set<string>();
    for (const m of safe(() => MissionService.list(orgId), [] as any[])) {
      if (m.targetMetric && !TERMINAL.has(m.status)) covered.add(m.targetMetric);
    }

    // Desvios priorizados (F5 usa o mesmo ranking). Só os que ameaçam uma META viram rascunho.
    const prio = safe(() => ImpactPrioritizationService.prioritize(orgId, { globalLimit: limit }), { global: [] as any[] } as any);
    const suggestions: MissionSuggestion[] = [];
    let idx = 0;
    for (const c of prio.global || []) {
      const fromConstraint = idx++ === 0;
      const ag = c.affectedGoal; // { metric, label, gapPct } | null — meta declarada ameaçada
      if (!ag || !goalByMetric.has(ag.metric)) {
        // Sem meta mapeável → não fabrica alvo (RN-CEO-11). Registra o desvio sem rascunho.
        suggestions.push({
          fromConstraint, signalId: c.signalId, domain: c.domain, pillar: pillarForDomain(c.domain),
          reason: `Desvio "${c.fact}" sem meta declarada mapeável — defina uma meta pra virar missão mensurável.`,
          basis: "hypothesis", alreadyCovered: false, draft: null,
        });
        continue;
      }
      const goal = goalByMetric.get(ag.metric)!;
      const alreadyCovered = covered.has(ag.metric);
      suggestions.push({
        fromConstraint, signalId: c.signalId, domain: c.domain, pillar: pillarForDomain(c.domain),
        reason: `O desvio "${c.fact}" ameaça a meta "${goal.label}" (gap ${ag.gapPct}%). Missão proposta: recuperar a meta.`,
        basis: "hypothesis", alreadyCovered,
        draft: {
          title: `Recuperar meta: ${goal.label}`,
          description: `Endereça o desvio "${c.fact}" (${c.recommendedAction}). Meta ameaçada: ${goal.label}.`,
          targetMetric: ag.metric, targetValue: goal.target, targetUnit: goal.unit,
          source: "system_proposed", confidence: null, // origem válida (MISSION_SOURCES) — o dono cria direto
        },
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      missionLayerEnabled,
      suggestions,
      note: "Sugestões (hipótese). O dono confirma pra virar missão — o bridge nunca cria (RN-CEO-06).",
    };
  }
}

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

export default ExecutiveMissionBridgeService;
