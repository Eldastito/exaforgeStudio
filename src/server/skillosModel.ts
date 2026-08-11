import type { EvidenceReference, ConfidenceBand } from "./contextModel.js";
import { confidenceBand, clampConfidence } from "./contextModel.js";

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

// ═══════════════════════════ §19 Grounding Validator ════════════════════════════

/** §16 — status de grounding de uma execução (também é campo do AI Run, F4). */
export type GroundingStatus = "grounded" | "unsupported" | "skipped";

/** Uma afirmação da resposta + o tipo + a(s) evidência(s) que a sustentam. */
export interface GroundedClaim {
  statement: string;
  responseType: ResponseType;             // fact/estimate/hypothesis/recommendation (§20)
  evidence?: EvidenceReference[];         // referências que sustentam a afirmação
}

export interface GroundingResult {
  status: GroundingStatus;
  checkedClaims: number;                  // afirmações que EXIGIAM evidência (fact/estimate)
  groundedClaims: number;
  unsupported: string[];                  // statements sem suporte → UNSUPPORTED_CLAIM
}

/** §19 — só FATO e ESTIMATIVA precisam citar evidência; hipótese/recomendação são interpretativas. */
export const CLAIM_TYPES_REQUIRING_EVIDENCE: ResponseType[] = ["fact", "estimate"];

/** Chave canônica de uma evidência (pra casar citação × disponível). */
export function evidenceKey(e: EvidenceReference): string {
  return `${e.sourceType}|${e.sourceId ?? ""}|${e.service ?? ""}|${e.field ?? ""}`;
}

/**
 * §19 — GATE de grounding, DETERMINÍSTICO (sem NLP): toda afirmação factual/estimada
 * tem de CITAR uma evidência que EXISTA no contexto disponível. Uma citação a uma
 * evidência ausente (LLM inventando fonte) ou sem citação alguma → UNSUPPORTED_CLAIM.
 * Casa por chave completa OU por (sourceType,sourceId) — a evidência do pacote pode
 * ter `field` diferente da citada. Hipótese/recomendação são isentas (§20).
 */
export function checkGrounding(claims: GroundedClaim[], available: EvidenceReference[]): GroundingResult {
  const availKeys = new Set((available || []).map(evidenceKey));
  const availSids = new Set((available || []).map((e) => `${e.sourceType}|${e.sourceId ?? ""}`));
  let checked = 0, grounded = 0;
  const unsupported: string[] = [];
  for (const c of claims || []) {
    if (!CLAIM_TYPES_REQUIRING_EVIDENCE.includes(c.responseType)) continue;
    checked++;
    const refs = c.evidence || [];
    const ok = refs.some((r) => availKeys.has(evidenceKey(r)) || availSids.has(`${r.sourceType}|${r.sourceId ?? ""}`));
    if (ok) grounded++; else unsupported.push(c.statement);
  }
  const status: GroundingStatus = checked === 0 ? "skipped" : (unsupported.length ? "unsupported" : "grounded");
  return { status, checkedClaims: checked, groundedClaims: grounded, unsupported };
}

// ═══════════════════════════ §21 Confidence Engine ══════════════════════════════

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = { low: 0.4, high: 0.75 };

export interface ConfidenceAssessment {
  score: number;                 // 0..1
  band: ConfidenceBand;
  action: ConfidenceAction;      // continue | seek_context | fallback (§21)
  groundingStatus?: GroundingStatus;
}

/**
 * §21 — avalia a confiança e DERIVA a ação (a confiança altera comportamento). O
 * grounding ENTRA no cálculo: `unsupported` derruba a confiança abaixo do piso →
 * ação `fallback` (uma afirmação sem suporte não segue como se fosse verdade, P6).
 * Determinístico. Reusa `confidenceBand` (§27) — não cria banda incompatível.
 */
