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

// ── Registry ──────────────────────────────────────────────────────────────
export class BusinessOutcomeResolverRegistry {
  private static resolvers: BusinessOutcomeResolver[] = [CollectionOutcomeResolver];

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

  /** Reset pro estado default (só o de cobrança) — usado em teste. */
  static reset(): void { this.resolvers = [CollectionOutcomeResolver]; }
}

export default BusinessOutcomeResolverRegistry;
