/**
 * BeautyReviewInviteCommandHandler (ADR-169 F13 / BEAUTY-014) — pedido de
 * avaliação (review) governado após atendimento realizado.
 *
 * Registrado no MESMO registry canônico do `CommandExecutorService` (§37 do PRD
 * — sem runtime paralelo), espelhando `SocialPublishCommandHandler`,
 * `GrowthOptimizationCommandHandler` e `CollectionSendReminderHandler`. O
 * comando (`beauty_review_invite`) atravessa `DecisionAction → ApprovalPolicy
 * (Autonomy Contract) → CommandExecutor` (D4) e envia a mensagem via
 * `MessageProviderService.sendMessage` — o sink canônico onde os 3 gates da
 * F5-transversal (consent LGPD + quiet-hours + frequency-cap) já rodam
 * automaticamente. F13 NÃO reimplementa esses freios: só os HERDA.
 *
 * REGRA FUNDANTE — GROUNDED NO ATENDIMENTO REALIZADO:
 * o handler EXIGE que o appointment referenciado exista na org, tenha
 * `status='completed'` (ou 'confirmed' aceito) e seja de contato conhecido.
 * "Cliente que não fez o serviço" NÃO recebe convite pra avaliar (RN-BS-11
 * — nunca infere; se não completou, não pergunta). Não trabalha sobre "o que
 * poderia ter sido"; trabalha sobre o que ASSURED aconteceu.
 *
 * BELT-AND-SUSPENDERS DE CONSENT: mesmo com F5-transversal-A ativa por org,
 * o handler valida DEFENSIVAMENTE `LgpdService.hasConsent(orgId, contactId,
 * 'comunicacoes')` ANTES de chamar o sink. Rationale: F5-A é OPT-IN por org;
 * uma org sem a flag ligada não teria o freio no sink. O handler garante que
 * F13 NUNCA envia review invite sem consent, INDEPENDENTE da postura do sink.
 * É uma REGRA DE PRODUTO da fatia beauty, não um duplicate do guard
 * transversal (que é fatia de plataforma).
 *
 * IDEMPOTÊNCIA HISTÓRICA: se o mesmo appointment já recebeu review invite
 * anteriormente (audit `RUNTIME_BEAUTY_REVIEW_SENT` presente), o handler
 * REJEITA como `non_retryable` — não pede avaliação 2x pro mesmo atendimento.
 *
 * PAYLOAD ESPERADO em `action.command_payload_json`:
 *   {
 *     appointmentId: string,   // atendimento REALIZADO
 *     contactId: string,
 *     phone: string,           // recipient identifier no canal
 *     channelId: string,       // canal WhatsApp/Instagram da org
 *     messageTemplate?: string // opcional; default por serviceName
 *   }
 *
 * DEFAULT COPY: "Oi {contactName}, tudo bem? Aqui é do salão — como foi seu
 * atendimento de {serviceName}? Ficaríamos gratos por uma avaliação rápida
 * ⭐". Nada de invenção — se não tem serviço, usa "atendimento". Sem nome,
 * sem saudação personalizada (RN-BS-11).
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-07 (cross-tenant): appointment/channel/contact validados na
 *    MESMA org do action.
 *  - RN-BS-11 (nunca infere): appointment DEVE existir com status válido;
 *    consent DEVE existir; template não inventa dados.
 *  - RN-BS-12 (autopilot conservador): F13 é HANDLER, roda só quando a
 *    ação já foi APROVADA (via ApprovalPolicy); nunca é chamado direto
 *    pelo autopilot em SHADOW.
 *  - RN-BS-04 (consent tipado): recusa se consent 'comunicacoes' revogado.
 */
import db from "./db.js";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { LgpdService } from "./LgpdService.js";
import { logAuthEvent } from "./auditLog.js";

const OUTBOUND_CONSENT_SCOPE = "comunicacoes";
const COMPLETED_STATUSES = new Set(["completed", "confirmed"]);

function payloadOf(action: any): any {
  try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; }
}

function throwHandler(cls: "retryable" | "external_unavailable" | "permission" | "non_retryable", message: string): never {
  const err = new Error(message) as any;
  err.errorClass = cls;
  throw err;
}

function defaultTemplate(contactName: string | null, serviceName: string | null): string {
  const nomeParte = contactName ? `${contactName}` : "";
  const saudação = nomeParte ? `Oi ${nomeParte}, tudo bem?` : `Oi, tudo bem?`;
  const referente = serviceName ? `atendimento de ${serviceName}` : "seu atendimento";
  return `${saudação} Aqui é do salão — como foi ${referente}? Ficaríamos gratos por uma avaliação rápida ⭐`;
}

