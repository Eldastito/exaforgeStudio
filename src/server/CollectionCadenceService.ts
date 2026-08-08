import db from "./db.js";
import { randomUUID } from "crypto";
import { MessageProviderService } from "./MessageProviderService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { CollectionCopy } from "./CollectionCopy.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * Cadência multi-tentativa de cobrança (ADR-152 F4b.3).
 *
 * Motor SÍNCRONO que roda periodicamente via `Scheduler.collectionCadence
 * Pass` (padrão dos ~15 passes por-org do repo). Para cada organização
 * opt-in (`collection_cadence_enabled=1`) e cada cobrança viva
 * (`action_confirmations pending × decision_actions collection_send_
 * reminder approved`), decide qual próxima tentativa mandar:
 *
 *   T1 (send_reminder) — sempre enviada, implícita no playbook F4b.
 *   T2 (firme)         — enviada quando `today >= dueDate + N_2 dias`.
 *   T3 (aviso de negativação) — enviada quando `today >= dueDate + N_3
 *                                dias` E T2 já enviada.
 *
 * N_2 e N_3 configuráveis por-org via `organization_settings`
 * (defaults 3 e 7). Guarda contra spam duplo via UNIQUE(org, action,
 * attempt_number) em `collection_followup_attempts` — 2 workers
 * concorrentes ou 2 ticks sobrepostos nunca duplicam.
 *
 * Guardas RN F4b.3 (documentadas + testadas):
 *   G-4b.3-1: NUNCA envia se o cliente respondeu (busca em
 *             auth_audit_logs por RUNTIME_COLLECTION_REPLY_INTERPRETED
 *             desta ação — F4b.2 já loga cada resposta interpretada).
 *   G-4b.3-2: NUNCA envia se a confirmação foi resolvida
 *             (confirmed/timed_out/dismissed) — a query base filtra
 *             `status='pending'`.
 *   G-4b.3-3: máximo 2 follow-ups (T2 + T3) além do T1 original —
 *             `attempt_number` no schema é livre mas `decideAttempt`
 *             só devolve 2|3|null.
 *   G-4b.3-4: dias configuráveis por-org (defaults 3 e 7).
 *   G-4b.3-5: idempotência via UNIQUE(org, action, attempt_number) —
 *             INSERT antes de enviar; se colidir, é porque outro
 *             worker já pegou → skip.
 *   G-4b.3-6: isolamento cross-tenant — todas as queries filtram
 *             organization_id (convenção nº 1 do CLAUDE.md).
 *   G-4b.3-7: opt-in por org (`collection_cadence_enabled=0` default) —
 *             nada muda pra orgs pré-existentes.
 *   G-4b.3-8: NUNCA envia se `receivable.status != 'open'` (o dono
 *             deu baixa manual, ou o webhook já confirmou).
 *   G-4b.3-9: 3ª msg (aviso de negativação) é INFORMATIVA — "vamos
 *             precisar informar os órgãos de proteção ao crédito", sem
 *             prometer "vou negativar amanhã". Publica sinal
 *             severity=risk pro dono acompanhar (CDC §42 §71).
 *   G-4b.3-10: envio WhatsApp falha → apaga a linha do attempt (para
 *              o próximo tick retry) + publica sinal `followup_N_send_
 *              failed`. Não deixa a org travada num erro transitório.
 */

const DEFAULT_D2 = 3;
const DEFAULT_D3 = 7;

interface DueRow {
  orgId: string;
  actionId: string;
  paymentId: string | null;
  contactId: string | null;
  phone: string;
  channelId: string;
  amount: number;
  dueDate: string;         // YYYY-MM-DD
  receivableId: string | null;
}

export interface CadenceTickResult { orgsScanned: number; sent: number; skipped: number; }
export interface OrgRunResult { sent: number; skipped: number; }

