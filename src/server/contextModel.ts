/**
 * contextModel — PRD 3 F1 (§8, §10-12, §24, §26-28, §30-31, §72, §100): o CORE
 * CONTEXT MODEL do Business Context Engine. São os CONTRATOS ESTÁVEIS que o PRD 4
 * (SkillOS) vai consumir (§84/§127) — puros (sem DB, sem LLM), determinísticos,
 * testáveis. F1 é TIPOS + VALIDAÇÃO + TRADUÇÃO do que já existe; nenhuma tabela
 * nova (a auditoria da Fase 0 mostrou que ~80% já tem casa).
 *
 * Princípios registrados na Fase 0 e reforçados aqui:
 *   - NÃO INVENTAR (§25): ausência é `unknown`/null, nunca valor arbitrário; toda
 *     inferência é marcada (`factType`).
 *   - FATO × INTERPRETAÇÃO (§26): o `basis` do ledger (fact|estimate|hypothesis)
 *     mapeia pro taxonomia de 6 do PRD — o Context Engine não confunde medido com
 *     interpretado.
 *   - PROVENIÊNCIA + CONFIANÇA + FRESCOR de 1ª classe (§24/§27/§28): todo fato/
 *     entidade carrega fonte, confiança (0..1) e frescor.
 *   - TRADUÇÃO, não duplicação: `ContextFact` ≈ `SignalInput` (business_signals);
 *     `EvidenceReference` ≈ `source_entity_*`+`sources[]`; `ContextFreshness` ≈
 *     `expires_at`/`freshness`. Os mappers abaixo provam a equivalência.
 */

// ── §8 CONTEXT SCOPE — o contexto é MULTIDIMENSIONAL (nunca só tenant_id). ──────
export type ContextScopeLevel =
  | "GLOBAL" | "TENANT" | "VERTICAL" | "PLAN" | "ORGANIZATION" | "BUSINESS_UNIT"
  | "LOCATION" | "DEPARTMENT" | "TEAM" | "ROLE" | "USER" | "CUSTOMER" | "SUPPLIER"
  | "PRODUCT" | "SERVICE" | "PROCESS" | "TRANSACTION" | "CONVERSATION" | "SESSION"
  | "SIGNAL" | "TASK" | "EXECUTION" | "TIME_WINDOW";

export const CONTEXT_SCOPE_LEVELS: readonly ContextScopeLevel[] = [
  "GLOBAL", "TENANT", "VERTICAL", "PLAN", "ORGANIZATION", "BUSINESS_UNIT",
  "LOCATION", "DEPARTMENT", "TEAM", "ROLE", "USER", "CUSTOMER", "SUPPLIER",
  "PRODUCT", "SERVICE", "PROCESS", "TRANSACTION", "CONVERSATION", "SESSION",
  "SIGNAL", "TASK", "EXECUTION", "TIME_WINDOW",
] as const;

export interface ContextScopeDimension {
  level: ContextScopeLevel;
  ref?: string | null;      // id concreto da entidade daquele nível (store-123, contactId…)
  label?: string | null;    // rótulo legível opcional
}

/** Escopo do contexto: tenant sempre presente + N dimensões (§8). */
export interface ContextScope {
  tenantId: string;
  dimensions: ContextScopeDimension[];
}

// ── §30/§72 CONTEXT SOURCE + TRUST LEVEL + precedência de fonte. ────────────────
export type ContextSourceType =
  | "SYSTEM_OF_RECORD"     // sistema oficial de registro (§30.1)
  | "TRUSTED_INTEGRATION"  // API transacional confiável (§30.2)
  | "INTERNAL_DB"          // banco interno (§30.3)
  | "APPROVED_CONFIG"      // configuração explicitamente aprovada (§30.4)
  | "APPROVED_DOCUMENT"    // documento oficial (§30.5)
  | "USER_DECLARATION"     // informação declarada pelo usuário (§30.6)
  | "HISTORY"              // histórico (§30.7)
  | "INFERRED"             // inferência (§30.8)
  | "EXTERNAL_SOURCE";     // fonte externa (mundo, não a org)

export const CONTEXT_SOURCE_TYPES: readonly ContextSourceType[] = [
  "SYSTEM_OF_RECORD", "TRUSTED_INTEGRATION", "INTERNAL_DB", "APPROVED_CONFIG",
  "APPROVED_DOCUMENT", "USER_DECLARATION", "HISTORY", "INFERRED", "EXTERNAL_SOURCE",
] as const;

