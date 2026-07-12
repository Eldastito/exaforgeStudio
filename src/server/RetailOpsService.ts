/**
 * Retail Ops — Cotas, fechamentos e checklist diário (ADR-083, Fase B).
 *
 * A espinha operacional: cotas por loja/dia, o registro de fechamento diário
 * (preenchido pela IA/WhatsApp na Fase C) com cálculo de desvio vs cota, e o
 * checklist de pendências (fechamento/malote/escala) que o Scheduler gera por
 * loja. Camada aditiva, isolada por organização. Auditado via logAuthEvent.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

// ── Cotas ────────────────────────────────────────────────────────────────────
export class RetailQuotaService {
  /** Define (upsert) a cota de uma loja num dia. */
  static set(orgId: string, input: { storeId: string; quotaDate: string; quotaAmount: number; source?: string }, actorId?: string): any {
    const amount = Number(input.quotaAmount || 0);
    db.prepare(
      `INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, store_id, quota_date) DO UPDATE SET
         quota_amount = excluded.quota_amount, source = excluded.source`
    ).run(randomUUID(), orgId, input.storeId, input.quotaDate, amount, input.source || "manual", actorId || null);
    try { logAuthEvent(orgId, actorId || "system", input.storeId, "RETAIL_QUOTA_SET", { date: input.quotaDate, amount }); } catch { /* noop */ }
    return this.get(orgId, input.storeId, input.quotaDate);
  }

  static get(orgId: string, storeId: string, date: string): any | null {
    return (db.prepare(`SELECT * FROM retail_store_quotas WHERE organization_id = ? AND store_id = ? AND quota_date = ?`).get(orgId, storeId, date) as any) || null;
  }

  static listByDate(orgId: string, date: string): any[] {
    return db.prepare(
      `SELECT q.*, s.name AS store_name FROM retail_store_quotas q
         JOIN retail_stores s ON s.id = q.store_id
        WHERE q.organization_id = ? AND q.quota_date = ? ORDER BY s.name`
    ).all(orgId, date) as any[];
  }

  /** Importação em lote (CSV/planilha). Retorna quantas cotas foram gravadas. */
  static import(orgId: string, rows: Array<{ storeId: string; quotaDate: string; quotaAmount: number }>, actorId?: string): number {
    let n = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.storeId || !r?.quotaDate) continue;
      this.set(orgId, { ...r, source: "imported" }, actorId);
      n++;
    }
    try { logAuthEvent(orgId, actorId || "system", "quotas", "RETAIL_QUOTA_IMPORTED", { count: n }); } catch { /* noop */ }
    return n;
  }
}

// ── Fechamentos ──────────────────────────────────────────────────────────────
export class RetailClosingService {
  /** Cria (ou devolve) o fechamento 'pending' da loja no dia, com a cota snapshot. */
  static getOrCreate(orgId: string, storeId: string, date: string): any {
    const existing = db.prepare(`SELECT * FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ?`).get(orgId, storeId, date) as any;
    if (existing) return existing;
    const quota = RetailQuotaService.get(orgId, storeId, date);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, quota_amount)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(id, orgId, storeId, date, Number(quota?.quota_amount || 0));
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any | null {
    const c = db.prepare(`SELECT * FROM retail_daily_closings WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!c) return null;
    c.items = db.prepare(`SELECT * FROM retail_daily_closing_items WHERE closing_id = ?`).all(id);
    return c;
  }

  static listByDate(orgId: string, date: string): any[] {
    return db.prepare(
      `SELECT c.*, s.name AS store_name FROM retail_daily_closings c
         JOIN retail_stores s ON s.id = c.store_id
        WHERE c.organization_id = ? AND c.closing_date = ? ORDER BY s.name`
    ).all(orgId, date) as any[];
  }

  /**
   * Registra o total INFORMADO (pela IA/WhatsApp na Fase C ou manual) e calcula
   * o desvio vs a cota. Não concilia com o sistema externo (Fase E). Grava itens
   * por forma de pagamento se vierem.
   */
  static setInformed(orgId: string, id: string, input: {
    informedTotal: number; items?: Array<{ paymentMethod: string; informedAmount: number }>;
    rawText?: string; imageUrl?: string; extractedJson?: any; source?: string;
    submittedByContactId?: string | null; submittedByIdentifier?: string | null;
  }, actorId?: string): any | null {
    const c = this.get(orgId, id);
    if (!c) return null;
    const informed = Number(input.informedTotal || 0);
    const quota = Number(c.quota_amount || 0);
    const variance = informed - quota;
    const variancePct = quota > 0 ? (variance / quota) * 100 : 0;
    db.prepare(
      `UPDATE retail_daily_closings SET
         status = 'received', source = COALESCE(?, source),
         submitted_by_contact_id = ?, submitted_by_identifier = ?, submitted_at = CURRENT_TIMESTAMP,
         raw_text = COALESCE(?, raw_text), image_url = COALESCE(?, image_url), extracted_json = COALESCE(?, extracted_json),
         informed_total = ?, variance_amount = ?, variance_percent = ?, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND id = ?`
    ).run(
      input.source || null, input.submittedByContactId || null, input.submittedByIdentifier || null,
      input.rawText || null, input.imageUrl || null, input.extractedJson ? JSON.stringify(input.extractedJson) : null,
      informed, variance, variancePct, orgId, id
    );
    if (Array.isArray(input.items)) {
      db.prepare(`DELETE FROM retail_daily_closing_items WHERE closing_id = ?`).run(id);
      for (const it of input.items) {
        db.prepare(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount) VALUES (?, ?, ?, ?, ?)`)
          .run(randomUUID(), orgId, id, String(it.paymentMethod || "outros"), Number(it.informedAmount || 0));
      }
    }
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_CLOSING_INFORMED", { informed, quota, variance }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static setStatus(orgId: string, id: string, status: string, actorId?: string): any | null {
    const c = this.get(orgId, id);
    if (!c) return null;
    db.prepare(`UPDATE retail_daily_closings SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`)
      .run(status, actorId || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, `RETAIL_CLOSING_${status.toUpperCase()}`, {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }
}

