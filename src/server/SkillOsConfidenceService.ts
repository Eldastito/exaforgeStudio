import {
  ConfidenceAssessment,
  ConfidenceThresholds,
  GroundingStatus,
  assessConfidence,
} from "./skillosModel.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";

/**
 * SkillOsConfidenceService — PRD 4 F6 (§21): o CONFIDENCE ENGINE.
 *
 * A confiança NÃO é só informativa — ELA ALTERA COMPORTAMENTO (§21): alta→segue,
 * média→buscar mais contexto, baixa→fallback/humano. COMPÕE (não recalcula) sobre
 * as primitivas existentes: `confidenceBand` (§27) e os fatores já emitidos por
 * `ImpactPrioritizationService.scoreSignal` (o componente `confidence`). O grounding
 * (F6) entra no cálculo: afirmação sem suporte derruba a confiança → ação fallback.
 *
 * GUARDRAILS (testados):
 *   - RN-CONF-1 ALTERA COMPORTAMENTO (§21): devolve uma AÇÃO, não só um número.
 *   - RN-CONF-2 GROUNDING PESA: `unsupported` → confiança abaixo do piso → fallback.
 *   - RN-CONF-3 COMPÕE: reusa scoreSignal/confidenceBand — não recalcula fatores.
 *   - RN-CONF-4 THRESHOLDS NÃO-GLOBAIS: limiares configuráveis por chamada (§21).
 */
export class SkillOsConfidenceService {
  /** Avalia um score cru (+grounding) → {score, band, action}. */
  static assess(score: number, opts: { thresholds?: ConfidenceThresholds; grounding?: GroundingStatus } = {}): ConfidenceAssessment {
    return assessConfidence(score, opts);
  }

  /**
   * Confiança DERIVADA de um sinal do Radar: reusa o fator `confidence` de
   * `ImpactPrioritizationService.scoreOne` (não recalcula). Sinal inexistente/
   * fechado → null (não inventa). Isolado por org.
   */
  static fromSignal(orgId: string, signalId: string, opts: { thresholds?: ConfidenceThresholds; grounding?: GroundingStatus } = {}): ConfidenceAssessment | null {
    const scored = ImpactPrioritizationService.scoreOne(orgId, signalId);
    if (!scored) return null;
    const c = Number(scored.confidence ?? scored.components?.confidence);
    if (!Number.isFinite(c)) return null;
    return this.assess(c, opts);
  }
}

export default SkillOsConfidenceService;
