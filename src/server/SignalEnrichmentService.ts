import db from "./db.js";
import {
  ContextFact,
  ContextFreshness,
  ContextConstraint,
  ContextPacket,
  ContextProfile,
  ContextScopeLevel,
  factFromSignal,
  freshnessFromSignal,
  makeScope,
} from "./contextModel.js";
import { ContextResolverService } from "./ContextResolverService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { ContextGraphService } from "./ContextGraphService.js";

/**
 * SignalEnrichmentService — PRD 3 F5 (§38/§39): SIGNAL CONTEXT ENRICHMENT, a ponte
 * PERCEPÇÃO → CONTEXTO que o Maestro (PRD 4) consome. Dado um sinal do Radar
 * (PRD 2, uma linha de `business_signals`), monta o CONTEXTO daquele sinal:
 *
 *   sinal        ← `business_signals` (traduzido em `ContextFact` por factFromSignal, F1)
 *   contexto     ← `ContextResolverService.resolve` ANCORADO no SUJEITO do sinal (F3)
 *   lente        ← `ImpactPrioritizationService.scoreOne` (score + meta ameaçada +
 *                  SLA/irreversibilidade + ação recomendada — §41)
 *   meta ameaçada← `affectedGoal` da priorização (goalGapsByDomain — §30/§31)
 *   restrições   ← as APLICÁVEIS à âncora (já no pacote do resolver, F4)
 *   correlatos   ← sinais ABERTOS do MESMO sujeito (a situação em volta — §39)
 *
 * É COMPOSIÇÃO pura: zero tabela nova, zero coluna nova (RN-004/§25). O conteúdo
 * é reúso — a "cola" (montar o contexto de UM sinal) é o que a F5 adiciona.
 *
 * GUARDRAILS (duros, testados):
 *   - RN-SE-1 ISOLAMENTO (§66): `orgId` 1º arg; toda leitura filtra
 *     `organization_id`. Sinal de outro tenant → `found:false` (nunca vaza).
 *   - RN-SE-2 NÃO INVENTAR (§25): âncora só quando o sujeito RESOLVE no grafo (F2);
 *     sujeito sem casa no grafo (ticket/opportunity/…) → `anchor:null` e o pacote
 *     degrada pra org+domínio — o sinal segue presente como fato, nada é fabricado.
 *     Sinal fechado não ganha lente de prioridade (scoreOne só pontua sinal vivo).
 *   - RN-SE-3 READ + DERIVE (AC-A02/§90): só leitura/derivação; NÃO executa a ação
 *     recomendada, NÃO muda o sinal, NÃO cria tarefa — a síntese é advisória (o
 *     gate real é RBAC/ApprovalPolicy; a execução é o PRD 4).
 *   - RN-SE-4 ESTENDE, não duplica (AC-A01): reúsa resolver (F3), prioridade
 *     (scoreOne) e grafo (F2) — não reimplementa score/meta/constraint.
 *   - RN-SE-5 MÍNIMO (§6): o pacote é escopado ao DOMÍNIO e ao SUJEITO do sinal
 *     (não o panorama inteiro); correlatos limitados.
 */

// subject_type do ledger → tipo de entidade do grafo (F2). Só os que têm casa no
// grafo viram âncora; os demais (ticket/opportunity/message/funnel/receivable/…)
// ficam SEM âncora de grafo — honesto, não inventa nó (RN-SE-2). Aliases comuns
// do vocabulário de sujeito real dos detectores (contact≈customer, sku≈product).
const SUBJECT_TO_ENTITY: Record<string, string> = {
  contact: "customer", customer: "customer",
  supplier: "supplier",
  product: "product", sku: "product",
  store: "store", retail_store: "store",
  department: "department",
  user: "user", employee: "user",
};

// tipo de entidade do grafo → nível de escopo (§8) pra montar o ContextScope que
// o resolver usa como âncora quando não passamos `focus` explícito.
const ENTITY_TO_LEVEL: Record<string, ContextScopeLevel> = {
  customer: "CUSTOMER", supplier: "SUPPLIER", product: "PRODUCT",
  store: "LOCATION", department: "DEPARTMENT", user: "USER",
};

