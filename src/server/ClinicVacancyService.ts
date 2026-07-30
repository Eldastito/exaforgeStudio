/**
 * Módulo Clínica — AVISO DE VAGA na fila de retornos (ADR-080 Fase Q).
 *
 * Fecha o triângulo:  cancelamento  →  vaga aberta  →  paciente da fila
 * de retornos recebe "temos vaga em HH:MM, responda SIM se quiser".
 *
 * Trigger:
 *   - `ClinicAgendaService.cancel` (patient/staff) numa consulta FUTURA
 *     (start > now + MIN_LEAD_HOURS) que TINHA profissional atribuído.
 *   - Chamado do webhookProcessor (após o `tryHandle` da Fase N/P) ou
 *     de qualquer rota manual que cancela.
 *
 * Regras:
 *   - Escolhe UM candidato por vez (mais antigo `signed encounter` com
 *     `follow_up_recommended_days > 0` pendente, do MESMO profissional).
 *     Nunca oferece pra quem já tem uma vaga pendente ou pra quem já
 *     recebeu esta vaga (`superseded`).
 *   - LGPD `comunicacoes` obrigatório pro candidato.
 *   - Se o candidato responde SIM (via `tryHandle`), cria o retorno como
 *     scheduleFollowUp (parent = source_appointment_id do candidato),
 *     marca a vaga `accepted`, e supera outras `pending` pra mesma vaga.
 *   - NÃO ou timeout → `declined`/`expired` + tenta o próximo candidato
 *     (idempotente).
 *
 * Não expõe ClinicAgendaService a acoplamentos com MessageProvider:
 * `sender` é injetável, e o chamador é quem enfia essa dependência.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";
import { LgpdService } from "./LgpdService.js";
import { MessageProviderService } from "./MessageProviderService.js";

const MIN_LEAD_HOURS = 6;        // não avisa pra vagas em menos de 6h (pouco tempo pra resposta)
const OFFER_TTL_MIN = 120;       // 2h pra responder — depois expira e passa pro próximo
const COMMS_CONSENT = "comunicacoes";

export type MessageSender = (channelId: string, recipientIdentifier: string, content: string) => Promise<any>;

export interface VacancyOffer {
  id: string;
  organizationId: string;
  sourceAppointmentId: string;
  candidateContactId: string;
  candidateEncounterId: string;
  professionalId: string | null;
  slotStart: string;
  slotDurationMinutes: number;
  status: "pending" | "accepted" | "declined" | "expired" | "superseded";
  newAppointmentId: string | null;
  providerMessageId: string | null;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

function hydrate(r: any): VacancyOffer | null {
  if (!r) return null;
  return {
    id: r.id, organizationId: r.organization_id, sourceAppointmentId: r.source_appointment_id,
    candidateContactId: r.candidate_contact_id, candidateEncounterId: r.candidate_encounter_id,
    professionalId: r.professional_id ?? null,
    slotStart: r.slot_start, slotDurationMinutes: Number(r.slot_duration_minutes || 30),
    status: r.status, newAppointmentId: r.new_appointment_id ?? null,
    providerMessageId: r.provider_message_id ?? null,
    expiresAt: r.expires_at, createdAt: r.created_at, resolvedAt: r.resolved_at ?? null,
  };
}

function fmtSlot(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

export class ClinicVacancyService {
  /**
   * Chamado logo depois de `cancel` (patient/staff). Best-effort — nunca
   * lança pra não bloquear o cancelamento em si. Devolve a oferta criada
   * ou `null` (sem candidato elegível, sem canal, sem consentimento, etc).
   */
  static async tryOfferOnCancel(orgId: string, cancelledAppointmentId: string, opts: { sender?: MessageSender; nowMs?: number } = {}): Promise<VacancyOffer | null> {
    try {
      const apt = db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND id = ?`).get(orgId, cancelledAppointmentId) as any;
      if (!apt || apt.status !== "cancelled") return null;
      if (!apt.professional_id) return null; // vaga sem profissional não faz match com a fila
      const startMs = new Date(apt.scheduled_start).getTime();
      const nowMs = opts.nowMs ?? Date.now();
      if (!Number.isFinite(startMs) || startMs < nowMs + MIN_LEAD_HOURS * 3600_000) return null;

      // Itera candidatos até achar um com LGPD comms + canal ativo + identifier.
      // Sem loop, um único candidato sem consent bloqueava a vaga inteira.
      let candidate: { contact_id: string; encounter_id: string } | null = null;
      let contact: any = null;
      let channelId: string | null = null;
      const excluded = new Set<string>();
      for (let i = 0; i < 20; i++) {
        candidate = this.pickCandidate(orgId, apt.professional_id, cancelledAppointmentId, excluded);
        if (!candidate) return null;
        contact = db.prepare(`SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, candidate.contact_id);
        if (!contact || !contact.identifier || !LgpdService.hasConsent(orgId, candidate.contact_id, COMMS_CONSENT)) {
          excluded.add(candidate.contact_id); continue;
        }
        channelId = this.resolveChannel(orgId, contact.channel_id);
        if (!channelId) { excluded.add(candidate.contact_id); continue; }
        break;
      }
      if (!candidate || !contact || !channelId) return null;

      // Cria a oferta ANTES de enviar (garante linha mesmo se send falhar — a próxima
      // rodada do dispatch tenta enviar de novo). Mas por simplicidade, se send lançar,
      // marca 'expired' já — o candidato não recebeu, não pode responder.
      const id = randomUUID();
      const expiresAt = new Date(nowMs + OFFER_TTL_MIN * 60000).toISOString();
      const durationMin = Number(apt.expected_duration_minutes) > 0 ? Number(apt.expected_duration_minutes) : 30;

      db.prepare(
        `INSERT INTO clinical_vacancy_offers
           (id, organization_id, source_appointment_id, candidate_contact_id, candidate_encounter_id,
            professional_id, slot_start, slot_duration_minutes, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(id, orgId, cancelledAppointmentId, candidate.contact_id, candidate.encounter_id, apt.professional_id, apt.scheduled_start, durationMin, expiresAt);

      const org = db.prepare(`SELECT business_name FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      const message = `Olá, ${contact.name || "paciente"}! Abriu uma vaga com ${apt.professional_name_snapshot || "seu profissional"} em ${fmtSlot(apt.scheduled_start)}. Se quiser, responda **SIM** que já agendo pra você — a oferta vale por 2 horas. Se preferir esperar seu retorno normal, é só ignorar. — ${org?.business_name || "Clínica"}`;

      try {
        const sender = opts.sender || MessageProviderService.sendMessage.bind(MessageProviderService);
        const result = await sender(channelId, contact.identifier, message);
        const providerMessageId = typeof result === "string" ? result
          : (result?.messages?.[0]?.id || result?.key?.id || result?.id || null);
        db.prepare(`UPDATE clinical_vacancy_offers SET provider_message_id = ? WHERE id = ?`).run(providerMessageId, id);
        logAuthEvent(orgId, null, candidate.contact_id, "CLINIC_VACANCY_OFFERED", { offerId: id, sourceAppointmentId: cancelledAppointmentId, slotStart: apt.scheduled_start });
      } catch (e) {
        // Falha ao enviar: marca expired IMEDIATAMENTE. Uma próxima rodada do dispatch (se existir) pega o próximo candidato.
        db.prepare(`UPDATE clinical_vacancy_offers SET status='expired', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
        return null;
      }
      return hydrate(db.prepare(`SELECT * FROM clinical_vacancy_offers WHERE id=?`).get(id));
    } catch (e) {
      // Best-effort — cancel nunca deve ser bloqueado por falha desta oferta.
      return null;
    }
  }

  /**
   * Seleciona o candidato "mais antigo" (signed encounter mais antigo) com
   * follow-up recomendado PENDENTE do mesmo profissional. Pula quem já
   * tem oferta pending, e quem já recebeu oferta 'declined'/'expired' pra
   * ESTA vaga (evita re-oferecer mesma vaga pra quem já recusou).
   */
  static pickCandidate(orgId: string, professionalId: string, sourceAppointmentId: string, excludeContactIds: Set<string> = new Set()): { contact_id: string; encounter_id: string } | null {
    const excludeList = Array.from(excludeContactIds);
    const excludeClause = excludeList.length ? ` AND e.contact_id NOT IN (${excludeList.map(() => "?").join(",")})` : "";
    const row = db.prepare(
      `SELECT e.id AS encounter_id, e.contact_id
         FROM clinical_encounters e
         JOIN appointments src ON src.id = e.appointment_id AND src.organization_id = e.organization_id
        WHERE e.organization_id = ? AND e.status = 'signed'
          AND e.professional_id = ?
          AND e.follow_up_recommended_days IS NOT NULL AND e.follow_up_recommended_days > 0
          AND NOT EXISTS (
            SELECT 1 FROM appointments ret
             WHERE ret.organization_id = e.organization_id
               AND ret.parent_appointment_id = e.appointment_id
               AND ret.status NOT IN ('cancelled','no_show')
          )
          AND NOT EXISTS (
            SELECT 1 FROM clinical_vacancy_offers vo
             WHERE vo.organization_id = e.organization_id
               AND vo.candidate_contact_id = e.contact_id
               AND vo.status = 'pending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM clinical_vacancy_offers vo2
             WHERE vo2.organization_id = e.organization_id
               AND vo2.source_appointment_id = ?
               AND vo2.candidate_contact_id = e.contact_id
               AND vo2.status IN ('declined','expired')
          )
        ${excludeClause}
        ORDER BY e.signed_at ASC, e.rowid ASC LIMIT 1`
    ).get(orgId, professionalId, sourceAppointmentId, ...excludeList) as any;
    if (!row) return null;
    return { contact_id: row.contact_id, encounter_id: row.encounter_id };
  }

  private static resolveChannel(orgId: string, contactChannelId: string | null): string | null {
    if (contactChannelId) {
      const c = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(contactChannelId, orgId) as any;
      if (c && c.status !== "disabled" && c.status !== "disconnected") return c.id;
    }
    const fb = db.prepare(
      `SELECT id FROM channels WHERE organization_id = ? AND status NOT IN ('disabled','disconnected')
        ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
    ).get(orgId) as any;
    return fb?.id || null;
  }

  /** Devolve oferta pendente do contato (housekeeping expira antes). */
  static pendingOfferFor(orgId: string, contactId: string): VacancyOffer | null {
    db.prepare(
      `UPDATE clinical_vacancy_offers SET status='expired', resolved_at=CURRENT_TIMESTAMP
        WHERE organization_id=? AND candidate_contact_id=? AND status='pending' AND expires_at < CURRENT_TIMESTAMP`
    ).run(orgId, contactId);
    const r = db.prepare(
      `SELECT * FROM clinical_vacancy_offers
        WHERE organization_id=? AND candidate_contact_id=? AND status='pending'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).get(orgId, contactId);
    return hydrate(r);
  }

  /**
   * Processa resposta do candidato. `accept=true` → cria o retorno e supera
   * outras pendentes pra mesma vaga. `accept=false` → marca declined.
   * Devolve mensagem pra ACK ou null se não houver oferta pendente.
   */
  static handleReply(orgId: string, contactId: string, accept: boolean, opts: { sender?: MessageSender } = {}): { reply: string; newAppointmentId?: string } | null {
    const offer = this.pendingOfferFor(orgId, contactId);
    if (!offer) return null;

    if (!accept) {
      db.prepare(`UPDATE clinical_vacancy_offers SET status='declined', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(offer.id);
      logAuthEvent(orgId, null, contactId, "CLINIC_VACANCY_DECLINED", { offerId: offer.id });
      // Tenta próximo candidato imediatamente (best-effort).
      // Não await pra não bloquear a resposta ao paciente atual.
      Promise.resolve().then(() => this.tryOfferOnCancel(orgId, offer.sourceAppointmentId, { sender: opts.sender })).catch(() => {});
      return { reply: "Ok, obrigado por avisar! Vou oferecer pra outra pessoa da fila. Aguardamos seu retorno normal." };
    }

    // Aceitou. Cria o retorno usando scheduleFollowUp — parent = APPOINTMENT do
    // encounter do candidato (não o source, que é de outro paciente!).
    const enc = db.prepare(`SELECT appointment_id FROM clinical_encounters WHERE id=? AND organization_id=?`)
      .get(offer.candidateEncounterId, orgId) as any;
    if (!enc) {
      db.prepare(`UPDATE clinical_vacancy_offers SET status='expired', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(offer.id);
      return { reply: "Desculpe, essa vaga não está mais disponível. Aguardamos seu retorno normal." };
    }

    let created: any;
    try {
      created = ClinicAgendaService.scheduleFollowUp(orgId, enc.appointment_id, {
        atISO: offer.slotStart,
        durationMinutes: offer.slotDurationMinutes,
        title: "Retorno (vaga oferecida)",
      }, null as any);
    } catch (e: any) {
      // Conflito no meio (outro pegou a vaga, race): marca expired + resposta amigável.
      db.prepare(`UPDATE clinical_vacancy_offers SET status='expired', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(offer.id);
      return { reply: "Esse horário acabou de ficar indisponível. Vamos manter seu retorno normal." };
    }
    ClinicAgendaService.confirmByPatient(orgId, created.id, null as any);

    db.prepare(`UPDATE clinical_vacancy_offers SET status='accepted', new_appointment_id=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(created.id, offer.id);
    // Supera outras pending PRA MESMA VAGA (proteção contra double-book em race).
    db.prepare(
      `UPDATE clinical_vacancy_offers SET status='superseded', resolved_at=CURRENT_TIMESTAMP
        WHERE organization_id=? AND source_appointment_id=? AND status='pending' AND id != ?`
    ).run(orgId, offer.sourceAppointmentId, offer.id);
    logAuthEvent(orgId, null, contactId, "CLINIC_VACANCY_ACCEPTED", { offerId: offer.id, newAppointmentId: created.id });

    return {
      reply: `Perfeito! Sua consulta foi agendada para ${fmtSlot(offer.slotStart)}. Até logo!`,
      newAppointmentId: created.id,
    };
  }
}

export default ClinicVacancyService;
