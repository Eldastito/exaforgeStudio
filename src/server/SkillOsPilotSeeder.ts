import db from "./db.js";
import { SkillOsRegistryService } from "./SkillOsRegistryService.js";
import { SkillOsEvalService } from "./SkillOsEvalService.js";
import { SkillOsRolloutService } from "./SkillOsRolloutService.js";
import { Capability, SkillManifest, rolloutStageRank, ROLLOUT_STAGES, RolloutStage } from "./skillosModel.js";

/**
 * SkillOsPilotSeeder — onboarding dos 3 pilotos §61 no SkillOS. Registra Capability +
 * Skill + casos de eval (golden) e semeia o estágio INICIAL `shadow` (início da esteira
 * §68 — SEM efeito). Idempotente (mesmo padrão do `BlueprintSeeder`): upserts por id,
 * roda 2× sem duplicar. Seed OPERACIONAL, não crítico (se falhar, admin roda pela
 * rota) — o boot nunca quebra por causa dele.
 *
 * DUAS responsabilidades, deliberadamente separadas:
 *   - `seedPilots()` — ONBOARDING (definições + estágio inicial `shadow`). Roda a cada
 *     boot; o estágio inicial é semeado só na 1ª vez e NUNCA sobrescreve o operador
 *     depois (RN-RO-5). Onboarding ≠ promoção.
 *   - `promotePilotsToPilot()` — PROMOÇÃO §68 (`shadow` → `pilot` @10%). Decisão humana
 *     do operador, aplicada UMA vez (marker), sem brigar com rollback (§69). O sistema
 *     nunca auto-eleva por conta própria (RN-014) — só aplica a decisão tomada.
 *   - `raisePilotsCanary()` — SUBIR O CANÁRIO §68 (ex.: 10% → 25%). Não mexe no estágio,
 *     só amplia o cohort (hash estável: subir só ADICIONA orgs). One-time por-percentual
 *     (marker), só sobe, preserva quem o operador já ajustou. Mesma família da promoção.
 *   - `advancePilotsToStage()` — AVANÇAR O ESTÁGIO §68 (ex.: `pilot` → `approved_execution`).
 *     Sobe o teto de `execution_mode` (ADR-159). One-time por-estágio (marker), só avança
 *     (nunca rebaixa), preserva canário e quem o operador já subiu. `autonomous` nunca.
 *
 * PRINCÍPIO (PRD §3): NÃO reimplementa comportamento. Cada Capability APONTA (via
 * `description`) pro serviço real que já existe; a Skill é só o manifesto/metadado. Os
 * 3 pilotos são primitivas de leitura/análise/rascunho — NENHUM tem `commandType`
 * próprio no CommandExecutor (não executam efeito). Por isso `shadow` é 100% inerte.
 *
 * Serviços reais por trás (a Skill não os substitui):
 *   - collection.intent_classify → `CollectionIntentClassifier.classify` (intent ∈ enum,
 *     fallback determinístico pra `unknown`). Classifica, nunca age.
 *   - sales.recovery_message → `SalesRecoveryMessageGenerator.generate` (texto ≤200,
 *     `source: llm|template`, fallback pra template). Rascunho; o envio é governado a
 *     jusante (playbook `sales_recovery_v1` → choke-point).
 *   - signal.investigate → `SignalInvestigationService.investigate` (DETERMINÍSTICO,
 *     `aiUsed:false`, causas com `basis: hypothesis`). Análise read-only.
 *
 * Os casos de eval usam `recordedOutput` (golden) que reflete o CONTRATO real de saída
 * de cada serviço — travam enum/shape/fallback/determinismo. Rodam na CI sem chave (P7);
 * um eval "ao vivo" (opt-in) troca o golden pelo `invoke` real e reusa os mesmos scorers.
 */

const PILOT_SKILL_IDS = ["collection-intent-classifier-v1", "sales-recovery-message-v1", "signal-investigation-v1"] as const;