export class CollectionCadenceService {
  /** Escaneia todas as orgs opt-in. Best-effort — uma org quebrando não trava as outras. */
  static async tickAll(): Promise<CadenceTickResult> {
    const rows = db.prepare(`
      SELECT organization_id AS orgId,
             COALESCE(collection_reminder_2_days_after_due, ?) AS d2,
             COALESCE(collection_reminder_3_days_after_due, ?) AS d3
        FROM organization_settings
       WHERE COALESCE(collection_cadence_enabled, 0) = 1
    `).all(DEFAULT_D2, DEFAULT_D3) as any[];
    let sent = 0, skipped = 0;
    for (const r of rows) {
      try {
        const res = await this.runForOrg(r.orgId, { d2: Number(r.d2), d3: Number(r.d3) });
        sent += res.sent; skipped += res.skipped;
      } catch (e) { console.error("[Cobrança F4b.3] cadência falhou pra org", r.orgId, e); }
    }
    return { orgsScanned: rows.length, sent, skipped };
  }

  /**
   * Roda a decisão pra UMA org. Exposto público pra testes e pro CLI de
   * simulação (`ric-simulate-collection-cadence`).
   */
  static async runForOrg(orgId: string, opts: { d2?: number; d3?: number } = {}): Promise<OrgRunResult> {
    const d2 = Number(opts.d2 ?? DEFAULT_D2);
    const d3 = Number(opts.d3 ?? DEFAULT_D3);
    const dues = this.findDueCollections(orgId);
    let sent = 0, skipped = 0;
    for (const row of dues) {
      const attempt = this.decideAttempt(row, d2, d3);
      if (!attempt) { skipped++; continue; }
      // G-4b.3-1: cliente respondeu → pausa.
      if (this.customerReplied(orgId, row.actionId)) { skipped++; continue; }
      // G-4b.3-8: receivable fechado → pausa.
      if (row.receivableId && !this.receivableIsOpen(orgId, row.receivableId)) { skipped++; continue; }
      const ok = await this.sendAttempt(row, attempt);
      if (ok) sent++; else skipped++;
    }
    return { sent, skipped };
  }

  private static findDueCollections(orgId: string): DueRow[] {
    const raw = db.prepare(`
      SELECT c.action_id AS actionId, c.external_ref AS paymentId, a.command_payload_json AS payloadJson
        FROM action_confirmations c
        JOIN decision_actions a ON a.id = c.action_id AND a.organization_id = c.organization_id
       WHERE c.organization_id = ?
         AND c.status = 'pending'
         AND a.command_type = 'collection_send_reminder'
         AND a.status = 'approved'
       ORDER BY c.created_at ASC
    `).all(orgId) as any[];
    const out: DueRow[] = [];
    for (const r of raw) {
      let p: any = null;
      try { p = r.payloadJson ? JSON.parse(r.payloadJson) : null; } catch { continue; }
      if (!p) continue;
      const amount = Number(p.amount || 0);
      const phone = String(p.phone || "");
      const channelId = String(p.channelId || "");
      const dueDate = String(p.dueDate || "");
      if (!phone || !channelId || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) continue;
      out.push({
        orgId, actionId: r.actionId,
        paymentId: r.paymentId || p.paymentId || null,
        contactId: p.contactId || null,
        phone, channelId, amount, dueDate,
        receivableId: p.receivableId || null,
      });
    }
    return out;
  }

  /**
   * Decide qual tentativa devemos mandar AGORA (ou null pra skip).
   * Regra dura: **priorizar T3 sobre T2** quando T2 já foi feita e
   * ambos thresholds passaram — evita envio duplo no mesmo tick.
   */
  private static decideAttempt(row: DueRow, d2: number, d3: number): 2 | 3 | null {
    const sent2 = this.attemptExists(row.orgId, row.actionId, 2);
    const sent3 = this.attemptExists(row.orgId, row.actionId, 3);
    if (sent3) return null; // já mandou o aviso final; não há T4.
    const dueMs = new Date(row.dueDate + "T00:00:00Z").getTime();
    const daysPastDue = Math.floor((Date.now() - dueMs) / 86400_000);
    if (sent2 && daysPastDue >= d3) return 3;
    if (!sent2 && daysPastDue >= d2) return 2;
    return null;
  }

  private static attemptExists(orgId: string, actionId: string, num: number): boolean {
    const r = db.prepare(`SELECT 1 FROM collection_followup_attempts WHERE organization_id = ? AND action_id = ? AND attempt_number = ? LIMIT 1`).get(orgId, actionId, num);
    return !!r;
  }

