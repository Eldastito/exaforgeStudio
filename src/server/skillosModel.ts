import type { EvidenceReference } from "./contextModel.js";

/**
 * skillosModel — PRD 4 F1 (Core Contracts): os CONTRATOS puros do ZapFlow SkillOS.
 *
 * Puro (sem DB, sem LLM, sem I/O) — o mesmo padrão de `contextModel.ts` (PRD 3 F1).
 * Estabelece a linguagem do SkillOS ANTES de qualquer motor/registry/runtime, sem
 * alterar comportamento algum. Só tipos + validadores/guardas determinísticos.
 *
 * Decisões da Fase 0 já embutidas:
 *  - REUSA `EvidenceReference` (contextModel) — não inventa contrato de evidência (P6/§19).
 *  - REUSA a semântica de resposta `fact/estimate/hypothesis` do Radar/Context Engine
 *    (§20), estendendo só com `recommendation` — nunca um enum incompatível.
 *  - Campos em camelCase (idioma TS do repo). O mapeamento pra colunas snake_case
 *    prefixadas `skillos_*` (Decisão D1) entra na F2 (persistência); aqui é in-memory.
 *
 * Guardas codificadas aqui (invariantes do PRD, testáveis já na F1):
 *  - §44 tool permission: uma tool só é permitida se declarada e não proibida.
 *  - §27 retry differ.: cada classe de falha tem uma política de retry distinta.
 *  - §22/§23 model match: um modelo atende se cobre os requisitos declarados.
 *  - §21 confidence gate: a confiança ALTERA comportamento (não é só informativa).
 *  - §65 sem silêncio: o resultado sempre termina num estado observável.
 */

export const SKILLOS_CONTRACT_VERSION = 1;

// ═══════════════════════════════ Vocabulários fechados ══════════════════════════

