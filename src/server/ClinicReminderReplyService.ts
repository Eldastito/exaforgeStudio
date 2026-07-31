/**
 * Módulo Clínica — parser SIM/NÃO em resposta a lembrete (ADR-080 Fase N).
 *
 * A Fatia M manda "responda SIM ou NÃO"; esta fatia FECHA o loop: quando o
 * paciente responde, o webhook processor chama `tryHandle` antes de qualquer
 * outra coisa (padrão dos interceptadores CSAT/Tutor em `webhookProcessor.ts`).
 *
 * Regras:
 *   - Reply só age se o paciente recebeu lembrete `sent` nas últimas 26h
 *     (janela = 24h do lembrete + 2h de folga pro paciente responder atrasado
 *     ou pra consulta que já começou).
 *   - Match tolerante a acento, caixa e pontuação (`SIM/S/CONFIRMA/OK/YES` /
 *     `NÃO/N/NAO/CANCELA/CANCELAR/NO`); mensagens ambíguas passam adiante.
 *   - SIM → `confirmByPatient` (idempotente).
 *   - NÃO → `cancel(cancelledBy='patient', reason='patient_reply')` (idempotente).
 *   - Devolve `{handled, reply}` — chamador manda `reply` como ACK e retorna
 *     antes da IA processar a msg.
 *
 * Determinístico, zero-token, isolado por `organization_id`.
 */
import db from "./db.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";
import { ClinicRescheduleService } from "./ClinicRescheduleService.js";
import { ClinicVacancyService } from "./ClinicVacancyService.js";
import { LgpdService } from "./LgpdService.js";
import { logAuthEvent } from "./auditLog.js";

const REPLY_WINDOW_HOURS = 26;

// Fase 32: patterns relaxadas — aceitam repetição de vogal/consoante final
// e "OK!!!" etc. Motivação: paciente digita "simm", "cancelaaaa", "nãooo",
// "confirmou", "confirmada" e o produto entende. Sem inventar palavra nova
// (esse é escopo de outra fatia — aqui é só flexibilidade das existentes).
// `+` no final permite repetição da última letra; `!*` no fim absorve
// exclamação restante (o `normalize` já retira pontuação de canto, mas
// deixa no meio).
const YES_PATTERNS = /^(?:si+m+|s|confirm(?:o|a|ar|ado|ada|ou)|ok+(?:ay|ei|zin)?|k|yes|y|👍)$/;
const NO_PATTERNS = /^(?:n+a+o+|n(?:n+)?|nao+|no+pe?|cancel(?:a+|ar|o|ei|amos)|👎)$/;
const RESCHEDULE_PATTERNS = /^(?:remarc(?:ar|a+r?|o)|reagend(?:ar|a+r?|o)|mudar|mudar horario|mudar data|outro horario|outra data|outro dia)$/;
// Fase 32: opt-out explícito no rodapé do lembrete ("Responda PARAR pra não
// receber mais lembretes"). Reconhece PARAR/STOP/CANCELAR TUDO/SAIR — LGPD
// Art.8 §5 (revogação facilitada). Revoga consent `comunicacoes` do paciente
// via LgpdService.revokeConsent (Fase L cascata pra portal tokens; Fase 18
// já garante que o portal para de resolver token depois do revoke).
const OPTOUT_PATTERNS = /^(?:parar|para|pare|stop|sair|cancelar tudo|nao quero mais|nao me mande mais|nao me manda mais)$/;