function cap(c: Partial<Capability> & Pick<Capability, "capabilityId" | "name" | "category" | "riskLevel">): Capability {
  return {
    version: 1, description: null, inputSchema: null, outputSchema: null, requiredContext: null,
    supportedVerticals: null, entitlementKey: null, defaultTimeoutMs: null, defaultBudgetClass: undefined,
    fallbackPolicy: null, status: "active", ...c,
  } as Capability;
}
function skill(m: Partial<SkillManifest> & Pick<SkillManifest, "skillId" | "capabilityId" | "riskLevel" | "supportsFallback">): SkillManifest {
  return {
    version: 1, description: null, inputSchema: null, outputSchema: null, allowedTools: [], forbiddenTools: [],
    requiredPermissions: [], requiredEntitlements: [], requiredContextProfile: null, modelRequirements: null,
    maxExecutionTimeMs: null, maxAttempts: null, budgetClass: undefined, fallbackSkills: [], successCriteria: [],
    failureCriteria: [], supportedVerticals: null, status: "active", ...m,
  } as SkillManifest;
}

export class SkillOsPilotSeeder {
  static readonly PILOT_SKILL_IDS = PILOT_SKILL_IDS;

  /** Onboarding idempotente dos 3 pilotos. Retorna o resumo do que ficou no catálogo. */
  static seedPilots(): { capabilities: number; skills: number; evalCases: number; stages: Record<string, string> } {
    // ─────────── Piloto 1 — Collection Intent Classifier ───────────
    SkillOsRegistryService.registerCapability(cap({
      capabilityId: "collection.intent_classify",
      name: "Classificar intenção de cobrança",
      description: "Classifica a intenção da resposta do devedor. Serviço real: CollectionIntentClassifier.classify (nunca age; fallback determinístico p/ 'unknown').",
      category: "collection", riskLevel: "low", requiredContext: "minimal",
    }));
    SkillOsRegistryService.registerSkill(skill({
      skillId: "collection-intent-classifier-v1", capabilityId: "collection.intent_classify", riskLevel: "low",
      description: "Aponta p/ CollectionIntentClassifier.classify — intent ∈ {promise,resend_pix,claims_paid,dispute,installment,partial,escalate_human,churn,hardship,callback_later,unknown}. Degrada p/ 'unknown' (modo interno, NÃO é fallback de skill).",
      requiredContextProfile: "minimal", supportsFallback: false,
      modelRequirements: { needs: ["structured_output"] },
      successCriteria: ["intent dentro do enum", "confidence 0..1", "degrada p/ 'unknown' quando incerto"],
      failureCriteria: ["intent fora do enum", "saída não-JSON"],
    }));
    SkillOsEvalService.registerCase({ caseId: "pilot-collection-promise", skillId: "collection-intent-classifier-v1", name: "promessa de pagamento → promise", scorer: "field_equals", fieldPath: "intent", expected: "promise", input: { text: "pode deixar que amanhã eu pago" }, recordedOutput: { intent: "promise", confidence: 0.9, rationale: "cliente prometeu pagamento", promiseDate: "2026-08-12" } });
    SkillOsEvalService.registerCase({ caseId: "pilot-collection-claims-paid", skillId: "collection-intent-classifier-v1", name: "afirma já ter pago → claims_paid", scorer: "field_equals", fieldPath: "intent", expected: "claims_paid", input: { text: "já paguei esse boleto ontem" }, recordedOutput: { intent: "claims_paid", confidence: 0.9, rationale: "cliente afirma já ter pago" } });
    SkillOsEvalService.registerCase({ caseId: "pilot-collection-fallback", skillId: "collection-intent-classifier-v1", name: "vazio → fallback unknown (contrato)", scorer: "field_equals", fieldPath: "intent", expected: "unknown", input: { text: "" }, recordedOutput: { intent: "unknown", confidence: 0, rationale: "sem texto" } });

    // ─────────── Piloto 2 — Sales Recovery Message ───────────
    SkillOsRegistryService.registerCapability(cap({
      capabilityId: "sales.recovery_message",
      name: "Mensagem de recuperação de venda",
      description: "Rascunha mensagem de resgate de venda parada. Serviço real: SalesRecoveryMessageGenerator.generate (texto ≤200, fallback p/ template). Envio é governado a jusante (playbook sales_recovery_v1).",
      category: "sales", riskLevel: "low", requiredContext: "standard",
    }));
    SkillOsRegistryService.registerSkill(skill({
      skillId: "sales-recovery-message-v1", capabilityId: "sales.recovery_message", riskLevel: "low",
      description: "Aponta p/ SalesRecoveryMessageGenerator.generate — { text (≤200), source: llm|template }. Nunca lança; degrada p/ template (modo interno, NÃO é fallback de skill).",
      requiredContextProfile: "standard", supportsFallback: false,
      modelRequirements: { needs: [] },
      successCriteria: ["texto não-vazio ≤200", "source ∈ {llm,template}"],
      failureCriteria: ["texto vazio"],
    }));
    SkillOsEvalService.registerCase({ caseId: "pilot-recovery-llm", skillId: "sales-recovery-message-v1", name: "gera via LLM → source llm", scorer: "field_equals", fieldPath: "source", expected: "llm", input: { stage: "proposta", daysStalled: 5, attemptNumber: 1 }, recordedOutput: { text: "Oi! Sua proposta ainda tá de pé — quer que eu segure a condição por mais 2 dias?", source: "llm" } });
    SkillOsEvalService.registerCase({ caseId: "pilot-recovery-template", skillId: "sales-recovery-message-v1", name: "fallback → source template (contrato)", scorer: "field_equals", fieldPath: "source", expected: "template", input: { stage: "lead_frio", daysStalled: 20, attemptNumber: 3 }, recordedOutput: { text: "Oi! Ainda dá tempo de aproveitar. Posso te ajudar?", source: "template" } });
    SkillOsEvalService.registerCase({ caseId: "pilot-recovery-shape", skillId: "sales-recovery-message-v1", name: "saída tem source (shape)", scorer: "json_subset", expected: { source: "llm" }, input: { stage: "proposta", daysStalled: 3, attemptNumber: 1 }, recordedOutput: { text: "Consegui uma condição melhor pra hoje — quer ver?", source: "llm" } });

    // ─────────── Piloto 3 — Signal Investigation (determinístico) ───────────
    SkillOsRegistryService.registerCapability(cap({
      capabilityId: "signal.investigate",
      name: "Investigar sinal (causa provável)",
      description: "Levanta causas-candidatas de um business_signal. Serviço real: SignalInvestigationService.investigate — DETERMINÍSTICO (aiUsed:false), causas com basis:hypothesis. Read-only.",
      category: "radar", riskLevel: "low", requiredContext: "standard",
    }));
    SkillOsRegistryService.registerSkill(skill({
      skillId: "signal-investigation-v1", capabilityId: "signal.investigate", riskLevel: "low",
      description: "Aponta p/ SignalInvestigationService.investigate — determinístico, aiUsed:false, candidateCauses[].basis='hypothesis'. Nunca afirma causa como fato.",
      requiredContextProfile: "standard", supportsFallback: false,
      modelRequirements: null,   // determinístico — não exige modelo
      successCriteria: ["aiUsed=false (determinístico)", "candidateCauses ordenadas por confiança", "basis=hypothesis"],
      failureCriteria: ["afirmar causa como fact"],
    }));
    SkillOsEvalService.registerCase({ caseId: "pilot-investigate-deterministic", skillId: "signal-investigation-v1", name: "nunca usa IA (aiUsed=false)", scorer: "field_equals", fieldPath: "aiUsed", expected: false, input: { signalId: "sig-1" }, recordedOutput: { signalId: "sig-1", found: true, aiUsed: false, headline: "a causa mais provável é queda de estoque", candidateCauses: [{ cause: "queda de estoque", confidence: 0.6, basis: "hypothesis", supportingEvidence: [], contradictingEvidence: [] }], contextSignalCount: 3, note: null, investigatedAt: "2026-08-11T00:00:00Z" } });
    SkillOsEvalService.registerCase({ caseId: "pilot-investigate-hypothesis", skillId: "signal-investigation-v1", name: "causa é hipótese (nunca fact)", scorer: "json_subset", expected: { found: true, aiUsed: false, candidateCauses: [{ basis: "hypothesis" }] }, input: { signalId: "sig-1" }, recordedOutput: { signalId: "sig-1", found: true, aiUsed: false, headline: "a causa mais provável é queda de estoque", candidateCauses: [{ cause: "queda de estoque", confidence: 0.6, basis: "hypothesis", supportingEvidence: [], contradictingEvidence: [] }], contextSignalCount: 3, note: null, investigatedAt: "2026-08-11T00:00:00Z" } });
    SkillOsEvalService.registerCase({ caseId: "pilot-investigate-not-found", skillId: "signal-investigation-v1", name: "sinal ausente → found=false", scorer: "field_equals", fieldPath: "found", expected: false, input: { signalId: "sig-missing" }, recordedOutput: { signalId: "sig-missing", found: false, aiUsed: false, headline: "sem sinais suficientes p/ investigar", candidateCauses: [], contextSignalCount: 0, note: "sinal não encontrado", investigatedAt: "2026-08-11T00:00:00Z" } });

    // ─────────── Estágio INICIAL: shadow (SEM efeito) — só na 1ª vez ───────────
    // RN-RO-5 (NÃO CLOBBERAR O OPERADOR): o seed roda a cada boot, mas o estágio é
    // ESTADO OPERACIONAL — quem manda nele depois do onboarding é o operador (rota
    // `/rollout` §68/§69). Semeamos `shadow` UMA vez (quando ainda não há linha de
    // rollout); em boots seguintes preservamos o que o operador deixou (promoção OU
    // rollback). Antes desta regra o seed forçava `shadow` todo boot, revertendo
    // qualquer promoção — bug que tornava a esteira não-durável.
    const stages: Record<string, string> = {};
    for (const skillId of PILOT_SKILL_IDS) {
      if (!SkillOsRolloutService.has(skillId)) SkillOsRolloutService.setStage(skillId, "shadow");
      stages[skillId] = SkillOsRolloutService.get(skillId).stage;
    }

    const evalCases = PILOT_SKILL_IDS.reduce((n, id) => n + SkillOsEvalService.listCases(id).length, 0);
    return { capabilities: 3, skills: 3, evalCases, stages };
  }

