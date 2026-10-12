import { randomUUID } from "crypto";
import db from "./db.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { CommandExecutorService } from "./CommandExecutorService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { InstagramService } from "./InstagramService.js";
// Registra o handler no MESMO registry do executor (efeito colateral de import — igual ao GovernedPublishService).
import "./InstagramCommentReplyCommandHandler.js";

/**
 * InstagramCommentReplyService (ADR-207 F9b) — responder um comentário do Instagram (público) ou por Direct (resposta privada),
 * SEMPRE como COMANDO GOVERNADO: `DecisionAction → ApprovalPolicy → CommandExecutor` (D4, §42 — sem motor/policy/runtime paralelo).
 *
 *  - `propose` NÃO envia nada: cria a ação em `awaiting_approval` (política padrão `single` = uma pessoa aprova; o Autonomy Contract do
 *    dono pode ajustar). O texto parte do rascunho da F9a e o dono pode editá-lo; reclamação não tem rascunho — o texto é do dono.
 *  - `send` (chamado pelo handler, só sobre ação APROVADA) fala com a Graph API da Meta. O executor já barra o 2º envio da mesma ação;
 *    aqui há uma trava durável por comentário (`replied_public_at` / `replied_private_at`) para nunca responder 2× o mesmo comentário.
 *  - Resposta PRIVADA: a Meta permite 1 por comentário e só até 7 dias depois do comentário — checado ao propor E ao enviar.
 *  - Permissão da Meta ausente (App Review) → o envio FALHA com "Aguardando permissão da Meta (escopo)" (execução auditada como falha,
 *    retentável) — nunca finge que respondeu e não marca como respondido.
 *  - O texto do CLIENTE nunca entra na resposta (o rascunho da F9a já nasce sem ele); o que o dono digita é sanitizado.
 *  - Isolado por empresa (orgId 1º arg); sem tabela nova (2 colunas aditivas em `instagram_comment_intents`).
 */
export type ReplyKind = "public" | "private";
const PRIVATE_WINDOW_DAYS = 7;
const MAX_PUBLIC_CHARS = 2000;
const MAX_PRIVATE_BYTES = 1000;
const TYPE = "instagram_comment_reply";

