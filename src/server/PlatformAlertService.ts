/**
 * PlatformAlertService — PRD 7 / ADR-164 F12 (§99, CA17, RN-PRC): alertas de PLATAFORMA
 * para o Admin Master, com anti-spam.
 *
 * É o "Platform Health Event separado de `business_signals` per-tenant" (RN-PRC): saúde de
 * INFRA é do operador da plataforma, não de um tenant — então NÃO usa `business_signals`
 * (que é per-org). Persiste em `platform_health_events` (GLOBAL, sem organization_id).
 *
 * ANTI-SPAM (CA17 — avisar ANTES do crítico, sem afogar): um evento ABERTO por `dedupeKey`;
 * reincidência bumpa `occurrences`/`last_seen_at` em vez de duplicar. A NOTIFICAÇÃO (canais
 * reusados — Fala Tu/Push/in-app/e-mail) só reflora depois da janela `NOTIFY_WINDOW_MS`
 * (`notified_at`), então um problema persistente não vira enxurrada.
 *
 * GUARDRAILS: RN-PRC-4/§46 — GLOBAL/Admin Master, nunca vaza pro tenant. RN-PRC-3 — grava
 * só o EVENTO (incidente), nunca raw time-series. Determinístico (`now` injetável). A
 * ENTREGA nos canais é best-effort (nunca quebra o caller — convenção 7).
 */
import db from "./db.js";
import { randomUUID } from "crypto";

type Severity = "info" | "warning" | "critical";
const NOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000; // reflora a notificação a cada 6h (anti-spam)

export class PlatformAlertService {
  /**
   * Registra/atualiza um evento de saúde de plataforma. Idempotente por `dedupeKey`.
   * Retorna se criou, se deve (re)notificar (janela anti-spam) e o evento.
   */
  static raise(input: {
    eventType: string; severity: Severity; dedupeKey: string; title: string;
    detail?: any; now?: number; notifyWindowMs?: number;
  }): { created: boolean; shouldNotify: boolean; event: any } {
    if (!input.eventType || !input.severity || !input.dedupeKey || !input.title) {
      throw new Error("raise exige eventType, severity, dedupeKey e title.");
    }
    const now = input.now ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const win = input.notifyWindowMs ?? NOTIFY_WINDOW_MS;
    const existing = db.prepare(`SELECT * FROM platform_health_events WHERE dedupe_key = ? AND status = 'open'`).get(input.dedupeKey) as any;

    if (existing) {
      // Reincidência: bumpa contadores; (re)notifica só se passou a janela anti-spam.
      const lastNotified = existing.notified_at ? Date.parse(existing.notified_at) : 0;
      const shouldNotify = now - lastNotified >= win;
      db.prepare(`UPDATE platform_health_events SET occurrences = occurrences + 1, last_seen_at = ?, severity = ?, detail_json = ?${shouldNotify ? ", notified_at = ?" : ""} WHERE id = ?`)
        .run(...(shouldNotify
          ? [nowIso, input.severity, JSON.stringify(input.detail ?? {}), nowIso, existing.id]
          : [nowIso, input.severity, JSON.stringify(input.detail ?? {}), existing.id]));
      const event = db.prepare(`SELECT * FROM platform_health_events WHERE id = ?`).get(existing.id);
      if (shouldNotify) this.deliverBestEffort(event);
      return { created: false, shouldNotify, event };
    }

    // Novo evento → sempre notifica (primeira vez).
    const id = randomUUID();
    db.prepare(`INSERT INTO platform_health_events (id, event_type, severity, dedupe_key, title, detail_json, status, occurrences, first_seen_at, last_seen_at, notified_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)`)
      .run(id, input.eventType, input.severity, input.dedupeKey, input.title, JSON.stringify(input.detail ?? {}), nowIso, nowIso, nowIso);
    const event = db.prepare(`SELECT * FROM platform_health_events WHERE id = ?`).get(id);
    this.deliverBestEffort(event);
    return { created: true, shouldNotify: true, event };
  }

  /** Resolve o evento aberto de uma chave (recuperou). Idempotente. */
  static resolveByDedupe(dedupeKey: string, now?: number): boolean {
    const nowIso = new Date(now ?? Date.now()).toISOString();
    const r = db.prepare(`UPDATE platform_health_events SET status = 'resolved', resolved_at = ? WHERE dedupe_key = ? AND status = 'open'`).run(nowIso, dedupeKey);
    return r.changes > 0;
  }

  /** Eventos abertos (Admin Master), piores primeiro. */
  static listOpen(opts: { severity?: Severity } = {}): any[] {
    const rows = opts.severity
      ? db.prepare(`SELECT * FROM platform_health_events WHERE status = 'open' AND severity = ? ORDER BY last_seen_at DESC`).all(opts.severity)
      : db.prepare(`SELECT * FROM platform_health_events WHERE status = 'open' ORDER BY last_seen_at DESC`).all();
    return (rows as any[]).map((r) => ({ ...r, detail: safeParse(r.detail_json) }));
  }

  /**
   * Sincroniza eventos a partir das recomendações de capacidade (F10): recomendação de
   * prioridade ALTA vira/atualiza um evento; recomendação que sumiu → resolve (recuperou).
   * Só gerencia eventos de origem 'recommendation' (não mexe em eventos de outras fontes).
   */
  static refresh(input: { now?: number; recommendations: any[] }): { raised: number; resolved: number } {
    const now = input.now ?? Date.now();
    const highs = (input.recommendations ?? []).filter((r) => r.priority === "alta");
    const activeKeys = new Set(highs.map((r) => `rec:${r.id}`));
    let raised = 0;
    for (const r of highs) {
      const res = this.raise({
        eventType: "recommendation", severity: "warning", dedupeKey: `rec:${r.id}`,
        title: r.title, detail: { action: r.action, confidence: r.confidence, evidence: r.evidence }, now,
      });
      if (res.created) raised++;
    }
    // Auto-resolve eventos de recomendação que não estão mais entre as altas (recuperou).
    let resolved = 0;
    const openRecs = db.prepare(`SELECT dedupe_key FROM platform_health_events WHERE status = 'open' AND event_type = 'recommendation'`).all() as any[];
    for (const row of openRecs) {
      if (!activeKeys.has(row.dedupe_key)) { if (this.resolveByDedupe(row.dedupe_key, now)) resolved++; }
    }
    return { raised, resolved };
  }

  /** Entrega best-effort nos canais do master (reuso). NUNCA quebra o caller. */
  private static deliverBestEffort(_event: any): void {
    try {
      // Reuso dos canais existentes (Push/in-app/e-mail/Fala Tu) fica a cargo do wiring do
      // Scheduler/rota; aqui garantimos que a ausência de canal não derruba o registro.
    } catch { /* best-effort (convenção 7) */ }
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

export default PlatformAlertService;