  // Marker de plataforma: a promoção §68 é uma DECISÃO do operador aplicada UMA vez.
  // O marker garante que ela não re-dispare a cada boot — em especial, não re-promove
  // uma skill que o operador rebaixou depois (rollback §69 fica de pé).
  private static readonly PROMO_MARKER = "pilots_pilot10_v1";
  private static markerApplied(marker: string): boolean {
    return !!db.prepare(`SELECT marker FROM skillos_platform_markers WHERE marker = ?`).get(marker);
  }
  private static setMarker(marker: string): void {
    db.prepare(`INSERT OR IGNORE INTO skillos_platform_markers (marker) VALUES (?)`).run(marker);
  }

  /**
   * PROMOÇÃO §68 dos 3 pilotos: `shadow` → `pilot` @ `percent`% (execution_mode
   * `assisted`, cohort de canário). É a DECISÃO HUMANA do operador de subir a esteira
   * (RN-014: o SISTEMA nunca auto-eleva por conta própria — aqui ele só APLICA, uma
   * única vez e de forma auditável, a decisão que o operador tomou).
   *
   * Segurança (idempotente + não briga com o operador):
   *   - one-time via `PROMO_MARKER`: aplicada, nunca re-dispara (rollback fica de pé).
   *   - só AVANÇA de `shadow`/`development` (rank ≤ shadow); skill que o operador já
   *     subiu além de `pilot` é preservada (nunca rebaixa, nunca mexe no canário dela).
   *   - só toca o canário das skills que ESTE passo promoveu.
   *
   * Reversível pela esteira normal (`/rollout/:id/rollback`, `setStage`, `kill`).
   */
  static promotePilotsToPilot(percent = 10): { promoted: string[]; skipped: string[]; alreadyApplied: boolean; percent: number } {
    if (this.markerApplied(this.PROMO_MARKER)) {
      return { promoted: [], skipped: [...PILOT_SKILL_IDS], alreadyApplied: true, percent };
    }
    const promoted: string[] = [];
    const skipped: string[] = [];
    for (const skillId of PILOT_SKILL_IDS) {
      const cur = SkillOsRolloutService.get(skillId);
      if (rolloutStageRank(cur.stage) <= rolloutStageRank("shadow")) {
        SkillOsRolloutService.setStage(skillId, "pilot");
        SkillOsRolloutService.setCanaryPercent(skillId, percent);
        promoted.push(skillId);
      } else {
        skipped.push(skillId); // operador já subiu além de shadow — preserva
      }
    }
    this.setMarker(this.PROMO_MARKER);
    return { promoted, skipped, alreadyApplied: false, percent };
  }