function normalize(s: string): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos (acentos)
    .replace(/[.!?,;:"'()\-—–…\s]+$/g, "") // pontuação/emoji no fim
    .replace(/^[.!?,;:"'()\-—–…\s]+/g, ""); // pontuação no início
}

export type ReplyAction = "confirmed" | "cancelled" | "reschedule_offered" | "rescheduled" | "reschedule_abandoned" | "vacancy_accepted" | "vacancy_declined" | "optout" | null;

export interface ReplyResult {
  handled: boolean;
  action: ReplyAction;
  appointmentId: string | null;
  reply: string | null;
}

const NOT_HANDLED: ReplyResult = { handled: false, action: null, appointmentId: null, reply: null };

export class ClinicReminderReplyService {
  /** Detecta o intent do texto. `null` = ambíguo, deixa o fluxo normal seguir. */
  static parseIntent(text: string): ReplyAction {
    const norm = normalize(text);
    if (!norm) return null;
    if (OPTOUT_PATTERNS.test(norm)) return "optout";
    if (YES_PATTERNS.test(norm)) return "confirmed";
    if (NO_PATTERNS.test(norm)) return "cancelled";
    if (RESCHEDULE_PATTERNS.test(norm)) return "reschedule_offered";
    return null;
  }

  /**
   * Procura o lembrete mais recente do paciente na janela e o appointment
   * correspondente. Devolve `null` se não houver — quer dizer "esta msg não
   * é resposta ao meu lembrete, deixa a IA cuidar".
   */
  static findPendingReminder(orgId: string, contactId: string, nowMs = Date.now()): { appointmentId: string; reminderSentAt: string } | null {
    const cutoffISO = new Date(nowMs - REPLY_WINDOW_HOURS * 3600_000).toISOString();
    const row = db.prepare(
      `SELECT r.appointment_id, r.sent_at, a.status
         FROM clinical_appointment_reminders r
         JOIN appointments a ON a.id = r.appointment_id AND a.organization_id = r.organization_id
        WHERE r.organization_id = ? AND r.contact_id = ?
          AND r.status = 'sent' AND r.sent_at >= ?
        ORDER BY r.sent_at DESC, r.rowid DESC LIMIT 1`
    ).get(orgId, contactId, cutoffISO) as any;
    if (!row) return null;
    return { appointmentId: row.appointment_id, reminderSentAt: row.sent_at };
  }

  /**
   * Tenta processar como resposta a lembrete. Se casar, executa a ação e
   * devolve `{handled: true, reply: "..."}`. Se não casar (intent ambíguo ou
   * sem lembrete recente), devolve `{handled: false}` — o processor
   * segue com o fluxo normal (IA, tickets, etc).
   */
  static tryHandle(orgId: string, contactId: string, text: string, nowMs = Date.now()): ReplyResult {
    // (0) Offer de reagendamento pendente? Tenta 1/2/3/X primeiro — o número
    // isolado só faz sentido quando há offer ativa, então prioriza sobre
    // qualquer outra interpretação.
    const pendingOffer = ClinicRescheduleService.pendingOffer(orgId, contactId);
    if (pendingOffer) {
      const choice = ClinicRescheduleService.handleChoice(orgId, contactId, text);
      if (choice) {
        return {
          handled: true,
          action: choice.newAppointmentId ? "rescheduled" : "reschedule_abandoned",
          appointmentId: choice.newAppointmentId || pendingOffer.sourceAppointmentId,
          reply: choice.message,
        };
      }
      // Se não bateu como escolha (texto qualquer), cai no fluxo normal —
      // permite paciente responder SIM/NÃO mesmo com offer pendente.
    }

    // (0.5) Oferta de VAGA pendente pro contato (Fase Q)? SIM/NÃO aqui vale
    // pra vaga, não pra lembrete — vaga é evento raro, o texto SIM logo
    // após "abriu uma vaga" refere-se a ela.
    const pendingVacancy = ClinicVacancyService.pendingOfferFor(orgId, contactId);
    if (pendingVacancy) {
      const intentForVacancy = this.parseIntent(text);
      if (intentForVacancy === "confirmed" || intentForVacancy === "cancelled") {
        const r = ClinicVacancyService.handleReply(orgId, contactId, intentForVacancy === "confirmed");
        if (r) {
          return {
            handled: true,
            action: intentForVacancy === "confirmed" ? "vacancy_accepted" : "vacancy_declined",
            appointmentId: r.newAppointmentId || pendingVacancy.sourceAppointmentId,
            reply: r.reply,
          };
        }
      }
    }

    const intent = this.parseIntent(text);
    if (!intent) return NOT_HANDLED;

    // (0.7) Opt-out (Fase 32): "PARAR"/"STOP"/"SAIR" revoga consent
    // `comunicacoes` do paciente — LGPD Art.8 §5. Não exige lembrete
    // pendente (paciente pode pedir pra parar a qualquer momento).
    // Idempotente: se já revogado, só devolve reply amigável.
    if (intent === "optout") {
      const already = !LgpdService.hasConsent(orgId, contactId, "comunicacoes");
      if (!already) {
        try { LgpdService.revokeConsent(orgId, contactId, "comunicacoes", null as any); } catch { /* noop */ }
        logAuthEvent(orgId, null, contactId, "CLINIC_REMINDER_OPTOUT", { via: "whatsapp_reply" });
      }
      return { handled: true, action: "optout", appointmentId: null,
        reply: already
          ? "Você já não recebe mais nossos avisos. Se mudar de ideia, é só falar com a recepção."
          : "Ok, não vamos mais te mandar avisos automáticos. Se precisar remarcar ou tirar dúvidas, fale direto com a recepção." };
    }

    const pending = this.findPendingReminder(orgId, contactId, nowMs);
    if (!pending) return NOT_HANDLED;

    // Pega estado atual pra respostas amigáveis e idempotência.
    const apt = db.prepare(`SELECT id, status, patient_confirmed_at, scheduled_start FROM appointments WHERE id = ? AND organization_id = ?`)
      .get(pending.appointmentId, orgId) as any;
    if (!apt) return NOT_HANDLED;

    if (intent === "confirmed") {
      // Se já cancelou, não "confirma de volta" — avisa que está cancelado.
      if (apt.status === "cancelled") {
        return { handled: true, action: null, appointmentId: apt.id, reply: "Sua consulta foi cancelada. Se quiser reagendar, é só nos avisar." };
      }
      if (apt.patient_confirmed_at) {
        return { handled: true, action: "confirmed", appointmentId: apt.id, reply: "Já está confirmado! Nos vemos em breve." };
      }
      ClinicAgendaService.confirmByPatient(orgId, apt.id, null);
      return { handled: true, action: "confirmed", appointmentId: apt.id, reply: "Perfeito! Consulta confirmada. Até logo!" };
    }

    if (intent === "reschedule_offered") {
      if (apt.status === "cancelled") {
        return { handled: true, action: null, appointmentId: apt.id, reply: "Sua consulta está cancelada. Se quiser marcar uma nova, entre em contato com a recepção." };
      }
      const offered = ClinicRescheduleService.createOffer(orgId, apt.id, contactId);
      if (!offered) {
        return { handled: true, action: null, appointmentId: apt.id, reply: "Não encontrei horários livres nos próximos dias — entre em contato com a recepção para remarcar." };
      }
      return { handled: true, action: "reschedule_offered", appointmentId: apt.id, reply: offered.message };
    }

    // intent === "cancelled"
    if (apt.status === "cancelled") {
      return { handled: true, action: "cancelled", appointmentId: apt.id, reply: "Ok, sua consulta já estava cancelada. Se quiser reagendar, é só nos avisar." };
    }
    ClinicAgendaService.cancel(orgId, apt.id, { cancelledBy: "patient", reason: "patient_reply" }, null);
    // Vaga aberta: tenta oferecer pra próximo da fila (best-effort, não bloqueia resposta ao paciente atual).
    Promise.resolve().then(() => ClinicVacancyService.tryOfferOnCancel(orgId, apt.id)).catch(() => {});
    return { handled: true, action: "cancelled", appointmentId: apt.id, reply: "Consulta cancelada. Obrigado por avisar! Se quiser reagendar, é só nos chamar." };
  }
}

export default ClinicReminderReplyService;