const clean = (t: unknown) => String(t ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").replace(/[ \t]+/g, " ").trim();

export class InstagramCommentReplyService {
  /** Transporte HTTP injetável (teste sem rede). Produção usa o `fetch` global. */
  static transport: typeof fetch | null = null;

  private static row(orgId: string, intentId: string): any | undefined {
    return db.prepare("SELECT * FROM instagram_comment_intents WHERE id = ? AND organization_id = ?").get(String(intentId || ""), orgId) as any;
  }

  /** Resposta privada ainda dentro da janela de 7 dias da Meta? (usa o instante em que o comentário chegou ao sistema) */
  private static withinPrivateWindow(orgId: string, intentId: string): boolean {
    return !!db.prepare("SELECT 1 FROM instagram_comment_intents WHERE id = ? AND organization_id = ? AND datetime(created_at) >= datetime('now', ?)").get(intentId, orgId, `-${PRIVATE_WINDOW_DAYS} days`);
  }

  private static validateText(kind: ReplyKind, text: string) {
    if (!text) throw new Error("Escreva o texto da resposta (comentários de reclamação não têm rascunho automático).");
    if (kind === "public" && text.length > MAX_PUBLIC_CHARS) throw new Error(`A resposta pública passa de ${MAX_PUBLIC_CHARS} caracteres.`);
    if (kind === "private" && Buffer.byteLength(text, "utf8") > MAX_PRIVATE_BYTES) throw new Error("A resposta por Direct passa do limite de 1000 bytes (encurte o texto).");
  }

  /** Ação aberta (aguardando ou aprovada) para este comentário+tipo, se houver. */
  private static openAction(orgId: string, intentId: string, kind: ReplyKind): any | undefined {
    const rows = db.prepare("SELECT * FROM decision_actions WHERE organization_id = ? AND action_type = ? AND status IN ('awaiting_approval','approved') AND command_payload_json LIKE ?").all(orgId, TYPE, `%"intentId":"${intentId}"%`) as any[];
    return rows.find((r) => { try { return JSON.parse(r.command_payload_json || "{}").kind === kind; } catch { return false; } });
  }

  /** Propõe a resposta como comando governado. NÃO envia. */
  static propose(orgId: string, actorId: string | null, input: { intentId: string; kind: ReplyKind; text?: string | null }) {
    const kind = input.kind;
    if (kind !== "public" && kind !== "private") throw new Error("Tipo inválido (use public ou private).");
    const r = this.row(orgId, input.intentId);
    if (!r) throw new Error("Comentário não encontrado.");
    if (r.status === "dismissed") throw new Error("Este comentário foi dispensado.");
    if (kind === "public" && r.replied_public_at) throw new Error("Este comentário já recebeu a resposta pública.");
    if (kind === "private" && r.replied_private_at) throw new Error("A Meta permite uma única resposta privada por comentário, e ela já foi enviada.");
    if (kind === "private" && !this.withinPrivateWindow(orgId, r.id)) throw new Error(`A resposta privada só é permitida até ${PRIVATE_WINDOW_DAYS} dias depois do comentário — esse prazo passou.`);

    const text = clean(input.text != null && String(input.text).trim() ? input.text : r.draft_reply);
    this.validateText(kind, text);

    const existing = this.openAction(orgId, r.id, kind);
    if (existing) return { action: existing, deduped: true as const };

    if (!db.prepare("SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'social' AND action_type = ?").get(orgId, TYPE)) {
      db.prepare("INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'social', ?, 'execute', 'approved_execution', 1)").run(randomUUID(), orgId, TYPE);
    }
    const who = r.from_username ? `@${r.from_username}` : "o comentarista";
    const action = DecisionActionService.propose(orgId, {
      domain: "social", actionType: TYPE,
      title: kind === "public" ? `Responder ${who} no comentário` : `Responder ${who} por Direct`,
      description: text.slice(0, 200),
      commandType: TYPE,
      commandPayload: { intentId: r.id, commentId: r.comment_id, kind, text, fromUsername: r.from_username ?? null },
      createdBy: actorId || "owner",
    });
    return { action, deduped: false as const };
  }

  /** Efeito externo. Chamado SÓ pelo handler, depois do executor confirmar que a ação está APROVADA. */
  static async send(orgId: string, payload: { intentId: string; commentId: string; kind: ReplyKind; text: string }) {
    const r = this.row(orgId, payload.intentId);
    if (!r) throw new Error("Comentário não encontrado.");
    const kind = payload.kind;
    if (kind === "public" && r.replied_public_at) return { duplicate: true as const };
    if (kind === "private" && r.replied_private_at) return { duplicate: true as const };
    if (kind === "private" && !this.withinPrivateWindow(orgId, r.id)) throw new Error(`A resposta privada só é permitida até ${PRIVATE_WINDOW_DAYS} dias depois do comentário — esse prazo passou.`);
    this.validateText(kind, clean(payload.text));
    if (!InstagramService.isConnected(orgId)) throw new Error("Instagram não conectado.");

    const f = this.transport || fetch;
    const res = kind === "public"
      ? await InstagramService.replyToComment(orgId, r.comment_id, clean(payload.text), f)
      : await InstagramService.privateReply(orgId, r.comment_id, clean(payload.text), f);

    // Só chega aqui se a Meta aceitou: marca durável + sai da fila de atenção.
    db.prepare(`UPDATE instagram_comment_intents SET ${kind === "public" ? "replied_public_at" : "replied_private_at"} = CURRENT_TIMESTAMP, status = CASE WHEN status = 'new' THEN 'answered' ELSE status END WHERE id = ? AND organization_id = ?`).run(r.id, orgId);
    try { BusinessSignalService.resolveByDedupe(orgId, `ig.comment|${r.id}`); } catch { /* best-effort */ }
    return { duplicate: false as const, externalId: res.id };
  }

  /** Executa uma ação de resposta APROVADA pelo choke-point governado (recusa se não aprovada). */
  static execute(orgId: string, actionId: string): Promise<any> {
    return CommandExecutorService.execute(orgId, actionId);
  }
}

export default InstagramCommentReplyService;