/** Ciclo de vida de Capability/Skill (§7 status). */
export const LIFECYCLE_STATUSES = ["draft", "active", "deprecated", "disabled"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** Nível de risco — reusa a escala já usada em `business_constraints`/impacto. */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Classe de orçamento (§34) — abstrai custo sem expor R$ (§30). free = determinístico. */
export const BUDGET_CLASSES = ["free", "low", "standard", "high"] as const;
export type BudgetClass = (typeof BUDGET_CLASSES)[number];

/** Perfil de contexto exigido — reusa os perfis do Context Engine (PRD 3). */
export const CONTEXT_PROFILES = ["minimal", "standard", "deep"] as const;
export type ContextProfileName = (typeof CONTEXT_PROFILES)[number];

/** Requisitos de modelo (§23) — a Capability pede capacidades, o Router acha o modelo. */
export const MODEL_CAPABILITIES = ["reasoning", "structured_output", "vision", "tool_call", "long_context", "fast", "cheap", "high_accuracy"] as const;
export type ModelCapabilityFlag = (typeof MODEL_CAPABILITIES)[number];

/**
 * §20 — tipo semântico da resposta. ESTENDE `basis` (fact/estimate/hypothesis do
 * Radar/Context Engine) com `recommendation` — NÃO cria enum incompatível.
 */
export const RESPONSE_TYPES = ["fact", "estimate", "hypothesis", "recommendation"] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

/**
 * §65 — estados TERMINAIS de um resultado de skill. Nunca "silêncio": toda execução
 * termina em um destes. `blocked` = política barrou; `escalated` = foi pro humano.
 */
export const SKILL_RESULT_STATUSES = ["success", "fallback", "blocked", "escalated", "failed"] as const;
export type SkillResultStatus = (typeof SKILL_RESULT_STATUSES)[number];

/** Estado do choke-point de confiabilidade (§15). */
export const RELIABILITY_STATUSES = ["ok", "retried", "fallback", "blocked", "failed"] as const;
export type ReliabilityStatus = (typeof RELIABILITY_STATUSES)[number];

// ═══════════════════════════ §17 Taxonomia de falhas ════════════════════════════

/** As 6 classes de falha (AI-FAIL-1..6). Ordem = o código AI-FAIL-N. */
export const FAILURE_CLASSES = ["technical", "format", "grounding", "policy", "execution", "outcome"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Código AI-FAIL-N de uma classe (§17). */
export function failureCode(cls: FailureClass): string {
  const i = FAILURE_CLASSES.indexOf(cls);
  return i >= 0 ? `AI-FAIL-${i + 1}` : "AI-FAIL-?";
}

/** Política de retry por classe (§27 — retry diferencia tipo de falha). */
export type RetryPolicy = "backoff" | "corrective" | "fallback" | "no_retry";
const RETRY_BY_CLASS: Record<FailureClass, RetryPolicy> = {
  technical: "backoff",     // timeout/429/5xx → retry com backoff
  format: "corrective",     // JSON/schema inválido → retry corretivo
  grounding: "fallback",    // afirmação sem suporte → não repetir igual; cai pro fallback
  policy: "no_retry",       // violação de política → nunca repetir o mesmo request
  execution: "fallback",    // efeito não pôde ser executado → tenta caminho alternativo
  outcome: "no_retry",      // executou mas não deu resultado → decisão humana, não retry
};
export function retryPolicyFor(cls: FailureClass): RetryPolicy {
  return RETRY_BY_CLASS[cls] ?? "no_retry";
}

// ═══════════════════════════════ §7 Capability ══════════════════════════════════

/** Uma Capability: "algo que o ZapFlow sabe fazer", independente de implementação. */
export interface Capability {
  capabilityId: string;
  version: number;
  name: string;
  description?: string | null;
  category: string;
  riskLevel: RiskLevel;
  inputSchema?: Record<string, unknown> | null;   // JSON Schema (validação é F4)
  outputSchema?: Record<string, unknown> | null;
  requiredContext?: ContextProfileName | null;     // perfil de contexto que a capacidade exige
  supportedVerticals?: string[] | null;            // null = todas as verticais
  entitlementKey?: string | null;                  // gate de plano (EntitlementService, F2)
  defaultTimeoutMs?: number | null;
  defaultBudgetClass?: BudgetClass;
  fallbackPolicy?: string | null;
  status: LifecycleStatus;
}

// ══════════════════════════ §22/§23 Model requirements ══════════════════════════

/** O que uma Skill exige do modelo. O Model Router (F5) resolve o modelo compatível. */
export interface ModelRequirements {
  needs: ModelCapabilityFlag[];        // obrigatórias
  prefer?: ModelCapabilityFlag[];      // desejáveis (desempate)
  minContextTokens?: number | null;
  maxLatencyMsTarget?: number | null;
  riskLevel?: RiskLevel | null;
}

/**
 * Perfil de um modelo (§23) — as capacidades que ele oferece. (O catálogo real de
 * modelos é plataforma/F5; aqui é só o contrato pro matcher determinístico.)
 */
export interface ModelProfile {
  model: string;
  provider: string;
  capabilities: ModelCapabilityFlag[];
  contextTokens?: number | null;
  typicalLatencyMs?: number | null;
}

/** §22 — o modelo atende os requisitos? Determinístico (cobre `needs` + janela). */
export function modelMeets(profile: ModelProfile, req: ModelRequirements): boolean {
  const caps = new Set(profile.capabilities || []);
  if (!(req.needs || []).every((n) => caps.has(n))) return false;
  if (req.minContextTokens != null && (profile.contextTokens ?? 0) < req.minContextTokens) return false;
  return true;
}

// ═══════════════════════════════ §9 Skill Manifest ══════════════════════════════

/** Manifesto de uma Skill (implementação de uma Capability). Nada implícito (§9). */
export interface SkillManifest {
  skillId: string;
  version: number;
  capabilityId: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  riskLevel: RiskLevel;
  allowedTools: string[];
  forbiddenTools?: string[];
  requiredPermissions?: string[];         // módulos RBAC (PermissionService)
  requiredEntitlements?: string[];
  requiredContextProfile?: ContextProfileName | null;
  modelRequirements?: ModelRequirements | null;
  maxExecutionTimeMs?: number | null;
  maxAttempts?: number | null;
  budgetClass?: BudgetClass;
  supportsFallback: boolean;
  fallbackSkills?: string[];
  successCriteria?: string[];
  failureCriteria?: string[];
  supportedVerticals?: string[] | null;
  status: LifecycleStatus;
}

/**
 * §44 — a Skill pode usar `tool`? Só se declarada em `allowedTools` E não em
 * `forbiddenTools` (proibido vence). O Skill Runtime (fase posterior) rejeita tool
 * não declarada; a decisão vive aqui, determinística.
 */
export function toolAllowedBySkill(manifest: Pick<SkillManifest, "allowedTools" | "forbiddenTools">, tool: string): boolean {
  const allowed = new Set(manifest.allowedTools || []);
  const forbidden = new Set(manifest.forbiddenTools || []);
  return allowed.has(tool) && !forbidden.has(tool);
}

// ═══════════════════════════════ Skill Result ═══════════════════════════════════

/** O resultado de UMA execução de skill. Reusa `EvidenceReference` (não inventa). */
export interface SkillResult {
  skillId: string;
  capabilityId: string;
  status: SkillResultStatus;              // §65 sempre observável
  output?: unknown;
  responseType?: ResponseType | null;     // §20 fact/estimate/hypothesis/recommendation
  confidence?: number | null;             // 0..1
  evidence?: EvidenceReference[];          // proveniência das afirmações (grounding, F6)
  failureClass?: FailureClass | null;
  fallbackUsed?: boolean;
  error?: string | null;
  correlationId?: string | null;          // fio ADR-158
}

// ═══════════════════════════ §15 Reliability Result ═════════════════════════════

/** A saída do AI Reliability Kernel para UMA chamada de modelo (base do AI Run, F4). */
export interface ReliabilityResult {
  status: ReliabilityStatus;
  validationStatus: "valid" | "invalid" | "skipped";
  groundingStatus: "grounded" | "unsupported" | "skipped";
  confidence?: number | null;
  retryCount: number;
  fallbackUsed: boolean;
  failureClass?: FailureClass | null;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number | null;
}

// ═══════════════════════════ §21 Confidence gate ════════════════════════════════

/** Limiares de confiança — configuráveis por Capability/Skill/risco (§21, não globais). */
export interface ConfidenceThresholds {
  low: number;    // < low → fallback/humano
  high: number;   // ≥ high → segue
}

export type ConfidenceAction = "continue" | "seek_context" | "fallback";

/**
 * §21 — a confiança ALTERA o comportamento (não é só exibida): alta→segue,
 * média→buscar mais contexto, baixa→fallback/humano. Determinístico.
 */
export function confidenceAction(confidence: number, t: ConfidenceThresholds): ConfidenceAction {
  const c = Number.isFinite(confidence) ? confidence : 0;
  if (c >= t.high) return "continue";
  if (c < t.low) return "fallback";
  return "seek_context";
}

// ═══════════════════════════════ Validadores ════════════════════════════════════

export interface ContractValidation {
  valid: boolean;
  errors: string[];
}

const isNonEmptyStr = (v: any) => typeof v === "string" && v.trim().length > 0;
const isPosInt = (v: any) => typeof v === "number" && Number.isInteger(v) && v > 0;
const isArrOfStr = (v: any) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Valida um `Capability` contra o contrato §7. Junta TODAS as violações. */
export function validateCapability(c: unknown): ContractValidation {
  const errors: string[] = [];
  const o: any = c;
  if (o == null || typeof o !== "object") return { valid: false, errors: ["capability: não é objeto"] };
  if (!isNonEmptyStr(o.capabilityId)) errors.push("capabilityId: string não-vazia obrigatória");
  if (!isPosInt(o.version)) errors.push("version: inteiro ≥1 obrigatório");
  if (!isNonEmptyStr(o.name)) errors.push("name: obrigatório");
  if (!isNonEmptyStr(o.category)) errors.push("category: obrigatório");
  if (!RISK_LEVELS.includes(o.riskLevel)) errors.push(`riskLevel: um de ${RISK_LEVELS.join("|")}`);
  if (!LIFECYCLE_STATUSES.includes(o.status)) errors.push(`status: um de ${LIFECYCLE_STATUSES.join("|")}`);
  if (o.defaultBudgetClass != null && !BUDGET_CLASSES.includes(o.defaultBudgetClass)) errors.push(`defaultBudgetClass: um de ${BUDGET_CLASSES.join("|")}`);
  if (o.requiredContext != null && !CONTEXT_PROFILES.includes(o.requiredContext)) errors.push(`requiredContext: um de ${CONTEXT_PROFILES.join("|")}`);
  if (o.supportedVerticals != null && !isArrOfStr(o.supportedVerticals)) errors.push("supportedVerticals: array de string ou null");
  if (o.defaultTimeoutMs != null && !(typeof o.defaultTimeoutMs === "number" && o.defaultTimeoutMs > 0)) errors.push("defaultTimeoutMs: número >0 ou null");
  return { valid: errors.length === 0, errors };
}

/** Valida um `SkillManifest` contra o contrato §9 + as invariantes de segurança. */
export function validateSkillManifest(m: unknown): ContractValidation {
  const errors: string[] = [];
  const o: any = m;
  if (o == null || typeof o !== "object") return { valid: false, errors: ["skill: não é objeto"] };
  if (!isNonEmptyStr(o.skillId)) errors.push("skillId: string não-vazia obrigatória");
  if (!isPosInt(o.version)) errors.push("version: inteiro ≥1 obrigatório");
  if (!isNonEmptyStr(o.capabilityId)) errors.push("capabilityId: obrigatório (a Skill implementa uma Capability)");
  if (!RISK_LEVELS.includes(o.riskLevel)) errors.push(`riskLevel: um de ${RISK_LEVELS.join("|")}`);
  if (!LIFECYCLE_STATUSES.includes(o.status)) errors.push(`status: um de ${LIFECYCLE_STATUSES.join("|")}`);
  if (!isArrOfStr(o.allowedTools)) errors.push("allowedTools: array de string obrigatório (nada implícito, §9)");
  if (o.forbiddenTools != null && !isArrOfStr(o.forbiddenTools)) errors.push("forbiddenTools: array de string ou ausente");
  if (typeof o.supportsFallback !== "boolean") errors.push("supportsFallback: boolean obrigatório");
  // INVARIANTE §44: uma tool não pode ser permitida E proibida.
  if (isArrOfStr(o.allowedTools) && isArrOfStr(o.forbiddenTools)) {
    const forbidden = new Set(o.forbiddenTools);
    const clash = o.allowedTools.filter((t: string) => forbidden.has(t));
    if (clash.length) errors.push(`tool em allowed E forbidden: ${clash.join(", ")}`);
  }
  // INVARIANTE §25: supportsFallback ⇒ há fallbackSkills declaradas.
  if (o.supportsFallback === true && !(isArrOfStr(o.fallbackSkills) && o.fallbackSkills.length > 0)) {
    errors.push("supportsFallback=true exige fallbackSkills não-vazio");
  }
  if (o.requiredContextProfile != null && !CONTEXT_PROFILES.includes(o.requiredContextProfile)) errors.push(`requiredContextProfile: um de ${CONTEXT_PROFILES.join("|")}`);
  if (o.budgetClass != null && !BUDGET_CLASSES.includes(o.budgetClass)) errors.push(`budgetClass: um de ${BUDGET_CLASSES.join("|")}`);
  if (o.maxAttempts != null && !isPosInt(o.maxAttempts)) errors.push("maxAttempts: inteiro ≥1 ou null");
  if (o.maxExecutionTimeMs != null && !(typeof o.maxExecutionTimeMs === "number" && o.maxExecutionTimeMs > 0)) errors.push("maxExecutionTimeMs: número >0 ou null");
  return { valid: errors.length === 0, errors };
}

// ═══════════════════════ §10/§11 Capability Resolution ══════════════════════════

/** Ordem de custo computacional (menor = mais barato). free = sem modelo. */
export function budgetRank(cls: BudgetClass | null | undefined): number {
  const i = BUDGET_CLASSES.indexOf(cls as BudgetClass);
  return i >= 0 ? i : BUDGET_CLASSES.length; // desconhecido = mais caro
}

/** Ordem de risco (menor = mais seguro). */
export function riskRank(level: RiskLevel | null | undefined): number {
  const i = RISK_LEVELS.indexOf(level as RiskLevel);
  return i >= 0 ? i : RISK_LEVELS.length;
}

/**
 * §7/§11 — a Skill é DETERMINÍSTICA (não precisa de modelo probabilístico)? Sim se
 * é budget `free` OU não declara requisitos de modelo. "Determinístico antes de
 * probabilístico" (P7) é a 1ª chave de ranqueamento.
 */
export function isDeterministicSkill(m: Pick<SkillManifest, "budgetClass" | "modelRequirements">): boolean {
  if (m.budgetClass === "free") return true;
  const needs = m.modelRequirements?.needs;
  return !needs || needs.length === 0;
}

/**
 * §11 — ranqueia candidatas (cópia; puro, determinístico). Ordem de preferência:
 *   1. determinística antes de probabilística (P7);
 *   2. menor custo computacional (budget);
 *   3. menor risco;
 *   4. versão mais nova (desempate);
 *   5. skillId asc (desempate final estável).
 * NÃO escolhe "o modelo mais poderoso" (§11). Confiabilidade histórica é critério
 * FUTURO (evals, F11) — DEFERIDO; por ora o desempate é estável por versão/id.
 */
export function rankSkills(candidates: SkillManifest[]): SkillManifest[] {
  return [...candidates].sort((a, b) => {
    const det = (isDeterministicSkill(a) ? 0 : 1) - (isDeterministicSkill(b) ? 0 : 1);
    if (det !== 0) return det;
    const bud = budgetRank(a.budgetClass) - budgetRank(b.budgetClass);
    if (bud !== 0) return bud;
    const rsk = riskRank(a.riskLevel) - riskRank(b.riskLevel);
    if (rsk !== 0) return rsk;
    const ver = (b.version || 0) - (a.version || 0);  // versão desc
    if (ver !== 0) return ver;
    return String(a.skillId).localeCompare(String(b.skillId));
  });
}

/** Por que uma Capability não resolveu (nunca "silêncio", §65). */
export type UnresolvedReason = "capability_not_found" | "capability_unavailable" | "no_skill_available";

/** §10 — o resultado da resolução: a Skill escolhida + razão + alternativas + fallback. */
export interface SkillResolution {
  capabilityId: string;
  resolved: boolean;
  skill: SkillManifest | null;         // a escolhida (null se não resolveu)
  reason: string;                      // por que esta (ou por que nenhuma)
  alternatives: SkillManifest[];       // demais candidatas ranqueadas
  fallbackChain: string[];             // skillIds declarados como fallback da escolhida (§25)
  unresolvedReason?: UnresolvedReason | null;
}

// ═══════════════════════ §22/§26 Model Router + Circuit Breaker ═════════════════

/** §26 — estado do provider/modelo no circuit breaker. */
export const PROVIDER_HEALTH_STATES = ["healthy", "watch", "degraded", "open", "half_open"] as const;
export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

/** True se o estado permite ROTEAR pra este modelo (open = barrado; half_open = probe). */
export function isRoutable(state: ProviderHealthState): boolean {
  return state !== "open";
}

/** Candidato de modelo já anotado com sua saúde — o que o ranker consome. */
export interface ModelCandidate {
  profile: ModelProfile;
  budgetClass?: BudgetClass | null;
  health: ProviderHealthState;
}

/**
 * §22/§11 — ranqueia modelos candidatos (cópia; puro, determinístico). Ordem:
 *   1. mais saudável primeiro (healthy < half_open);
 *   2. menor custo (budget);
 *   3. menor latência típica;
 *   4. nome do modelo (desempate estável).
 * NÃO prefere "o mais poderoso" (§11). `open` deve ser filtrado ANTES (não roteável).
 */
export function rankModelCandidates(candidates: ModelCandidate[]): ModelCandidate[] {
  const healthRank = (s: ProviderHealthState) => (s === "healthy" ? 0 : s === "watch" ? 1 : s === "degraded" ? 2 : s === "half_open" ? 3 : 4);
  return [...candidates].sort((a, b) => {
    const h = healthRank(a.health) - healthRank(b.health);
    if (h !== 0) return h;
    const bud = budgetRank(a.budgetClass) - budgetRank(b.budgetClass);
    if (bud !== 0) return bud;
    const lat = (a.profile.typicalLatencyMs ?? Infinity) - (b.profile.typicalLatencyMs ?? Infinity);
    if (lat !== 0) return lat;
    return String(a.profile.model).localeCompare(String(b.profile.model));
  });
}

/** Por que o Router não encontrou modelo (nunca "silêncio", §65). */
export type NoModelReason = "no_model_meets_requirements" | "all_candidates_open";

/** §22 — o resultado do roteamento: o modelo escolhido + razão + alternativas. */
export interface ModelRoute {
  routed: boolean;
  model: string | null;
  provider: string | null;
  health: ProviderHealthState | null;
  reason: string;
  alternatives: Array<{ model: string; provider: string; health: ProviderHealthState }>;
  noModelReason?: NoModelReason | null;
}

/**
 * §24 — contrato de um Provider de IA (abstração comum). Os adaptadores concretos
 * (OpenAI/Google/Anthropic em volta de `llm.ts`) entram na fatia de execução; aqui
 * fica o CONTRATO pra o Router/Kernel programarem contra a interface, não o SDK.
 */
export interface AIProviderContract {
  name: string;
  supports(req: ModelRequirements, profile: ModelProfile): boolean;
  estimateUsage?(inputTokens: number, outputTokens: number, model: string): { costUsd?: number } | null;
  health?(): ProviderHealthState;
  invoke?(args: unknown): Promise<unknown>;
}
