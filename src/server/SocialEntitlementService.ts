/**
 * SocialEntitlementService (PRD 10 / ADR-167 F15 — Entitlements + Billing) — o GATE de
 * PLANO das capacidades sociais, SERVER-SIDE. As capacidades de publicação/estúdio
 * pertencem ao módulo `estudio`, então este service só COMPÕE o `EntitlementService`
 * canônico (§42 — sem catálogo/plano paralelo) e o aplica NO CAMINHO real de publicação.
 *
 * RN-SI-14 (esconder botão NÃO é segurança): o gate mora no SERVIDOR — `assertAllowed`
 * é chamado ANTES de propor a publicação; um cliente que pule a UI e bata direto na API
 * é RECUSADO igual. A resposta carrega a procedência da recusa (state/reason) + o caminho
 * de billing (upgradeTargetPlan/addonPrice) pra a CTA — nunca "publica e cobra depois".
 * Isolamento (convenção #1): `orgId` 1º arg; a decisão deriva do plano/RBAC/billing da org.
 */
import { EntitlementService, type EntitlementAction, type EntitlementDecision } from "./EntitlementService.js";

const RESOURCE = "estudio";

export interface SocialEntitlementStatus {
  resource: string;
  allowed: boolean;
  state: string;
  reason: string;
  upgradeEligible: boolean;
  upgradeTargetPlan: string | null;
  addonEligible: boolean;
  addonPrice: number | null;
}

export class SocialEntitlementService {
  /** Decisão crua do `EntitlementService` pro recurso social (`estudio`). */
  static check(orgId: string, user: any, action: EntitlementAction = "execute"): EntitlementDecision {
    return EntitlementService.check(orgId, user, RESOURCE, action);
  }

  /** Status REDIGIDO pra UI/billing: allowed + caminho de upgrade (sem vazar interno). */
  static status(orgId: string, user: any): SocialEntitlementStatus {
    const d = this.check(orgId, user, "execute");
    return {
      resource: RESOURCE, allowed: d.allowed, state: d.state, reason: d.reason,
      upgradeEligible: d.upgradeEligible, upgradeTargetPlan: d.upgradeTargetPlan,
      addonEligible: d.addonEligible, addonPrice: d.addonPrice,
    };
  }

  /**
   * GATE server-side: LANÇA se o plano não cobre a capacidade. O erro carrega `code`
   * (`entitlement_denied`) + a decisão (state/upgrade) pra a rota mapear pra 402/upgrade.
   * `execute` = publicar (ação de valor); `use` = configurar/ler.
   */
  static assertAllowed(orgId: string, user: any, action: EntitlementAction = "execute"): EntitlementDecision {
    const d = this.check(orgId, user, action);
    if (!d.allowed) {
      const err: any = new Error(`Capacidade social não incluída no plano (${d.state}).`);
      err.code = "entitlement_denied";
      err.decision = { state: d.state, reason: d.reason, upgradeTargetPlan: d.upgradeTargetPlan, addonEligible: d.addonEligible, addonPrice: d.addonPrice };
      throw err;
    }
    return d;
  }
}

export default SocialEntitlementService;
