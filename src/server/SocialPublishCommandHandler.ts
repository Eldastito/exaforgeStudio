/**
 * SocialPublishCommandHandler (PRD 10 / ADR-167 F11 — Governed Publishing) — o handler
 * de comando que PUBLICA em canal social PELO choke-point governado. A publicação deixa
 * de ser um efeito direto e vira um COMANDO que passa por `DecisionAction → ApprovalPolicy
 * (Autonomy Contract) → CommandExecutor → ConfirmationEngine` (D4). Registrado no MESMO
 * registry do executor (§42 — sem runtime paralelo), espelhando `CollectionPlaybook`.
 *
 * IDEMPOTÊNCIA DURÁVEL (fecha o que a F1/F3 deixou): o `idempotencyKey` do provider é o
 * `action.id` (estável cross-processo) e o executor já barra 2º `execute` bem-sucedido
 * (`action_already_executed`) — juntos garantem que a MESMA publicação nunca sai 2×.
 * PUBLISHED ≠ RESULTADO (RN-SI-03): no sucesso arma `ConfirmationEngine.expect` (method
 * `social_publish`) — o resultado (engajamento) é confirmado na F12. Degradação honesta:
 * canal sem capacidade (`manual_required`/`capability_unavailable`/`unavailable`) → o
 * handler LANÇA (execução auditada como `failed`, retryável) — nunca finge "publicado".
 */
import { CommandExecutorService, type CommandHandler } from "./CommandExecutorService.js";
import { SocialConnectionService } from "./SocialConnectionService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";
import type { SocialPostKind } from "./SocialChannelProvider.js";

function payloadOf(action: any): any { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } }

export const SocialPublishCommandHandler: CommandHandler = {
  key: "SocialPublishCommandHandler",
  commandTypes: ["social_publish"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Publicação preparada para ${p.channel || "rede social"}${p.variantKey ? ` (variante ${p.variantKey})` : ""}`,
      artifact: { kind: "social_post_draft", channel: p.channel || null, postKind: p.kind || "image", caption: p.caption ?? null, mediaRef: p.mediaRef ?? null, variantKey: p.variantKey ?? null },
    };
  },

  async execute(orgId, action) {
    const p = payloadOf(action);
    const channel = String(p.channel || "instagram");
    const kind = (p.kind || "image") as SocialPostKind;
    const provider = SocialConnectionService.providerFor(orgId, channel);
    // idempotencyKey DURÁVEL = id da ação (estável cross-processo).
    const res = await provider.publish({ kind, caption: p.caption ?? null, mediaRef: p.mediaRef ?? null, idempotencyKey: action.id });

    if (res.status === "published" || res.status === "scheduled") {
      // PUBLISHED ≠ RESULTADO — arma a confirmação do OUTCOME (resolvida na F12).
      try {
        ConfirmationEngine.expect(orgId, { actionId: action.id, method: "social_publish", externalRef: res.externalId ?? null });
      } catch { /* confirmação é aditiva — nunca bloqueia o efeito já realizado */ }
      return { summary: `Publicado em ${channel}`, artifact: { kind: "social_post", channel, postKind: kind, variantKey: p.variantKey ?? null }, effect: `social_${res.status}`, externalRef: res.externalId ?? null };
    }
    if (res.status === "duplicate") {
      // Efeito já saiu antes (idempotência do provider) — no-op seguro.
      return { summary: `Publicação duplicada (idempotente) em ${channel}`, artifact: { kind: "social_post", channel }, effect: "social_duplicate", externalRef: null };
    }
    // manual_required | capability_unavailable | unavailable → falha HONESTA (retryável).
    throw new Error(`Publicação não realizada (${res.status})${res.detail ? `: ${res.detail}` : ""}.`);
  },
};

// Registra no MESMO registry do executor (mesmo padrão de CollectionPlaybook).
CommandExecutorService.registerHandler(SocialPublishCommandHandler);

export default SocialPublishCommandHandler;
