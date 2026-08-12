/**
 * ReputationReplyService + ReputationPublishReplyCommandHandler (ADR-162 / PRD 5
 * §29, §25/§61, F8) — a RESPOSTA PÚBLICA GOVERNADA: o primeiro efeito EXTERNO do
 * módulo. Reusa a cadeia canônica (§29, D4/D5 — nada de motor paralelo):
 *
 *   propor (governado) → aprovar (humano, começa em `approved_execution`) →
 *   `CommandExecutorService.execute` (guardas G1/G2/G3) → HANDLER → provider → confirmação.
 *
 * O provider é chamado **exclusivamente** pelo handler (D4/§29), nunca por serviço de
 * IA. Três guardrails dentro do handler, antes de qualquer publicação:
 *   - GROUNDING (§25/§61, RN-CRR-3): toda afirmação FACTUAL da resposta tem de citar
 *     evidência que EXISTA no caso (fatos da investigação F5). "Reembolso realizado"
 *     sem `refund.confirmed` → UNSUPPORTED_CLAIM → **não publica**. Resposta empática
 *     sem afirmação factual passa (checkGrounding 'skipped'). Determinístico (checkGrounding).
 *   - IDEMPOTÊNCIA (§30/§71): `idempotencyKey = action.id`; e o executor já barra um 2º
 *     `execute` bem-sucedido (nunca publica 2×).
 *   - DEGRADAÇÃO EXPLÍCITA (§6): provider sem capacidade → `manual_required` (resposta
 *     preparada, publicação manual); indisponível → `unavailable` (retry, caso preservado).
 *
 * Publicado com sucesso, arma `ConfirmationEngine.expect(method:'reputation_reply')` — a
 * operação NÃO fecha só porque respondeu (§11.10); a confirmação de fechamento é a F10.
 * Isolado por org (RN-CRR-9).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";
import { ReputationConnectorService } from "./ReputationConnectorService.js";
import { ReputationInvestigationService } from "./ReputationInvestigationService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { checkGrounding, GroundedClaim } from "./skillosModel.js";
import type { EvidenceReference } from "./contextModel.js";

const REPLY_COMMAND = "reputation_publish_reply";
const REPLY_DOMAIN = "recovery";
const REPLY_ACTION_TYPE = "reputation_publish_reply";

const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };
function throwHandler(cls: "retryable" | "external_unavailable" | "permission" | "non_retryable", message: string): never {
  const err = new Error(message) as any; err.errorClass = cls; throw err;
}
function replyDeadline(): string { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString(); }

/**
 * Evidência disponível do caso pro gate de grounding: os FATOS internos da
 * investigação (F5) + a declaração do cliente. Uma afirmação factual da resposta só
 * é "grounded" se citar um desses.
 */
function caseEvidence(orgId: string, signalId: string | null, fallbackId: string): EvidenceReference[] {
  const inv = signalId ? ReputationInvestigationService.investigate(orgId, signalId) : null;
  const declaration: EvidenceReference = { sourceType: "USER_DECLARATION", sourceId: signalId || fallbackId, service: "reputation", field: "complaint" };
  return [...(inv?.facts || []), declaration];
}

