/**
 * SubscriptionOrchestratorService — ADR-153 Fatia 6.1 (PRD §18/§19).
 *
 * PREVIEW de mudança de plano: cálculo de proporcionalidade + diff de módulos,
 * SEM efeito colateral. É o read-model por trás do CTA "Fazer upgrade" da aba
 * "Plano e Expansões" (F4.2), que hoje é placeholder.
 *
 * ESCOPO desta fatia = SÓ `preview` (read-only, determinístico). O `confirm`/
 * `cancel` (cobrança real no Asaas + aceite de Termos) são as Fatias 5.2/5.3,
 * BLOQUEADAS por decisões externas (Decisão #2 jurídico / Asaas homologado) —
 * não entram aqui. Preview não cobra, não aceita termos, não toca provedor.
 *
 * §19 (proporcionalidade):
 *  - UPGRADE é imediato: cobra a diferença PROPORCIONAL ao período restante e
 *    MANTÉM a data de renovação. `prorationAmount = priceDelta × dias_restantes /
 *    dias_no_período`.
 *  - DOWNGRADE entra no próximo ciclo: sem cobrança imediata (`prorationAmount=0`,
 *    `effectiveAt = fim do período`) e AVISA os módulos que serão perdidos.
 *  - Primeira assinatura ('new'): é checkout, não proporcional → `prorationAmount
 *    = null` (não inventa valor; a cobrança cheia é da F5.3).
 *
 * Honestidade (RN-004 / não inventa): sem datas de período (org sem ciclo ainda),
 * a proporção não é calculável → `prorationBasis='unknown'` + `prorationAmount=
 * null`, nunca um número inventado. Isolado por org. Read-only.
 */
import { PlanService } from "./PlanService.js";

export type ChangeDirection = "new" | "upgrade" | "downgrade" | "same";

export interface PlanRef { id: string; name: string; price: number; }

export interface PlanChangePreview {
  ok: true;
  direction: ChangeDirection;
  fromPlan: PlanRef | null;
  toPlan: PlanRef;
  priceDelta: number;
  /** Valor proporcional a cobrar AGORA (upgrade). 0 no downgrade/same; null quando não calculável ou 'new'. */
  prorationAmount: number | null;
  prorationBasis: "period" | "unknown" | "not_applicable";
  /** Quando a mudança passa a valer. ISO. Upgrade/new = agora; downgrade = fim do período (ou null se desconhecido). */
  effectiveAt: string | null;
  /** Data de renovação preservada (upgrade mantém o ciclo). null se desconhecida. */
  renewalAt: string | null;
  modulesGained: string[];
  modulesLost: string[];
  warnings: string[];
  breakdown: {
    daysRemaining: number | null;
    daysInPeriod: number | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  };
}

export interface PlanChangePreviewError { ok: false; reason: "plan_not_found"; }

export class SubscriptionOrchestratorService {
  static preview(orgId: string, targetPlanId: string): PlanChangePreview | PlanChangePreviewError {
    const target = PlanService.listPlans().find((p) => p.id === targetPlanId);
    if (!target) return { ok: false, reason: "plan_not_found" };

    const snap = PlanService.getBillingSnapshot(orgId);
    const current = snap.plan; // Plan | null
    const fromPrice = current?.price ?? 0;
    const toPrice = target.price;
    const priceDelta = Math.round((toPrice - fromPrice) * 100) / 100;

    const direction: ChangeDirection = !current
      ? "new"
      : toPrice > fromPrice ? "upgrade"
      : toPrice < fromPrice ? "downgrade"
      : "same";

    // Diff de módulos base do plano (add-ons são camada à parte — ADR-091 §5).
    const fromModules: string[] = (current?.features?.modules as string[]) ?? [];
    const toModules: string[] = (target.features?.modules as string[]) ?? [];
    const modulesGained = toModules.filter((m) => !fromModules.includes(m));
    const modulesLost = fromModules.filter((m) => !toModules.includes(m));

    // Janela do ciclo atual (para a proporção).
    const start = snap.currentPeriodStart ? Date.parse(snap.currentPeriodStart) : NaN;
    const end = snap.currentPeriodEnd ? Date.parse(snap.currentPeriodEnd) : NaN;
    const now = Date.now();
    const hasPeriod = Number.isFinite(start) && Number.isFinite(end) && end > start;
    const daysInPeriod = hasPeriod ? Math.round((end - start) / 86400000) : null;
    const daysRemaining = hasPeriod ? Math.max(0, Math.round((end - now) / 86400000)) : null;

    let prorationAmount: number | null;
    let prorationBasis: PlanChangePreview["prorationBasis"];
    let effectiveAt: string | null;
    let renewalAt: string | null = snap.currentPeriodEnd || null;

    if (direction === "new") {
      // Primeira assinatura = checkout cheio (F5.3), não proporcional. Não inventa valor.
      prorationAmount = null;
      prorationBasis = "not_applicable";
      effectiveAt = new Date(now).toISOString();
    } else if (direction === "same") {
      prorationAmount = 0;
      prorationBasis = "not_applicable";
      effectiveAt = new Date(now).toISOString();
    } else if (direction === "upgrade") {
      // Imediato + proporcional ao período restante; renovação mantida (§19).
      effectiveAt = new Date(now).toISOString();
      if (hasPeriod && daysInPeriod && daysInPeriod > 0) {
        prorationAmount = Math.round(priceDelta * (daysRemaining! / daysInPeriod) * 100) / 100;
        prorationBasis = "period";
      } else {
        prorationAmount = null; // sem ciclo → não calculável; NÃO inventa
        prorationBasis = "unknown";
      }
    } else {
      // downgrade: vale no próximo ciclo; sem cobrança imediata; avisa perdas.
      prorationAmount = 0;
      prorationBasis = "not_applicable";
      effectiveAt = snap.currentPeriodEnd || null; // próximo ciclo (ou desconhecido)
    }

    const warnings: string[] = [];
    if (direction === "downgrade" && modulesLost.length > 0)
      warnings.push(`O downgrade removerá o acesso a: ${modulesLost.join(", ")}. Passa a valer no próximo ciclo.`);
    if ((direction === "upgrade") && prorationBasis === "unknown")
      warnings.push("Sem ciclo de cobrança definido ainda — o valor proporcional não pôde ser calculado (será o valor cheio no checkout).");

    return {
      ok: true,
      direction,
      fromPlan: current ? { id: current.id, name: current.name, price: current.price } : null,
      toPlan: { id: target.id, name: target.name, price: target.price },
      priceDelta,
      prorationAmount,
      prorationBasis,
      effectiveAt,
      renewalAt,
      modulesGained,
      modulesLost,
      warnings,
      breakdown: {
        daysRemaining,
        daysInPeriod,
        currentPeriodStart: snap.currentPeriodStart || null,
        currentPeriodEnd: snap.currentPeriodEnd || null,
      },
    };
  }
}

export default SubscriptionOrchestratorService;
