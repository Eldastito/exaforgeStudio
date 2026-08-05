/**
 * PlanFitDetectorService (ADR-153 F7.1) — scanner puro pra recomendação de plano.
 *
 * Detecta condições em que a org está próxima (ou acima) dos limites do plano
 * atual e produz candidatos a sinais `domain='plan'` que o publisher (idem
 * F7.1) vai emitir em `business_signals`. Análogo estrutural ao
 * `SalesStalledDealDetectorService` (ADR-152 F4c) e ao pattern ADR-136.
 *
 * PURO — sem side effects. Apenas lê estado + retorna candidatos com evidência.
 * O publisher (F7.1) faz o dedupe/publish; o Scheduler pauta.
 *
 * F7.1 = 4 detectores (near_limit AI/contacts/channels/users). F7.2 (próxima
 * fatia) adiciona `plan_module_gap` (blueprint quer módulo, plano não cobre)
 * + score 0-100 + explicabilidade. F7.3 adiciona frequency control + LGPD.
 *
 * G-153-6: severity segue tabela dura — dono decide se aceita:
 *   pct ∈ [80, 90) → attention  (sugestão discreta)
 *   pct ∈ [90, 100) → risk       (sugestão contextual)
 *   pct ≥ 100 → critical         (excedeu — inevitável falar)
 *
 * RN-153-F7.1-001: orgId sempre 1º arg; toda query filtra organization_id.
 * RN-153-F7.1-002: NÃO recomenda upgrade se plano da org é 'cortesia'
 *                  (dono não paga; regra política — se surgir demanda, retira).
 * RN-153-F7.1-003: NÃO recomenda upgrade em orgs com billing_status
 *                  `blocked | cancelled | past_due` (PRD §15 — "não exibir
 *                  durante inadimplência").
 */
import db from "./db.js";
import { PlanService } from "./PlanService.js";
import { PLAN_GRADE } from "./plansGrade.js";

export type PlanFitSignalType =
  | "plan_near_limit_ai"
  | "plan_near_limit_contacts"
  | "plan_near_limit_channels"
  | "plan_near_limit_users";

export type PlanFitSeverity = "attention" | "risk" | "critical";

export interface PlanFitCandidate {
  signalType: PlanFitSignalType;
  severity: PlanFitSeverity;
  metric: "ai" | "contacts" | "channels" | "users";
  used: number;
  limit: number;
  pct: number;               // 0..∞ (percentual normalizado; 100 = teto)
  planId: string;
  targetPlanId: string | null;   // próximo tier que aumenta esse limite
  evidence: {
    metric: string;
    used: number;
    limit: number;
    pctInt: number;
    currentPlan: string;
    upgradeTargetPlan: string | null;
    upgradeTargetLimit: number | null;
  };
  dedupeKey: string;          // mensal — evita spammar dono no mesmo mês
}

// Tabela hard de severity por faixa de uso — inspecionável, sem "IA no meio".
function severityFor(pct: number): PlanFitSeverity | null {
  if (pct < 80) return null;
  if (pct < 90) return "attention";
  if (pct < 100) return "risk";
  return "critical";
}

// Menor tier ≥ currentIdx+1 cujo limite pra `metric` > currentLimit. Se todos
// os tiers acima são zero (ilimitado — enterprise), aponta pro primeiro tier
// ilimitado (dono pode chegar a "sem trava").
function findUpgradeForLimit(currentPlanId: string, metric: "ai" | "contacts" | "channels" | "users", currentLimit: number): { planId: string; limit: number } | null {
  const order = ["autonomo", "start", "growth", "scale", "enterprise"];
  const idx = order.indexOf(currentPlanId);
  if (idx < 0) return null;
  const featureField: Record<string, keyof (typeof PLAN_GRADE)[0]["features"]> = {
    ai: "ai_monthly_limit",
    contacts: "contacts_limit",
    channels: "channels_limit",
    users: "users_limit",
  };
  const field = featureField[metric];
  for (let i = idx + 1; i < order.length; i++) {
    const p = PLAN_GRADE.find((pl) => pl.id === order[i]);
    if (!p) continue;
    const lim = Number(p.features[field] as any);
    // limit=0 significa ilimitado (Enterprise) — sempre "melhor" que qualquer teto.
    if (lim === 0 || lim > currentLimit) return { planId: p.id, limit: lim };
  }
  return null;
}

function ymNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class PlanFitDetectorService {
  /**
   * Varre a org e devolve candidatos a sinal. Roda em ~1 query (PlanService.
   * getBillingSnapshot faz 3-4 queries internas mas é read-only). Puro.
   */
  static detect(orgId: string): PlanFitCandidate[] {
    // Guardas duras (RN-153-F7.1-002/003):
    const org = db.prepare(
      `SELECT plan_id, billing_status FROM organization_settings
        WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any;
    if (!org) return [];
    if (org.plan_id === "cortesia" || !org.plan_id) return [];
    if (["blocked", "cancelled", "past_due"].includes(String(org.billing_status || ""))) return [];

    const plan = PlanService.getCurrentPlan(orgId);
    if (!plan || !plan.features) return [];
    const usage = PlanService.getUsage(orgId);

    const candidates: PlanFitCandidate[] = [];
    const ym = ymNow();

    const metrics: Array<{
      metric: "ai" | "contacts" | "channels" | "users";
      signalType: PlanFitSignalType;
      used: number;
      limit: number;
    }> = [
      { metric: "ai", signalType: "plan_near_limit_ai", used: usage.ai_this_month, limit: Number(plan.features.ai_monthly_limit || 0) },
      { metric: "contacts", signalType: "plan_near_limit_contacts", used: usage.contacts, limit: Number(plan.features.contacts_limit || 0) },
      { metric: "channels", signalType: "plan_near_limit_channels", used: usage.channels, limit: Number(plan.features.channels_limit || 0) },
      { metric: "users", signalType: "plan_near_limit_users", used: usage.users, limit: Number(plan.features.users_limit || 0) },
    ];

    for (const m of metrics) {
      // limit=0 = ilimitado (Enterprise) — nunca dispara. limit=null/undefined idem.
      if (!m.limit || m.limit <= 0) continue;
      const pct = (m.used / m.limit) * 100;
      const severity = severityFor(pct);
      if (!severity) continue;

      const upgrade = findUpgradeForLimit(plan.id, m.metric, m.limit);
      candidates.push({
        signalType: m.signalType,
        severity,
        metric: m.metric,
        used: m.used,
        limit: m.limit,
        pct,
        planId: plan.id,
        targetPlanId: upgrade?.planId || null,
        evidence: {
          metric: m.metric,
          used: m.used,
          limit: m.limit,
          pctInt: Math.round(pct),
          currentPlan: plan.id,
          upgradeTargetPlan: upgrade?.planId || null,
          upgradeTargetLimit: upgrade?.limit ?? null,
        },
        // Mensal — dono aceita ou rejeita 1 vez por mês por métrica.
        // F7.3 vai adicionar frequency control com 30d rolling.
        dedupeKey: `plan:near_limit:${m.metric}:${ym}`,
      });
    }

    return candidates;
  }
}