export function assessConfidence(score: number, opts: { thresholds?: ConfidenceThresholds; grounding?: GroundingStatus } = {}): ConfidenceAssessment {
  const t = opts.thresholds || DEFAULT_CONFIDENCE_THRESHOLDS;
  let s = clampConfidence(score);
  if (opts.grounding === "unsupported") s = Math.min(s, Math.max(0, t.low - 0.01)); // força abaixo do piso
  return { score: s, band: confidenceBand(s), action: confidenceAction(s, t), groundingStatus: opts.grounding };
}

// ═══════════════════════════ §12/§13 Execution Plan ═════════════════════════════

/** ready = toda capability resolveu + deps OK; blocked = falta skill ou dep inválida. */
export type PlanStatus = "ready" | "blocked";

/** Um passo do plano: uma Capability a resolver numa Skill (F3) + dependências. */
export interface ExecutionPlanStep {
  stepId: string;
  capabilityId: string;
  dependsOn: string[];                          // stepIds
  resolvedSkillId: string | null;               // via Capability Resolver (F3)
  resolution: "resolved" | "unresolved";
  reason: string;
  riskLevel: RiskLevel | null;
  requiredContextProfile: ContextProfileName | null;
}

/** §13 — o plano: passos + risco/contexto agregados + status. NÃO executa (§12). */
export interface ExecutionPlan {
  planId: string;
  correlationId: string;                        // fio ADR-158
  goal: string;
  intent: string | null;
  steps: ExecutionPlanStep[];
  riskLevel: RiskLevel;                          // máximo dos passos
  requiredContextProfile: ContextProfileName;   // o mais profundo exigido
  status: PlanStatus;
  unresolvedCapabilities: string[];             // capabilities sem skill (→ escalada §45)
  issues: string[];                             // problemas de dependência (ciclo/inexistente)
}

/** Maior risco de um conjunto (default 'low'). */
export function maxRisk(levels: Array<RiskLevel | null | undefined>): RiskLevel {
  let best: RiskLevel = "low";
  for (const l of levels) if (l && riskRank(l) > riskRank(best)) best = l;
  return best;
}

/** Perfil de contexto mais profundo de um conjunto (default 'minimal'). */
export function deepestProfile(profiles: Array<ContextProfileName | null | undefined>): ContextProfileName {
  let best: ContextProfileName = "minimal";
  for (const p of profiles) {
    if (p && CONTEXT_PROFILES.indexOf(p) > CONTEXT_PROFILES.indexOf(best)) best = p;
  }
  return best;
}

/**
 * Valida as dependências dos passos: toda `dependsOn` referencia um stepId existente
 * e não há CICLO. Retorna a lista de problemas (vazia = DAG válido). Puro.
 */
export function validatePlanDeps(steps: Array<{ stepId: string; dependsOn?: string[] }>): string[] {
  const issues: string[] = [];
  const ids = new Set(steps.map((s) => s.stepId));
  const adj = new Map<string, string[]>();
  for (const s of steps) {
    adj.set(s.stepId, s.dependsOn || []);
    for (const d of s.dependsOn || []) if (!ids.has(d)) issues.push(`passo '${s.stepId}' depende de '${d}' inexistente`);
  }
  // detecção de ciclo (DFS com cores).
  const color = new Map<string, number>(); // 0=branco 1=cinza 2=preto
  const dfs = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) || []) {
      if (!ids.has(v)) continue;
      const c = color.get(v) || 0;
      if (c === 1) return true;            // aresta de retorno → ciclo
      if (c === 0 && dfs(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const s of steps) if ((color.get(s.stepId) || 0) === 0 && dfs(s.stepId)) { issues.push(`ciclo de dependência envolvendo '${s.stepId}'`); break; }
  return issues;
}

/**
 * Ordenação topológica dos passos (deps antes dos dependentes). Se houver ciclo,
 * cai pra ordem original (o plano já estará `blocked`). Puro/estável.
 */
export function topoSortSteps<T extends { stepId: string; dependsOn?: string[] }>(steps: T[]): T[] {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const indeg = new Map<string, number>();
  for (const s of steps) indeg.set(s.stepId, 0);
  for (const s of steps) for (const d of s.dependsOn || []) if (byId.has(d)) indeg.set(s.stepId, (indeg.get(s.stepId) || 0) + 1);
  const ready = steps.filter((s) => (indeg.get(s.stepId) || 0) === 0).map((s) => s.stepId);
  const out: T[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    ready.sort(); // desempate estável
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id)!);
    for (const s of steps) {
      if ((s.dependsOn || []).includes(id)) {
        indeg.set(s.stepId, (indeg.get(s.stepId) || 0) - 1);
        if ((indeg.get(s.stepId) || 0) === 0) ready.push(s.stepId);
      }
    }
  }
  return out.length === steps.length ? out : steps; // ciclo → ordem original
}

