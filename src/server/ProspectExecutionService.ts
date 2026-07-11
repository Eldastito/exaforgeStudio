import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { ProspectService } from "./ProspectService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { phoneMatches, onlyDigits } from "./phoneMatch.js";

/**
 * Prospect AI — EXECUÇÃO E MEDIÇÃO (ADR-079, Fase B).
 *
 * Fecha o ciclo que faltava: abordagem aprovada é ENVIADA de verdade
 * (WhatsApp via MessageProviderService, e-mail via Gmail conectado), a
 * RESPOSTA do lead é capturada (webhook de entrada + phoneMatch) e reunião/
 * conversão para o CRM viram eventos. Tudo cai em `prospect_events` — a
 * fonte das métricas dos experimentos da Fase C (Research Engine).
 *
 * Guardrails herdados da Fase A: nada é enviado sem aprovação humana, e o
 * envio re-checa bloqueio, opt-out e teto de tentativas ANTES do provedor.
 */
const WHATSAPP_PROVIDERS = ["whatsapp_cloud", "evolution", "evolution_go"];

export class ProspectExecutionService {
  /** Registra um evento do funil de prospecção (fonte das métricas da Fase C). */
  static emit(orgId: string, eventType: string, refs: {
    campaignId?: string | null; accountId?: string | null; contactId?: string | null; outreachId?: string | null; payload?: any;
  } = {}): void {
    try {
      db.prepare(`INSERT INTO prospect_events (id, organization_id, event_type, campaign_id, prospect_account_id, contact_id, outreach_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, eventType, refs.campaignId || null, refs.accountId || null, refs.contactId || null, refs.outreachId || null, JSON.stringify(refs.payload || {}));
    } catch (e) { console.error("[ProspectAI] Falha ao registrar evento", eventType, e); }
  }

  static listEvents(orgId: string, accountId?: string): any[] {
    if (accountId) return db.prepare("SELECT * FROM prospect_events WHERE organization_id = ? AND prospect_account_id = ? ORDER BY created_at DESC LIMIT 200").all(orgId, accountId) as any[];
    return db.prepare("SELECT * FROM prospect_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200").all(orgId) as any[];
  }

  /**
   * ENVIO REAL de uma abordagem aprovada. WhatsApp exige canal conectado da
   * organização; e-mail exige conta Google conectada. Canais manuais (ligação,
   * LinkedIn) seguem o fluxo antigo: executar fora e marcar 'sent' na mão.
   * Sequência segura: guardrails → provedor → só então status 'sent'.
   */
  static async sendOutreach(orgId: string, outreachId: string, actorId?: string): Promise<any> {
    const o = ProspectService.assertOutreachSendable(orgId, outreachId);
    if (!o.contact_id) throw new Error("Abordagem sem contato definido — envio real exige um contato.");
    const contact = db.prepare("SELECT * FROM prospect_contacts WHERE id = ? AND organization_id = ?").get(o.contact_id, orgId) as any;
    if (!contact) throw new Error("Contato não encontrado.");

    let sentVia = "";
    let providerMessageId: string | null = null;

    if (o.channel === "whatsapp") {
      const phone = onlyDigits(contact.phone);
      if (!phone) throw new Error("Contato sem telefone — não dá para enviar por WhatsApp.");
      const ch = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider IN (${WHATSAPP_PROVIDERS.map(() => "?").join(",")}) AND status = 'connected' ORDER BY created_at ASC LIMIT 1`)
        .get(orgId, ...WHATSAPP_PROVIDERS) as any;
      if (!ch) throw new Error("Nenhum canal de WhatsApp conectado. Conecte um canal em Configurações › Canais.");
      // sendMessage agora devolve o id do provedor (wamid) como string.
      const wamid = await MessageProviderService.sendMessage(ch.id, phone, o.body);
      providerMessageId = (typeof wamid === "string" && wamid) ? wamid : null;
      sentVia = "whatsapp";
    } else if (o.channel === "email") {
      const email = String(contact.email || "").trim();
      if (!email) throw new Error("Contato sem e-mail — não dá para enviar por e-mail.");
      const r = await GoogleOAuthService.gmailSend(orgId, email, o.subject || "Contato comercial", o.body);
      if ((r as any)?.error) throw new Error(`Falha no envio do e-mail: ${(r as any).error}`);
      providerMessageId = String((r as any)?.id || "") || null;
      sentVia = "email";
    } else {
      throw new Error("Canal manual (ligação/LinkedIn): execute fora do sistema e marque como enviada na fila.");
    }

    // Provedor confirmou → agora sim transiciona (audita e re-checa guardrails).
    ProspectService.setOutreachStatus(orgId, outreachId, "sent", actorId);
    db.prepare("UPDATE prospect_outreach SET sent_via = ?, provider_message_id = ? WHERE id = ? AND organization_id = ?")
      .run(sentVia, providerMessageId, outreachId, orgId);
    this.emit(orgId, "message.sent", { campaignId: o.campaign_id, accountId: o.prospect_account_id, contactId: o.contact_id, outreachId, payload: { via: sentVia, providerMessageId } });
    return ProspectService.getAccount(orgId, o.prospect_account_id);
  }

