/**
 * SimplesHybridAdvisorService — ADR-181 F5: advisor DAS × regime regular (Simples híbrido).
 *
 * A LC 214/2025 criou, pra empresa do Simples, a decisão inédita de recolher CBS/IBS DENTRO do
 * DAS (simples, sem crédito) ou migrar pro REGIME REGULAR/híbrido (recolhe por fora, aí gera e
 * aproveita crédito — art. 47 §9). Este service AJUDA o dono a entender o trade-off, mas
 * **NUNCA decide nem força** (RN-FISCAL-9): expõe fatores estruturais (fatos dos regimes),
 * reflete a escolha atual, aterra UM sinal real (tem custo de insumos creditável?) e é
 * HONESTO sobre o que o sistema NÃO sabe (o mix de clientes PJ×consumidor final, o fator
 * decisivo). A gravação da escolha é explícita (`setChoice`) e só reflete a decisão do dono.
 *
 * Guardrails RN-FISCAL:
 *  - 9 (Simples default DAS; nunca força híbrido): `advise` não recomenda um lado; `setChoice`
 *    só persiste o que o dono mandou; disclaimer cravado em toda resposta.
 *  - 4 (honesto quando falta dado): o mix de clientes não é conhecido → declarado, não chutado.
 *  - determinístico; isolado por org.
 */
import db from "./db.js";
import { FiscalProfileService, FiscalProfile } from "./FiscalProfileService.js";

const DISCLAIMER =
  "A escolha entre DAS e regime regular é uma decisão tributária que depende do seu mix de clientes (empresas × consumidor final) e dos seus custos — o ZapFlow não decide por você. Confirme com seu contador antes de optar.";

export interface HybridFactor { path: "das" | "regime_regular"; text: string }

export interface HybridAdvice {
  applicable: boolean;                        // só faz sentido pro Simples
  reason?: string;                            // 'not_simples' quando N/A
  regime: string | null;
  currentChoice: "das" | "regime_regular";
  factors: HybridFactor[];
  signals: {
    hasCreditableInputs: boolean;             // tem payables → crédito de insumo é alavanca real
    clientMixKnown: false;                    // o sistema NÃO sabe PJ×consumidor final (honesto)
  };
  disclaimer: string;
}

// Fatores ESTRUTURAIS (fatos dos regimes — não são números inventados nem recomendação).
const FACTORS: HybridFactor[] = [
  { path: "das", text: "Guia única (DAS): mais simples, menos obrigação acessória." },
  { path: "das", text: "CBS e IBS ficam embutidos no DAS — você NÃO transfere crédito a clientes empresa nem aproveita crédito das suas compras (LC 214, art. 47 §9)." },
  { path: "regime_regular", text: "Recolhe CBS e IBS por fora, com apuração própria (mais obrigação acessória)." },
  { path: "regime_regular", text: "GERA crédito de CBS/IBS pros seus clientes empresa e permite APROVEITAR crédito das suas compras — tende a compensar se você vende para empresas ou tem custo relevante de insumos." },
];

export class SimplesHybridAdvisorService {
  /** Panorama informativo. Só pro Simples (mei/presumido/real não têm essa escolha). */
  static advise(orgId: string): HybridAdvice {
    const profile = FiscalProfileService.get(orgId);
    const isSimples = profile.regime === "simples" || profile.regime === "simples_hibrido";
    if (!isSimples) {
      return {
        applicable: false, reason: "not_simples", regime: profile.regime,
        currentChoice: "das", factors: [], signals: { hasCreditableInputs: false, clientMixKnown: false },
        disclaimer: DISCLAIMER,
      };
    }
    return {
      applicable: true, regime: profile.regime,
      currentChoice: profile.regimeRegularOptin ? "regime_regular" : "das",
      factors: FACTORS,
      signals: { hasCreditableInputs: this.hasCreditableInputs(orgId), clientMixKnown: false },
      disclaimer: DISCLAIMER,
    };
  }

  /** Sinal ATERRADO: a org tem contas a pagar (custo de insumo)? Crédito de insumo é alavanca
   *  real do regime regular. Best-effort/honesto (tabela ausente/vazia → false, não inventa). */
  private static hasCreditableInputs(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT COUNT(*) n FROM payables WHERE organization_id = ?`).get(orgId) as any;
      return Number(r?.n || 0) > 0;
    } catch { return false; }
  }

  /**
   * Grava a ESCOLHA do dono (DAS × regime regular). Só Simples; delega ao FiscalProfileService
   * (fonte única do perfil). NUNCA é chamado automaticamente — reflete decisão explícita
   * (RN-FISCAL-9). Fora do Simples → erro (a escolha não existe).
   */
  static setChoice(orgId: string, optIn: boolean, actorId?: string): FiscalProfile {
    const profile = FiscalProfileService.get(orgId);
    const isSimples = profile.regime === "simples" || profile.regime === "simples_hibrido";
    if (!isSimples) throw new Error("not_simples");
    return FiscalProfileService.save(orgId, { regimeRegularOptin: !!optIn }, actorId);
  }
}

export default SimplesHybridAdvisorService;