// Precedência DEFAULT (§30) — menor rank = MAIOR prioridade. Configurável por
// domínio no futuro (§30: "a prioridade deverá ser configurável por domínio").
export const SOURCE_PRIORITY: Record<ContextSourceType, number> = {
  SYSTEM_OF_RECORD: 1, TRUSTED_INTEGRATION: 2, INTERNAL_DB: 3, APPROVED_CONFIG: 4,
  APPROVED_DOCUMENT: 5, USER_DECLARATION: 6, HISTORY: 7, INFERRED: 8, EXTERNAL_SOURCE: 6,
};

export interface ContextSource {
  type: ContextSourceType;
  service?: string | null;   // o service/integração concreto (ex.: "AlterdataSync")
  reference?: string | null; // id no sistema de origem
}

/** Compara precedência: retorna a fonte de MAIOR prioridade (menor rank). */
export function higherPrioritySource(a: ContextSource, b: ContextSource): ContextSource {
  return (SOURCE_PRIORITY[a.type] ?? 99) <= (SOURCE_PRIORITY[b.type] ?? 99) ? a : b;
}

// ── §26 CONTEXT FACT TYPE — a taxonomia de fato (dado × interpretação). ─────────
export type ContextFactType = "OBSERVED" | "DECLARED" | "CALCULATED" | "INFERRED" | "DERIVED" | "EXTERNAL";

export const CONTEXT_FACT_TYPES: readonly ContextFactType[] = ["OBSERVED", "DECLARED", "CALCULATED", "INFERRED", "DERIVED", "EXTERNAL"] as const;

/**
 * Traduz o `basis` do ledger (fact|estimate|hypothesis) pro fact_type do PRD.
 * Default honesto: `fact`→OBSERVED (medido), `estimate`→CALCULATED (cálculo sobre
 * evidência), `hypothesis`→INFERRED (interpretação não comprovada). O caller pode
 * sobrescrever quando souber a origem exata (ex.: DECLARED/EXTERNAL).
 */
export function factTypeFromBasis(basis: string | null | undefined): ContextFactType {
  switch (String(basis || "").toLowerCase()) {
    case "fact": return "OBSERVED";
    case "estimate": return "CALCULATED";
    case "hypothesis": return "INFERRED";
    default: return "INFERRED";
  }
}

// ── §27 CONFIDENCE MODEL — bandas nomeadas (não usar precisão falsa). ───────────
export type ConfidenceBand = "very_high" | "high" | "medium" | "low" | "unreliable";

export const clampConfidence = (n: number): number => Math.max(0, Math.min(1, Number(n) || 0));

export function confidenceBand(n: number): ConfidenceBand {
  const c = clampConfidence(n);
  if (c >= 0.90) return "very_high";
  if (c >= 0.75) return "high";
  if (c >= 0.55) return "medium";
  if (c >= 0.30) return "low";
  return "unreliable";
}

// ── §28/§29 CONTEXT FRESHNESS — contexto envelhece. ────────────────────────────
export type FreshnessStatus = "fresh" | "stale" | "unknown";

export interface ContextFreshness {
  observedAt?: string | null;  // quando foi observado (ISO)
  validUntil?: string | null;  // até quando vale (ISO)
  status: FreshnessStatus;
  ageMs?: number | null;       // idade desde observedAt (ms)
}

// Política de frescor por classe de dado (§28) — REFERÊNCIA/documentação; o
// resolver escolhe a janela por domínio. Valores em ms.
export const FRESHNESS_POLICY_MS: Record<string, number> = {
  bank_balance: 60_000,        // 1 min (§28: altíssima volatilidade)
  inventory: 5 * 60_000,       // 5 min (alta)
  operational_queue: 5 * 60_000,
  company_address: 30 * 24 * 3600_000, // 30 dias (baixa)
};

/**
 * Deriva o frescor de um dado. `validUntil` no passado → stale; ambos ausentes →
 * unknown (não presume atualidade — §25/§29). `now` injetável pra teste.
 */
export function freshnessOf(input: { observedAt?: string | null; validUntil?: string | null }, now = Date.now()): ContextFreshness {
  const observedAt = input.observedAt || null;
  const validUntil = input.validUntil || null;
  const obsMs = observedAt ? Date.parse(observedAt) : NaN;
  const ageMs = Number.isFinite(obsMs) ? Math.max(0, now - obsMs) : null;
  let status: FreshnessStatus;
  if (validUntil) {
    const vu = Date.parse(validUntil);
    status = Number.isFinite(vu) ? (vu > now ? "fresh" : "stale") : "unknown";
  } else if (observedAt) {
    status = "fresh"; // observado sem TTL declarado — fresco por padrão (o domínio pode reavaliar)
  } else {
    status = "unknown";
  }
  return { observedAt, validUntil, status, ageMs };
}

