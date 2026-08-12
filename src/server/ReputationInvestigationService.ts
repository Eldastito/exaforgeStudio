/**
 * ReputationInvestigationService (ADR-162 / PRD 5 §19-§20, F5) — a INVESTIGAÇÃO de um
 * caso de reputação já ingerido/identificado/classificado (F2/F3/F4). Responde "qual a
 * causa PROVÁVEL desta reclamação e ela se sustenta em fato interno?" — separando com
 * rigor os três níveis epistêmicos do §20:
 *
 *   - CLAIM (alegação do cliente): `basis='estimate'` / responseType 'estimate'. É o que
 *     o consumidor DIZ. Nunca vira fato automático (RN-CRR-2 / §13).
 *   - FACT (registro interno): pedidos/tickets/reembolsos do customer-360 (F3) +
 *     business_signals operacionais correlatos → `SYSTEM_OF_RECORD`/`INTERNAL_DB`. É o
 *     que o SISTEMA sabe de forma verificável.
 *   - HYPOTHESIS (causa candidata): `basis='hypothesis'`. A explicação PROVÁVEL, com
 *     evidência a favor/contra e confiança derivada — nunca afirmada (§13).
 *
 * REÚSO (sem motor novo, §5): `SignalInvestigationService.investigate` traz as causas
 * por CORRELAÇÃO de sinais (após a F3 re-sujeitar ao contato); `CustomerContextService`
 * traz os fatos do 360; `checkGrounding` (o gate DETERMINÍSTICO do §25/§61 que o
 * `AiReliabilityKernel` embrulha) decide se a reclamação é CORROBORADA por fato interno
 * — se não for, ela permanece ALEGAÇÃO (grounding 'unsupported'), e o caso escala pra
 * apuração humana quando é sério. High-risk (F4) NUNCA é auto-concluído (RN-CRR-4).
 *
 * Determinístico (roda em CI sem chave de IA). Não age (F5 é investigação, não resposta).
 * Isolado por org (RN-CRR-9).
 */
import db from "./db.js";
import { SignalInvestigationService } from "./SignalInvestigationService.js";
import { CustomerContextService, CustomerContext } from "./CustomerContextService.js";
import { checkGrounding, GroundedClaim, GroundingStatus } from "./skillosModel.js";
import type { EvidenceReference } from "./contextModel.js";

interface RepCauseTemplate {
  cause: string;
  base: number;
  /** Fatos internos do 360 que CORROBORAM esta causa (transforma alegação→fato). */
  corroborate: (ctx: CustomerContext | null) => EvidenceReference[];
}

// Pedidos em estado que NÃO indica entrega concluída (corrobora "não chegou").
const NOT_DELIVERED = new Set(["pendente", "processando", "aguardando", "enviado", "em transito", "em trânsito", "separacao", "separação"]);
const REFUND_STATUSES = new Set(["reembolso", "devolucao", "devolução"]);

const orderEvidence = (o: { id: string; status: string }): EvidenceReference => ({
  sourceType: "SYSTEM_OF_RECORD", sourceId: o.id, service: "orders", field: "status", value: o.status,
});
const ticketEvidence = (t: { id: string; status: string; sla: string | null }): EvidenceReference => ({
  sourceType: "SYSTEM_OF_RECORD", sourceId: t.id, service: "tickets", field: "sla", value: t.sla ?? t.status,
});

/**
 * Causas por CATEGORIA (F4). Cada uma sabe quais fatos internos a corroboram — é isso
 * que distingue uma alegação genérica de um problema com lastro no sistema. Categorias
 * high-risk NÃO entram aqui: não se deriva causa automática pra elas (RN-CRR-4).
 */
