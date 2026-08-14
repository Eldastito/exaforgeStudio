/**
 * BusinessOutcomeResolver — PRD 8 / ADR-165 F3 (§13, D3, RN-OA): "o problema se resolveu?"
 *
 * A F1 deixou o OUTCOME DE NEGÓCIO como `resolver_pending`: saber se a ação de fato
 * resolveu o problema é DIFERENTE de "a ação foi disparada" (DONE ≠ RESULTADO). Este
 * registry responde essa pergunta perguntando ao SYSTEM-OF-RECORD do domínio — nunca à IA
 * (D3/RN-OA-6: determinístico antes de LLM). Ex.: cobrança → `receivables.status='received'`.
 *
 * Arquitetura: um `BusinessOutcomeResolver` por domínio, registrados num registry. Substitui
 * o array hard-coded que a auditoria apontou no `ConfirmationEngine` (achado — métodos
 * fixos): aqui adicionar um domínio é registrar um resolver, não editar um enum.
 *
 * GUARDRAILS (RN-OA):
 *   - RN-OA-6 — determinístico: pergunta ao dado canônico (SQL), nunca "acha".
 *   - RN-OA-2 — sem evidência no system-of-record → `unknown` (NÃO inventa "resolveu" nem
 *     "falhou"); ausência ≠ falha.
 *   - RN-OA-8 — não inventa dinheiro/confirmação: só reporta o que o dado prova.
 *   - Read-only: só LÊ o system-of-record. Isolado por `organization_id`.
 */
import db from "./db.js";

export type OutcomeVerdict = "confirmed" | "not_confirmed" | "unknown";

export interface ResolverResult {
  resolved: OutcomeVerdict;
  basis: "system_of_record";
  domain: string;
  reason?: string;
  evidence?: any;
}

export interface BusinessOutcomeResolver {
  domain: string;
  /** Este resolver sabe responder por esta ação? (determinístico, sem efeito) */
  appliesTo(action: any): boolean;
  /** Pergunta ao system-of-record. NUNCA inventa: sem prova → unknown. */
  resolve(orgId: string, action: any): ResolverResult;
}

function safeParse(s: any): any { try { return JSON.parse(s); } catch { return null; } }

// ── Resolver de COBRANÇA (golden loop 1) ──────────────────────────────────
// System-of-record: `receivables`. O problema ("recebível em aberto") só está resolvido
// quando o recebível foi PAGO (status='received') — nunca porque a mensagem foi enviada.
const COLLECTION_COMMANDS = new Set(["collection_send_reminder", "asaas_pix_charge"]);

export const CollectionOutcomeResolver: BusinessOutcomeResolver = {
  domain: "collection",
  appliesTo(action: any): boolean {
    return COLLECTION_COMMANDS.has(action?.command_type);
  },
  resolve(orgId: string, action: any): ResolverResult {
    const payload = safeParse(action?.command_payload_json) || {};
    const receivableId = payload.receivableId || payload.receivable_id || null;
    if (!receivableId) {
      // Sem vínculo com o recebível não há como perguntar ao system-of-record (RN-OA-2).
      return { resolved: "unknown", basis: "system_of_record", domain: "collection", reason: "no_receivable_link" };
    }
    const rec = db.prepare("SELECT status, amount, received_at FROM receivables WHERE id = ? AND organization_id = ?").get(receivableId, orgId) as any;
    if (!rec) return { resolved: "unknown", basis: "system_of_record", domain: "collection", reason: "receivable_not_found", evidence: { receivableId } };
    if (rec.status === "received") {
      return { resolved: "confirmed", basis: "system_of_record", domain: "collection", reason: "receivable_received", evidence: { receivableId, amount: rec.amount, receivedAt: rec.received_at } };
    }
    if (rec.status === "canceled") {
      return { resolved: "not_confirmed", basis: "system_of_record", domain: "collection", reason: "receivable_canceled", evidence: { receivableId } };
    }
    // 'open' (ou outro): ainda não pago → não resolvido (mas não é falha — pode pagar depois).
    return { resolved: "not_confirmed", basis: "system_of_record", domain: "collection", reason: "receivable_open", evidence: { receivableId, status: rec.status } };
  },
};