  /**
   * Correlaciona mensagem RECEBIDA (webhook) com leads prospectados: se o
   * telefone do remetente bate com um contato que tem abordagem enviada e
   * ainda sem resposta, registra lead.replied. Best-effort — nunca lança.
   */
  static correlateInboundReply(orgId: string, senderPhone: string): boolean {
    try {
      const phone = onlyDigits(senderPhone);
      if (phone.length < 8) return false;
      const pending = db.prepare(`
        SELECT o.id AS outreach_id, o.campaign_id, o.prospect_account_id, c.id AS contact_id, c.phone
        FROM prospect_outreach o JOIN prospect_contacts c ON c.id = o.contact_id
        WHERE o.organization_id = ? AND o.status = 'sent' AND o.replied_at IS NULL AND c.phone != ''
        ORDER BY o.sent_at DESC LIMIT 200
      `).all(orgId) as any[];
      for (const p of pending) {
        if (phoneMatches(phone, p.phone)) {
          this.registerReply(orgId, p.prospect_account_id, { contactId: p.contact_id, outreachId: p.outreach_id, source: "whatsapp_inbound" });
          return true;
        }
      }
      return false;
    } catch (e) { console.error("[ProspectAI] Falha ao correlacionar resposta:", e); return false; }
  }

  /** Registra a RESPOSTA do lead (automática via webhook ou manual pelo SDR). */
  static registerReply(orgId: string, accountId: string, opts: { contactId?: string; outreachId?: string; source?: string } = {}, actorId?: string): any {
    const acc = db.prepare("SELECT id, campaign_id FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    // Marca a resposta na abordagem indicada, ou na última enviada da conta.
    let outreach = opts.outreachId
      ? db.prepare("SELECT id, campaign_id, contact_id FROM prospect_outreach WHERE id = ? AND organization_id = ? AND prospect_account_id = ?").get(opts.outreachId, orgId, accountId) as any
      : db.prepare("SELECT id, campaign_id, contact_id FROM prospect_outreach WHERE organization_id = ? AND prospect_account_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1").get(orgId, accountId) as any;
    if (outreach) db.prepare("UPDATE prospect_outreach SET replied_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND replied_at IS NULL").run(outreach.id);
    this.emit(orgId, "lead.replied", { campaignId: outreach?.campaign_id || acc.campaign_id, accountId, contactId: opts.contactId || outreach?.contact_id, outreachId: outreach?.id, payload: { source: opts.source || "manual" } });
    logAuthEvent(orgId, actorId, null, "PROSPECT_LEAD_REPLIED", { accountId, outreachId: outreach?.id || null, source: opts.source || "manual" });
    return ProspectService.getAccount(orgId, accountId);
  }

  /** Registra REUNIÃO marcada com o lead. */
  static registerMeeting(orgId: string, accountId: string, opts: { when?: string; notes?: string } = {}, actorId?: string): any {
    const acc = db.prepare("SELECT id, campaign_id FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    const when = String(opts.when || "").trim() || null;
    db.prepare(`UPDATE prospect_accounts SET meeting_at = ${when ? "?" : "CURRENT_TIMESTAMP"}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`)
      .run(...(when ? [when, accountId, orgId] : [accountId, orgId]));
    this.emit(orgId, "meeting.created", { campaignId: acc.campaign_id, accountId, payload: { when, notes: String(opts.notes || "").slice(0, 500) } });
    logAuthEvent(orgId, actorId, null, "PROSPECT_MEETING_CREATED", { accountId, when });
    return ProspectService.getAccount(orgId, accountId);
  }

  /**
   * CONVERTE o lead para o CRM: cria/reaproveita o contato (`contacts`) e abre
   * um ticket no Kanban comercial (`tickets.stage`). O card do PRD É um ticket
   * — nenhuma estrutura paralela. Idempotente: reconverter reaproveita.
   */
  static convertToCrm(orgId: string, accountId: string, actorId?: string): any {
    const acc = ProspectService.getAccount(orgId, accountId);
    if (!acc) throw new Error("Conta não encontrada.");
    if (acc.crm_ticket_id) {
      const t = db.prepare("SELECT id FROM tickets WHERE id = ? AND organization_id = ?").get(acc.crm_ticket_id, orgId);
      if (t) return { account: acc, ticketId: acc.crm_ticket_id, alreadyConverted: true };
    }
    const pcontact = (acc.contacts || []).find((c: any) => c.phone || c.email) || (acc.contacts || [])[0];
    const identifier = onlyDigits(pcontact?.phone) || String(pcontact?.email || "").trim().toLowerCase();
    if (!identifier) throw new Error("Conta sem contato com telefone ou e-mail — adicione um contato antes de converter.");
    const ch = db.prepare("SELECT id FROM channels WHERE organization_id = ? ORDER BY created_at ASC LIMIT 1").get(orgId) as any;
    if (!ch) throw new Error("Nenhum canal cadastrado — conecte um canal antes de converter leads para o CRM.");

    let crmContact = db.prepare("SELECT id FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?").get(orgId, ch.id, identifier) as any;
    if (!crmContact) {
      const cid = randomUUID();
      db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)")
        .run(cid, orgId, ch.id, `${pcontact?.full_name || acc.display_name} (${acc.display_name})`.slice(0, 120), identifier);
      crmContact = { id: cid };
    }
    const stage = acc.account_status === "qualified" ? "qualificado" : "novo_lead";
    const ticketId = randomUUID();
    db.prepare("INSERT INTO tickets (id, organization_id, contact_id, status, stage, ai_paused) VALUES (?, ?, ?, 'open', ?, 1)")
      .run(ticketId, orgId, crmContact.id, stage);

    if (pcontact?.id) db.prepare("UPDATE prospect_contacts SET crm_contact_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(crmContact.id, pcontact.id, orgId);
    db.prepare("UPDATE prospect_accounts SET crm_ticket_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(ticketId, accountId, orgId);

    this.emit(orgId, "lead.converted", { campaignId: acc.campaign_id, accountId, contactId: pcontact?.id, payload: { crmContactId: crmContact.id, ticketId, stage } });
    logAuthEvent(orgId, actorId, null, "PROSPECT_CONVERTED_TO_CRM", { accountId, crmContactId: crmContact.id, ticketId, stage });
    return { account: ProspectService.getAccount(orgId, accountId), ticketId, crmContactId: crmContact.id, stage, alreadyConverted: false };
  }
}