const MAX_RELATED = 10;

export interface EnrichedSignal {
  found: boolean;
  signalId: string | null;
  domain: string | null;
  signalType: string | null;
  severity: string | null;
  basis: string | null;
  confidence: number | null;
  status: string | null;
  subject: { type: string | null; id: string | null } | null;
  anchor: string | null;                 // entidade do grafo resolvida (ou null → org+domínio)
  correlationId: string | null;
  fact: ContextFact | null;              // o próprio sinal como ContextFact (F1)
  freshness: ContextFreshness | null;
  priority: Record<string, unknown> | null;   // lente do scoreOne (null p/ sinal fechado)
  threatenedGoal: { metric: string; label: string; gapPct: number } | null;
  constraints: ContextConstraint[];
  relatedSignals: Array<Record<string, unknown>>;  // sinais abertos do MESMO sujeito
  context: ContextPacket | null;         // o pacote ancorado (a ponte pro Maestro)
  generatedAt: string;
  schemaVersion: number;
}

export class SignalEnrichmentService {
  /**
   * Enriquece um sinal pelo id. Isolado por org: sinal inexistente ou de outro
   * tenant → `found:false` (RN-SE-1). Nunca lança por dado ausente (best-effort
   * por seção — degrada pra null/[] como o resolver da F3).
   */
  static enrich(orgId: string, signalId: string, opts: { profile?: ContextProfile; asOf?: string } = {}): EnrichedSignal {
    const signal = db.prepare("SELECT * FROM business_signals WHERE id = ? AND organization_id = ?").get(signalId, orgId) as any;
    if (!signal) return emptyEnriched();
    return this.enrichRow(orgId, signal, opts);
  }

