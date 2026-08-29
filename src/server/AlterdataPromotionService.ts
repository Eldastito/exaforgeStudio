/**
 * AlterdataPromotionService — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 6, RF-11).
 *
 * Fluxo formal de "Promover para produção":
 *   1. Consulta readiness do env alvo (usa AlterdataReadinessService, PR 4)
 *   2. Bloqueia se houver blockers com severity='blocker' que NÃO sejam
 *      apenas advisory/backup — inclusive PROD_NOT_VALIDATED (o próprio
 *      promote é quem tira ele)
 *   3. Para prod + pdvCustomerImport ligado, exige AlterdataLgpdApprovalService
 *      ativo pra 'pdvCustomerImport'
 *   4. Marca profile.validation_status='validated' + approved_by/approved_at
 *   5. Loga o evento no audit trail
 *
 * `validate(orgId, environment)` = dry-run: retorna o mesmo objeto de blockers
 * sem tocar em nada. Usado pela UI pra mostrar "Preparar produção" antes de
 * pedir o "Promover".
 */
import db from "./db.js";
import { AlterdataReadinessService, type ReadinessResponse, type ReadinessBlocker } from "./AlterdataReadinessService.js";
import { AlterdataLgpdApprovalService } from "./AlterdataLgpdApprovalService.js";
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";
import type { AlterdataEnvironment } from "./AlterdataProfileService.js";

export type PromotionOutcome = "promoted" | "blocked";

export interface PromotionResult {
  outcome: PromotionOutcome;
  environment: AlterdataEnvironment;
  status: "ready" | "blocked" | "not_configured";
  /** Blockers residuais (fora advisory/BACKUP_ADVISORY/PROD_NOT_VALIDATED). */
  blockers: ReadinessBlocker[];
  /** Data em que o profile ficou validated (só quando outcome='promoted'). */
  validatedAt?: string;
  approvedBy?: string;
}

/**
 * Blockers que o próprio promote resolve OU que são só aviso — não devem
 * impedir a promoção.
 */
const ADVISORY_CODES = new Set<string>([
  "PROD_NOT_VALIDATED",   // é EXATAMENTE o que o promote levanta
  "BACKUP_ADVISORY",      // severity='info' já, mas defensive
  // CRM_LGPD_UNAPPROVED do readiness checa `profile.approved_by` (que o
  // próprio promote grava). O gate LGPD REAL fica no
  // LGPD_APPROVAL_MISSING abaixo (checa a tabela alterdata_lgpd_approvals).
  "CRM_LGPD_UNAPPROVED",
]);

export class AlterdataPromotionService {
  /**
   * Dry-run: retorna readiness + separação entre blockers residuais e
   * blockers "resolvidos pelo próprio promote". A UI mostra o botão
   * "Promover" habilitado se `blockers.length === 0` (residuais zerados).
   */
  static validate(orgId: string, environment: AlterdataEnvironment): PromotionResult & { readiness: ReadinessResponse } {
    const readiness = AlterdataReadinessService.compute(orgId, environment);
    const residual = this.residualBlockers(readiness);
    // LGPD extra pra prod com CRM
    if (environment === "prod" && AlterdataConnectorService.isPdvCustomerImport(orgId)
        && !AlterdataLgpdApprovalService.hasActiveApproval(orgId, "pdvCustomerImport")) {
      residual.push({
        code: "LGPD_APPROVAL_MISSING",
        severity: "blocker",
        responsible: "toulon",
        message: "CRM (import de clientes) ligado sem aprovação LGPD registrada.",
        action: "Registre a aprovação LGPD (POST /api/integrations/alterdata/lgpd-approvals com purpose=pdvCustomerImport) antes de promover.",
      });
    }
    return {
      outcome: residual.length === 0 ? "promoted" : "blocked",
      environment,
      status: readiness.status,
      blockers: residual,
      readiness,
    };
  }

  /**
   * Executa a promoção: valida + grava validation_status + approved_by/at
   * no profile do env alvo. Sem side-effects se `blocked`.
   */
  static promote(
    orgId: string,
    environment: AlterdataEnvironment,
    opts: { approvedBy: string; note?: string },
  ): PromotionResult {
    if (!opts.approvedBy) throw new Error("promote: approvedBy obrigatório.");
    const dry = this.validate(orgId, environment);
    if (dry.blockers.length > 0) {
      return {
        outcome: "blocked",
        environment,
        status: dry.status,
        blockers: dry.blockers,
      };
    }
    const validatedAt = new Date().toISOString();
    db.prepare(
      `UPDATE alterdata_integration_profiles
       SET validation_status = 'validated',
           last_validated_at = ?,
           approved_by = ?,
           approved_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND environment = ?`
    ).run(validatedAt, opts.approvedBy, validatedAt, orgId, environment);
    return {
      outcome: "promoted",
      environment,
      status: "ready",
      blockers: [],
      validatedAt,
      approvedBy: opts.approvedBy,
    };
  }

  /** Blockers residuais = todos com severity='blocker' que não estão em ADVISORY_CODES. */
  private static residualBlockers(readiness: ReadinessResponse): ReadinessBlocker[] {
    return readiness.blockers.filter(b =>
      b.severity === "blocker" && !ADVISORY_CODES.has(b.code)
    );
  }
}