const CATEGORY_CAUSES: Record<string, RepCauseTemplate[]> = {
  delivery: [{
    cause: "Atraso ou falha na entrega",
    base: 0.4,
    corroborate: (ctx) => (ctx?.orders || []).filter((o) => NOT_DELIVERED.has(String(o.status).toLowerCase())).map(orderEvidence),
  }],
  refund_billing: [{
    cause: "Reembolso ou estorno ainda não concluído",
    base: 0.4,
    corroborate: (ctx) => (ctx?.orders || []).filter((o) => REFUND_STATUSES.has(String(o.status).toLowerCase())).map(orderEvidence),
  }],
  service_quality: [{
    cause: "Falha no atendimento (SLA/resposta)",
    base: 0.4,
    corroborate: (ctx) => (ctx?.tickets || []).filter((t) => t.status !== "closed" && (t.sla === "breached" || t.sla === "at_risk")).map(ticketEvidence),
  }],
  product_defect: [{
    cause: "Produto entregue com problema",
    // Corroboração FRACA de propósito: o pedido prova a COMPRA, não o defeito (o defeito
    // é alegação até verificação operacional — RN-CRR-2). base baixa reflete isso.
    base: 0.3,
    corroborate: (ctx) => (ctx?.orders || []).slice(0, 1).map(orderEvidence),
  }],
  access_account: [{ cause: "Bloqueio ou dificuldade de acesso à conta", base: 0.3, corroborate: () => [] }],
  misinformation: [{ cause: "Expectativa não atendida vs. o que foi comunicado", base: 0.3, corroborate: () => [] }],
  food_quality: [{ cause: "Qualidade do preparo abaixo do esperado", base: 0.3, corroborate: () => [] }],
  wrong_order: [{
    cause: "Item errado ou faltante no pedido",
    base: 0.35,
    corroborate: (ctx) => (ctx?.orders || []).slice(0, 1).map(orderEvidence),
  }],
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export interface ReputationInvestigation {
  signalId: string;
  found: boolean;
  category: string;
  highRisk: boolean;
  escalate: boolean;
  /** A alegação do cliente — estimativa, nunca fato (RN-CRR-2). */
  claim: { statement: string; basis: "estimate" };
  /** Fatos internos verificáveis disponíveis (customer-360 + sinais correlatos). */
  facts: EvidenceReference[];
  candidateCauses: Array<{
    cause: string; confidence: number; basis: "hypothesis";
    corroborated: boolean; supportingEvidence: EvidenceReference[]; contradictingEvidence: EvidenceReference[];
  }>;
  grounding: { status: GroundingStatus; corroboratedByInternalFact: boolean; checkedClaims: number; unsupported: string[] };
  confidence: number;
  headline: string;
  contextSignalCount: number;
  investigatedAt: string;
}

export class ReputationInvestigationService {
  static investigate(orgId: string, signalId: string, opts: { now?: number } = {}): ReputationInvestigation | null {
    const now = opts.now || Date.now();
    const sig = db.prepare(
      `SELECT id, evidence_json, severity, subject_type, subject_id FROM business_signals
       WHERE organization_id = ? AND id = ? AND domain = 'reputation'`
    ).get(orgId, signalId) as any;
    if (!sig) return null;

    let evidence: any = {};
    try { evidence = JSON.parse(sig.evidence_json || "{}"); } catch { evidence = {}; }
    const classification = evidence.classification || {};
    const category = String(classification.category || "other");
    const highRisk = !!classification.highRisk;
    const claimText = String(evidence.content || evidence.summary || "").slice(0, 500);

    // Contato conhecido (a F3 re-sujeitou o sinal); só então há customer-360.
    const contactId = sig.subject_type === "contact" && sig.subject_id ? String(sig.subject_id) : null;
    const ctx = contactId ? CustomerContextService.build(orgId, contactId) : null;

    // REÚSO — causas por correlação de sinais (mesmo contato/cadeia) + contexto.
    const corr = SignalInvestigationService.investigate(orgId, signalId, { now });
    const correlatedCauses = (corr.candidateCauses || []).map((c) => ({
      cause: c.cause, confidence: c.confidence, basis: "hypothesis" as const, corroborated: c.supportingEvidence.length > 0,
      supportingEvidence: c.supportingEvidence.map(signalEvidence), contradictingEvidence: c.contradictingEvidence.map(signalEvidence),
    }));

    // Fatos internos disponíveis (o "conjunto verificável" pro grounding).
    const facts: EvidenceReference[] = [];
    for (const o of ctx?.orders || []) facts.push(orderEvidence(o));
    for (const t of ctx?.tickets || []) facts.push(ticketEvidence(t));
    for (const cc of correlatedCauses) facts.push(...cc.supportingEvidence);

    // Causas por CATEGORIA, corroboradas pelos fatos do 360. High-risk não deriva causa.
    const categoryCauses = highRisk ? [] : (CATEGORY_CAUSES[category] || []).map((t) => {
      const support = t.corroborate(ctx);
      const confidence = Math.round(clamp01(t.base + 0.2 * support.length) * 100) / 100;
      return { cause: t.cause, confidence, basis: "hypothesis" as const, corroborated: support.length > 0, supportingEvidence: support, contradictingEvidence: [] as EvidenceReference[] };
    });

    // Merge (dedupe por texto da causa), ordena por confiança.
    const seen = new Set<string>();
    const candidateCauses = [...categoryCauses, ...correlatedCauses]
      .filter((c) => (seen.has(c.cause) ? false : (seen.add(c.cause), true)))
      .sort((a, b) => b.confidence - a.confidence);

    const leading = candidateCauses[0] || null;
    const corroboratingFacts = leading ? leading.supportingEvidence : [];
    const corroboratedByInternalFact = corroboratingFacts.length > 0;

    // GROUNDING (§25/§61) — determinístico. Duas afirmações checadas:
    //   (1) a ALEGAÇÃO como estimativa, citando a declaração do cliente (existe → ok);
    //   (2) a CORROBORAÇÃO como FATO, citando o registro interno — se não houver registro,
    //       a citação fica sem evidência disponível → UNSUPPORTED (é só alegação, RN-CRR-2).
    const declaration: EvidenceReference = { sourceType: "USER_DECLARATION", sourceId: signalId, service: "reputation", field: "complaint" };
    const available: EvidenceReference[] = [declaration, ...facts];
    const claims: GroundedClaim[] = [
      { statement: "O cliente relatou um problema.", responseType: "estimate", evidence: [declaration] },
      { statement: `Há registro interno que sustenta a causa provável (${leading?.cause || "n/d"}).`, responseType: "fact", evidence: corroboratingFacts },
    ];
    const g = checkGrounding(claims, available);

    // Confiança geral = da causa líder, com bônus se corroborada por fato interno.
    const confidence = leading ? Math.round(clamp01(leading.confidence + (corroboratedByInternalFact ? 0.1 : 0)) * 100) / 100 : 0;

    // Escala: high-risk sempre (RN-CRR-4); ou caso sério (critical/risk) SEM corroboração
    // interna — se não dá pra fundamentar e é grave, humano decide.
    const severe = sig.severity === "critical" || sig.severity === "risk";
    const escalate = highRisk || (severe && !corroboratedByInternalFact);

    const headline = highRisk
      ? `Caso de alto risco (${category}): requer apuração humana. IA não conclui nem responde autônomo (RN-CRR-4).`
      : corroboratedByInternalFact && leading
        ? `Causa mais provável: ${leading.cause} (confiança ${Math.round(confidence * 100)}%). Corroborada por registro interno — correlação, não causalidade comprovada.`
        : leading
          ? `Registrado como ALEGAÇÃO do cliente (${leading.cause}); sem corroboração interna ainda — apurar. Alegação ≠ fato (RN-CRR-2).`
          : "Sem causa provável derivável — apurar manualmente.";

    return {
      signalId, found: true, category, highRisk, escalate,
      claim: { statement: claimText, basis: "estimate" },
      facts,
      candidateCauses,
      grounding: { status: g.status, corroboratedByInternalFact, checkedClaims: g.checkedClaims, unsupported: g.unsupported },
      confidence,
      headline,
      contextSignalCount: corr.contextSignalCount || 0,
      investigatedAt: new Date(now).toISOString(),
    };
  }
}

/** Sinal correlato (business_signal) → EvidenceReference (INTERNAL_DB). */
function signalEvidence(e: any): EvidenceReference {
  return { sourceType: "INTERNAL_DB", sourceId: e.signalId || e.id || null, service: "business_signals", field: e.type || e.domain || null, value: e.severity ?? null };
}

export default ReputationInvestigationService;
