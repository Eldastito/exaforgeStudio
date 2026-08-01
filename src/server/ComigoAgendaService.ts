import db from "./db.js";
import { randomUUID } from "crypto";
import { BalcaoService } from "./BalcaoService.js";

/**
 * ZappFlow Comigo — Agenda por HORA MARCADA (ADR-088 D1, arquétipo agenda).
 *
 * Superfície de agendamento pro autônomo que atende com hora marcada
 * (manicure, cabelo/barbearia, chaveiro-em-modo-agenda...). Serviço LIGHT: o
 * autônomo É o único profissional — não modela múltiplos operadores/salas
 * (isso vira segunda fatia quando entrar o "sócio"). Reusa a tabela genérica
 * `appointments` (não cria `comigo_appointments`) — os campos clínicos ficam
 * NULL e o vocabulário de status (`pending`/`confirmed`/`in_progress`/
 * `completed`/`cancelled`/`no_show`) já é comum.
 *
 * Padrão: reusa `BalcaoService.ensureFiadoContact` pra criar o contato do
 * cliente (canal sintético "balcao") — evita duplicar identidade entre
 * caderneta e agenda. Duração padrão vem da recipe (`labor_minutes`) quando
 * o serviço é vinculado a uma ficha — fecha o loop do ADR-088 D6 ("O tempo
 * é o insumo esquecido do serviço").
 *
 * Isolado por organization_id em toda leitura/escrita.
 */

// Status considerados "ativos" pra fins de conflito (não conta cancelado/no-show/concluído).
const ACTIVE_STATUSES = ["pending", "confirmed", "in_progress"];

// Duração-piso quando a recipe não tem `labor_minutes` e o UI não passou nada.
const DEFAULT_DURATION_MIN = 30;