// ── §24 EVIDENCE REFERENCE — rastreabilidade de toda informação usada. ─────────
export interface EvidenceReference {
  sourceType: ContextSourceType;
  sourceId?: string | null;
  service?: string | null;
  observedAt?: string | null;
  field?: string | null;
  value?: unknown;
  confidence?: number | null;
}

// ── §10 CONTEXT ENTITY — "quem/o quê" do contexto. ─────────────────────────────
export type ContextEntityType =
  | "organization" | "business_unit" | "location" | "department" | "team" | "role"
  | "user" | "customer" | "supplier" | "product" | "service" | "process" | "goal"
  | "constraint" | "policy" | "order" | "opportunity" | "signal" | "task" | string;

export interface ContextEntity {
  id: string;
  tenantId: string;
  type: ContextEntityType;
  name?: string | null;
  attributes: Record<string, unknown>;
  source: ContextSource;
  sourceReference?: string | null;
  confidence: number;          // 0..1
  freshness: ContextFreshness;
  validFrom?: string | null;
  validUntil?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

// ── §11 CONTEXT FACT — subject/predicate/object com evidência + confiança. ──────
export interface ContextFact {
  subject: string;             // ex.: "customer:123"
  predicate: string;           // ex.: "has_open_debt"
  object: unknown;             // ex.: 4500
  scope?: ContextScope | null;
  evidence: EvidenceReference[];
  confidence: number;          // 0..1
  factType: ContextFactType;
  source: ContextSource;
  validFrom?: string | null;
  validUntil?: string | null;
  observedAt?: string | null;
}

// ── §12 CONTEXT RELATIONSHIP — relações entre entidades. ────────────────────────
export interface ContextRelationship {
  from: string;                // "customer:123"
  type: string;                // "belongs_to_portfolio_of"
  to: string;                  // "user:45"
  confidence?: number | null;
  source?: ContextSource | null;
}

// ── §31 CONTEXT CONFLICT — fontes divergentes NÃO se resolvem em silêncio. ──────
export type ConflictResolution = "auto" | "degrade_confidence" | "ask" | "block";

export interface ContextConflictValue {
  source: ContextSource;
  value: unknown;
  confidence?: number | null;
  observedAt?: string | null;
}

export interface ContextConflict {
  field: string;
  values: ContextConflictValue[];
  resolution?: ConflictResolution | null;
  resolvedValue?: unknown;
  resolvedBy?: ContextSource | null;
}

// ────────────────────────── Validação / construção ────────────────────────────

export function isScopeLevel(x: any): x is ContextScopeLevel {
  return CONTEXT_SCOPE_LEVELS.includes(x);
}

/** Cria um escopo a partir do tenant + dimensões válidas (ignora inválidas). */
export function makeScope(tenantId: string, dims: ContextScopeDimension[] = []): ContextScope {
  const dimensions = dims.filter((d) => d && isScopeLevel(d.level));
  return { tenantId, dimensions };
}

/** Encontra a `ref` de um nível no escopo (null se ausente). */
export function scopeRef(scope: ContextScope | null | undefined, level: ContextScopeLevel): string | null {
  if (!scope) return null;
  const d = scope.dimensions.find((x) => x.level === level);
  return d ? (d.ref ?? null) : null;
}

/**
 * §31 — detecta conflito num campo dado ≥2 candidatos. Retorna o `ContextConflict`
 * se os VALORES divergem (comparação por JSON canônico), senão null (concordam).
 */
export function detectConflict(field: string, candidates: ContextConflictValue[]): ContextConflict | null {
  const real = (candidates || []).filter((c) => c && c.value !== undefined);
  if (real.length < 2) return null;
  const distinct = new Set(real.map((c) => JSON.stringify(c.value ?? null)));
  if (distinct.size < 2) return null;
  return { field, values: real, resolution: null };
}

/**
 * §30/§31 — resolução AUTOMÁTICA por precedência de fonte: escolhe o valor da
 * fonte de maior prioridade. NÃO oculta o conflito — preserva `values[]` e marca
 * `resolution:'auto'` + `resolvedBy`. Casos importantes devem preferir
 * 'degrade_confidence'/'ask'/'block' (decisão do resolver, não deste helper).
 */
export function resolveConflictByPriority(conflict: ContextConflict): ContextConflict {
  const winner = conflict.values.reduce((best, c) =>
    (SOURCE_PRIORITY[c.source.type] ?? 99) < (SOURCE_PRIORITY[best.source.type] ?? 99) ? c : best
  , conflict.values[0]);
  return { ...conflict, resolution: "auto", resolvedValue: winner?.value, resolvedBy: winner?.source ?? null };
}

// ────────────────── Mappers: TRADUÇÃO do que já existe (não duplica) ───────────

// Forma mínima de um sinal do ledger (subset de business_signals / SignalInput)
// usada só pra tradução — o mapper não depende do serviço nem do DB.
export interface SignalLike {
  id?: string;
  domain: string;
  signal_type?: string; signalType?: string;
  basis?: string | null;
  confidence?: number | null;
  subject_type?: string | null; subjectType?: string | null;
  subject_id?: string | null; subjectId?: string | null;
  source_service?: string | null; sourceService?: string | null;
  source_entity_type?: string | null; sourceEntityType?: string | null;
  source_entity_id?: string | null; sourceEntityId?: string | null;
  evidence?: any; evidence_json?: string | null;
  impact_amount?: number | null; impactAmount?: number | null;
  impact_unit?: string | null; impactUnit?: string | null;
  detected_at?: string | null; occurred_at?: string | null; occurredAt?: string | null;
  expires_at?: string | null; expiresAt?: string | null;
}

const pick = <T,>(...vals: (T | null | undefined)[]): T | null => {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
};

/** Fonte do ledger: um sinal é INTERNO/derivado — trust INTERNAL_DB por padrão. */
function sourceFromSignal(s: SignalLike): ContextSource {
  return { type: "INTERNAL_DB", service: pick(s.source_service, s.sourceService), reference: pick(s.source_entity_id, s.sourceEntityId) };
}

/** §24 — evidência-referência a partir de um sinal (o que sustenta o fato). */
export function evidenceFromSignal(s: SignalLike): EvidenceReference {
  return {
    sourceType: "INTERNAL_DB",
    sourceId: pick(s.source_entity_id, s.sourceEntityId, s.id),
    service: pick(s.source_service, s.sourceService),
    observedAt: pick(s.occurred_at, s.occurredAt, s.detected_at),
    field: pick(s.signal_type, s.signalType),
    confidence: s.confidence != null ? clampConfidence(s.confidence) : null,
  };
}

/**
 * §11 — TRADUZ um sinal do ledger num `ContextFact` (prova a equivalência
 * SignalInput≈ContextFact). subject = `subjectType:subjectId`; predicate =
 * signal_type; object = impacto/evidence; factType do `basis`; freshness do
 * `expires_at`. NUNCA inventa: campos ausentes ficam null.
 */
export function factFromSignal(s: SignalLike, now = Date.now()): ContextFact {
  const signalType = pick(s.signal_type, s.signalType) || "signal";
  const subjType = pick(s.subject_type, s.subjectType);
  const subjId = pick(s.subject_id, s.subjectId);
  const subject = subjType ? `${subjType}:${subjId ?? "?"}` : `${s.domain}:${signalType}`;
  const amount = pick(s.impact_amount, s.impactAmount);
  const object = amount != null ? { amount, unit: pick(s.impact_unit, s.impactUnit) } : (pick(s.evidence) ?? null);
  const observedAt = pick(s.occurred_at, s.occurredAt, s.detected_at);
  const validUntil = pick(s.expires_at, s.expiresAt);
  return {
    subject,
    predicate: signalType,
    object,
    evidence: [evidenceFromSignal(s)],
    confidence: s.confidence != null ? clampConfidence(s.confidence) : 0.5,
    factType: factTypeFromBasis(s.basis),
    source: sourceFromSignal(s),
    observedAt,
    validUntil,
  };
}

/** §28 — frescor de um sinal (helper de conveniência sobre freshnessOf). */
export function freshnessFromSignal(s: SignalLike, now = Date.now()): ContextFreshness {
  return freshnessOf({ observedAt: pick(s.occurred_at, s.occurredAt, s.detected_at), validUntil: pick(s.expires_at, s.expiresAt) }, now);
}

// Forma mínima de um hit de RAG (subset de `RagHit` do geminiRAG) usada só pra
// tradução — o mapper não depende do serviço de RAG nem do DB (contextModel puro).
export interface RagHitLike {
  documentId?: string | null;
  chunkId?: string | null;
  chunkIndex?: number | null;
  title?: string | null;
  source?: string | null;
  text?: string | null;
  score?: number | null;
  observedAt?: string | null;
}

/**
 * §49 (F7) — TRADUZ um hit de RAG/memória num `EvidenceReference` (§24): RAG vira
 * evidência de 1ª classe, RASTREÁVEL. Um documento da base de conhecimento é um
 * documento OFICIAL da org (§30.5 → APPROVED_DOCUMENT). Preserva documentId/
 * chunkIndex/título/timestamp que a linha carrega e antes era descartado. O
 * `score` de similaridade vira a confiança da referência. Não inventa: campos
 * ausentes ficam null.
 */
export function evidenceFromRagHit(h: RagHitLike): EvidenceReference {
  return {
    sourceType: "APPROVED_DOCUMENT",
    sourceId: pick(h.documentId, h.chunkId),
    service: "geminiRAG",
    observedAt: pick(h.observedAt),
    field: h.chunkIndex != null ? `chunk:${h.chunkIndex}` : pick(h.source, h.title),
    value: pick(h.text),
    confidence: h.score != null ? clampConfidence(h.score) : null,
  };
}

// ═══════════════════════ RESOLVER I/O (§18/§19/§20/§6) — F3 ════════════════════
// Os contratos de ENTRADA (`ContextRequest`) e SAÍDA (`ContextPacket`) do Context
// Resolver. Puros (tipos + orçamento derivável) — a montagem (que lê DB/serviços)
// vive no `ContextResolverService`. É a INTERFACE que o PRD 4 (SkillOS) consome
// (§84/§127/AC-A05): o pacote é o contrato entre os dois PRDs.

/** §6 — perfil de profundidade (Progressive Disclosure): quanto contexto revelar. */
export type ContextProfile = "minimal" | "standard" | "deep";

/** Tetos de orçamento por seção — o resolver nunca despeja tudo (§6/§123). */
export interface ContextBudget {
  maxFacts?: number;     // fatos traduzidos do ledger
  maxEntities?: number;  // nós do grafo (F2)
  maxSignals?: number;   // itens do "momento" (attention)
  graphDepth?: number;   // profundidade da vizinhança do grafo
  maxGoals?: number;     // metas incluídas
}

// Orçamento por perfil (§6). O caller pode sobrescrever campo a campo via
// `request.budget`. `minimal` = decisão rápida; `deep` = análise L3+ (§41).
export const PROFILE_BUDGETS: Record<ContextProfile, Required<ContextBudget>> = {
  minimal:  { maxFacts: 5,  maxEntities: 8,  maxSignals: 5,  graphDepth: 1, maxGoals: 2 },
  standard: { maxFacts: 15, maxEntities: 25, maxSignals: 15, graphDepth: 2, maxGoals: 4 },
  deep:     { maxFacts: 40, maxEntities: 60, maxSignals: 40, graphDepth: 3, maxGoals: 8 },
};

/** §19 CONTEXT REQUEST — a ENTRADA do resolver: intent + escopo + orçamento. */
export interface ContextRequest {
  intent: string;               // o que o caller quer decidir/fazer (livre)
  scope?: ContextScope | null;  // dimensões de escopo (âncora: CUSTOMER/BUSINESS_UNIT/…)
  focus?: string | null;        // entidade âncora "type:id" — atalho pro grafo (sobrepõe o escopo)
  profile?: ContextProfile;     // perfil de profundidade (default "standard")
  budget?: ContextBudget;       // tetos explícitos (sobrescrevem o perfil)
  domains?: string[] | null;    // domínios de interesse (filtra momento/fatos)
}

/** Resolve o orçamento efetivo: perfil + overrides do request. Puro/determinístico. */
export function resolveBudget(request: Pick<ContextRequest, "profile" | "budget">): Required<ContextBudget> {
  const base = PROFILE_BUDGETS[request.profile || "standard"];
  const b = request.budget || {};
  const pos = (v: number | undefined, d: number) => (Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : d);
  return {
    maxFacts: pos(b.maxFacts, base.maxFacts),
    maxEntities: pos(b.maxEntities, base.maxEntities),
    maxSignals: pos(b.maxSignals, base.maxSignals),
    graphDepth: Number.isFinite(b.graphDepth) && (b.graphDepth as number) >= 0 ? Math.floor(b.graphDepth as number) : base.graphDepth,
    maxGoals: pos(b.maxGoals, base.maxGoals),
  };
}

/** §17 BUSINESS MOMENT — o "o que está acontecendo agora" (resumo do attention). */
export interface ContextMoment {
  total: number;
  bySeverity: Record<string, number>;
  byDomain: Record<string, number>;
  top: Array<Record<string, unknown>>;  // itens trimados ao orçamento
}

/**
 * §21 SKILL HINT — PISTA de processo derivada de `recommendedActionType`/ACTION_MAP.
 * É só uma DICA no pacote: NÃO seleciona nem executa skill (isso é o PRD 4).
 */
export interface SkillHint {
  domain: string;
  hint: string;          // classe de ação/processo (ex.: "collection", "prepare_purchase")
  label: string;         // rótulo humano da ação recomendada
  reason: string;
  priority: number;      // score de prioridade (0..1)
  impactLevel?: string | null;
}

/**
 * §15 CONTEXT CONSTRAINT — um limite/política que a decisão deve respeitar. O
 * Context Engine só o LÊ e ANEXA (READ+DERIVE §90) — o enforcement é do RBAC/
 * ApprovalPolicy. Tradução direta de `business_constraints` (F4).
 */
export interface ContextConstraint {
  id: string;
  kind: string;                 // discount_ceiling|budget_limit|margin_floor|payment_term_max|policy|custom
  name: string;
  scopeType?: string | null;
  scopeRef?: string | null;
  operator: string;             // lte|gte|eq|max|min
  value?: number | null;
  unit?: string | null;
  text?: string | null;
  source: ContextSource;
  active: boolean;
}

/** §75 CONTEXT QUALITY — a confiança no próprio contexto (cobertura+conf+frescor+conflito). */
export interface ContextQuality {
  coveragePct: number | null;                         // % de dados informados (dataQuality)
  confidence: { score: number; band: ConfidenceBand }; // média dos fatos (ou cobertura, se sem fato)
  freshness: { fresh: number; stale: number; unknown: number };
  conflicts: number;                                  // nº de campos com fontes divergentes (§31)
  gaps: string[];                                     // dados ausentes / domínios available:false
}

/** §34 CONTEXT COVERAGE — disponibilidade de uma fonte de dado (available × ausente). */
export interface ContextCoverageItem {
  key: string;
  label: string;
  available: boolean;
}

/**
 * §75+§34+§31+§24 CONTEXT QUALITY REPORT (F8) — a qualidade do contexto como
 * leitura RICA de 1ª classe: o resumo (`quality`) + cobertura POR-FONTE + os
 * conflitos DETALHADOS (não só a contagem) + a proveniência AGREGADA por tipo.
 */
export interface ContextQualityReport {
  tenantId: string;
  quality: ContextQuality;
  coverage: { pct: number | null; items: ContextCoverageItem[] };
  conflicts: ContextConflict[];
  evidence: { total: number; bySourceType: Record<string, number> };
  generatedAt: string;
  schemaVersion: number;
}

/** §20 CONTEXT PACKET — a SAÍDA: mínimo e relevante ao intent. Contrato pro PRD 4. */
export interface ContextPacket {
  tenantId: string;
  intent: string;
  scope: ContextScope;
  anchor: string | null;              // entidade âncora resolvida (ou null → org-wide)
  moment: ContextMoment;
  facts: ContextFact[];
  entities: ContextEntity[];
  relationships: ContextRelationship[];
  goals: Array<Record<string, unknown>>;
  constraints: ContextConstraint[];
  skillHints: SkillHint[];
  quality: ContextQuality;
  sources: string[];
  truncated: boolean;                 // algum orçamento cortou (nunca em silêncio §31/§123)
  budget: Required<ContextBudget>;
  generatedAt: string;
  schemaVersion: number;
}

// ═══════════════════ CONTEXT PACKET CONTRACT (AC-A05/§127) — F10 ════════════════
// O `ContextPacket` é a INTERFACE entre o PRD 3 (Context Engine) e o PRD 4
// (SkillOS). AC-A05 exige que ela seja ESTÁVEL — qualquer regressão de forma/
// invariante tem de FALHAR ALTO (não passar em silêncio). Este é o validador
// determinístico que blinda o contrato: forma + tipos + invariantes de negócio.

/** Versão do contrato do pacote. Sobe SÓ em breaking change (o PRD 4 pina a versão). */
export const CONTEXT_PACKET_SCHEMA_VERSION = 1;

const CONFIDENCE_BANDS: readonly ConfidenceBand[] = ["very_high", "high", "medium", "low", "unreliable"];

export interface ContextPacketValidation {
  valid: boolean;
  errors: string[];    // caminho + motivo, um por violação (vazio ⇒ válido)
}

const isStr = (v: any) => typeof v === "string";
const isNum = (v: any) => typeof v === "number" && Number.isFinite(v);
const isBool = (v: any) => typeof v === "boolean";
const isArr = (v: any) => Array.isArray(v);
const isObj = (v: any) => v != null && typeof v === "object" && !Array.isArray(v);
const isNonNegInt = (v: any) => isNum(v) && v >= 0 && Number.isInteger(v);

/**
 * §127 — valida um `ContextPacket` contra o contrato. Determinístico e PURO (sem
 * DB/IA). Junta TODAS as violações (não para na 1ª) pra o caller ver o quadro
 * inteiro. Cobre: campos obrigatórios + tipos · schemaVersion · budget completo ·
 * moment/quality bem-formados · e as INVARIANTES: budget RESPEITADO (nenhum array
 * acima do teto), confiança em [0,1] com banda válida, frescor com inteiros ≥0,
 * `truncated` booleano coerente. Nunca lança (retorna erros) — use `assert` p/ throw.
 */
export function validateContextPacket(packet: unknown): ContextPacketValidation {
  const errors: string[] = [];
  const p: any = packet;
  if (!isObj(p)) return { valid: false, errors: ["packet: não é um objeto"] };

  if (!isStr(p.tenantId) || !p.tenantId.trim()) errors.push("tenantId: string não-vazia obrigatória");
  if (!isStr(p.intent)) errors.push("intent: string obrigatória");
  if (!isObj(p.scope)) errors.push("scope: objeto obrigatório");
  if (!(p.anchor === null || isStr(p.anchor))) errors.push("anchor: string ou null");
  for (const k of ["facts", "entities", "relationships", "goals", "constraints", "skillHints", "sources"]) {
    if (!isArr(p[k])) errors.push(`${k}: array obrigatório`);
  }
  if (!isBool(p.truncated)) errors.push("truncated: boolean obrigatório");
  if (!isStr(p.generatedAt)) errors.push("generatedAt: string obrigatória");
  if (p.schemaVersion !== CONTEXT_PACKET_SCHEMA_VERSION) errors.push(`schemaVersion: esperado ${CONTEXT_PACKET_SCHEMA_VERSION}, veio ${p.schemaVersion}`);

  // budget — Required<ContextBudget>: 5 campos, todos números finitos ≥0.
  if (!isObj(p.budget)) errors.push("budget: objeto obrigatório");
  else for (const k of ["maxFacts", "maxEntities", "maxSignals", "graphDepth", "maxGoals"]) {
    if (!isNum(p.budget[k]) || p.budget[k] < 0) errors.push(`budget.${k}: número ≥0 obrigatório`);
  }

  // moment — §17.
  if (!isObj(p.moment)) errors.push("moment: objeto obrigatório");
  else {
    if (!isNum(p.moment.total)) errors.push("moment.total: número obrigatório");
    if (!isObj(p.moment.bySeverity)) errors.push("moment.bySeverity: objeto obrigatório");
    if (!isObj(p.moment.byDomain)) errors.push("moment.byDomain: objeto obrigatório");
    if (!isArr(p.moment.top)) errors.push("moment.top: array obrigatório");
  }

  // quality — §75.
  if (!isObj(p.quality)) errors.push("quality: objeto obrigatório");
  else {
    const q = p.quality;
    if (!(q.coveragePct === null || isNum(q.coveragePct))) errors.push("quality.coveragePct: número ou null");
    if (!isObj(q.confidence)) errors.push("quality.confidence: objeto obrigatório");
    else {
      if (!isNum(q.confidence.score) || q.confidence.score < 0 || q.confidence.score > 1) errors.push("quality.confidence.score: número em [0,1]");
      if (!CONFIDENCE_BANDS.includes(q.confidence.band)) errors.push("quality.confidence.band: banda inválida");
    }
    if (!isObj(q.freshness)) errors.push("quality.freshness: objeto obrigatório");
    else for (const k of ["fresh", "stale", "unknown"]) if (!isNonNegInt(q.freshness[k])) errors.push(`quality.freshness.${k}: inteiro ≥0`);
    if (!isNum(q.conflicts) || q.conflicts < 0) errors.push("quality.conflicts: número ≥0");
    if (!isArr(q.gaps)) errors.push("quality.gaps: array obrigatório");
  }

  // INVARIANTE — budget RESPEITADO: nenhum array acima do teto (o corte tem de ter
  // acontecido; §123 proíbe estourar o orçamento). Só checa se ambos os lados são sãos.
  if (isObj(p.budget)) {
    const cap = (arr: any, max: any, name: string) => { if (isArr(arr) && isNum(max) && arr.length > max) errors.push(`${name}: ${arr.length} acima do teto do budget (${max})`); };
    cap(p.facts, p.budget.maxFacts, "facts");
    cap(p.entities, p.budget.maxEntities, "entities");
    cap(p.goals, p.budget.maxGoals, "goals");
    if (isObj(p.moment)) cap(p.moment.top, p.budget.maxSignals, "moment.top");
  }

  return { valid: errors.length === 0, errors };
}

/** Igual ao validate, mas LANÇA no 1º pacote inválido (guarda dura p/ caller/teste). */
export function assertContextPacket(packet: unknown): asserts packet is ContextPacket {
  const r = validateContextPacket(packet);
  if (!r.valid) throw new Error(`ContextPacket inválido (contrato §127): ${r.errors.join("; ")}`);
}

// ═══════════════════════ CONTEXT CANDIDATE (§36/§37) — F6 ══════════════════════
// Um candidato de CONTEXTO/REGRA (não de ação): uma mudança PROPOSTA ao contexto
// (um fato, uma restrição/regra) capturada do Fala Tu / de um detector, que SÓ
// afeta o contexto depois de CONFIRMADA por um humano — NUNCA em silêncio (§36).
// É o contrato de estados que o `ContextCandidateService` (F6) materializa.

/** §37 — ciclo do candidato. CONFIRMED/REJECTED/EXPIRED são terminais. */
export type ContextCandidateStatus = "DETECTED" | "PENDING" | "CONFIRMED" | "REJECTED" | "EXPIRED";

export const CONTEXT_CANDIDATE_STATUSES: readonly ContextCandidateStatus[] = ["DETECTED", "PENDING", "CONFIRMED", "REJECTED", "EXPIRED"] as const;

/** O que o candidato viraria ao confirmar (o alvo da promoção). */
export type ContextCandidateKind = "constraint" | "fact";

export const CONTEXT_CANDIDATE_KINDS: readonly ContextCandidateKind[] = ["constraint", "fact"] as const;

/**
 * §36 — transições VÁLIDAS. A confirmação é um ATO humano: nenhum estado pula pra
 * CONFIRMED sozinho (só via `confirm`, que promove). DETECTED pode ir direto a
 * CONFIRMED (o humano triou e confirmou num passo) — ainda é confirmação, não
 * silêncio. Terminais não transicionam. Usado pra guardar o invariante de estado.
 */
export const CONTEXT_CANDIDATE_TRANSITIONS: Record<ContextCandidateStatus, ContextCandidateStatus[]> = {
  DETECTED: ["PENDING", "CONFIRMED", "REJECTED", "EXPIRED"],
  PENDING: ["CONFIRMED", "REJECTED", "EXPIRED"],
  CONFIRMED: [],
  REJECTED: [],
  EXPIRED: [],
};

/** True se `from → to` é uma transição permitida do ciclo (§36). */
export function canTransitionCandidate(from: ContextCandidateStatus, to: ContextCandidateStatus): boolean {
  return (CONTEXT_CANDIDATE_TRANSITIONS[from] || []).includes(to);
}

/** §37 CONTEXT CANDIDATE — a mudança proposta + seu estado + proveniência. */
export interface ContextCandidate {
  id: string;
  tenantId: string;
  kind: ContextCandidateKind;
  status: ContextCandidateStatus;
  title: string;
  summary?: string | null;
  scopeType?: string | null;
  scopeRef?: string | null;
  proposed: Record<string, unknown>;   // o payload que MUDARIA o contexto (inerte até confirmar)
  source: string;                      // falatu|signal|detector|manual
  sourceRef?: string | null;           // id da origem (inbox item / sinal)
  confidence?: number | null;
  detectedAt?: string | null;
  expiresAt?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionReason?: string | null;
  promotedKind?: string | null;        // o que virou ao confirmar (constraint|signal)
  promotedRefId?: string | null;       // id do registro criado na promoção
  correlationId?: string | null;
}