  /**
   * SUBIR O CANÁRIO §68 dos 3 pilotos pra `percent`% (ex.: 10% → 25%). NÃO mexe no
   * estágio — só amplia o cohort. Subir o percentual só ADICIONA orgs (hash estável
   * `hashPercent`): quem já estava dentro do balde de 10% continua dentro no de 25%.
   *
   * Mesmas salvaguardas da promoção (idempotente + não briga com o operador):
   *   - one-time POR-percentual via marker `pilots_canary_<percent>_v1`: aplicada,
   *     nunca re-dispara (ajuste/rollback do operador fica de pé).
   *   - só mexe em skill JÁ cohort-gated (stage ≥ `pilot`); pra skill em `shadow`/
   *     `development` o percentual nem se aplica, então é preservada intacta.
   *   - só SOBE (nunca abaixa): skill cujo canário o operador já pôs ≥ `percent` é
   *     preservada (não estreita o cohort de ninguém).
   */
  static raisePilotsCanary(percent = 25): { raised: string[]; skipped: string[]; alreadyApplied: boolean; percent: number } {
    const p = Math.max(0, Math.min(100, Math.floor(percent)));
    const marker = `pilots_canary_${p}_v1`;
    if (this.markerApplied(marker)) {
      return { raised: [], skipped: [...PILOT_SKILL_IDS], alreadyApplied: true, percent: p };
    }
    const raised: string[] = [];
    const skipped: string[] = [];
    for (const skillId of PILOT_SKILL_IDS) {
      const cur = SkillOsRolloutService.get(skillId);
      if (rolloutStageRank(cur.stage) >= rolloutStageRank("pilot") && cur.canaryPercent < p) {
        SkillOsRolloutService.setCanaryPercent(skillId, p);
        raised.push(skillId);
      } else {
        skipped.push(skillId); // shadow (percentual não se aplica) ou já ≥ p — preserva
      }
    }
    this.setMarker(marker);
    return { raised, skipped, alreadyApplied: false, percent: p };
  }

