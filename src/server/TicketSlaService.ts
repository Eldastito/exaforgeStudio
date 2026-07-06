import db from "./db.js";
import { NotificationService } from "./NotificationService.js";

/**
 * SLA de primeira resposta por PRIORIDADE e SEGMENTO (VIP) — ADR posterior ao
 * "SLA por canal" (ADR-026). Enquanto o SLA por canal mora na engine de IVC
 * (ConversionVelocityService, agregado/read-time), este serviço é ACIONÁVEL por
 * ticket: calcula, para cada atendimento aberto, o prazo de primeira resposta
 * segundo a prioridade do ticket e o valor do cliente, marca quem estourou e
 * notifica o responsável UMA vez. Fonte de verdade da "régua" é sempre
 * determinística e configurável — nunca IA.
 *
 * Regra de resolução: a meta efetiva é a MAIS APERTADA entre a meta da
 * prioridade e (se VIP) a meta VIP — um cliente VIP com prioridade alta recebe
 * a promessa mais rápida das duas, nunca a mais frouxa.
 */

export type SlaSegment = "vip" | "regular";
export interface SlaConfig {
  enabled: boolean;
  prioritySeconds: { alta: number; media: number; baixa: number };
  vipSeconds: number;
  vipMinSpent: number;
}

const DEFAULTS: SlaConfig = {
  enabled: false,
  prioritySeconds: { alta: 1800, media: 14400, baixa: 86400 },
  vipSeconds: 900,
  vipMinSpent: 1000,
};

