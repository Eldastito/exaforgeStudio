/**
 * Módulo Clínica — REAGENDAMENTO em 1 clique via WhatsApp (ADR-080 Fase P).
 *
 * Fecha o ciclo do parser SIM/NÃO (Fase N): se o paciente responde "REMARCAR"
 * ao lembrete, o sistema OFERECE 3 slots (mesma faixa horária do dia da
 * consulta original, nos próximos dias úteis, sem conflito com o profissional).
 * O paciente responde "1" / "2" / "3" e o sistema:
 *   1. Cria novo appointment (parent_appointment_id = original)
 *   2. Cancela o original (cancelled_by='patient', reason='rescheduled')
 *   3. Marca o novo como confirmado pelo paciente
 *   4. Envia ACK
 *
 * A `clinical_reschedule_offers` guarda os slots entre as duas mensagens
 * (senão o "1" fica ambíguo). Expira em 30 min — o paciente que não
 * escolhe rápido tem que pedir de novo.
 *
 * Reusa ClinicAgendaService (createAppointment, cancel, confirmByPatient,
 * findConflicts) — zero-token, determinístico, isolado por org.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";
import { AppointmentService } from "./AppointmentService.js";
import { LgpdService } from "./LgpdService.js";

// Fase 19: consent LGPD `comunicacoes` obrigatório antes de enviar oferta
// de reagendamento — assíncrona com o consentimento pra remarcação por
// canal (mesmo padrão de `ClinicReminderService`/`ClinicDocumentDelivery
// Service`). Se o paciente revogou, nem gera offer nem espera resposta.
const COMMS_CONSENT = "comunicacoes";

const OFFER_TTL_MIN = 30;
const DAYS_TO_SCAN = 14;
const SLOTS_TO_OFFER = 3;
const WORKDAY_START_HOUR = 8;   // 08:00 local
const WORKDAY_END_HOUR = 18;    // até 18:00 local
const SLOT_STEP_MIN = 30;

export interface OfferSlot { startISO: string; durationMinutes: number }

export interface RescheduleOffer {
  id: string;
  organizationId: string;
  contactId: string;
  sourceAppointmentId: string;
  slots: OfferSlot[];
  status: "pending" | "chosen" | "expired" | "abandoned";
  chosenIndex: number | null;
  newAppointmentId: string | null;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

function hydrate(r: any): RescheduleOffer | null {
  if (!r) return null;
  let slots: OfferSlot[] = [];
  try { slots = JSON.parse(r.offered_slots_json || "[]"); } catch { /* ignora */ }
  return {
    id: r.id, organizationId: r.organization_id, contactId: r.contact_id,
    sourceAppointmentId: r.source_appointment_id, slots, status: r.status,
    chosenIndex: r.chosen_index ?? null, newAppointmentId: r.new_appointment_id ?? null,
    expiresAt: r.expires_at, createdAt: r.created_at, resolvedAt: r.resolved_at ?? null,
  };
}