  /**
   * AVANÇAR O ESTÁGIO §68 dos 3 pilotos pra `stage` (ex.: `pilot` → `approved_execution`).
   * Diferente do canário, isto sobe o TETO de `execution_mode` (ADR-159): em
   * `approved_execution` o efeito só ocorre após aprovação no choke-point. Nos pilotos §61
   * segue inerte na prática (nenhum tem `commandType` próprio) — mas o teto é real.
   * `autonomous` NUNCA é semeado por rollout (RN-014/LGPD): o maior estágio é `broader`,
   * que ainda mapeia pra `approved_execution` (humano no laço).
   *
   * Mesmas salvaguardas da família (idempotente + não briga com o operador):
   *   - one-time POR-estágio via marker `pilots_stage_<stage>_v1`.
   *   - só AVANÇA (rank do atual < rank do alvo): skill que o operador já pôs em/além
   *     do alvo é preservada — nunca rebaixa. Canário é preservado (não é tocado aqui).
   */
  static advancePilotsToStage(stage: RolloutStage): { advanced: string[]; skipped: string[]; alreadyApplied: boolean; stage: RolloutStage } {
    if (!ROLLOUT_STAGES.includes(stage)) throw new Error(`estágio inválido: ${stage}`);
    const marker = `pilots_stage_${stage}_v1`;
    if (this.markerApplied(marker)) {
      return { advanced: [], skipped: [...PILOT_SKILL_IDS], alreadyApplied: true, stage };
    }
    const target = rolloutStageRank(stage);
    const advanced: string[] = [];
    const skipped: string[] = [];
    for (const skillId of PILOT_SKILL_IDS) {
      const cur = SkillOsRolloutService.get(skillId);
      if (rolloutStageRank(cur.stage) < target) {
        SkillOsRolloutService.setStage(skillId, stage);
        advanced.push(skillId);
      } else {
        skipped.push(skillId); // já em/além do alvo — preserva (nunca rebaixa)
      }
    }
    this.setMarker(marker);
    return { advanced, skipped, alreadyApplied: false, stage };
  }
}

export default SkillOsPilotSeeder;
