/**
 * InstagramCommentReplyCommandHandler (ADR-207 F9b) — handler do comando `instagram_comment_reply`: responde um comentário do Instagram
 * (público) ou por Direct (resposta privada) PELO choke-point governado. Registrado no MESMO registry do executor (§42 — sem runtime
 * paralelo), espelhando `SocialPublishCommandHandler`. O executor só chama `execute` com a ação APROVADA e já barra 2º envio da mesma
 * ação; a trava por comentário vive no `InstagramCommentReplyService.send`. Falha da Meta (inclui permissão ausente) LANÇA — execução
 * auditada como falha e retentável, nunca "respondido" de mentira.
 */
import { CommandExecutorService, type CommandHandler } from "./CommandExecutorService.js";

function payloadOf(action: any): any { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } }

export const InstagramCommentReplyCommandHandler: CommandHandler = {
  key: "InstagramCommentReplyCommandHandler",
  commandTypes: ["instagram_comment_reply"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: p.kind === "private" ? "Resposta por Direct preparada" : "Resposta pública ao comentário preparada",
      artifact: { kind: "instagram_comment_reply_draft", replyKind: p.kind || "public", text: p.text ?? null },
    };
  },

  async execute(orgId, action) {
    const p = payloadOf(action);
    const { InstagramCommentReplyService } = await import("./InstagramCommentReplyService.js");   // import dinâmico: quebra o ciclo service↔handler
    const out = await InstagramCommentReplyService.send(orgId, { intentId: String(p.intentId || ""), commentId: String(p.commentId || ""), kind: p.kind, text: String(p.text || "") });
    if (out.duplicate) return { summary: "Comentário já respondido (idempotente)", artifact: { kind: "instagram_comment_reply", replyKind: p.kind }, effect: "instagram_reply_duplicate", externalRef: null };
    return { summary: p.kind === "private" ? "Resposta enviada por Direct" : "Resposta publicada no comentário", artifact: { kind: "instagram_comment_reply", replyKind: p.kind }, effect: `instagram_reply_${p.kind}`, externalRef: out.externalId ?? null };
  },
};

CommandExecutorService.registerHandler(InstagramCommentReplyCommandHandler);

export default InstagramCommentReplyCommandHandler;