// ═══════════════════════════════════════════════════════════════════════════
// PRD 4 F11 — Evals + Shadow (contratos puros + scorers DETERMINÍSTICOS)
// ---------------------------------------------------------------------------
// P7 (determinístico antes de probabilístico): o núcleo do eval NÃO usa LLM-juiz.
// Cada caso declara um scorer determinístico e um `expected`; a nota sai de regra
// pura (match exato, subconjunto JSON, campo igual, grounded, não-vazio, predicado).
// Assim o eval roda na CI SEM chave de IA (mesma disciplina de todos os testes).
// O candidato pode vir gravado no caso (`recordedOutput`, replay golden) ou de um
// `invoke` injetado (mesma técnica testável do Kernel F4) — nunca um provider real
// embutido aqui. "Simples primeiro; sem plataforma de ML" (auditoria).
// ═══════════════════════════════════════════════════════════════════════════

export const EVAL_SCORERS = ["exact", "json_subset", "field_equals", "grounded", "non_empty", "predicate"] as const;
export type EvalScorer = (typeof EVAL_SCORERS)[number];

export interface EvalCase {
  caseId: string;
  skillId: string;
  name: string;
  input: any;                         // insumo do caso (o que a skill receberia)
  scorer: EvalScorer;
  expected?: any;                     // gabarito (exact/json_subset/field_equals)
  fieldPath?: string;                 // p/ field_equals: "a.b.c"
  recordedOutput?: any;               // candidato gravado (replay determinístico)
  weight?: number;                    // peso na agregação (default 1)
}

export interface EvalCaseScore {
  caseId: string;
  scorer: EvalScorer;
  passed: boolean;
  score: number;                      // 0..1
  weight: number;
  detail: string | null;             // onde divergiu (null se passou)
}

export interface EvalResult {
  skillId: string;
  promptVersion: string | null;
  total: number;
  passed: number;
  failed: number;
  passRate: number;                   // 0..1 (ponderado por weight)
  scores: EvalCaseScore[];
  regressed: boolean;                 // vs baseline (setado pelo serviço)
}