  /**
   * Enriquece a partir de uma LINHA já lida (evita re-leitura pra callers que já
   * têm o sinal em mão — ex.: um sweep que enriquece o feed). Assume que a linha
   * já é da org (o caller garante o isolamento na leitura).
   */
  static enrichRow(orgId: string, signal: any, opts: { profile?: ContextProfile; asOf?: string } = {}): EnrichedSignal {
    const subjectType: string | null = signal.subject_type ?? null;
    const subjectId: string | null = signal.subject_id ?? null;

    // ── Âncora: sujeito do sinal → entidade do grafo, SE resolver (RN-SE-2). ────
    const anchor = this.resolveAnchor(orgId, subjectType, subjectId);

    // ── Pacote de contexto (F3), escopado ao domínio e ancorado no sujeito. ────
    let context: ContextPacket | null = null;
    try {
      const entityType = anchor ? anchor.slice(0, anchor.indexOf(":")) : null;
      const level = entityType ? ENTITY_TO_LEVEL[entityType] : null;
      const scope = level && subjectId ? makeScope(orgId, [{ level, ref: subjectId }]) : makeScope(orgId, []);
      context = ContextResolverService.resolve(orgId, {
        intent: `enrich_signal:${signal.signal_type || "signal"}`,
        focus: anchor,
        scope,
        profile: opts.profile || "standard",
        domains: signal.domain ? [String(signal.domain)] : null,
      });
    } catch { context = null; /* sem contexto: segue com sinal+lente (RN-SE-2) */ }

    // ── Lente de prioridade (§41) — MESMO cálculo do feed, pra este sinal. ─────
    // null pra sinal fechado (scoreOne só pontua sinal vivo) — não inventa lente.
    let priority: Record<string, unknown> | null = null;
    let threatenedGoal: EnrichedSignal["threatenedGoal"] = null;
    try {
      priority = ImpactPrioritizationService.scoreOne(orgId, signal.id, { asOf: opts.asOf }) || null;
      const ag = (priority as any)?.affectedGoal;
      if (ag && ag.metric) threatenedGoal = { metric: String(ag.metric), label: String(ag.label), gapPct: Number(ag.gapPct) };
    } catch { priority = null; }

    // ── Restrições aplicáveis (F4) — já vêm no pacote, ancoradas ao sujeito. ───
    const constraints = context?.constraints ?? [];

    // ── Correlatos: sinais ABERTOS do MESMO sujeito (a situação — §39). ────────
    const relatedSignals = this.relatedBySubject(orgId, subjectType, subjectId, signal.id);

    // ── O sinal como fato (F1) + frescor. ──────────────────────────────────────
    const fact = factFromSignal({ ...signal, evidence: signal.evidence_json ? safeParse(signal.evidence_json) : undefined });
    const freshness = freshnessFromSignal(signal);

    return {
      found: true,
      signalId: String(signal.id),
      domain: signal.domain ?? null,
      signalType: signal.signal_type ?? null,
      severity: signal.severity ?? null,
      basis: signal.basis ?? null,
      confidence: signal.confidence != null ? Number(signal.confidence) : null,
      status: signal.status ?? null,
      subject: subjectType || subjectId ? { type: subjectType, id: subjectId } : null,
      anchor,
      correlationId: signal.correlation_id ?? null,
      fact,
      freshness,
      priority,
      threatenedGoal,
      constraints,
      relatedSignals,
      context,
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
  }

  /**
   * Sujeito do sinal → âncora "type:id" do grafo (F2), SÓ quando o sujeito tem
   * casa no grafo E resolve de fato (não-inventar, RN-SE-2). Sujeito sem mapa
   * (ticket/opportunity/…) ou FK pendurada → null (o pacote fica org+domínio).
   */
  private static resolveAnchor(orgId: string, subjectType: string | null, subjectId: string | null): string | null {
    if (!subjectType || !subjectId) return null;
    const entityType = SUBJECT_TO_ENTITY[String(subjectType).toLowerCase()];
    if (!entityType) return null;
    const candidate = `${entityType}:${subjectId}`;
    try {
      return ContextGraphService.resolveEntity(orgId, candidate) ? candidate : null;
    } catch { return null; }
  }

  /**
   * Sinais ABERTOS e não expirados do MESMO sujeito (exceto o próprio) — a
   * "situação" em volta do sinal (§39). Isolado por org; limitado (RN-SE-5).
   * Sem sujeito → [] (nada a correlacionar — não inventa vínculo).
   */
  private static relatedBySubject(orgId: string, subjectType: string | null, subjectId: string | null, selfId: string): Array<Record<string, unknown>> {
    if (!subjectType || !subjectId) return [];
    try {
      const rows = db.prepare(
        `SELECT id, domain, signal_type, severity, basis, confidence, impact_amount, impact_unit, detected_at, correlation_id, status
           FROM business_signals
          WHERE organization_id = ? AND subject_type = ? AND subject_id = ? AND id != ?
            AND status = 'open' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
          ORDER BY datetime(detected_at) DESC LIMIT ?`
      ).all(orgId, subjectType, subjectId, selfId, MAX_RELATED) as any[];
      return rows.map((r) => ({
        id: String(r.id), domain: r.domain, signalType: r.signal_type, severity: r.severity,
        basis: r.basis, confidence: r.confidence != null ? Number(r.confidence) : null,
        impactAmount: r.impact_amount ?? null, impactUnit: r.impact_unit ?? null,
        detectedAt: r.detected_at ?? null, correlationId: r.correlation_id ?? null, status: r.status,
      }));
    } catch { return []; }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
function safeParse(s: string | null | undefined): any { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } }

function emptyEnriched(): EnrichedSignal {
  return {
    found: false, signalId: null, domain: null, signalType: null, severity: null, basis: null,
    confidence: null, status: null, subject: null, anchor: null, correlationId: null, fact: null,
    freshness: null, priority: null, threatenedGoal: null, constraints: [], relatedSignals: [],
    context: null, generatedAt: new Date().toISOString(), schemaVersion: 1,
  };
}

export default SignalEnrichmentService;
