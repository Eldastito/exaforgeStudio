import db from "./db.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { ClinicAgendaService } from "./ClinicAgendaService.js";

/**
 * Módulo Clínica — Portal do Profissional por link seguro (ADR-080, Fase D).
 *
 * Molde do Radar público (RadarPublicService): token aleatório de 32 bytes,
 * devolvido UMA vez ao gestor; no banco fica só o hash SHA-256 + expiração. O
 * link resolve SEMPRE por token (nunca por id — evita enumeração) e expõe
 * SOMENTE a agenda do próprio profissional: nada de financeiro, configurações
 * ou dados de outros profissionais.
 */
const TTL_DAYS = 90;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class ClinicPortalService {
  /** (Re)gera o link do profissional. Invalida tokens anteriores. Retorna o token CRU uma única vez. */
  static generateToken(orgId: string, professionalId: string, actorId?: string): { token: string; expiresAt: string } {
    const prof = db.prepare("SELECT id, name FROM clinic_professionals WHERE id = ? AND organization_id = ?").get(professionalId, orgId) as any;
    if (!prof) throw new Error("Profissional não encontrado.");
    // Um link ativo por profissional: desativa os anteriores.
    db.prepare("UPDATE professional_portal_tokens SET active = 0 WHERE organization_id = ? AND professional_id = ? AND active = 1").run(orgId, professionalId);
    const raw = randomBytes(32).toString("hex");
    const id = randomUUID();
    db.prepare(`INSERT INTO professional_portal_tokens (id, organization_id, professional_id, token_hash, active, expires_at) VALUES (?, ?, ?, ?, 1, datetime('now', ?))`)
      .run(id, orgId, professionalId, hashToken(raw), `+${TTL_DAYS} days`);
    logAuthEvent(orgId, actorId, null, "CLINIC_PORTAL_TOKEN_ISSUED", { professionalId, tokenId: id });
    const row = db.prepare("SELECT expires_at FROM professional_portal_tokens WHERE id = ?").get(id) as any;
    return { token: raw, expiresAt: row.expires_at };
  }

  /** Revoga o link ativo do profissional. */
  static revoke(orgId: string, professionalId: string, actorId?: string): boolean {
    const r = db.prepare("UPDATE professional_portal_tokens SET active = 0 WHERE organization_id = ? AND professional_id = ? AND active = 1").run(orgId, professionalId);
    if (r.changes > 0) logAuthEvent(orgId, actorId, null, "CLINIC_PORTAL_TOKEN_REVOKED", { professionalId });
    return r.changes > 0;
  }

  /** Status do link (sem expor o token): existe/ativo e validade. */
  static status(orgId: string, professionalId: string): { active: boolean; expiresAt: string | null; lastAccessAt: string | null } {
    const row = db.prepare("SELECT expires_at, last_access_at FROM professional_portal_tokens WHERE organization_id = ? AND professional_id = ? AND active = 1 AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1").get(orgId, professionalId) as any;
    return { active: !!row, expiresAt: row?.expires_at || null, lastAccessAt: row?.last_access_at || null };
  }

  /**
   * Resolve o token (sem login) e devolve a agenda do dia do profissional, com
   * projeção ENXUTA (nada sensível além do necessário para atender). Registra o
   * acesso. Lança se o token for inválido/expirado.
   */
  static agendaByToken(rawToken: string, dateISO?: string): any {
    const raw = String(rawToken || "").trim();
    if (!raw) throw new Error("Link inválido.");
    const tok = db.prepare("SELECT * FROM professional_portal_tokens WHERE token_hash = ? AND active = 1 AND expires_at > CURRENT_TIMESTAMP").get(hashToken(raw)) as any;
    if (!tok) throw new Error("Link inválido ou expirado. Peça um novo link à recepção.");
    const prof = db.prepare("SELECT id, name, specialty, color FROM clinic_professionals WHERE id = ? AND organization_id = ?").get(tok.professional_id, tok.organization_id) as any;
    if (!prof || !prof) throw new Error("Profissional não encontrado.");
    db.prepare("UPDATE professional_portal_tokens SET last_access_at = CURRENT_TIMESTAMP WHERE id = ?").run(tok.id);

    const agenda = ClinicAgendaService.agendaForDay(tok.organization_id, dateISO, { professionalId: tok.professional_id });
    // Projeção do portal: só o que o profissional precisa. Sem ids internos de
    // outras entidades, sem financeiro, sem outros profissionais.
    const appointments = agenda.appointments.map((a: any) => ({
      id: a.id,
      time: a.scheduled_start,
      patient_name: a.contact_name,
      room: a.room_name_snapshot,
      procedure: a.title,
      plan: [a.insurance_name, a.current_plan_name].filter(Boolean).join(" · ") || null,
      status: a.status,
      duration_minutes: a.duration_minutes,
      effective_end: a.effective_end,
      overrun_state: a.overrun_state,
      warning_minutes: a.warning_minutes,
      checkin_at: a.checkin_at,
      care_started_at: a.care_started_at,
      continuation_status: a.continuation_status,
    }));
    return {
      professional: { name: prof.name, specialty: prof.specialty, color: prof.color },
      date: agenda.date,
      appointments,
    };
  }

  /** CSV da agenda do dia (para impressão/exportação da recepção). */
  static agendaCsv(orgId: string, dateISO?: string, opts: { professionalId?: string } = {}): string {
    const agenda = ClinicAgendaService.agendaForDay(orgId, dateISO, { professionalId: opts.professionalId });
    const header = ["Horario", "Paciente", "Profissional", "Sala", "Convenio", "Plano", "Procedimento", "Duracao(min)", "Status"];
    const esc = (v: any) => { const s = String(v ?? ""); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = agenda.appointments.map((a: any) => [
      a.scheduled_start, a.contact_name, a.professional_name, a.room_name_snapshot,
      a.insurance_name, a.current_plan_name, a.title, a.duration_minutes, a.status,
    ].map(esc).join(","));
    return [header.join(","), ...rows].join("\n");
  }
}