// ── Resolver de RECUPERAÇÃO COMERCIAL (golden loop 2) ─────────────────────
// System-of-record: `sales_recovery_attributions` (FK action_id). O problema
// ("negócio parado") só está resolvido quando o ticket virou `ganho` e foi ATRIBUÍDO —
// enviar mensagem de recuperação não é fechar a venda. `basis` (fact/estimate) vem da linha.
export const SalesRecoveryOutcomeResolver: BusinessOutcomeResolver = {
  domain: "sales_recovery",
  appliesTo(action: any): boolean {
    return typeof action?.command_type === "string" && action.command_type.startsWith("sales_recovery");
  },
  resolve(orgId: string, action: any): ResolverResult {
    const row = db.prepare("SELECT ticket_id, revenue_recovered, basis, source FROM sales_recovery_attributions WHERE action_id = ? AND organization_id = ?").get(action.id, orgId) as any;
    if (row) {
      return { resolved: "confirmed", basis: "system_of_record", domain: "sales_recovery", reason: "deal_won_attributed",
        evidence: { ticketId: row.ticket_id, revenueRecovered: row.revenue_recovered, measurementBasis: row.basis, source: row.source } };
    }
    // Sem atribuição → o negócio ainda não foi ganho por este touch (não é falha — RN-OA-2).
    return { resolved: "not_confirmed", basis: "system_of_record", domain: "sales_recovery", reason: "not_attributed_yet" };
  },
};

// ── Resolver de REPUTAÇÃO (golden loop 3) ─────────────────────────────────
// System-of-record: `business_signals` do caso. O problema só está resolvido quando o caso
// foi FECHADO como `resolved` (ReputationClosureService) — publicar resposta ≠ resolver.
export const ReputationOutcomeResolver: BusinessOutcomeResolver = {
  domain: "reputation",
  appliesTo(action: any): boolean {
    return action?.command_type === "reputation_publish_reply";
  },
  resolve(orgId: string, action: any): ResolverResult {
    let sig: any = null;
    if (action.signal_id) sig = db.prepare("SELECT status FROM business_signals WHERE id = ? AND organization_id = ?").get(action.signal_id, orgId);
    if (!sig && action.correlation_id) sig = db.prepare("SELECT status FROM business_signals WHERE correlation_id = ? AND organization_id = ? ORDER BY detected_at DESC LIMIT 1").get(action.correlation_id, orgId);
    if (!sig) return { resolved: "unknown", basis: "system_of_record", domain: "reputation", reason: "case_not_found" };
    if (sig.status === "resolved") return { resolved: "confirmed", basis: "system_of_record", domain: "reputation", reason: "case_resolved" };
    // open/acknowledged/dismissed → respondeu mas não resolveu (ou reabriu).
    return { resolved: "not_confirmed", basis: "system_of_record", domain: "reputation", reason: `case_${sig.status}` };
  },
};

// ── Resolver de FECHAMENTO DE VAREJO (golden loop 4) ──────────────────────
// System-of-record: `retail_daily_closings`. O problema ("dia sem conferência") só está
// resolvido quando o fechamento foi RECONCILIADO/aprovado (PDV batido) — `divergent` revela
// falta de caixa (problema aberto, não resolvido).
const RETAIL_RESOLVED = new Set(["approved", "reconciled"]);
export const RetailClosingOutcomeResolver: BusinessOutcomeResolver = {
  domain: "retail",
  appliesTo(action: any): boolean {
    return typeof action?.command_type === "string" && action.command_type.startsWith("retail_");
  },
  resolve(orgId: string, action: any): ResolverResult {
    const payload = safeParse(action?.command_payload_json) || {};
    let closing: any = null;
    const closingId = payload.closingId || payload.closing_id;
    if (closingId) closing = db.prepare("SELECT status, divergence_status FROM retail_daily_closings WHERE id = ? AND organization_id = ?").get(closingId, orgId);
    else if (payload.storeId && (payload.closingDate || payload.date)) {
      closing = db.prepare("SELECT status, divergence_status FROM retail_daily_closings WHERE store_id = ? AND closing_date = ? AND organization_id = ?").get(payload.storeId, payload.closingDate || payload.date, orgId);
    }
    if (!closing) return { resolved: "unknown", basis: "system_of_record", domain: "retail", reason: "closing_not_linked" };
    if (RETAIL_RESOLVED.has(closing.status)) return { resolved: "confirmed", basis: "system_of_record", domain: "retail", reason: `closing_${closing.status}` };
    if (closing.status === "divergent" || closing.divergence_status === "divergent") {
      return { resolved: "not_confirmed", basis: "system_of_record", domain: "retail", reason: "closing_divergent", evidence: { status: closing.status, divergence: closing.divergence_status } };
    }
    return { resolved: "not_confirmed", basis: "system_of_record", domain: "retail", reason: `closing_${closing.status}` };
  },
};