/** Lê um caminho "a.b.c" de um objeto (sem lançar). */
export function readPath(obj: any, path: string): any {
  if (!path) return obj;
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** `expected` é subconjunto (recursivo) de `candidate`? (arrays: igualdade por índice.) */
export function isJsonSubset(expected: any, candidate: any): boolean {
  if (expected === null || typeof expected !== "object") return expected === candidate;
  if (Array.isArray(expected)) {
    if (!Array.isArray(candidate) || candidate.length !== expected.length) return false;
    return expected.every((v, i) => isJsonSubset(v, candidate[i]));
  }
  if (candidate === null || typeof candidate !== "object") return false;
  return Object.keys(expected).every((k) => isJsonSubset(expected[k], candidate[k]));
}

/**
 * Pontua UM caso contra um candidato, determinístico. `predicate` opcional só é
 * usado pelo scorer 'predicate' (o serviço injeta; o modelo puro aceita a função).
 * Retorna pass/score/detalhe (detail = onde divergiu, pra diagnóstico).
 */
export function scoreEvalCase(c: EvalCase, candidate: any, predicate?: (candidate: any, c: EvalCase) => boolean): EvalCaseScore {
  const weight = c.weight && c.weight > 0 ? c.weight : 1;
  const mk = (passed: boolean, detail: string | null): EvalCaseScore =>
    ({ caseId: c.caseId, scorer: c.scorer, passed, score: passed ? 1 : 0, weight, detail });

  if (candidate === undefined) return mk(false, "sem candidato (recordedOutput/invoke ausente)");

  switch (c.scorer) {
    case "exact": {
      const ok = JSON.stringify(candidate) === JSON.stringify(c.expected);
      return mk(ok, ok ? null : "candidato ≠ expected (match exato)");
    }
    case "json_subset": {
      const ok = isJsonSubset(c.expected, candidate);
      return mk(ok, ok ? null : "expected não é subconjunto do candidato");
    }
    case "field_equals": {
      const got = readPath(candidate, c.fieldPath || "");
      const ok = JSON.stringify(got) === JSON.stringify(c.expected);
      return mk(ok, ok ? null : `campo '${c.fieldPath}': ${JSON.stringify(got)} ≠ ${JSON.stringify(c.expected)}`);
    }
    case "grounded": {
      // candidato deve declarar grounding_status = 'grounded' (§19). Aceita o campo
      // no candidato OU num sub-objeto .grounding.status.
      const gs = candidate?.grounding_status ?? candidate?.grounding?.status ?? candidate?.groundingStatus;
      const ok = gs === "grounded";
      return mk(ok, ok ? null : `grounding_status='${gs}' (esperado 'grounded')`);
    }
    case "non_empty": {
      const ok = candidate !== null && candidate !== undefined && candidate !== "" &&
        !(Array.isArray(candidate) && candidate.length === 0) &&
        !(typeof candidate === "object" && !Array.isArray(candidate) && Object.keys(candidate).length === 0);
      return mk(ok, ok ? null : "candidato vazio");
    }
    case "predicate": {
      const ok = typeof predicate === "function" ? !!predicate(candidate, c) : false;
      return mk(ok, ok ? null : "predicado retornou falso");
    }
    default:
      return mk(false, `scorer desconhecido: ${c.scorer}`);
  }
}

/** Agrega notas de casos num passRate ponderado por weight. */
export function aggregateEval(skillId: string, promptVersion: string | null, scores: EvalCaseScore[]): EvalResult {
  const total = scores.length;
  const passed = scores.filter((s) => s.passed).length;
  const wSum = scores.reduce((a, s) => a + s.weight, 0);
  const wPass = scores.reduce((a, s) => a + (s.passed ? s.weight : 0), 0);
  return {
    skillId, promptVersion, total, passed, failed: total - passed,
    passRate: wSum > 0 ? wPass / wSum : 0,
    scores, regressed: false,
  };
}

/**
 * REGRESSÃO vs baseline (gate simples, sem ML): regrediu se o passRate CAIU, OU se
 * algum caso que passava no baseline agora falha (mesmo com passRate estável — troca
 * de acerto por acerto ainda é sinal). `baselinePassRate`/`baselinePassedCaseIds` do
 * último run registrado.
 */
export function detectRegression(current: EvalResult, baseline: { passRate: number; passedCaseIds: string[] } | null): boolean {
  if (!baseline) return false;                         // primeiro run nunca "regride"
  if (current.passRate < baseline.passRate - 1e-9) return true;
  const nowPassing = new Set(current.scores.filter((s) => s.passed).map((s) => s.caseId));
  return baseline.passedCaseIds.some((id) => !nowPassing.has(id));
}

// ═══════════════════════════════════════════════════════════════════════════
// PRD 4 F12 — Canary + Production Readiness (contratos puros do rollout §68/§69)
// ---------------------------------------------------------------------------
// A ESCADA de rollout (§68). Ordem = maturidade crescente. `development` = só dev/
// testes (nunca live pro tenant); a partir de `shadow` a skill "existe" pro runtime,
// mas o MODO de execução (ADR-159 `execution_mode`) sobe junto — nunca `autonomous`
// (RN-014/LGPD: humano sempre no laço). O gate real de execução continua no
// CommandExecutor (G1/G2/G3); aqui só se decide SE a skill está exposta e em que modo.
// ═══════════════════════════════════════════════════════════════════════════

export const ROLLOUT_STAGES = ["development", "shadow", "pilot", "assisted", "approved_execution", "broader"] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];