// ── HANDLER (CRIAR §29) — registrado no boot; o provider só é tocado aqui (D4). ──
export const ReputationPublishReplyCommandHandler: CommandHandler = {
  key: "ReputationPublishReplyCommandHandler",
  commandTypes: [REPLY_COMMAND],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Resposta pública preparada (${p.itemExternalId || "?"})`, artifact: { kind: "reputation_reply_draft", itemExternalId: p.itemExternalId || null, content: p.content || null, provider: p.provider || "reclame_aqui" } };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    const itemExternalId = String(p.itemExternalId || "").trim();
    const content = String(p.content || "").trim();
    if (!itemExternalId) throwHandler("non_retryable", "reputation_publish_reply exige itemExternalId no payload.");
    if (!content) throwHandler("non_retryable", "reputation_publish_reply exige content não-vazio.");

    // GROUNDING (§25/§61, RN-CRR-3) — antes de qualquer publicação.
    const claims: GroundedClaim[] = Array.isArray(p.claims) ? p.claims : [];
    if (claims.length) {
      const available = caseEvidence(orgId, action.signal_id || null, itemExternalId);
      const g = checkGrounding(claims, available);
      if (g.status === "unsupported") {
        throwHandler("non_retryable", `unsupported_claim: "${g.unsupported.join("; ")}" — resposta factual sem evidência interna NÃO publica (RN-CRR-3/§25).`);
      }
    }

    // Publica pelo provider (transporte). idempotencyKey estável = action.id (§30/§71).
    const provider = String(p.provider || "reclame_aqui");
    const prov = ReputationConnectorService.providerFor(orgId, provider);
    let result;
    try { result = await prov.publishReply({ itemExternalId, content, idempotencyKey: action.id }); }
    catch (e: any) { throwHandler("external_unavailable", `Falha ao publicar resposta: ${e?.message || e}`); }

    if (result.status === "unavailable") throwHandler("external_unavailable", result.detail || "provider indisponível — caso preservado (§68).");
    if (result.status === "manual_required") {
      // Degradação explícita (§6): não finge que publicou. Fica executado com efeito
      // 'manual_required'; o humano publica fora de banda.
      return { summary: "Resposta preparada — publicação MANUAL necessária (§6).", artifact: { kind: "reputation_reply_manual", itemExternalId, content, detail: result.detail || null }, effect: "reputation_reply_manual_required", externalRef: null };
    }

    // published | duplicate
    const replyId = result.externalReplyId || null;
    if (result.status === "published" && replyId) {
      // A operação NÃO fecha só porque respondeu (§11.10) — arma o fechamento (F10).
      try { ConfirmationEngine.expect(orgId, { actionId: action.id, method: "reputation_reply", externalRef: replyId, deadlineAt: replyDeadline() }); }
      catch (e: any) { console.warn("[ReputationReply] expect falhou (resposta já publicada):", e?.message || e); }
    }
    return {
      summary: result.status === "duplicate" ? "Resposta já publicada — idempotência (§30)." : `Resposta pública publicada (${replyId}).`,
      artifact: { kind: "reputation_reply_published", itemExternalId, replyId, status: result.status },
      effect: result.status === "duplicate" ? "reputation_reply_duplicate" : "reputation_reply_published",
      externalRef: replyId,
    };
  },
};
CommandExecutorService.registerHandler(ReputationPublishReplyCommandHandler);

export class ReputationReplyService {
  /** Pré-checagem de grounding (sem publicar) — pra UI avisar antes de propor (§25). */
  static checkGroundingFor(orgId: string, signalId: string, claims: GroundedClaim[]): { status: string; unsupported: string[] } {
    const g = checkGrounding(claims || [], caseEvidence(orgId, signalId, signalId));
    return { status: g.status, unsupported: g.unsupported };
  }

  /** Semeia a política (execute + approved_execution) — "começa approved_execution". */
  private static seedPolicy(orgId: string): void {
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?`).get(orgId, REPLY_DOMAIN, REPLY_ACTION_TYPE) as any;
    if (!pol) db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, 'execute', 'approved_execution', 1)`).run(randomUUID(), orgId, REPLY_DOMAIN, REPLY_ACTION_TYPE);
  }

  /**
   * RASCUNHA a resposta como AÇÃO GOVERNADA (awaiting_approval) — o humano aprova
   * depois (Approval Center, F7). Não publica nada. Devolve a prévia de grounding.
   */
  static draft(orgId: string, signalId: string, input: { content: string; provider?: string; claims?: GroundedClaim[]; createdBy?: string }): { action: any; grounding: { status: string; unsupported: string[] } } | null {
    const sig = db.prepare(`SELECT source_entity_id FROM business_signals WHERE organization_id = ? AND id = ? AND domain = 'reputation'`).get(orgId, signalId) as any;
    if (!sig) return null;
    const content = String(input?.content || "").trim();
    if (!content) throw new Error("content obrigatório.");
    const itemExternalId = sig.source_entity_id || signalId;
    const claims = input.claims || [];
    this.seedPolicy(orgId);
    const grounding = this.checkGroundingFor(orgId, signalId, claims);
    const action = DecisionActionService.propose(orgId, {
      signalId, domain: REPLY_DOMAIN, actionType: REPLY_ACTION_TYPE,
      title: "Responder publicamente à reclamação",
      description: content.slice(0, 200), basis: "hypothesis", confidence: 0.7, expectedImpact: null,
      commandType: REPLY_COMMAND,
      commandPayload: { itemExternalId, content, provider: input.provider || "reclame_aqui", claims },
      createdBy: input.createdBy || "reputation_reply",
    });
    return { action, grounding };
  }

  /** PUBLICA (execute governado) — exige ação APROVADA. Delega ao choke-point (§29). */
  static async publish(orgId: string, actionId: string): Promise<any> {
    return CommandExecutorService.execute(orgId, actionId);
  }
}

export default ReputationReplyService;
