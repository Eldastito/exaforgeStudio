/**
 * Módulo Clínica — LEMBRETE AUTOMÁTICO de consulta (ADR-080 Fase M).
 *
 * Scheduler roda a cada hora (`clinicReminderPass`) e, para cada consulta
 * futura dentro da janela `[now + hoursBefore - tolerance, now + hoursBefore]`,
 * dispara uma mensagem WhatsApp ao paciente. Reduz no-show — problema #1
 * da clínica no BR — sem depender de o profissional ou secretária lembrar.
 *
 * Regras (todas do produto, não do cliente):
 *   - Dedup por (org, appointment, template_key): mesmo lembrete de 24h só
 *     sai UMA vez por consulta, mesmo que o Scheduler rode 4× na janela.
 *     Uma falha `failed` NÃO conta como dedup — permite reenvio automático
 *     na próxima passada.
 *   - Só appointments em status ativo: `confirmed`, `arrived`. Nunca envia
 *     pra cancelled/no_show/completed/in_care.
 *   - LGPD `comunicacoes` obrigatório (mesma barreira do envio de docs).
 *   - Canal precisa estar conectado; sem canal utilizável, skip silencioso
 *     (não é erro do fluxo — pode ser transiente).
 *
 * Envio é síncrono nesta fatia. `sender` injetável facilita teste sem
 * chamar rede real.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { MessageProviderService } from "./MessageProviderService.js";

export type ReminderTemplateKey = "24h" | "2h";

export interface Reminder {
  id: string;
  organizationId: string;
  appointmentId: string;
  contactId: string;
  channelId: string;
  toIdentifier: string;
  templateKey: string;
  status: "queued" | "sent" | "failed";
  providerMessageId: string | null;
  error: string | null;
  sentAt: string;
}

/** Contrato mínimo pra teste injetar mock. */
export type MessageSender = (channelId: string, recipientIdentifier: string, content: string) => Promise<any>;

const COMMS_CONSENT = "comunicacoes";
const DEFAULT_HOURS_BEFORE = 24;
const WINDOW_TOLERANCE_MIN = 60; // roda a cada hora → janela de 1h evita duplicata e cobre atraso
const ACTIVE_STATUS = ["confirmed", "arrived"];