// ── Checklist diário (fechamento/malote/escala) ──────────────────────────────
const TASK_FLAG: Record<string, string> = {
  fechamento: "retail_daily_closing_enabled",
  malote: "retail_malote_enabled",
  escala: "retail_scale_reminder_enabled",
};

export class RetailTaskService {
  /**
   * Gera as pendências do dia por loja ativa, respeitando as flags de automação.
   * Idempotente (UNIQUE por org/loja/dia/tipo → INSERT OR IGNORE). Retorna quantas
   * foram criadas. Chamado pelo Scheduler (e sob demanda pela API).
   */
  static generateDay(orgId: string, date: string): number {
    let settings: any = {};
    try { settings = db.prepare(`SELECT retail_daily_closing_enabled, retail_malote_enabled, retail_scale_reminder_enabled, retail_daily_closing_due_hour FROM organization_settings WHERE organization_id = ?`).get(orgId) || {}; } catch { settings = {}; }
    const dueHour = Number(settings.retail_daily_closing_due_hour ?? 21);
    const types = (Object.keys(TASK_FLAG) as string[]).filter((t) => Number(settings[TASK_FLAG[t]] ?? 0) === 1);
    if (!types.length) return 0;
    const stores = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    let n = 0;
    for (const s of stores) {
      for (const t of types) {
        const r = db.prepare(
          `INSERT OR IGNORE INTO retail_store_daily_tasks (id, organization_id, store_id, task_date, task_type, status, due_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`
        ).run(randomUUID(), orgId, s.id, date, t, `${date} ${String(dueHour).padStart(2, "0")}:00:00`);
        if (r.changes > 0) n++;
      }
    }
    return n;
  }

  static listByDate(orgId: string, date: string): any[] {
    return db.prepare(
      `SELECT t.*, s.name AS store_name FROM retail_store_daily_tasks t
         JOIN retail_stores s ON s.id = t.store_id
        WHERE t.organization_id = ? AND t.task_date = ? ORDER BY s.name, t.task_type`
    ).all(orgId, date) as any[];
  }

  static markSubmitted(orgId: string, id: string, input: { contactId?: string | null; attachmentUrl?: string | null } = {}, actorId?: string): any | null {
    const t = db.prepare(`SELECT * FROM retail_store_daily_tasks WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!t) return null;
    db.prepare(
      `UPDATE retail_store_daily_tasks SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
         submitted_by_contact_id = COALESCE(?, submitted_by_contact_id), attachment_url = COALESCE(?, attachment_url), updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND id = ?`
    ).run(input.contactId || null, input.attachmentUrl || null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_TASK_SUBMITTED", { type: t.task_type }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_store_daily_tasks WHERE id = ?`).get(id);
  }
}