const toMs = (iso: string | number | Date | null | undefined): number | null => {
  if (iso == null) return null;
  if (typeof iso === "number") return iso;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

export type AgendaAppointment = {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_phone: string | null;
  product_service_id: string | null;
  product_name: string | null;
  title: string;
  description: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  duration_minutes: number;
  status: string;
  cancellation_reason: string | null;
  created_at: string;
};

export type CreateAgendaInput = {
  contact_name?: string;
  contact_phone?: string;
  contact_id?: string;
  product_service_id?: string | null;
  title?: string;
  description?: string | null;
  scheduled_start: string; // ISO
  duration_minutes?: number;
  force?: boolean; // ignora conflito (uso raro, mas registrado)
};

export type Conflict = {
  id: string;
  title: string;
  scheduled_start: string;
  scheduled_end: string | null;
};

export class ComigoAgendaService {
  /** Contatos da agenda (usa o mesmo do Balcão pra não duplicar cadastro). */
  static ensureContact(orgId: string, name: string, phone: string): string {
    return BalcaoService.ensureFiadoContact(orgId, name, phone);
  }

  /**
   * Duração padrão do atendimento: se vier `product_service_id` e existir
   * `comigo_recipes.labor_minutes` pra esse produto, usa; senão o piso.
   */
  static defaultDuration(orgId: string, productServiceId?: string | null): number {
    if (!productServiceId) return DEFAULT_DURATION_MIN;
    const r = db.prepare(
      "SELECT labor_minutes FROM comigo_recipes WHERE organization_id = ? AND product_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(orgId, productServiceId) as any;
    const mins = Number(r?.labor_minutes);
    return mins > 0 ? mins : DEFAULT_DURATION_MIN;
  }

  /**
   * Conflitos: appointments ativos que se sobrepõem à janela [startMs,endMs].
   * O autônomo é o único profissional — conflito é global (qualquer appt
   * ativo no intervalo colide). `ignoreId` pra edição.
   */
  static findConflicts(orgId: string, startMs: number, endMs: number, ignoreId?: string): Conflict[] {
    const rows = db.prepare(
      `SELECT id, title, scheduled_start, scheduled_end
         FROM appointments
        WHERE organization_id = ?
          AND status IN ('pending','confirmed','in_progress')
          ${ignoreId ? "AND id != ?" : ""}`
    ).all(...(ignoreId ? [orgId, ignoreId] : [orgId])) as any[];
    const out: Conflict[] = [];
    for (const r of rows) {
      const st = toMs(r.scheduled_start);
      if (st == null) continue;
      const en = toMs(r.scheduled_end) ?? (st + DEFAULT_DURATION_MIN * 60000);
      if (en > startMs && st < endMs) {
        out.push({ id: r.id, title: r.title, scheduled_start: r.scheduled_start, scheduled_end: r.scheduled_end });
      }
    }
    return out;
  }

  /** Lista o dia hidratado (join com contacts e products_services). */
  static listForDay(orgId: string, dateISO: string): AgendaAppointment[] {
    // dateISO no formato YYYY-MM-DD; janela do dia no horário LOCAL do server.
    const d = new Date(`${dateISO}T00:00:00`);
    if (!Number.isFinite(d.getTime())) return [];
    const start = d.getTime();
    const end = start + 24 * 60 * 60 * 1000;

    const rows = db.prepare(
      `SELECT a.id, a.contact_id, a.product_service_id, a.title, a.description,
              a.scheduled_start, a.scheduled_end, a.expected_duration_minutes,
              a.status, a.cancellation_reason, a.created_at,
              c.name AS contact_name, c.identifier AS contact_phone,
              p.name AS product_name
         FROM appointments a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN products_services p ON p.id = a.product_service_id
        WHERE a.organization_id = ?
          AND a.scheduled_start IS NOT NULL
        ORDER BY a.scheduled_start ASC`
    ).all(orgId) as any[];

    const out: AgendaAppointment[] = [];
    for (const r of rows) {
      const st = toMs(r.scheduled_start);
      if (st == null || st < start || st >= end) continue;
      const en = toMs(r.scheduled_end);
      const dur = Number(r.expected_duration_minutes) ||
        (en != null && st != null ? Math.max(1, Math.round((en - st) / 60000)) : DEFAULT_DURATION_MIN);
      out.push({
        id: r.id,
        contact_id: r.contact_id,
        contact_name: r.contact_name || "Cliente",
        contact_phone: r.contact_phone || null,
        product_service_id: r.product_service_id || null,
        product_name: r.product_name || null,
        title: r.title,
        description: r.description || null,
        scheduled_start: r.scheduled_start,
        scheduled_end: r.scheduled_end || null,
        duration_minutes: dur,
        status: r.status,
        cancellation_reason: r.cancellation_reason || null,
        created_at: r.created_at,
      });
    }
    return out;
  }

  /** Lê um único agendamento hidratado (ou null). */
  static get(orgId: string, id: string): AgendaAppointment | null {
    const r = db.prepare(
      `SELECT a.id, a.contact_id, a.product_service_id, a.title, a.description,
              a.scheduled_start, a.scheduled_end, a.expected_duration_minutes,
              a.status, a.cancellation_reason, a.created_at,
              c.name AS contact_name, c.identifier AS contact_phone,
              p.name AS product_name
         FROM appointments a
         LEFT JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN products_services p ON p.id = a.product_service_id
        WHERE a.organization_id = ? AND a.id = ?`
    ).get(orgId, id) as any;
    if (!r) return null;
    const st = toMs(r.scheduled_start);
    const en = toMs(r.scheduled_end);
    const dur = Number(r.expected_duration_minutes) ||
      (en != null && st != null ? Math.max(1, Math.round((en - st) / 60000)) : DEFAULT_DURATION_MIN);
    return {
      id: r.id,
      contact_id: r.contact_id,
      contact_name: r.contact_name || "Cliente",
      contact_phone: r.contact_phone || null,
      product_service_id: r.product_service_id || null,
      product_name: r.product_name || null,
      title: r.title,
      description: r.description || null,
      scheduled_start: r.scheduled_start,
      scheduled_end: r.scheduled_end || null,
      duration_minutes: dur,
      status: r.status,
      cancellation_reason: r.cancellation_reason || null,
      created_at: r.created_at,
    };
  }

  /**
   * Cria um agendamento. Requer: cliente (por contact_id OU nome+telefone),
   * scheduled_start (ISO). Se `product_service_id` vem, herda duração da
   * recipe. Se `force !== true` e houver conflito, devolve error CONFLICT
   * com a lista — a UI decide o que mostrar.
   */
  static create(
    orgId: string,
    input: CreateAgendaInput,
    _actorId?: string
  ): { ok: true; id: string } | { ok: false; error: string; conflicts?: Conflict[]; message?: string } {
    // Cliente: prioriza contact_id passado; senão cria pelo nome/telefone.
    let contactId = input.contact_id?.trim() || "";
    if (!contactId) {
      const name = String(input.contact_name || "").trim();
      const phone = String(input.contact_phone || "").trim();
      if (!name && !phone) return { ok: false, error: "contact_required", message: "Informe o cliente (nome e telefone)." };
      contactId = this.ensureContact(orgId, name || "Cliente", phone);
    } else {
      const exists = db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(contactId, orgId);
      if (!exists) return { ok: false, error: "contact_not_found" };
    }

    // Horário
    const startMs = toMs(input.scheduled_start);
    if (startMs == null) return { ok: false, error: "invalid_scheduled_start" };
    const durationMin = Number(input.duration_minutes) > 0
      ? Number(input.duration_minutes)
      : this.defaultDuration(orgId, input.product_service_id);
    const endMs = startMs + durationMin * 60000;
    const endISO = new Date(endMs).toISOString();

    // Conflito (a menos que force=true)
    if (!input.force) {
      const conflicts = this.findConflicts(orgId, startMs, endMs);
      if (conflicts.length) return { ok: false, error: "CONFLICT", conflicts, message: "Já tem outro cliente nesse horário." };
    }

    // Título default
    let title = String(input.title || "").trim();
    if (!title && input.product_service_id) {
      const p = db.prepare("SELECT name FROM products_services WHERE organization_id = ? AND id = ?").get(orgId, input.product_service_id) as any;
      title = p?.name || "Atendimento";
    }
    if (!title) title = "Atendimento";

    const id = randomUUID();
    db.prepare(
      `INSERT INTO appointments (id, organization_id, contact_id, product_service_id, title, description,
                                 scheduled_start, scheduled_end, expected_duration_minutes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`
    ).run(id, orgId, contactId, input.product_service_id || null, title, input.description || null,
      input.scheduled_start, endISO, durationMin);

    return { ok: true, id };
  }

  /** Cancela (não deleta — mantém histórico). Aceita motivo. */
  static cancel(orgId: string, id: string, reason?: string, actorId?: string): boolean {
    const r = db.prepare("SELECT status FROM appointments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!r) return false;
    if (r.status === "cancelled") return true;
    db.prepare(
      `UPDATE appointments SET status = 'cancelled', cancellation_reason = ?, cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ?
       WHERE id = ? AND organization_id = ?`
    ).run(String(reason || "").trim() || null, actorId || null, id, orgId);
    return true;
  }

  /** Conclui (atendido). */
  static complete(orgId: string, id: string): boolean {
    const r = db.prepare("SELECT status FROM appointments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!r) return false;
    if (r.status === "completed") return true;
    if (r.status === "cancelled") return false;
    db.prepare(
      `UPDATE appointments SET status = 'completed' WHERE id = ? AND organization_id = ?`
    ).run(id, orgId);
    return true;
  }

  /** No-show: cliente furou. Registra pra métrica futura sem apagar. */
  static markNoShow(orgId: string, id: string): boolean {
    const r = db.prepare("SELECT status FROM appointments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!r) return false;
    if (r.status === "no_show") return true;
    if (["cancelled", "completed"].includes(r.status)) return false;
    db.prepare(
      `UPDATE appointments SET status = 'no_show' WHERE id = ? AND organization_id = ?`
    ).run(id, orgId);
    return true;
  }

  /** Contadores rápidos pra badge/overview. */
  static counts(orgId: string, dateISO?: string): { today: number; upcoming: number } {
    const nowMs = Date.now();
    const date = dateISO || new Date().toISOString().slice(0, 10);
    const dayStart = new Date(`${date}T00:00:00`).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const rows = db.prepare(
      `SELECT scheduled_start FROM appointments
        WHERE organization_id = ? AND status IN ('pending','confirmed','in_progress')
              AND scheduled_start IS NOT NULL`
    ).all(orgId) as any[];
    let today = 0, upcoming = 0;
    for (const r of rows) {
      const t = toMs(r.scheduled_start);
      if (t == null) continue;
      if (t >= dayStart && t < dayEnd) today++;
      if (t >= nowMs) upcoming++;
    }
    return { today, upcoming };
  }
}

export default ComigoAgendaService;

// Constantes exportadas pra testes.
export const _internals = { ACTIVE_STATUSES, DEFAULT_DURATION_MIN };
