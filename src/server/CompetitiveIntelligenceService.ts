/**
 * CompetitiveIntelligenceService (PRD 10 / ADR-167 F5) — orquestração FINA da coleta
 * de inteligência competitiva. NÃO tem pipeline próprio (§42/D5): delega ao
 * `VerticalIntelligenceService.runResearch` com o provider `competitive` (registrado no
 * mesmo registry do PRD 9), herdando orçamento de plataforma, anonimização
 * (`sanitizeForShared`/`assertNoTenantData`), curadoria de procedência e persistência no
 * compartilhado `vertical_intelligence`. SÓ admin master (a rota impõe `requireMasterAdmin`).
 *
 * O `topic` é emoldurado como competitivo, mas a QUERY continua derivada SÓ de
 * (vertical, topic, region, timeframe) — nunca dado de tenant (RN-EI-2). Sem fonte
 * pública configurada, o provider degrada pra `model_knowledge` honesto (RN-EI-6/RN-SI-11);
 * o resultado carrega `evidenceMode` pra decisão ponderar síntese × fonte viva.
 */
import { VerticalIntelligenceService } from "./VerticalIntelligenceService.js";
import { CompetitiveIntelligenceProvider } from "./CompetitiveIntelligenceProvider.js";

export class CompetitiveIntelligenceService {
  /** Há fonte PÚBLICA de concorrência configurada? (senão o provider degrada honesto). */
  static isConfigured(): boolean {
    return CompetitiveIntelligenceProvider.isConfigured();
  }

  /**
   * Coleta inteligência competitiva pro nicho e grava no compartilhado (via runResearch).
   * `topic` default "concorrência". Retorna o registro de `vertical_intelligence`
   * (já anonimizado/curado) — com a procedência (evidenceMode) embutida no conteúdo.
   */
  static async gather(
    actor: { userId?: string | null; organizationId?: string | null } | null,
    input: { vertical: string; topic?: string; region?: string; timeframe?: string; ttlDays?: number },
  ): Promise<any> {
    const vertical = String(input?.vertical || "").trim();
    if (!vertical) throw new Error("vertical é obrigatório.");
    const topic = String(input?.topic || "concorrência").trim() || "concorrência";
    return VerticalIntelligenceService.runResearch(
      actor,
      { vertical, topic, region: input.region, timeframe: input.timeframe, ttlDays: input.ttlDays },
      { providerName: "competitive" },
    );
  }
}

export default CompetitiveIntelligenceService;