  private static customerReplied(orgId: string, actionId: string): boolean {
    // F4b.2 loga cada resposta interpretada — a presença de audit log
    // com actionId indica cliente respondeu; QUALQUER intent (inclusive
    // `unknown`) pausa a cadência automática (o dono decide como agir).
    const r = db.prepare(`SELECT 1 FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RUNTIME_COLLECTION_REPLY_INTERPRETED' AND metadata_json LIKE ? LIMIT 1`).get(orgId, `%"actionId":"${actionId}"%`);
    return !!r;
  }

  private static receivableIsOpen(orgId: string, receivableId: string): boolean {
    const r = db.prepare(`SELECT status FROM receivables WHERE id = ? AND organization_id = ?`).get(receivableId, orgId) as any;
    return r?.status === "open";
  }

  private static async sendAttempt(row: DueRow, attempt: 2 | 3): Promise<boolean> {
    // Idempotência atômica: INSERT primeiro; se UNIQUE colide, outro
    // worker/tick pegou → skip. Só depois de reservar a linha
    // enviamos a mensagem — assim NUNCA há duplo envio se 2 ticks
    // sobrepõem. Se o envio falhar, apagamos a linha pra permitir
    // retry no próximo tick (G-4b.3-10).
    const id = randomUUID();
    const templateKey = attempt === 2 ? "firm" : "default_notice";
    // F2.1 — variante A/B da copy (control|calibrated), por-org. Registrada na
    // linha do attempt pra a F2.3 correlacionar variante × revenue recuperado.
    const variant = CollectionCopy.variantFor(row.orgId);
    try {
      db.prepare(`INSERT INTO collection_followup_attempts (id, organization_id, action_id, attempt_number, template_key, variant) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, row.orgId, row.actionId, attempt, templateKey, variant);
    } catch (e: any) {
      if (e?.code === "SQLITE_CONSTRAINT_UNIQUE") return false;
      console.error("[Cobrança F4b.3] INSERT attempt falhou", e); return false;
    }
    const msg = attempt === 2 ? CollectionCopy.firm(variant, row) : CollectionCopy.notice(variant, row);
    let messageId: string | undefined;
    try { messageId = await MessageProviderService.sendMessage(row.channelId, row.phone, msg); }
    catch (e: any) {
      // Envio falhou — reverte a reserva pra permitir retry.
      db.prepare(`DELETE FROM collection_followup_attempts WHERE id = ?`).run(id);
      try {
        BusinessSignalService.publish(row.orgId, {
          domain: "collection", signalType: `followup_${attempt}_send_failed`, severity: "attention",
          basis: "fact", confidence: 1, sourceService: "CollectionCadenceService",
          sourceEntityType: "decision_action", sourceEntityId: row.actionId,
          evidence: { attempt, error: e?.message || String(e), actionId: row.actionId, phone: row.phone },
          dedupeKey: `collection:followup_${attempt}_send_failed:${row.actionId}`,
        });
      } catch { /* noop */ }
      return false;
    }
    if (messageId) {
      db.prepare(`UPDATE collection_followup_attempts SET message_id = ? WHERE id = ?`).run(messageId, id);
    }
    try {
      logAuthEvent(row.orgId, null, row.contactId, "RUNTIME_COLLECTION_FOLLOWUP_SENT", {
        attempt, actionId: row.actionId, receivableId: row.receivableId,
        messageId: messageId || null, templateKey, variant,
      });
    } catch { /* noop */ }

    // 3ª tentativa é o aviso de negativação — publica sinal severity=risk
    // pra o dono acompanhar (RN G-4b.3-9). Dedupe por receivable pra 3ª
    // repetida (não deveria acontecer, mas defesa em profundidade).
    if (attempt === 3) {
      try {
        BusinessSignalService.publish(row.orgId, {
          domain: "collection", signalType: "default_notice_sent", severity: "risk",
          basis: "fact", confidence: 1,
          impactAmount: row.amount, impactUnit: "BRL",
          sourceService: "CollectionCadenceService",
          sourceEntityType: row.receivableId ? "receivable" : "decision_action",
          sourceEntityId: row.receivableId || row.actionId,
          evidence: { actionId: row.actionId, receivableId: row.receivableId, amount: row.amount, dueDate: row.dueDate, phone: row.phone },
          dedupeKey: `collection:default_notice_sent:${row.receivableId || row.actionId}`,
        });
      } catch { /* noop */ }
    }
    return true;
  }
}

export default CollectionCadenceService;
