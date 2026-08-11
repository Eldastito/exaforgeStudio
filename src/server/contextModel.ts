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
