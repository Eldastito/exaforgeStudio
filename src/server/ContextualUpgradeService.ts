/**
 * ContextualUpgradeService — PRD 6 / ADR-163 F9 (§55-§57, D3): upgrades contextuais.
 *
 * A regra de ouro (§56/D3): **esconder fora-de-plano, nunca virar catálogo de
 * cadeados.** O usuário jamais vê uma lista de "coisas que você não tem, pague pra
 * liberar". Um upgrade só aparece quando DUAS condições se encontram:
 *   1) há uma RECOMENDAÇÃO SITUACIONAL viva (`UpgradeRecommendationService`, pending
 *      — emitida pelo PlanFitDetector a partir de um sinal real de uso/necessidade,
 *      com cooldown/dismiss já respeitados); E
 *   2) o módulo-alvo é GENUINAMENTE fora-do-plano segundo a porta única de acesso
 *      (`EntitlementService.overview` → `state:"available_to_buy"` + `visibility:"visible"`).
 *
 * A interseção é o ponto: recomendação sozinha sem entitlement coerente não vira
 * oferta; módulo comprável sem gatilho situacional NÃO aparece (é isso que impede o
 * catálogo de cadeados). É COMPOSIÇÃO pura (D1/CA17) — reusa os dois engines, não
 * cria motor/tabela/oferta paralela.
 *
 * Escopo: upgrade é decisão de gestor — role-gate (owner/admin). Hidden nunca
 * aflora (D3/RN-UX-2). Isolado por org.
 */
import db from "./db.js";
import { EntitlementService } from "./EntitlementService.js";
import { UpgradeRecommendationService } from "./UpgradeRecommendationService.js";

export interface ContextualUpgrade {
  recommendationId: string;
  moduleKey: string | null;
  planId: string | null;
  situation: string;              // signalType — a necessidade observada que disparou
  reason: string;
  impact: { amount: number | null; unit: string | null };
  upgradeTargetPlan: string | null;
  addonPrice: number | null;
  situational: true;              // sempre — nunca oferta de catálogo
}

function isManager(user: any): boolean {
  return ["owner", "admin"].includes(String(user?.role || ""));
}

export class ContextualUpgradeService {
  /**
   * Upgrades contextuais pro usuário: interseção (recomendação pending) ∩
   * (módulo `available_to_buy` + visível). Vazio quando não há gatilho — é o
   * comportamento CORRETO (§56), não uma falha.
   */
  static forUser(orgId: string, user: any): { contextualUpgradeEnabled: boolean; upgrades: ContextualUpgrade[]; generatedAt: string } {
    const row = db.prepare(`SELECT COALESCE(contextual_upgrade_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const enabled = !!(row && Number(row.e));
    // Upgrade é matéria de gestor (§57) — não-gestor não recebe oferta.
    if (!isManager(user)) return { contextualUpgradeEnabled: enabled, upgrades: [], generatedAt: new Date().toISOString() };

    const pending = UpgradeRecommendationService.list(orgId, { status: "pending", limit: 50 });
    if (!pending.length) return { contextualUpgradeEnabled: enabled, upgrades: [], generatedAt: new Date().toISOString() };

    const overview = EntitlementService.overview(orgId, user);
    const upgrades: ContextualUpgrade[] = [];
    for (const rec of pending) {
      const moduleKey = rec.targetModuleKey || null;
      let upgradeTargetPlan: string | null = null;
      let addonPrice: number | null = null;

      if (moduleKey) {
        const dec = overview[moduleKey];
        // D3: só surge se é comprável E visível. active/available_to_enable/hidden
        // NÃO viram oferta (já tem, é só ligar, ou é fora-de-nicho escondido).
        if (!dec || dec.state !== "available_to_buy" || dec.visibility !== "visible") continue;
        upgradeTargetPlan = dec.upgradeTargetPlan ?? null;
        addonPrice = dec.addonPrice ?? null;
      } else if (!rec.targetPlanId) {
        // Sem módulo E sem plano-alvo → não há o que ofertar coerentemente.
        continue;
      }

      upgrades.push({
        recommendationId: rec.id,
        moduleKey,
        planId: rec.targetPlanId || null,
        situation: rec.signalType,
        reason: this.reasonFor(rec),
        impact: { amount: rec.impactAmount ?? null, unit: rec.impactUnit ?? null },
        upgradeTargetPlan,
        addonPrice,
        situational: true,
      });
    }
    // Maior score (necessidade mais forte) primeiro.
    upgrades.sort((a, b) => (pendingScore(pending, b.recommendationId) - pendingScore(pending, a.recommendationId)));
    return { contextualUpgradeEnabled: enabled, upgrades, generatedAt: new Date().toISOString() };
  }

  /** Motivo humano a partir da evidência do sinal (nunca inventa — cai no tipo). */
  private static reasonFor(rec: any): string {
    const ev = rec.evidence || {};
    if (typeof ev.reason === "string" && ev.reason.trim()) return ev.reason.trim();
    const alvo = rec.targetModuleKey || rec.targetPlanId || "este recurso";
    return `O seu uso indicou necessidade de ${alvo} (sinal: ${rec.signalType}).`;
  }
}

function pendingScore(pending: any[], id: string): number {
  const r = pending.find((x) => x.id === id);
  return r ? Number(r.score) || 0 : 0;
}

export default ContextualUpgradeService;
