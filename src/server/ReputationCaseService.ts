/**
 * ReputationCaseService (ADR-162 / PRD 5 §11-§14, F3) — costura a IDENTIDADE ao
 * CONTEXTO de uma reclamação já ingerida (business_signal domain='reputation'):
 *
 *   1. extrai pistas do conteúdo (+ override do operador) e resolve o cliente
 *      (IdentityResolutionService) — ambiguidade encaminha, nunca chuta (RN-CRR-5);
 *   2. em match ÚNICO, RE-SUJEITA o sinal `reputation_item`→`contact` (trabalho
 *      previsto na ingestão F2) — assim a reclamação passa a correlacionar com churn/
 *      outros sinais do MESMO contato via SignalCorrelationService (§41);
 *   3. FENCE do conteúdo externo (§11): embrulha em `<untrusted_external_data>` via
 *      ContextGuardService — é o PRIMEIRO caller de produção do fence (a F0 achou que
 *      ele existia sem uso). Assim F5/F8 herdam a proteção: conteúdo de reclamação
 *      NUNCA vira instrução de sistema, e injeção é sinalizada (`suspicious`);
 *   4. monta o customer-360 (CustomerContextService) quando o cliente é conhecido.
 *
 * Sem automação de resposta aqui (F3): só percepção + identidade + contexto. Isolado
 * por org. Não decide ação (isso é policy/executor, F6+).
 */
import db from "./db.js";
import { IdentityResolutionService, IdentityHints, IdentityResolution } from "./IdentityResolutionService.js";
import { CustomerContextService, CustomerContext } from "./CustomerContextService.js";
import { ContextGuardService } from "./ContextGuardService.js";
import { ReputationClassificationService, ReputationClassification } from "./ReputationClassificationService.js";

export interface ReputationCaseContext {
  signalId: string;
  source: string | null;
  externalId: string | null;
  identity: IdentityResolution;
  /** Conteúdo cercado como untrusted_external_data (§11) — seguro pra prompt a jusante. */
  fenced: { suspicious: boolean; matched: string[]; text: string };
  reSubjected: boolean;
  customerContext: CustomerContext | null;
  /** Classificação F4 (§15-18): taxonomia + severidade + high-risk. Persiste upgrade monotônico. */
  classification: ReputationClassification;
  escalate: boolean;   // ambíguo/não-achado, injeção detectada, OU high-risk (§18) → humano decide
}

export class ReputationCaseService {
  /** Sinal de reputação + sua evidência (conteúdo/proveniência). */
  private static loadSignal(orgId: string, signalId: string): { id: string; evidence: any } | null {
    const row = db.prepare(
      `SELECT id, evidence_json, source_entity_type, source_entity_id, subject_type, subject_id
       FROM business_signals WHERE organization_id = ? AND id = ? AND domain = 'reputation'`
    ).get(orgId, signalId) as any;
    if (!row) return null;
    let evidence: any = {};
    try { evidence = JSON.parse(row.evidence_json || "{}"); } catch { evidence = {}; }
    return { id: row.id, evidence: { ...evidence, _source: row.source_entity_type, _externalId: row.source_entity_id, _subjectType: row.subject_type, _subjectId: row.subject_id } };
  }

  /**
   * Resolve identidade + contexto de um caso de reputação. `overrideHints` = o operador
   * informa cliente/pedido (recepção decide) — sempre vence a extração do texto.
   */
  static resolveCase(orgId: string, signalId: string, overrideHints: IdentityHints = {}): ReputationCaseContext | null {
    const sig = this.loadSignal(orgId, signalId);
    if (!sig) return null;
    const content = String(sig.evidence.content || sig.evidence.summary || "");
    const source = sig.evidence._source || sig.evidence.source || null;
    const externalId = sig.evidence._externalId || sig.evidence.externalId || null;

    // 1) pistas do texto + override (override vence).
    const extracted = IdentityResolutionService.extractHints(content);
    const hints: IdentityHints = {
      ...extracted,
      ...clean(overrideHints), // só campos não-vazios sobrescrevem
    };
    const identity = IdentityResolutionService.resolve(orgId, hints);

    // 2) re-sujeita em match único (habilita correlação com churn etc., §41).
    let reSubjected = false;
    if (identity.status === "resolved" && identity.contactId) {
      const r = db.prepare(
        `UPDATE business_signals SET subject_type = 'contact', subject_id = ? WHERE organization_id = ? AND id = ?`
      ).run(identity.contactId, orgId, signalId);
      reSubjected = r.changes > 0;
    }

    // 3) FENCE do conteúdo externo (§11) — untrusted_external_data.
    const f = ContextGuardService.fence(content, { source: String(source || "reputation") });

    // 4) CLASSIFICAÇÃO F4 (§15-18): taxonomia + severidade + high-risk gates, e
    // persiste o upgrade monotônico de severidade no sinal (o attention feed ranqueia
    // certo um caso de acidente/fraude mesmo com nota mediana). Determinístico.
    const classified = ReputationClassificationService.classifySignal(orgId, signalId);
    const classification = classified!.classification; // sinal existe (loadSignal passou)

    // 5) customer-360 quando o cliente é conhecido.
    const customerContext = identity.status === "resolved" && identity.contactId
      ? CustomerContextService.build(orgId, identity.contactId)
      : null;

    // Escala se: identidade não resolvida, injeção no conteúdo, OU high-risk (§18/RN-CRR-4).
    const escalate = identity.status !== "resolved" || f.suspicious || classification.escalate;

    return {
      signalId, source, externalId,
      identity,
      fenced: { suspicious: f.suspicious, matched: f.matched, text: f.fenced },
      reSubjected,
      customerContext,
      classification,
      escalate,
    };
  }
}

/** Remove campos nulos/vazios de um objeto de hints (pra override só sobrescrever o que veio). */
function clean(h: IdentityHints): IdentityHints {
  const out: IdentityHints = {};
  for (const k of ["contactId", "phone", "email", "orderRef", "protocol"] as const) {
    const v = (h as any)[k];
    if (v != null && String(v).trim() !== "") (out as any)[k] = v;
  }
  return out;
}

export default ReputationCaseService;