// ── Resolver de CONTEÚDO (PRD 11 / ADR-168 F7) ────────────────────────────
// System-of-record: `content_lead_attributions`. O problema ("conteúdo publicado não
// converteu") só está no 1º grau resolvido quando o conteúdo GEROU UM LEAD — publicar (e até
// engajar) NÃO é resultado de negócio (RN-CG-01: ENGAGEMENT ≠ BUSINESS VALUE; um lead é o 1º
// sinal de valor). A F8 estende pra venda→receita→margem. Read-only, pergunta ao dado (D3).
export const ContentOutcomeResolver: BusinessOutcomeResolver = {
  domain: "content",
  appliesTo(action: any): boolean {
    return action?.command_type === "social_publish";
  },
  resolve(orgId: string, action: any): ResolverResult {
    const corr = action?.correlation_id || null;
    if (!corr) {
      // Sem o fio da campanha não há como perguntar ao system-of-record (RN-OA-2).
      return { resolved: "unknown", basis: "system_of_record", domain: "content", reason: "no_correlation_link" };
    }
    const row = db.prepare(
      "SELECT COUNT(*) AS leads FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ?"
    ).get(orgId, corr) as any;
    const leads = Number(row?.leads || 0);
    if (leads > 0) {
      return { resolved: "confirmed", basis: "system_of_record", domain: "content", reason: "lead_generated", evidence: { correlationId: corr, leadCount: leads, stage: "lead" } };
    }
    // Publicou mas ainda não gerou lead → não resolvido (não é falha — pode converter depois).
    return { resolved: "not_confirmed", basis: "system_of_record", domain: "content", reason: "no_lead_yet", evidence: { correlationId: corr } };
  },
};

// ── Registry ──────────────────────────────────────────────────────────────
const DEFAULT_RESOLVERS: BusinessOutcomeResolver[] = [
  CollectionOutcomeResolver, SalesRecoveryOutcomeResolver, ReputationOutcomeResolver, RetailClosingOutcomeResolver,
  ContentOutcomeResolver,
];

export class BusinessOutcomeResolverRegistry {
  private static resolvers: BusinessOutcomeResolver[] = [...DEFAULT_RESOLVERS];

  /** Registra um resolver de domínio (idempotente por instância). F4 adiciona os demais. */
  static register(r: BusinessOutcomeResolver): void {
    if (!this.resolvers.includes(r)) this.resolvers.push(r);
  }

  static domains(): string[] { return this.resolvers.map((r) => r.domain); }

  /**
   * Resolve o outcome de negócio de uma ação. Sem resolver aplicável → `resolver_pending`
   * (honesto — nem todo domínio foi instrumentado ainda; RN-OA-2, não inventa).
   */
  static resolve(orgId: string, action: any): ResolverResult {
    const r = this.resolvers.find((x) => { try { return x.appliesTo(action); } catch { return false; } });
    if (!r) return { resolved: "unknown", basis: "system_of_record", domain: action?.domain || "unknown", reason: "resolver_pending" };
    try { return r.resolve(orgId, action); }
    catch { return { resolved: "unknown", basis: "system_of_record", domain: r.domain, reason: "resolver_error" }; }
  }

  /** Reset pro estado default (os quatro golden loops) — usado em teste. */
  static reset(): void { this.resolvers = [...DEFAULT_RESOLVERS]; }
}

export default BusinessOutcomeResolverRegistry;