export function rolloutStageRank(stage: RolloutStage): number {
  const i = ROLLOUT_STAGES.indexOf(stage);
  return i < 0 ? 0 : i;
}

/**
 * Mapeia o estágio §68 pro `execution_mode` da ADR-159 (shadow<assisted<
 * approved_execution). REUSA o teto existente — NÃO cria escala paralela.
 * `development` → null (a skill nem se expõe). `broader` ainda é `approved_execution`
 * (aprovação humana): `autonomous` NUNCA é semeado por rollout (RN-014/LGPD).
 */
export function executionModeForStage(stage: RolloutStage): "shadow" | "assisted" | "approved_execution" | null {
  switch (stage) {
    case "development": return null;
    case "shadow": return "shadow";
    case "pilot": return "assisted";
    case "assisted": return "assisted";
    case "approved_execution": return "approved_execution";
    case "broader": return "approved_execution";
    default: return null;
  }
}

/**
 * Hash determinístico e portável (FNV-1a 32-bit) → 0..99. Puro (sem crypto/I/O), pra
 * o cohort de canário ser ESTÁVEL: a mesma (skill, org) cai sempre no mesmo balde,
 * então subir o percentual só ADICIONA orgs, nunca embaralha quem já estava dentro.
 */
export function hashPercent(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 100;
}

/** Org está no cohort de canário de `percent`% da skill? (0 = ninguém, 100 = todos.) */
export function inCanaryCohort(skillId: string, orgId: string, percent: number): boolean {
  const p = Math.max(0, Math.min(100, Math.floor(percent)));
  if (p <= 0) return false;
  if (p >= 100) return true;
  return hashPercent(`${skillId}:${orgId}`) < p;
}

export interface RolloutState {
  skillId: string;
  stage: RolloutStage;
  canaryPercent: number;    // 0..100 (só se aplica de `pilot` pra cima)
  killed: boolean;          // kill switch por-skill
}

export interface RolloutDecision {
  live: boolean;
  executionMode: "shadow" | "assisted" | "approved_execution" | null;
  stage: RolloutStage;
  reason: string;
}

/**
 * DECISÃO pura de rollout pra uma (skill, org). `globalKilled` = kill switch de
 * plataforma. Ordem: kill global → kill da skill → development → cohort de canário
 * (pilot+; shadow/broader ignoram o percentual — shadow é universal-sem-efeito e
 * broader é geral). Devolve live + o `execution_mode` do estágio.
 */
export function evaluateRollout(state: RolloutState, orgId: string, globalKilled: boolean): RolloutDecision {
  const mode = executionModeForStage(state.stage);
  if (globalKilled) return { live: false, executionMode: null, stage: state.stage, reason: "kill switch global ativo" };
  if (state.killed) return { live: false, executionMode: null, stage: state.stage, reason: "skill em kill switch" };
  if (state.stage === "development") return { live: false, executionMode: null, stage: state.stage, reason: "estágio development (não exposto)" };
  // shadow e broader não dependem de percentual (universal); pilot/assisted/approved
  // respeitam o cohort quando canaryPercent < 100.
  const cohortGated = state.stage === "pilot" || state.stage === "assisted" || state.stage === "approved_execution";
  if (cohortGated && !inCanaryCohort(state.skillId, orgId, state.canaryPercent)) {
    return { live: false, executionMode: mode, stage: state.stage, reason: `fora do cohort de canário (${state.canaryPercent}%)` };
  }
  return { live: true, executionMode: mode, stage: state.stage, reason: "live" };
}