export class TicketSlaService {
  static config(orgId: string): SlaConfig {
    const o = db.prepare(
      `SELECT sla_monitor_enabled, sla_priority_alta_seconds, sla_priority_media_seconds,
              sla_priority_baixa_seconds, sla_vip_seconds, sla_vip_min_spent
         FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    if (!o) return { ...DEFAULTS };
    return {
      enabled: !!o.sla_monitor_enabled,
      prioritySeconds: {
        alta: Number(o.sla_priority_alta_seconds) || DEFAULTS.prioritySeconds.alta,
        media: Number(o.sla_priority_media_seconds) || DEFAULTS.prioritySeconds.media,
        baixa: Number(o.sla_priority_baixa_seconds) || DEFAULTS.prioritySeconds.baixa,
      },
      vipSeconds: Number(o.sla_vip_seconds) || DEFAULTS.vipSeconds,
      vipMinSpent: o.sla_vip_min_spent != null ? Number(o.sla_vip_min_spent) : DEFAULTS.vipMinSpent,
    };
  }

  static saveConfig(orgId: string, patch: Partial<{ enabled: boolean; alta: number; media: number; baixa: number; vipSeconds: number; vipMinSpent: number }>): SlaConfig {
    const cur = this.config(orgId);
    // Sanitiza cada meta para 30s–7 dias (evita limiar absurdo); VIP min spent >= 0.
    const clampSec = (v: any, def: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 30 && n <= 604800 ? n : def; };
    const next = {
      enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
      alta: patch.alta !== undefined ? clampSec(patch.alta, cur.prioritySeconds.alta) : cur.prioritySeconds.alta,
      media: patch.media !== undefined ? clampSec(patch.media, cur.prioritySeconds.media) : cur.prioritySeconds.media,
      baixa: patch.baixa !== undefined ? clampSec(patch.baixa, cur.prioritySeconds.baixa) : cur.prioritySeconds.baixa,
      vipSeconds: patch.vipSeconds !== undefined ? clampSec(patch.vipSeconds, cur.vipSeconds) : cur.vipSeconds,
      vipMinSpent: patch.vipMinSpent !== undefined ? Math.max(0, Number(patch.vipMinSpent) || 0) : cur.vipMinSpent,
    };
    db.prepare(
      `UPDATE organization_settings SET sla_monitor_enabled = ?, sla_priority_alta_seconds = ?, sla_priority_media_seconds = ?,
              sla_priority_baixa_seconds = ?, sla_vip_seconds = ?, sla_vip_min_spent = ? WHERE organization_id = ?`
    ).run(next.enabled ? 1 : 0, next.alta, next.media, next.baixa, next.vipSeconds, next.vipMinSpent, orgId);
    return this.config(orgId);
  }

  /** Segmento do cliente a partir do gasto acumulado. VIP só quando o limiar > 0. */
  static segmentForSpent(totalSpent: number, vipMinSpent: number): SlaSegment {
    return vipMinSpent > 0 && Number(totalSpent || 0) >= vipMinSpent ? "vip" : "regular";
  }

  /** Meta efetiva (segundos) = a mais apertada entre prioridade e (se VIP) VIP. */
  static effectiveSeconds(cfg: SlaConfig, priority: string, segment: SlaSegment): number {
    const base = priority === "alta" ? cfg.prioritySeconds.alta
      : priority === "baixa" ? cfg.prioritySeconds.baixa
      : cfg.prioritySeconds.media;
    return segment === "vip" ? Math.min(base, cfg.vipSeconds) : base;
  }

  /** Faltando isto para o prazo, um ticket sem resposta já conta como "em risco". */
  static AT_RISK_LOOKAHEAD_MS = 30 * 60 * 1000;

  /**
   * Estado de exibição de um ticket a partir das colunas persistidas + agora.
   * Recalcula o breach ao vivo (não depende do último tick do monitor):
   * 'breached' = estourou (sem resposta já vencida, ou respondido acima do prazo);
   * 'at_risk' = sem resposta ainda e o prazo vence nos próximos 30 min;
   * 'ok' = respondido no prazo ou ainda com folga; null = sem dados/desligado.
   */
  static displayState(row: { sla_due_at?: string | null; sla_first_response_at?: string | null; sla_breached?: number | null }, nowMs: number): "ok" | "at_risk" | "breached" | null {
    if (!row || row.sla_due_at == null) return null;
    const dueMs = Date.parse(String(row.sla_due_at).replace(" ", "T") + (String(row.sla_due_at).includes("Z") ? "" : "Z"));
    if (!Number.isFinite(dueMs)) return null;
    if (row.sla_first_response_at) return row.sla_breached ? "breached" : "ok";
    if (nowMs > dueMs) return "breached";
    if (dueMs - nowMs <= this.AT_RISK_LOOKAHEAD_MS) return "at_risk";
    return "ok";
  }

  /**
   * Monitor (Scheduler): recalcula o SLA de todos os tickets abertos de uma org,
   * persiste due/breach/segment e notifica o responsável no 1º estouro sem
   * resposta. Idempotente e best-effort. Devolve contadores (usado em teste).
   */
  static evaluateOrg(orgId: string): { evaluated: number; breached: number; notified: number } {
    const cfg = this.config(orgId);
    if (!cfg.enabled) return { evaluated: 0, breached: 0, notified: 0 };

    // 1º contato (fc) e 1ª resposta nossa (fb) por ticket aberto — mesmo padrão
    // de ConversionVelocityService (sender_type = 'contact' vs 'bot'/'agent').
    const rows = db.prepare(`
      SELECT tk.id AS ticket_id, tk.priority AS priority, tk.assigned_to AS assigned_to,
             tk.sla_breach_notified_at AS notified_at,
             COALESCE(ct.total_spent, 0) AS total_spent, ct.name AS contact_name,
             fc.t AS contact_at, fb.t AS response_at
      FROM tickets tk
      LEFT JOIN contacts ct ON ct.id = tk.contact_id
      JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE organization_id = ? AND sender_type = 'contact' GROUP BY ticket_id) fc
        ON fc.ticket_id = tk.id
      LEFT JOIN (SELECT ticket_id, MIN(created_at) t FROM messages WHERE organization_id = ? AND sender_type IN ('bot','agent') GROUP BY ticket_id) fb
        ON fb.ticket_id = tk.id AND fb.t >= fc.t
      WHERE tk.organization_id = ? AND tk.status = 'open'
    `).all(orgId, orgId, orgId) as any[];

    const nowMs = Date.now();
    let breachedCount = 0, notified = 0;
    const upd = db.prepare(
      `UPDATE tickets SET sla_first_response_at = ?, sla_due_at = ?, sla_breached = ?, sla_segment = ?, sla_breach_notified_at = ? WHERE id = ? AND organization_id = ?`
    );

    for (const r of rows) {
      const segment = this.segmentForSpent(r.total_spent, cfg.vipMinSpent);
      const seconds = this.effectiveSeconds(cfg, r.priority || "media", segment);
      const contactMs = Date.parse(String(r.contact_at).replace(" ", "T") + "Z");
      if (!Number.isFinite(contactMs)) continue;
      const dueMs = contactMs + seconds * 1000;
      const dueIso = new Date(dueMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

      let firstResponseAt: string | null = null;
      let breached = 0;
      if (r.response_at) {
        firstResponseAt = r.response_at;
        const respMs = Date.parse(String(r.response_at).replace(" ", "T") + "Z");
        breached = Number.isFinite(respMs) && respMs - contactMs > seconds * 1000 ? 1 : 0;
      } else if (nowMs > dueMs) {
        breached = 1;
      }
      if (breached) breachedCount++;

      // Notifica só no 1º estouro SEM resposta (não re-notifica; some quando responde).
      let notifiedAt: string | null = r.notified_at || null;
      const isOpenBreach = breached === 1 && !firstResponseAt;
      if (isOpenBreach && !r.notified_at) {
        const ok = NotificationService.push({
          organizationId: orgId,
          title: "SLA estourado — atendimento sem resposta",
          message: `${r.contact_name || "Cliente"}${segment === "vip" ? " (VIP)" : ""} está há mais tempo que a meta de SLA sem primeira resposta.`,
          type: "alert",
          dedupeKey: `sla_breach:${r.ticket_id}`,
          dedupeWindowMin: 1440,
        });
        if (ok) { notified++; notifiedAt = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""); }
      } else if (firstResponseAt && r.notified_at) {
        // já respondido: limpa o carimbo para permitir futura notificação se reabrir.
        notifiedAt = null;
      }

      upd.run(firstResponseAt, dueIso, breached, segment, notifiedAt, r.ticket_id, orgId);
    }

    return { evaluated: rows.length, breached: breachedCount, notified };
  }
}
