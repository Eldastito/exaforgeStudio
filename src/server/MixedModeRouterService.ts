/**
 * Roteador do MODO MISTO (PRD WhatsApp Unificado — RF-04 §10, F3.3a).
 *
 * Decide, para uma mensagem inbound JÁ validada/deduplicada/classificada como
 * individual (F1.2a/F1.2b fazem isso ANTES), em qual FAIXA ela cai — seguindo a
 * ordem de processamento do §10:
 *
 *   4. Resolve o remetente e o acesso atual (SEM carregar dado de negócio) —
 *      compõe `SenderIdentityService` (F3.1b) + o vínculo VERIFICADO por posse
 *      (`PhonePossessionService`, F3.2, que tem precedência sobre o match
 *      tolerante).
 *   5/6. Com contexto interno autorizado → entrada interna; contexto de
 *      cliente → atendimento.
 *   7. Remetente com os DOIS papéis e SEM contexto claro → pedir escolha
 *      (`ask_which`). NUNCA inferir acesso por linguagem natural — por isso a
 *      decisão NÃO olha o texto da mensagem.
 *   8. Só o `attendance` autoriza criar contato/ticket/CRM (quem consome, F3.3b).
 *
 * Função PURA de decisão: lê identidade (org-scoped) mas NÃO escreve nada, NÃO
 * cria CRM, NÃO responde. Ninguém a consome ainda — a fiação no webhook, atrás
 * da flag `mixed_mode_enabled`, é a F3.3b. Logo esta fatia é 0-regressão.
 *
 * Guardrails:
 * - Desconhecido em canal interno → `reject_unknown_internal` (não vaza gestão).
 * - Identidade AMBÍGUA (F3.1b) sem vínculo verificado, num caminho que exige
 *   saber QUEM → `ambiguous_identity` (pendente; o vínculo verificado da F3.2
 *   resolve). Nunca "chuta" a pessoa.
 * - Papel só vem do usuário resolvido (F3.1a/§73) — presença em
 *   `authorized_managers` não vira papel.
 * - Mensagem própria (`fromMe`) → `skip` (§10.3, não aciona o bot).
 */
import { SenderIdentityService } from "./SenderIdentityService.js";
import { PhonePossessionService } from "./PhonePossessionService.js";

export type MixedModeLane =
  | "skip"                    // mensagem própria / não aciona o bot
  | "attendance"              // trata como cliente (único que cria CRM)
  | "internal"                // gestão interna (Controller/Coordenador/FalaTu)
  | "ask_which"               // papel duplo, contexto ambíguo → perguntar (§10.7)
  | "reject_unknown_internal" // desconhecido num canal interno
  | "ambiguous_identity";     // pessoa conhecida mas ambígua num caminho que exige QUEM

export interface MixedModeDecision {
  lane: MixedModeLane;
  /** Usuário resolvido (quando há um único). null em attendance/rejeição/ambíguo. */
  userId: string | null;
  /** Papel REAL do usuário (F3.1a). null sem usuário resolvido. */
  role: string | null;
  /** Só filiação em authorized_managers, sem usuário casado (não eleva). */
  legacyManagerOnly: boolean;
  /** Confiança do vínculo de identidade: 'high' (verificado/exato) … 'none'. */
  confidence: string;
  /** Motivo legível da decisão (audit/observabilidade). */
  reason: string;
}

export interface MixedModeInput {
  /** `channels.kind` do canal resolvido ('internal' | 'client' | outro/default). */
  channelKind?: string | null;
  /** Mensagem do próprio número conectado (§10.3). */
  isFromMe?: boolean;
  /**
   * Contexto ATIVO da conversa (§10.5), fornecido pelo chamador — o roteador
   * não lê estado de conversa (mantém-se puro). Quando um recorte é claro, ele
   * decide a faixa sem precisar perguntar.
   */
  hasActiveCustomerContext?: boolean;
  hasActiveInternalContext?: boolean;
}

export class MixedModeRouterService {
  static route(orgId: string, senderId: string, input: MixedModeInput = {}): MixedModeDecision {
    const base = { userId: null as string | null, role: null as string | null, legacyManagerOnly: false, confidence: "none" };

    if (input.isFromMe) return { ...base, lane: "skip", reason: "own_message" };
    if (!orgId || !String(senderId || "").trim()) return { ...base, lane: "skip", reason: "no_sender" };

    const id = SenderIdentityService.resolve(orgId, senderId);
    const verified = PhonePossessionService.verifiedBinding(orgId, senderId);

    // Vínculo VERIFICADO por posse tem precedência: dá o userId definitivo e
    // desfaz a ambiguidade do match tolerante (F3.2 > F3.1b).
    const resolvedUserId = verified?.userId ?? (id.ambiguous ? null : id.user?.id ?? null);
    const role = resolvedUserId && !verified ? id.role : (verified ? (resolvedUserId === id.user?.id ? id.role : null) : null);
    const legacyManagerOnly = id.legacyManagerOnly && !resolvedUserId;
    const isKnownInternal = !!resolvedUserId || id.isAuthorizedManager;
    const confidence = verified ? (verified.confidence || "high") : id.confidence;

    const kind = String(input.channelKind || "client");

    // ── Canal INTERNO (dedicado à gestão) ──
    if (kind === "internal") {
      if (resolvedUserId || id.isAuthorizedManager) {
        return { ...base, lane: "internal", userId: resolvedUserId, role, legacyManagerOnly, confidence, reason: "internal_channel_known_sender" };
      }
      // Conhecido porém AMBÍGUO (2+ usuários casam, sem vínculo verificado):
      // não sabemos QUEM → pendente, nunca escolhe.
      if (id.ambiguous) {
        return { ...base, lane: "ambiguous_identity", confidence: id.confidence, reason: "internal_channel_ambiguous_sender" };
      }
      return { ...base, lane: "reject_unknown_internal", reason: "internal_channel_unknown_sender" };
    }

    // ── Canal de ATENDIMENTO (client/default) ──
    // Não-reconhecido como interno → cliente (o caso comum, 0-regressão).
    if (!isKnownInternal) {
      return { ...base, lane: "attendance", confidence, reason: "client_channel_customer" };
    }

    // Reconhecido como interno num canal de atendimento = MODO MISTO (§10.6/7).
    // Contexto claro decide a faixa; senão pergunta (nunca infere por texto).
    if (input.hasActiveCustomerContext && !input.hasActiveInternalContext) {
      return { ...base, lane: "attendance", userId: resolvedUserId, role, legacyManagerOnly, confidence, reason: "mixed_customer_context" };
    }
    if (input.hasActiveInternalContext && !input.hasActiveCustomerContext) {
      return { ...base, lane: "internal", userId: resolvedUserId, role, legacyManagerOnly, confidence, reason: "mixed_internal_context" };
    }
    return { ...base, lane: "ask_which", userId: resolvedUserId, role, legacyManagerOnly, confidence, reason: "dual_role_no_clear_context" };
  }
}

export default MixedModeRouterService;
