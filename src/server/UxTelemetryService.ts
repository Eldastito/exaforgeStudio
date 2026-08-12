/**
 * UxTelemetryService — PRD 6 / ADR-163 F10 (§80-§84): telemetria de UX.
 *
 * Mede a EXPERIÊNCIA (não o conteúdo): TTFV (time-to-first-value), cliques em ação,
 * aprovações concluídas, pedidos de esclarecimento, adoção e abandono. É a base que
 * a F12 (redução de legado) exige ANTES de remover qualquer tela (§107/§112).
 *
 * GUARDRAIL DURO — RN-UX-7 / LGPD §84 (minimização): NUNCA grava conteúdo. Só
 * identificadores curtos SANITIZADOS (`event_type` do whitelist; `surface`/`module_key`
 * reduzidos a [a-z0-9_-], truncados). Sem texto livre, sem payload, sem PII de
 * conteúdo — só o `user_id` interno (que já vive no audit) pra adoção/abandono.
 *
 * OPT-IN (§84): `record` só coleta quando `ux_telemetry_enabled` está ligado —
 * sem a flag é NO-OP (nada entra no banco). Best-effort (nunca joga pro caller,
 * padrão nº 7). Isolado por org; leitura agregada só pra gestor.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { ContextProjectionService } from "./ContextProjectionService.js";

// Whitelist de eventos (§80) — nada fora disso é gravado.
const EVENT_TYPES = new Set(["view_opened", "action_clicked", "approval_completed", "clarification_requested", "first_value"]);

/** Reduz a um id curto seguro: [a-z0-9_-], minúsculo, ≤ 40 — barra texto livre/PII. */
function safeId(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return s || null;
}

export class UxTelemetryService {
  static enabled(orgId: string): boolean {
    const r = db.prepare(`SELECT COALESCE(ux_telemetry_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && Number(r.e));
  }

  /**
   * Registra um evento minimizado. No-op se a flag estiver desligada (consentimento)
   * ou se o `event_type` não estiver no whitelist. Nunca lança (best-effort).
   */
  static record(orgId: string, user: any, input: { eventType: string; surface?: string; moduleKey?: string; sessionId?: string; ttfvMs?: number }): { recorded: boolean; reason?: string } {
    try {
      if (!this.enabled(orgId)) return { recorded: false, reason: "disabled" };
      const eventType = String(input?.eventType || "");
      if (!EVENT_TYPES.has(eventType)) return { recorded: false, reason: "event_type_not_allowed" };
      const userId = user?.userId || user?.id || null;
      // TTFV só faz sentido em first_value; ignorado (null) nos demais.
      const ttfv = eventType === "first_value" && Number.isFinite(Number(input?.ttfvMs)) && Number(input.ttfvMs) >= 0
        ? Math.round(Number(input.ttfvMs)) : null;
      db.prepare(
        `INSERT INTO ux_telemetry_events (id, organization_id, user_id, event_type, surface, module_key, session_id, ttfv_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, userId, eventType, safeId(input?.surface), safeId(input?.moduleKey), safeId(input?.sessionId), ttfv);
      return { recorded: true };
    } catch { return { recorded: false, reason: "error" }; }
  }

  /**
   * Agregados derivados (RN-004) numa janela: contagem por evento/superfície, TTFV
   * (p50/média), adoção (usuários distintos) e abandono (sessões que abriram uma
   * tela sem nenhum clique de ação). Só pra gestor (visão completa). Nunca conteúdo.
   */
  static summary(orgId: string, user: any, opts: { sinceDays?: number } = {}): {
    windowDays: number;
    totals: { events: number; byType: Record<string, number>; bySurface: Record<string, number> };
    ttfv: { count: number; avgMs: number | null; medianMs: number | null };
    adoption: { distinctUsers: number };
    abandonment: { viewSessions: number; sessionsWithAction: number; abandonedSessions: number; rate: number };
    generatedAt: string;
  } | { restricted: true } {
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, user)) return { restricted: true };
    const days = Math.max(1, Math.min(365, Number(opts.sinceDays) || 30));
    const since = `-${days} day`;
    const rows = db.prepare(
      `SELECT event_type, surface, session_id, user_id, ttfv_ms FROM ux_telemetry_events
        WHERE organization_id = ? AND datetime(created_at) >= datetime('now', ?)`
    ).all(orgId, since) as any[];

    const byType: Record<string, number> = {};
    const bySurface: Record<string, number> = {};
    const ttfvs: number[] = [];
    const users = new Set<string>();
    const viewSessions = new Set<string>();
    const actionSessions = new Set<string>();
    for (const r of rows) {
      byType[r.event_type] = (byType[r.event_type] || 0) + 1;
      if (r.surface) bySurface[r.surface] = (bySurface[r.surface] || 0) + 1;
      if (r.user_id) users.add(r.user_id);
      if (r.ttfv_ms != null) ttfvs.push(Number(r.ttfv_ms));
      if (r.session_id) {
        if (r.event_type === "view_opened") viewSessions.add(r.session_id);
        if (r.event_type === "action_clicked") actionSessions.add(r.session_id);
      }
    }
    ttfvs.sort((a, b) => a - b);
    const median = ttfvs.length ? ttfvs[Math.floor((ttfvs.length - 1) / 2)] : null;
    const avg = ttfvs.length ? Math.round(ttfvs.reduce((s, x) => s + x, 0) / ttfvs.length) : null;
    // Abandono = sessão que abriu uma tela e NÃO teve nenhum clique de ação.
    let withAction = 0;
    for (const s of viewSessions) if (actionSessions.has(s)) withAction++;
    const abandoned = viewSessions.size - withAction;

    return {
      windowDays: days,
      totals: { events: rows.length, byType, bySurface },
      ttfv: { count: ttfvs.length, avgMs: avg, medianMs: median },
      adoption: { distinctUsers: users.size },
      abandonment: {
        viewSessions: viewSessions.size,
        sessionsWithAction: withAction,
        abandonedSessions: abandoned,
        rate: viewSessions.size ? Math.round((abandoned / viewSessions.size) * 100) / 100 : 0,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

export default UxTelemetryService;