export const BeautyReviewInviteCommandHandler: CommandHandler = {
  key: "BeautyReviewInviteCommandHandler",
  commandTypes: ["beauty_review_invite"],

  prepare(orgId, action) {
    const p = payloadOf(action);
    // Rascunho auditável — mostra a mensagem que SERIA enviada; ainda sem
    // efeito externo (o gate de aprovação humana decide se avança).
    const contact = p.contactId
      ? (db.prepare(`SELECT id, name FROM contacts WHERE id = ? AND organization_id = ?`).get(p.contactId, orgId) as any)
      : null;
    const svcName = p.appointmentId
      ? ((db.prepare(
          `SELECT ps.name FROM appointments a
             LEFT JOIN products_services ps ON ps.id = a.product_service_id AND ps.organization_id = a.organization_id
            WHERE a.id = ? AND a.organization_id = ?`,
        ).get(p.appointmentId, orgId) as any)?.name ?? null)
      : null;
    const message = String(p.messageTemplate || defaultTemplate(contact?.name ?? null, svcName)).trim();
    return {
      summary: `Convite de avaliação preparado (contato ${p.contactId || "?"})`,
      artifact: {
        kind: "beauty_review_invite_draft",
        appointmentId: p.appointmentId || null,
        contactId: p.contactId || null,
        phone: p.phone || null,
        channelId: p.channelId || null,
        serviceName: svcName,
        message,
      },
    };
  },

  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);

    // Validação de payload (dead-letter direto se dado ruim — G-4b-5).
    if (!p.appointmentId) throwHandler("non_retryable", "beauty_review_invite exige appointmentId no payload.");
    if (!p.contactId) throwHandler("non_retryable", "beauty_review_invite exige contactId no payload.");
    if (!p.phone) throwHandler("non_retryable", "beauty_review_invite exige phone (recipientIdentifier) no payload.");
    if (!p.channelId) throwHandler("non_retryable", "beauty_review_invite exige channelId no payload.");

    // Isolamento cross-tenant + validação de existência (RN-BS-07/11).
    const ch = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(p.channelId, orgId) as any;
    if (!ch) throwHandler("non_retryable", `channel ${p.channelId} não pertence à org.`);
    if (ch.status === "disabled") throwHandler("external_unavailable", `channel ${p.channelId} está desabilitado.`);

    const contact = db.prepare(`SELECT id, name FROM contacts WHERE id = ? AND organization_id = ?`).get(p.contactId, orgId) as any;
    if (!contact) throwHandler("non_retryable", `contato ${p.contactId} não pertence à org.`);

    const appt = db.prepare(
      `SELECT a.id, a.status, a.contact_id, a.product_service_id, ps.name AS service_name
         FROM appointments a
         LEFT JOIN products_services ps ON ps.id = a.product_service_id AND ps.organization_id = a.organization_id
        WHERE a.id = ? AND a.organization_id = ?`,
    ).get(p.appointmentId, orgId) as any;
    if (!appt) throwHandler("non_retryable", `appointment ${p.appointmentId} não pertence à org.`);
    if (appt.contact_id !== p.contactId) throwHandler("non_retryable", `appointment ${p.appointmentId} não é do contato ${p.contactId}.`);
    if (!COMPLETED_STATUSES.has(String(appt.status || "").toLowerCase())) {
      throwHandler("non_retryable", `appointment ${p.appointmentId} não está 'completed' (atual: ${appt.status || "null"}).`);
    }

    // RN-BS-04 belt-and-suspenders — mesmo com F5-A ativa por org, F13 exige
    // consent 'comunicacoes' como REGRA DE PRODUTO, não delegando ao guard
    // transversal opt-in.
    if (!LgpdService.hasConsent(orgId, p.contactId, OUTBOUND_CONSENT_SCOPE)) {
      throwHandler("permission", `contato ${p.contactId} não tem consent 'comunicacoes' ativo.`);
    }

    // Idempotência histórica — não pede avaliação 2x pro mesmo atendimento.
    const already = db.prepare(
      `SELECT id FROM auth_audit_logs
        WHERE organization_id = ? AND event_type = 'RUNTIME_BEAUTY_REVIEW_SENT'
          AND target_user_id = ?
        LIMIT 1`,
    ).get(orgId, p.appointmentId);
    if (already) {
      throwHandler("non_retryable", `appointment ${p.appointmentId} já recebeu review invite anteriormente.`);
    }

    // Copy: template do payload OU default determinístico (nunca inventa dados).
    const message = String(
      p.messageTemplate || defaultTemplate(contact.name ?? null, appt.service_name ?? null),
    ).trim();

    // Envia via sink — os 3 gates da F5-transversal (consent LGPD +
    // quiet-hours + frequency-cap) rodam AUTOMATICAMENTE ali dentro. Se
    // qualquer um bloqueia, o sink lança e o handler propaga como
    // `external_unavailable` (o autopilot tenta de novo quando a janela
    // reabre ou o cap desatarrece).
    let messageId: string | undefined;
    try {
      messageId = await MessageProviderService.sendMessage(String(p.channelId), String(p.phone), message);
    } catch (e: any) {
      const code = e?.code || "";
      if (typeof code === "string" && code.startsWith("outbound_blocked:")) {
        throwHandler("external_unavailable", `Envio bloqueado pelos guards F5-transversal: ${code}`);
      }
      throwHandler("external_unavailable", `Falha ao enviar WhatsApp: ${e?.message || e}`);
    }

    // Audit — grava o "aconteceu" pra que a idempotência histórica funcione
    // no próximo execute.
    try {
      logAuthEvent(orgId, "runtime", p.appointmentId, "RUNTIME_BEAUTY_REVIEW_SENT", {
        appointmentId: p.appointmentId,
        contactId: p.contactId,
        phone: p.phone,
        channelId: p.channelId,
        serviceName: appt.service_name || null,
        messageId: messageId || null,
      });
    } catch { /* noop */ }

    return {
      summary: `Convite de avaliação enviado (contato ${p.contactId} → ${p.phone})`,
      artifact: {
        kind: "beauty_review_invite_sent",
        appointmentId: p.appointmentId,
        contactId: p.contactId,
        phone: p.phone,
        channelId: p.channelId,
        serviceName: appt.service_name || null,
        message,
        messageId: messageId || null,
      },
      effect: "beauty_review_invite_sent",
      externalRef: messageId || null,
    };
  },
};

// Registra no MESMO registry canônico do executor.
CommandExecutorService.registerHandler(BeautyReviewInviteCommandHandler);

export default BeautyReviewInviteCommandHandler;
