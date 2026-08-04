import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";
import { SalesStalledDealDetectorService, type StalledDeal } from "./SalesStalledDealDetectorService.js";
import { SalesRecoveryMessageGenerator } from "./SalesRecoveryMessageGenerator.js";
import type { PlaybookDefinition } from "./PlaybookEngine.js";

/**
 * Piloto 3 do Execution Runtime — RECUPERAÇÃO COMERCIAL (ADR-152 F4c).
 *
 * MVP em modo `approved_execution` — NUNCA envia mensagem sem aprovação
 * humana. Respeita a decisão pendente #4 (LGPD signoff) e a R10 (F4c
 * permanece em assisted/approved até revisão jurídica).
 *
 * Playbook `sales_recovery_v1` (1 step atômico):
 *   propose_recovery_message →
 *     (1) valida payload (ticketId, contactId, phone, channelId, stage);
 *     (2) gera mensagem de reengajamento via LLM (fallback template);
 *     (3) publica business_signal `sales_recovery_proposed` com o TEXTO
 *         proposto + evidência (stage, dias parados);
 *     (4) NÃO envia. Retorna `{effect: 'proposed'}`. O envio real
 *         acontece via `SalesRecoveryPlaybookService.approve(signalId,
 *         messageOverride?)` — rota HTTP com auth+RBAC.
 *   → $end (process_instance vira 'completed' — o Runtime fez sua parte).
 *
 * Guarda MASSIVA G-4c-1: nenhuma mensagem sai do Runtime sem que o
 * dono aprove EXPLICITAMENTE via UI/API. Isso é o que permite F4c
 * rodar em produção HOJE, antes do LGPD signoff — a resposta é PROPOR,
 * nunca ENVIAR autonomamente.
 *
 * F4c.2+ (após LGPD signoff) pode adicionar modo "auto-approve dentro
 * de política (max N envios/dia, contatos com opt-in explícito, etc)"
 * — mas isso NÃO é escopo desta fatia.
 *
 * Guardas RN F4c (documentadas + testadas):
 *   G-4c-1: NUNCA envia autonomamente — playbook só PROPÕE via sinal.
 *   G-4c-2: Opt-in por org (`sales_recovery_enabled=1` default 0).
 *   G-4c-3: Isolamento cross-tenant.
 *   G-4c-4: Dedupe do processo por ticketId (startForSubject).
 *   G-4c-5: Idempotência do sinal via dedupeKey (evita spam se detector
 *           varrer o mesmo ticket em ticks consecutivos antes do
 *           dono aprovar/dispensar).
 *   G-4c-6: LLM ausente → fallback template + source='template'.
 *   G-4c-7: `approve()` valida sinal ATIVO (status='open') — não
 *           reenviar se dono já aprovou/dispensou.
 *   G-4c-8: `approve()` publica outcome F3.1 com `revenueRecovered=0`
 *           (o valor final vem quando ticket vira 'ganho' — F4c.3 mede).
 *   G-4c-9: Ticket deve continuar `open` + stage no funil na hora de
 *           aprovar (senão retorna erro; ticket pode ter fechado
 *           entre o proponente e o dono clicar).
 */

const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };

const throwHandler = (cls: "retryable" | "external_unavailable" | "permission" | "non_retryable", message: string): never => {
  const err = new Error(message) as any;
  err.errorClass = cls;
  throw err;
};

// ── Handler ──────────────────────────────────────────────────────────────

/**
 * `sales_recovery_propose_message` — recebe o payload do deal parado,
 * gera a msg e publica sinal. NÃO envia. A execução acontece em
 * `approved_execution` como qualquer handler — mas o efeito lateral é
 * apenas "publicar sinal" (nada externo).
 */