function hydrate(r: any): Reminder | null {
  if (!r) return null;
  return {
    id: r.id, organizationId: r.organization_id, appointmentId: r.appointment_id,
    contactId: r.contact_id, channelId: r.channel_id, toIdentifier: r.to_identifier,
    templateKey: r.template_key, status: r.status,
    providerMessageId: r.provider_message_id ?? null, error: r.error ?? null, sentAt: r.sent_at,
  };
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // "amanhã às 14:30" ficaria bonito mas depende de fuso; ficamos com
  // "dd/MM às HH:mm" em pt-BR (São Paulo) — o mesmo padrão do checkout SMS.
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

function renderMessage(patientName: string, whenISO: string, professionalName: string | null, clinicName: string, templateKey: ReminderTemplateKey): string {
  const when = fmtWhen(whenISO);
  const withProf = professionalName ? ` com ${professionalName}` : "";
  // Fase 32: rodapé com REMARCAR (Fase P já reconhecia, faltava explicitar
  // pro paciente) + PARAR (opt-out LGPD Art.8 §5 — Fatia 32 grava audit e
  // revoga consent `comunicacoes`). Uma linha em branco separa o rodapé do
  // corpo pra ficar visível.
  const footer = `\n\nResponda REMARCAR pra trocar horário, ou PARAR pra não receber mais lembretes.`;
  if (templateKey === "2h") {
    // Segundo lembrete — tom mais urgente, texto mais curto (paciente deveria
    // já saber; é uma cutucada final pra confirmar).
    return `Oi, ${patientName}! Ainda vamos te ver hoje às ${when.split("às ")[1] || when}${withProf}? Responda SIM pra confirmar ou NÃO pra cancelar. — ${clinicName}${footer}`;
  }
  return `Olá, ${patientName}! Lembramos que você tem consulta em ${when}${withProf}. Se puder confirmar, responda SIM. Se precisar cancelar, responda NÃO. — ${clinicName}${footer}`;
}

export class ClinicReminderService {
  static list(orgId: string, appointmentId: string): Reminder[] {
    const rows = db.prepare(
      `SELECT * FROM clinical_appointment_reminders
        WHERE organization_id = ? AND appointment_id = ?
        ORDER BY sent_at DESC, rowid DESC`
    ).all(orgId, appointmentId) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  private static reminderHoursFor(orgId: string): number {
    try {
      const o = db.prepare(`SELECT clinic_reminder_hours FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      const h = Number(o?.clinic_reminder_hours);
      return Number.isFinite(h) && h >= 1 ? Math.floor(h) : DEFAULT_HOURS_BEFORE;
    } catch { return DEFAULT_HOURS_BEFORE; }
  }

  /** Config do segundo lembrete (Fase S). Devolve `null` se desabilitado. */
  private static secondReminderHoursFor(orgId: string): number | null {
    try {
      const o = db.prepare(`SELECT clinic_second_reminder_hours, clinic_second_reminder_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      if (o?.clinic_second_reminder_enabled === 0) return null;
      const h = Number(o?.clinic_second_reminder_hours);
      return Number.isFinite(h) && h >= 1 ? Math.floor(h) : 2;
    } catch { return 2; }
  }

  private static resolveChannel(orgId: string, contactChannelId: string | null): string | null {
    if (contactChannelId) {
      const c = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(contactChannelId, orgId) as any;
      if (c && c.status !== "disabled" && c.status !== "disconnected") return c.id;
    }
    const fb = db.prepare(
      `SELECT id FROM channels WHERE organization_id = ?
         AND status NOT IN ('disabled','disconnected')
        ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
    ).get(orgId) as any;
    return fb?.id || null;
  }

  /**
   * Envia lembrete pra UMA consulta. Idempotente por (appt, template): se
   * já existe row `sent` ou `queued`, devolve a existente sem duplicar.
   * Retorna null se sem canal ativo (skip silencioso) ou sem consentimento
   * (bloqueia — LGPD_COMMS_CONSENT_REQUIRED só quando chamado direto).
   */
  static async sendForAppointment(orgId: string, appointmentId: string, opts: {
    templateKey?: ReminderTemplateKey;
    sender?: MessageSender;
    force?: boolean; // pula dedup — útil pra manual "reenviar"
    actorId?: string | null;
  } = {}): Promise<Reminder | null> {
    const templateKey = opts.templateKey || "24h";
    const apt = db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND id = ?`).get(orgId, appointmentId) as any;
    if (!apt) throw new Error("Agendamento não encontrado.");
    if (!apt.contact_id) throw new Error("Agendamento sem paciente.");
    if (!ACTIVE_STATUS.includes(apt.status) && apt.status !== "in_care") {
      const e: any = new Error("Consulta não está em status ativo (confirmed/arrived).");
      e.code = "APPT_NOT_ACTIVE"; throw e;
    }
    // Segundo lembrete (2h): só sai se paciente ainda NÃO confirmou o 24h.
    // Sem esse guard, mandaria SIM/NÃO de novo pra quem já respondeu SIM —
    // usuário odiaria receber "confirma?" logo depois de confirmar.
    if (templateKey === "2h" && apt.patient_confirmed_at && !opts.force) {
      return null;
    }

    // Dedup: já enviado com sucesso ou em fila com o mesmo template.
    if (!opts.force) {
      const existing = db.prepare(
        `SELECT * FROM clinical_appointment_reminders
          WHERE organization_id = ? AND appointment_id = ? AND template_key = ? AND status IN ('sent','queued')
          ORDER BY sent_at DESC LIMIT 1`
      ).get(orgId, appointmentId, templateKey) as any;
      if (existing) return hydrate(existing);
    }

    const contact = db.prepare(`SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`)
      .get(orgId, apt.contact_id) as any;
    if (!contact) throw new Error("Paciente não encontrado.");
    if (!contact.identifier) throw new Error("Paciente sem identificador (telefone/WhatsApp).");

    if (!LgpdService.hasConsent(orgId, apt.contact_id, COMMS_CONSENT)) {
      const e: any = new Error("Consentimento para comunicações é obrigatório para envio de lembrete.");
      e.code = "LGPD_COMMS_CONSENT_REQUIRED"; throw e;
    }

    const channelId = this.resolveChannel(orgId, contact.channel_id);
    if (!channelId) return null; // skip silencioso — pass tenta na próxima rodada

    const org = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const message = renderMessage(
      contact.name || "paciente",
      apt.scheduled_start,
      apt.professional_name_snapshot || null,
      org?.business_name || "Clínica",
      templateKey
    );

    const id = randomUUID();
    db.prepare(
      `INSERT INTO clinical_appointment_reminders
         (id, organization_id, appointment_id, contact_id, channel_id, to_identifier, template_key, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`
    ).run(id, orgId, appointmentId, apt.contact_id, channelId, contact.identifier, templateKey);

    const sender: MessageSender = opts.sender || MessageProviderService.sendMessage.bind(MessageProviderService);
    try {
      const result = await sender(channelId, contact.identifier, message);
      const providerMessageId = typeof result === "string" ? result
        : (result?.messages?.[0]?.id || result?.key?.id || result?.id || null);
      db.prepare(`UPDATE clinical_appointment_reminders SET status='sent', provider_message_id=? WHERE id=? AND organization_id=?`)
        .run(providerMessageId, id, orgId);
      logAuthEvent(orgId, opts.actorId || null, apt.contact_id, "CLINIC_REMINDER_SENT", { reminderId: id, appointmentId, templateKey });
    } catch (e: any) {
      db.prepare(`UPDATE clinical_appointment_reminders SET status='failed', error=? WHERE id=? AND organization_id=?`)
        .run(String(e?.message || e).slice(0, 500), id, orgId);
      logAuthEvent(orgId, opts.actorId || null, apt.contact_id, "CLINIC_REMINDER_FAILED", { reminderId: id, appointmentId, error: String(e?.message || e).slice(0, 200) });
    }
    return hydrate(db.prepare(`SELECT * FROM clinical_appointment_reminders WHERE id = ?`).get(id))!;
  }

  /**
   * Pass do Scheduler — encontra appointments na janela e dispara. Percorre
   * SÓ orgs que têm o módulo clínica ativo (ModuleService.isEnabled), padrão
   * dos outros passes. Se `orgId` vier, roda só naquela org (útil pra teste).
   */
  static async dispatch(opts: { orgId?: string; now?: Date; sender?: MessageSender } = {}): Promise<{ sent: number; failed: number; skipped: number }> {
    const nowMs = (opts.now || new Date()).getTime();
    const stats = { sent: 0, failed: 0, skipped: 0 };

    let orgs: string[] = [];
    if (opts.orgId) orgs = [opts.orgId];
    else {
      try {
        // Orgs que têm ao menos uma consulta futura em status ativo — evita percorrer o mundo.
        orgs = (db.prepare(
          `SELECT DISTINCT organization_id FROM appointments WHERE status IN ('confirmed','arrived') AND scheduled_start > CURRENT_TIMESTAMP`
        ).all() as any[]).map((r) => r.organization_id);
      } catch { return stats; }
    }

    for (const orgId of orgs) {
      // 1ª janela: primeiro lembrete (default 24h)
      await this.dispatchWindow(orgId, nowMs, this.reminderHoursFor(orgId), "24h", stats, opts.sender);
      // 2ª janela: segundo lembrete (default 2h, se habilitado). Só sai pra
      // quem NÃO confirmou ainda (guard no sendForAppointment).
      const h2 = this.secondReminderHoursFor(orgId);
      if (h2 !== null) await this.dispatchWindow(orgId, nowMs, h2, "2h", stats, opts.sender);
      // Escalada H-1: seta needs_manual_confirmation=1 pras appts que ainda
      // não confirmaram e estão a menos de 1h. Recepção liga pra confirmar
      // ou libera vaga. Idempotente (UPDATE WHERE needs_manual_confirmation=0).
      this.escalateNearAppointments(orgId, nowMs);
    }
    return stats;
  }

  private static async dispatchWindow(orgId: string, nowMs: number, hoursBefore: number, templateKey: ReminderTemplateKey, stats: { sent: number; failed: number; skipped: number }, sender?: MessageSender) {
    const windowStart = new Date(nowMs + (hoursBefore - WINDOW_TOLERANCE_MIN / 60) * 3600_000).toISOString();
    const windowEnd = new Date(nowMs + (hoursBefore + WINDOW_TOLERANCE_MIN / 60) * 3600_000).toISOString();
    const appts = db.prepare(
      `SELECT id FROM appointments
        WHERE organization_id = ? AND status IN ('confirmed','arrived')
          AND scheduled_start >= ? AND scheduled_start <= ?`
    ).all(orgId, windowStart, windowEnd) as any[];
    for (const a of appts) {
      try {
        const r = await this.sendForAppointment(orgId, a.id, { sender, templateKey });
        if (!r) stats.skipped++;
        else if (r.status === "sent") stats.sent++;
        else if (r.status === "failed") stats.failed++;
        else stats.skipped++;
      } catch { stats.skipped++; }
    }
  }

  /**
   * Escalada H-1 (Fase S): consultas que começam em menos de 1h e o paciente
   * ainda não confirmou — marca `needs_manual_confirmation=1` pra recepção
   * decidir (ligar / liberar vaga). Idempotente e não envia mensagem.
   */
  private static escalateNearAppointments(orgId: string, nowMs: number) {
    const cutoff = new Date(nowMs + 60 * 60_000).toISOString(); // 1h no futuro
    try {
      db.prepare(
        `UPDATE appointments SET needs_manual_confirmation = 1
          WHERE organization_id = ?
            AND status IN ('confirmed','arrived')
            AND scheduled_start > CURRENT_TIMESTAMP
            AND scheduled_start <= ?
            AND patient_confirmed_at IS NULL
            AND COALESCE(needs_manual_confirmation, 0) = 0`
      ).run(orgId, cutoff);
    } catch { /* best-effort */ }
  }
}

export default ClinicReminderService;