function fmtSlot(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

export class ClinicRescheduleService {
  /**
   * Encontra até N slots livres do profissional nos próximos DAYS_TO_SCAN
   * dias, preferindo o MESMO horário do dia da consulta original. Ignora
   * conflitos com outros appointments ativos.
   */
  static findSlots(orgId: string, sourceAppointmentId: string, count = SLOTS_TO_OFFER): OfferSlot[] {
    const apt = db.prepare(`SELECT * FROM appointments WHERE organization_id = ? AND id = ?`).get(orgId, sourceAppointmentId) as any;
    if (!apt) return [];
    const durationMin = Number(apt.expected_duration_minutes) > 0
      ? Number(apt.expected_duration_minutes)
      : 30;
    const originalStart = AppointmentService.ms(apt.scheduled_start);
    if (originalStart == null) return [];

    // "Mesmo horário do dia" = a hora local do início.
    const originalDate = new Date(originalStart);
    const targetHour = originalDate.getUTCHours(); // Nota: usar UTC hours evita drift de TZ; a agenda já grava em ISO com fuso.
    const targetMin = originalDate.getUTCMinutes();

    const nowMs = Date.now();
    const out: OfferSlot[] = [];
    for (let d = 1; d <= DAYS_TO_SCAN && out.length < count; d++) {
      // Data-base do dia D à frente do NOW, ancorada no minuto original.
      const base = new Date(nowMs + d * 86400_000);
      base.setUTCHours(targetHour, targetMin, 0, 0);
      // Tenta o horário-alvo primeiro; se conflita, varre em passos de 30 min
      // até WORKDAY_END_HOUR. Se ainda não achou nada, tenta 08:00 em diante.
      const tryOrder: number[] = [];
      tryOrder.push(base.getTime());
      for (let m = SLOT_STEP_MIN; m <= 8 * 60; m += SLOT_STEP_MIN) tryOrder.push(base.getTime() + m * 60000);
      for (let m = SLOT_STEP_MIN; m <= 4 * 60; m += SLOT_STEP_MIN) tryOrder.push(base.getTime() - m * 60000);

      for (const startMs of tryOrder) {
        // Não oferecer no passado.
        if (startMs <= nowMs + 3600_000) continue; // ao menos 1h no futuro
        const asDate = new Date(startMs);
        const hourLocal = asDate.getUTCHours();
        // Fica só dentro da faixa útil (heurística ampla). Ajuste real via
        // config de organização é uma fatia futura.
        if (hourLocal < WORKDAY_START_HOUR || hourLocal >= WORKDAY_END_HOUR) continue;

        const endMs = startMs + durationMin * 60000;
        const conflicts = ClinicAgendaService.findConflicts(orgId, {
          professionalId: apt.professional_id || null,
          roomId: null, // sala é opcional; propor sem restrição de sala é mais flexível
          startMs,
          endMs,
          ignoreId: apt.id, // pra não colidir com o próprio
        });
        if (conflicts.length === 0) {
          out.push({ startISO: new Date(startMs).toISOString(), durationMinutes: durationMin });
          break; // um por dia, no máximo
        }
      }
    }
    return out;
  }

  /**
   * Cria uma offer nova, expira anteriores do mesmo paciente (só faz sentido
   * uma ativa por vez — se o paciente pediu de novo, é porque não quis as
   * primeiras). Devolve `{offer, message}` — chamador envia `message` como
   * ACK e retorna. Se não encontrou nenhum slot, devolve `null`.
   */
  static createOffer(orgId: string, sourceAppointmentId: string, contactId: string): { offer: RescheduleOffer; message: string } | null {
    // Fase 19: sem consent pra comms, não oferece — economiza slots que o
    // paciente não pode receber. Retorna null (comportamento existente
    // pra "nada a oferecer") em vez de lançar — o caller (handler do
    // parser SIM/NÃO/REMARCAR) trata null como "não fez nada".
    if (!LgpdService.hasConsent(orgId, contactId, COMMS_CONSENT)) {
      logAuthEvent(orgId, null, contactId, "CLINIC_RESCHEDULE_SKIPPED_NO_CONSENT", { sourceAppointmentId });
      return null;
    }

    // Expira offers anteriores desse paciente (garante 1 ativa por vez).
    db.prepare(
      `UPDATE clinical_reschedule_offers SET status='abandoned', resolved_at=CURRENT_TIMESTAMP
        WHERE organization_id=? AND contact_id=? AND status='pending'`
    ).run(orgId, contactId);

    const slots = this.findSlots(orgId, sourceAppointmentId);
    if (!slots.length) return null;

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + OFFER_TTL_MIN * 60000).toISOString();
    db.prepare(
      `INSERT INTO clinical_reschedule_offers
         (id, organization_id, contact_id, source_appointment_id, offered_slots_json, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, orgId, contactId, sourceAppointmentId, JSON.stringify(slots), expiresAt);
    logAuthEvent(orgId, null, contactId, "CLINIC_RESCHEDULE_OFFERED", { offerId: id, sourceAppointmentId, slots: slots.length });

    const lines = slots.map((s, i) => `${i + 1}) ${fmtSlot(s.startISO)}`).join("\n");
    const message = `Encontrei estes horários pra remarcar sua consulta:\n\n${lines}\n\nResponda o número (1, 2 ou 3) para escolher, ou "X" para cancelar a remarcação. Válido por ${OFFER_TTL_MIN} minutos.`;

    return { offer: hydrate(db.prepare(`SELECT * FROM clinical_reschedule_offers WHERE id=?`).get(id))!, message };
  }

  /** Devolve offer pendente do paciente (a ativa mais recente). */
  static pendingOffer(orgId: string, contactId: string): RescheduleOffer | null {
    // Expira as vencidas ANTES de retornar (housekeeping leve).
    db.prepare(
      `UPDATE clinical_reschedule_offers SET status='expired', resolved_at=CURRENT_TIMESTAMP
        WHERE organization_id=? AND contact_id=? AND status='pending' AND expires_at < CURRENT_TIMESTAMP`
    ).run(orgId, contactId);
    const r = db.prepare(
      `SELECT * FROM clinical_reschedule_offers
        WHERE organization_id=? AND contact_id=? AND status='pending'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).get(orgId, contactId);
    return hydrate(r);
  }

  /**
   * Processa a escolha do paciente. `raw` é o texto puro; se for "1"/"2"/"3"
   * dentro de uma offer válida, agenda o retorno + cancela original. Se for
   * "X"/"cancel"/"desisto", marca abandoned. Se não bater, retorna null.
   */
  static handleChoice(orgId: string, contactId: string, raw: string): { message: string; newAppointmentId?: string } | null {
    const pending = this.pendingOffer(orgId, contactId);
    if (!pending) return null;
    const norm = String(raw || "").trim().toLowerCase();

    // Abandono explícito
    if (/^(x|xis|cancelar|cancela|desisto|desistir|nao|não)$/.test(norm)) {
      db.prepare(`UPDATE clinical_reschedule_offers SET status='abandoned', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(pending.id);
      logAuthEvent(orgId, null, contactId, "CLINIC_RESCHEDULE_ABANDONED", { offerId: pending.id });
      return { message: "Ok, mantive sua consulta original. Se precisar remarcar depois, é só nos avisar." };
    }

    // Precisa ser um dígito 1..N (N = slots.length)
    const idx = parseInt(norm, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > pending.slots.length) return null;

    const chosen = pending.slots[idx - 1];
    // Chegou tarde? Se o slot escolhido é passado, refaz busca automaticamente.
    if (new Date(chosen.startISO).getTime() <= Date.now() + 3600_000) {
      db.prepare(`UPDATE clinical_reschedule_offers SET status='expired', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(pending.id);
      return { message: "O horário escolhido já passou. Se ainda quiser remarcar, responda REMARCAR de novo." };
    }

    // Cria o novo appointment reusando scheduleFollowUp (parent_appointment_id,
    // herança de profissional/duração, validação de conflito).
    let created: any;
    try {
      created = ClinicAgendaService.scheduleFollowUp(orgId, pending.sourceAppointmentId, {
        atISO: chosen.startISO,
        durationMinutes: chosen.durationMinutes,
        title: "Remarcada (via WhatsApp)",
      }, null as any);
    } catch (e: any) {
      // Se apareceu conflito entre gerar a offer e agora (raro), abandona.
      db.prepare(`UPDATE clinical_reschedule_offers SET status='abandoned', resolved_at=CURRENT_TIMESTAMP WHERE id=?`).run(pending.id);
      return { message: "Esse horário ficou indisponível agora. Responda REMARCAR pra tentar de novo." };
    }
    // Cancela original + confirma o novo automaticamente.
    ClinicAgendaService.cancel(orgId, pending.sourceAppointmentId, { cancelledBy: "patient", reason: "rescheduled" }, null as any);
    ClinicAgendaService.confirmByPatient(orgId, created.id, null as any);
    // Vaga do original: tenta oferecer pra próximo da fila (best-effort, lazy import).
    Promise.resolve().then(async () => {
      const { ClinicVacancyService } = await import("./ClinicVacancyService.js");
      return ClinicVacancyService.tryOfferOnCancel(orgId, pending.sourceAppointmentId);
    }).catch(() => {});

    db.prepare(
      `UPDATE clinical_reschedule_offers SET status='chosen', chosen_index=?, new_appointment_id=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?`
    ).run(idx, created.id, pending.id);
    logAuthEvent(orgId, null, contactId, "CLINIC_RESCHEDULE_CHOSEN", { offerId: pending.id, chosenIndex: idx, newAppointmentId: created.id });

    return {
      message: `Perfeito! Sua consulta foi remarcada para ${fmtSlot(chosen.startISO)}. Até logo!`,
      newAppointmentId: created.id,
    };
  }
}

export default ClinicRescheduleService;