const SalesRecoveryProposeHandler: CommandHandler = {
  key: "SalesRecoveryProposeHandler",
  commandTypes: ["sales_recovery_propose_message"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Rascunho de mensagem de reengajamento pra ${p.contactName || p.ticketId} (stage=${p.stage})`,
      artifact: { kind: "sales_recovery_draft", ticketId: p.ticketId, contactId: p.contactId, stage: p.stage, daysStalled: p.daysStalled },
    };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    if (!p.ticketId) throwHandler("non_retryable", "sales_recovery_propose_message exige ticketId no payload.");
    if (!p.contactId) throwHandler("non_retryable", "sales_recovery_propose_message exige contactId.");
    if (!p.phone) throwHandler("non_retryable", "sales_recovery_propose_message exige phone.");
    if (!p.channelId) throwHandler("non_retryable", "sales_recovery_propose_message exige channelId.");

    // Reconfirma ticket ainda `open` + stage no funil (o processo pode
    // ter ficado dias na fila entre detecção e execução).
    const ticket = db.prepare(`SELECT status, stage FROM tickets WHERE id = ? AND organization_id = ?`).get(p.ticketId, orgId) as any;
    if (!ticket) throwHandler("non_retryable", `ticket ${p.ticketId} não pertence à org.`);
    if (ticket.status !== "open") throwHandler("non_retryable", `ticket ${p.ticketId} não está 'open' (atual: ${ticket.status}).`);
    if (!SalesStalledDealDetectorService.getSalesStages().includes(String(ticket.stage))) {
      throwHandler("non_retryable", `ticket ${p.ticketId} saiu do funil (stage=${ticket.stage}).`);
    }

    // Gera msg (LLM ou fallback template).
    let gen: { text: string; source: "llm" | "template" };
    try {
      gen = await SalesRecoveryMessageGenerator.generate({
        contactName: p.contactName || null,
        stage: String(ticket.stage),
        daysStalled: Number(p.daysStalled || 0),
      });
    } catch (e: any) {
      // NUNCA propaga throw — usa fallback.
      gen = { text: `Oi! Faz um tempo que a gente não conversa por aqui. Posso te ajudar em algo?`, source: "template" };
    }

    // Publica sinal com proposta. UI/aba Operações lista e permite aprovar.
    // Dedupe por ticket + dia — se o detector varrer 2× no mesmo dia
    // (antes do dono decidir), atualiza mesma linha em vez de duplicar.
    const todayIso = new Date().toISOString().slice(0, 10);
    const dedupeKey = `sales_recovery:proposed:${p.ticketId}:${todayIso}`;
    let signalId: string | null = null;
    try {
      const pub = BusinessSignalService.publish(orgId, {
        domain: "sales",
        signalType: "sales_recovery_proposed",
        severity: "attention",
        basis: "estimate",
        confidence: gen.source === "llm" ? 0.8 : 0.5,
        sourceService: "SalesRecoveryPlaybook",
        sourceEntityType: "ticket",
        sourceEntityId: p.ticketId,
        evidence: {
          ticketId: p.ticketId,
          contactId: p.contactId,
          contactName: p.contactName || null,
          phone: p.phone,
          channelId: p.channelId,
          stage: ticket.stage,
          daysStalled: Number(p.daysStalled || 0),
          proposedText: gen.text,
          messageSource: gen.source,
          actionId: action.id,
        },
        dedupeKey,
      });
      signalId = pub.id;
    } catch (e: any) { throwHandler("retryable", `BusinessSignal.publish falhou: ${e?.message || e}`); }

    try {
      logAuthEvent(orgId, null, p.contactId, "RUNTIME_SALES_RECOVERY_PROPOSED", {
        ticketId: p.ticketId, stage: ticket.stage, daysStalled: p.daysStalled,
        messageSource: gen.source, signalId,
      });
    } catch { /* noop */ }

    return {
      summary: `Rascunho pra ${p.contactName || p.ticketId}: "${gen.text.slice(0, 60)}${gen.text.length > 60 ? "…" : ""}"`,
      artifact: {
        kind: "sales_recovery_proposed",
        ticketId: p.ticketId, contactId: p.contactId, stage: ticket.stage,
        proposedText: gen.text, messageSource: gen.source, signalId,
      },
      effect: "sales_recovery_proposed",
      externalRef: signalId || undefined,
    };
  },
};

CommandExecutorService.registerHandler(SalesRecoveryProposeHandler);

// ── Playbook ─────────────────────────────────────────────────────────────

export const SALES_RECOVERY_V1: PlaybookDefinition = {
  startStep: "propose",
  steps: [
    {
      id: "propose",
      commandType: "sales_recovery_propose_message",
      successCondition: { op: "truthy", path: "results.propose.signalId" },
      timeoutSeconds: 30,
      maxAttempts: 2,
      onFailure: "escalate",
      next: "$end",
    },
  ],
};

// ── Service ──────────────────────────────────────────────────────────────

export interface ApproveInput { messageOverride?: string; actorId: string; }
export interface ApproveResult {
  sent: boolean;
  messageId?: string;
  finalText: string;
  ticketId: string;
  signalStatus: "resolved" | "kept_open";
  error?: string;
}

export interface DismissInput { actorId: string; reason?: string; }

/**
 * Detecção + kickoff. Uso do padrão F4a/F4b:
 *   seed()  — cria definição idempotente.
 *   detectAndProposeAll(orgId) — combo: detecta + inicia + roda pra completed.
 *   approve(signalId, ...) — envia msg via MessageProviderService (aprovação humana).
 *   dismiss(signalId, ...) — resolve sinal sem enviar.
 */
export class SalesRecoveryPlaybookService {
  static seed(orgId: string, actorId?: string): any {
    const existing = ProcessRuntimeService.latestActiveDefinition(orgId, "sales_recovery_v1");
    if (existing) return existing;
    return ProcessRuntimeService.defineProcess(orgId, {
      processType: "sales_recovery_v1",
      name: "Recuperação Comercial (proposta)",
      description: "Detecta deals parados no funil e PROPÕE mensagem de reengajamento. Não envia autonomamente — aprovação humana obrigatória. F4c MVP em approved_execution.",
      triggerType: "manual",
      objective: "Sem oportunidades qualificadas paradas > N dias sem próxima ação PROPOSTA pro dono.",
      autonomyLevelDefault: "execute",
      slaDefinition: { deadline: "N/A (sinal fica aberto até dono decidir)", timezone: "America/Sao_Paulo" },
      steps: SALES_RECOVERY_V1,
    }, actorId);
  }

  /**
   * Dispara UM processo pra um ticket específico. Dedupe automático via
   * `startForSubject` (subject=ticket:ticketId). Retorna a instance.
   */
  static async proposeForTicket(orgId: string, deal: StalledDeal, createdBy?: string): Promise<any> {
    const inst = ProcessRuntimeService.startForSubject(orgId, {
      processType: "sales_recovery_v1",
      subjectType: "ticket",
      subjectId: deal.ticketId,
      context: {
        ticketId: deal.ticketId,
        contactId: deal.contactId,
        contactName: deal.contactName,
        phone: deal.contactPhone,
        channelId: deal.channelId,
        stage: deal.stage,
        temperature: deal.temperature,
        daysStalled: deal.daysSinceLastActivity,
      },
      priority: Math.min(10, Math.max(1, Math.floor(deal.daysSinceLastActivity / 3))),
      riskLevel: "low",
      expectedValue: null,
      createdBy: createdBy || null,
    }, createdBy || undefined);
    // Roda o playbook até completar (só 1 step — vai pra completed).
    await ProcessRuntimeService.runToCompletion(orgId, inst.id, { actor: createdBy });
    return inst;
  }

  /**
   * Combo pra Scheduler: detecta todos os parados + roda proposta pra cada.
   * Idempotente pelo dedupe de subject vivo (processo pra ticket que já
   * tem instance viva → devolve a mesma; sinal dedupado por dia).
   */
  static async detectAndProposeAll(orgId: string, opts: { stalledDays?: number; limit?: number } = {}): Promise<{ detected: number; proposed: number; skipped: number }> {
    const deals = SalesStalledDealDetectorService.detect(orgId, opts);
    let proposed = 0, skipped = 0;
    for (const deal of deals) {
      try { await this.proposeForTicket(orgId, deal, "runtime"); proposed++; }
      catch (e: any) { skipped++; console.warn("[SalesRecovery] proposeForTicket falhou pra ticket", deal.ticketId, e?.message); }
    }
    return { detected: deals.length, proposed, skipped };
  }

  /**
   * DONO APROVA — ENVIA a mensagem via WhatsApp e resolve o sinal.
   * `messageOverride` permite ao dono editar o texto antes de enviar
   * (fluxo padrão: dono revisa proposta, ajusta o texto, aprova).
   *
   * Guardas:
   *   - Sinal precisa estar 'open' (não já resolvido/dispensado).
   *   - Ticket precisa continuar 'open' + stage no funil.
   *   - Envio best-effort — falha registra sinal `sales_recovery_send_failed`.
   */
  static async approve(orgId: string, signalId: string, input: ApproveInput): Promise<ApproveResult> {
    const sig = db.prepare(`SELECT * FROM business_signals WHERE id = ? AND organization_id = ? AND signal_type = 'sales_recovery_proposed'`).get(signalId, orgId) as any;
    if (!sig) throw new Error("Sinal não encontrado.");
    if (sig.status !== "open") throw new Error(`Sinal já resolvido (${sig.status}).`);
    const evidence = sig.evidence_json ? JSON.parse(sig.evidence_json) : {};
    const ticketId: string = evidence.ticketId;
    const phone: string = evidence.phone;
    const channelId: string = evidence.channelId;
    if (!ticketId || !phone || !channelId) throw new Error("Sinal sem dados suficientes (ticketId/phone/channelId).");

    // Reconfirma ticket state.
    const ticket = db.prepare(`SELECT status, stage FROM tickets WHERE id = ? AND organization_id = ?`).get(ticketId, orgId) as any;
    if (!ticket || ticket.status !== "open") throw new Error(`Ticket ${ticketId} não está mais 'open'.`);
    if (!SalesStalledDealDetectorService.getSalesStages().includes(String(ticket.stage))) {
      throw new Error(`Ticket ${ticketId} saiu do funil (stage=${ticket.stage}).`);
    }

    // ADR-152 F4c.2 — LGPD Art.8 §5. Se o contato pediu opt-out (via
    // reply intent=remove_me OU marcação manual), NÃO envia nova msg.
    // Erro claro pra a UI destacar "contato optou por não receber".
    const contactId: string | null = evidence.contactId || null;
    if (contactId) {
      const contact = db.prepare(`SELECT marketing_opt_out FROM contacts WHERE id = ? AND organization_id = ?`).get(contactId, orgId) as any;
      if (contact && Number(contact.marketing_opt_out) === 1) {
        // Dispensa o sinal automaticamente pra não ficar poluindo o painel.
        try { BusinessSignalService.resolveByDedupe(orgId, sig.dedupe_key); } catch { /* noop */ }
        try {
          logAuthEvent(orgId, input.actorId, contactId, "RUNTIME_SALES_RECOVERY_BLOCKED_OPT_OUT", {
            ticketId, signalId, phone,
          });
        } catch { /* noop */ }
        throw new Error("Contato optou por não receber mensagens (LGPD Art.8 §5). Proposta descartada automaticamente.");
      }
    }

    const finalText = (input.messageOverride || evidence.proposedText || "").toString().trim().slice(0, 1000);
    if (!finalText) throw new Error("Mensagem vazia — nada a enviar.");

    let messageId: string | undefined;
    try { messageId = await MessageProviderService.sendMessage(channelId, phone, finalText); }
    catch (e: any) {
      // Envio falhou — publica sinal fail (dedupe por signal_id) + mantém aberto.
      try {
        BusinessSignalService.publish(orgId, {
          domain: "sales", signalType: "sales_recovery_send_failed", severity: "attention",
          basis: "fact", confidence: 1, sourceService: "SalesRecoveryPlaybookService",
          sourceEntityType: "ticket", sourceEntityId: ticketId,
          evidence: { proposedSignalId: signalId, ticketId, error: e?.message || String(e) },
          dedupeKey: `sales_recovery:send_failed:${signalId}`,
        });
      } catch { /* noop */ }
      try { logAuthEvent(orgId, input.actorId, null, "RUNTIME_SALES_RECOVERY_SEND_FAILED", { ticketId, signalId, error: e?.message || String(e) }); } catch { /* noop */ }
      return { sent: false, finalText, ticketId, signalStatus: "kept_open", error: e?.message || String(e) };
    }

    // Sucesso — resolve o sinal + publica outcome F3.1 + audit.
    try { BusinessSignalService.resolveByDedupe(orgId, sig.dedupe_key); } catch { /* noop */ }
    // Toca `tickets.updated_at` — sinaliza atividade no ticket pra o
    // detector NÃO re-propor amanhã (a mensagem foi enviada).
    try { db.prepare(`UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(ticketId, orgId); } catch { /* noop */ }
    // ADR-152 F4c.2 — registra touch pra o SalesRecoveryReplyService
    // poder correlacionar a resposta do cliente. Import dinâmico pra
    // quebrar ciclo (SalesRecoveryReplyService importa BusinessSignal
    // que pode importar isso). Best-effort — se falha, o loop de envio
    // continua funcionando, só perde o registro do touch.
    try {
      const { SalesRecoveryReplyService } = await import("./SalesRecoveryReplyService.js");
      SalesRecoveryReplyService.recordTouch(orgId, {
        ticketId, contactId: contactId || evidence.contactId || null as any,
        phone, channelId, proposedSignalId: signalId,
        approvedBy: input.actorId, messageId: messageId || null,
      });
    } catch (e) { console.warn("[Sales Recovery F4c.2] recordTouch falhou", e); }

    // Se veio da execução do playbook, temos actionId no evidence pra
    // amarrar o outcome. F3.1 registra timeSavedMinutes (o que o dono
    // não teve que redigir do zero); revenue_recovered fica em 0 aqui
    // e é atualizado quando o ticket virar 'ganho' (F4c.2).
    if (evidence.actionId) {
      try {
        OutcomeMeasurementService.record(orgId, evidence.actionId, {
          expectedValue: null, realizedValue: null, basis: "fact", measurementMethod: "derived",
          timeSavedMinutes: 3, revenueRecovered: 0, costAvoided: 0, lossPrevented: 0,
          evidence: { ticketId, signalId, messageId: messageId || null, finalText, source: "sales_recovery_v1" },
        });
      } catch { /* noop */ }
    }

    try {
      logAuthEvent(orgId, input.actorId, null, "RUNTIME_SALES_RECOVERY_APPROVED", {
        ticketId, signalId, messageId: messageId || null, edited: !!input.messageOverride,
      });
    } catch { /* noop */ }
    return { sent: true, messageId, finalText, ticketId, signalStatus: "resolved" };
  }

  /**
   * DONO DISPENSA — resolve o sinal sem enviar. Registra motivo pra
   * auditoria (§14: "opt-out e limites respeitados"). Nenhum efeito
   * externo — pura decisão do humano.
   */
  static dismiss(orgId: string, signalId: string, input: DismissInput): { ok: boolean } {
    const sig = db.prepare(`SELECT id, dedupe_key, status FROM business_signals WHERE id = ? AND organization_id = ? AND signal_type = 'sales_recovery_proposed'`).get(signalId, orgId) as any;
    if (!sig) throw new Error("Sinal não encontrado.");
    if (sig.status !== "open") throw new Error(`Sinal já resolvido (${sig.status}).`);
    BusinessSignalService.dismiss(orgId, signalId);
    try {
      logAuthEvent(orgId, input.actorId, null, "RUNTIME_SALES_RECOVERY_DISMISSED", {
        signalId, reason: input.reason || null,
      });
    } catch { /* noop */ }
    return { ok: true };
  }

  /** Lista propostas em aberto pra UI. */
  static listOpenProposals(orgId: string, opts: { limit?: number } = {}): any[] {
    const limit = Math.max(1, Math.min(Number(opts.limit ?? 50), 200));
    const rows = db.prepare(`
      SELECT * FROM business_signals
       WHERE organization_id = ? AND signal_type = 'sales_recovery_proposed' AND status = 'open'
       ORDER BY detected_at DESC LIMIT ?
    `).all(orgId, limit) as any[];
    return rows.map((r) => ({
      id: r.id, ticketId: r.source_entity_id,
      severity: r.severity, confidence: r.confidence,
      evidence: r.evidence_json ? JSON.parse(r.evidence_json) : {},
      detectedAt: r.detected_at,
    }));
  }
}

export default SalesRecoveryPlaybookService;
