import db from "./db.js";
import { randomUUID } from "crypto";
import { MessageProviderService } from "./MessageProviderService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * Re-check automático de promessa de pagamento (ADR-152 F4b.4).
 *
 * Quando o intent classifier (F4b.2) detecta `promise`, o
 * CollectionReplyService chama `create(...)` aqui pra registrar a data
 * prometida (extraída pelo LLM ou fallback "hoje + N" configurável).
 * A cada tick do Scheduler, `Scheduler.collectionPromiseCheckPass`
 * invoca `tickAll()` que percorre orgs opt-in e checa cada promise
 * cujo `promised_date <= today - grace_days`:
 *
 *   - receivable virou `received` → mark `fulfilled` + resolve o sinal
 *     `reply_promise` (fecha o loop no painel) + publica sinal
 *     `promise_fulfilled` (severity=info) pro histórico.
 *   - receivable ainda `open` → mark `broken` + envia WhatsApp de
 *     follow-up ("você tinha combinado pra {data}...") + publica sinal
 *     `promise_broken` severity=risk pro dono acompanhar.
 *
 * Guardas RN F4b.4:
 *   G-4b.4-1: NUNCA envia follow-up sem verificar receivable.status
 *             atual (evita "cobrar" cliente que já pagou entre a
 *             promessa e a checagem).
 *   G-4b.4-2: LLM extraiu `promiseDate` no passado → fallback pra
 *             "hoje+1" (LLM pode ter confundido "amanhã").
 *   G-4b.4-3: UNIQUE parcial em `pending` — 2ª promessa do mesmo
 *             action_id em status pending: fecha a anterior como
 *             `cancelled` e cria a nova (cliente adiou o pagamento).
 *   G-4b.4-4: Opt-in via `collection_cadence_enabled=1` (mesma flag
 *             do F4b.3 — quem opta pela cadência opta pelo re-check).
 *   G-4b.4-5: Recibable `received` durante grace-window → mark
 *             fulfilled + resolveByDedupe do reply_promise
 *             (loop fechado sem esperar o dia da promessa).
 *   G-4b.4-6: envio WA falha → publica sinal fail + próxima passada
 *             tenta de novo (deixa `checked_at` NÃO atualizado pra
 *             re-tentar; padrão F4b.3).
 *   G-4b.4-7: isolamento cross-tenant (convenção nº 1).
 *   G-4b.4-8: `checked_at` avança APÓS ação bem-sucedida (fulfilled/
 *             broken enviado) pra evitar duplo envio no mesmo tick.
 *   G-4b.4-9: Grace days por-org (default 0 = age no MESMO dia).
 */

const DEFAULT_FALLBACK_DAYS = 3;   // "hoje + 3" quando LLM não extrai promiseDate.

export interface CreatePromiseInput {
  actionId: string;
  receivableId?: string | null;
  contactId?: string | null;
  phone: string;
  channelId: string;
  amount?: number | null;
  dueDate: string;                 // YYYY-MM-DD do receivable
  promisedDate?: string | null;    // YYYY-MM-DD extraída pelo LLM; null → fallback
  signalId?: string | null;
  actorId?: string | null;
}

interface DueRow {
  orgId: string;
  promiseId: string;
  actionId: string;
  receivableId: string | null;
  contactId: string | null;
  phone: string;
  channelId: string;
  amount: number | null;
  dueDate: string;
  promisedDate: string;
  signalId: string | null;
}

export interface CheckPassResult { orgsScanned: number; fulfilled: number; broken: number; skipped: number; }

const TERMINAL = new Set(["fulfilled", "broken", "escalated", "cancelled"]);

export class CollectionPromiseService {
  /**
   * Cria uma promessa pendente. Se já existe uma `pending` pra a mesma
   * action, marca a anterior como `cancelled` e cria a nova (cliente
   * adiou o pagamento). Idempotente por UNIQUE parcial no schema.
   *
   * `source`: 'llm' se `promisedDate` veio explícito; 'default' se
   * caímos no fallback (hoje + N).
   */
  static create(orgId: string, input: CreatePromiseInput): { id: string; promisedDate: string; source: "llm" | "default" } {
    if (!orgId || !input?.actionId) throw new Error("orgId + actionId obrigatórios");
    if (!input.phone || !input.channelId) throw new Error("phone + channelId obrigatórios");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new Error("dueDate deve ser YYYY-MM-DD");

    // Resolve a data prometida — LLM ou fallback.
    let source: "llm" | "default" = "default";
    let promisedDate: string;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);
    if (input.promisedDate && /^\d{4}-\d{2}-\d{2}$/.test(input.promisedDate)) {
      // G-4b.4-2: LLM extraiu data no passado — fallback pra "amanhã".
      if (input.promisedDate < todayIso) {
        const tomorrow = new Date(today.getTime() + 86400_000);
        promisedDate = tomorrow.toISOString().slice(0, 10);
        source = "default";
      } else {
        promisedDate = input.promisedDate;
        source = "llm";
      }
    } else {
      const fb = new Date(today.getTime() + DEFAULT_FALLBACK_DAYS * 86400_000);
      promisedDate = fb.toISOString().slice(0, 10);
      source = "default";
    }

    // G-4b.4-3: se já há pending pra essa action, cancela a anterior.
    db.prepare(`UPDATE collection_payment_promises SET status = 'cancelled' WHERE organization_id = ? AND action_id = ? AND status = 'pending'`)
      .run(orgId, input.actionId);

    const id = randomUUID();
    db.prepare(`INSERT INTO collection_payment_promises
        (id, organization_id, action_id, receivable_id, contact_id, phone, channel_id, amount, due_date, promised_date, status, signal_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, orgId, input.actionId, input.receivableId || null, input.contactId || null,
           input.phone, input.channelId, input.amount != null ? Number(input.amount) : null,
           input.dueDate, promisedDate, input.signalId || null, source);

    try {
      logAuthEvent(orgId, input.actorId || null, input.contactId || null, "RUNTIME_COLLECTION_PROMISE_CREATED", {
        promiseId: id, actionId: input.actionId, receivableId: input.receivableId, promisedDate, source,
      });
    } catch { /* noop */ }

    return { id, promisedDate, source };
  }

  /** Retorna a promise pending pra uma action (ou null). */
  static getPending(orgId: string, actionId: string): any | null {
    const r = db.prepare(`SELECT * FROM collection_payment_promises WHERE organization_id = ? AND action_id = ? AND status = 'pending' LIMIT 1`).get(orgId, actionId);
    return r || null;
  }

  /** Roda o re-check em todas as orgs opt-in. Best-effort. */
  static async tickAll(): Promise<CheckPassResult> {
    const rows = db.prepare(`
      SELECT organization_id AS orgId,
             COALESCE(collection_promise_grace_days, 0) AS graceDays
        FROM organization_settings
       WHERE COALESCE(collection_cadence_enabled, 0) = 1
    `).all() as any[];
    let fulfilled = 0, broken = 0, skipped = 0;
    for (const r of rows) {
      try {
        const res = await this.runForOrg(r.orgId, { graceDays: Number(r.graceDays) });
        fulfilled += res.fulfilled; broken += res.broken; skipped += res.skipped;
      } catch (e) { console.error("[Cobrança F4b.4] re-check falhou pra org", r.orgId, e); }
    }
    return { orgsScanned: rows.length, fulfilled, broken, skipped };
  }

  /** Re-check pra UMA org. Retorna contadores. */
  static async runForOrg(orgId: string, opts: { graceDays?: number } = {}): Promise<{ fulfilled: number; broken: number; skipped: number }> {
    const graceDays = Number(opts.graceDays ?? 0);
    const dues = this.findDuePromises(orgId, graceDays);
    let fulfilled = 0, broken = 0, skipped = 0;
    for (const row of dues) {
      try {
        const outcome = await this.processOne(row);
        if (outcome === "fulfilled") fulfilled++;
        else if (outcome === "broken") broken++;
        else skipped++;
      } catch (e) { console.error("[Cobrança F4b.4] processOne falhou", row.promiseId, e); skipped++; }
    }
    return { fulfilled, broken, skipped };
  }

  private static findDuePromises(orgId: string, graceDays: number): DueRow[] {
    // Threshold: promised_date <= (today - graceDays). Ex.: graceDays=0
    // age no MESMO dia; graceDays=1 dá 1 dia de tolerância antes de
    // marcar broken (cliente pode ter esquecido no dia).
    const cutoff = new Date(Date.now() - graceDays * 86400_000).toISOString().slice(0, 10);
    const raw = db.prepare(`
      SELECT id, action_id, receivable_id, contact_id, phone, channel_id, amount, due_date, promised_date, signal_id
        FROM collection_payment_promises
       WHERE organization_id = ?
         AND status = 'pending'
         AND promised_date <= ?
       ORDER BY promised_date ASC, rowid ASC
    `).all(orgId, cutoff) as any[];
    return raw.map((r) => ({
      orgId, promiseId: r.id, actionId: r.action_id,
      receivableId: r.receivable_id || null, contactId: r.contact_id || null,
      phone: r.phone, channelId: r.channel_id,
      amount: r.amount != null ? Number(r.amount) : null,
      dueDate: r.due_date, promisedDate: r.promised_date,
      signalId: r.signal_id || null,
    }));
  }

  private static async processOne(row: DueRow): Promise<"fulfilled" | "broken" | "skipped"> {
    // G-4b.4-1: consulta receivable.status ATUAL — pode ter mudado
    // entre a promessa e o check.
    if (row.receivableId) {
      const rec = db.prepare(`SELECT status FROM receivables WHERE id = ? AND organization_id = ?`).get(row.receivableId, row.orgId) as any;
      if (rec?.status === "received") return this.markFulfilled(row);
      if (rec?.status && rec.status !== "open") {
        // Cancelled/other: nem cobra nem trata como pago — cancela a promessa (dono decide).
        db.prepare(`UPDATE collection_payment_promises SET status = 'cancelled', checked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.promiseId);
        return "skipped";
      }
    }
    // Sem receivableId ou status='open': verifica também se a confirmação
    // Asaas fechou (pagamento confirmado por webhook — F4b closes action).
    const conf = db.prepare(`SELECT status FROM action_confirmations WHERE organization_id = ? AND action_id = ? LIMIT 1`).get(row.orgId, row.actionId) as any;
    if (conf?.status === "confirmed") return this.markFulfilled(row);
    // Ainda aberto → broken (cliente prometeu mas não pagou).
    return await this.markBroken(row);
  }

  private static markFulfilled(row: DueRow): "fulfilled" {
    db.prepare(`UPDATE collection_payment_promises SET status = 'fulfilled', checked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.promiseId);
    // Resolve o sinal reply_promise (que estava aberto no painel) — a
    // promessa foi cumprida, o dono não precisa acompanhar mais.
    try {
      if (row.receivableId) {
        BusinessSignalService.resolveByDedupe(row.orgId, `collection:reply_promise:${row.receivableId}`);
      } else {
        BusinessSignalService.resolveByDedupe(row.orgId, `collection:reply_promise:${row.actionId}`);
      }
    } catch { /* noop */ }
    // Publica sinal info pro histórico (dedupe por promise pra 2 checks
    // do mesmo dia não duplicarem).
    try {
      BusinessSignalService.publish(row.orgId, {
        domain: "collection", signalType: "promise_fulfilled", severity: "info",
        basis: "fact", confidence: 1,
        impactAmount: row.amount, impactUnit: row.amount != null ? "BRL" : null,
        sourceService: "CollectionPromiseService",
        sourceEntityType: row.receivableId ? "receivable" : "decision_action",
        sourceEntityId: row.receivableId || row.actionId,
        evidence: { promiseId: row.promiseId, actionId: row.actionId, receivableId: row.receivableId, promisedDate: row.promisedDate, amount: row.amount },
        dedupeKey: `collection:promise_fulfilled:${row.promiseId}`,
      });
    } catch { /* noop */ }
    try {
      logAuthEvent(row.orgId, null, row.contactId, "RUNTIME_COLLECTION_PROMISE_FULFILLED", {
        promiseId: row.promiseId, actionId: row.actionId, receivableId: row.receivableId, promisedDate: row.promisedDate,
      });
    } catch { /* noop */ }
    return "fulfilled";
  }

  private static async markBroken(row: DueRow): Promise<"broken" | "skipped"> {
    // Envia WhatsApp de follow-up antes de marcar broken — se envio
    // falha, deixa a promessa PENDING pra próximo tick retentar
    // (G-4b.4-6). Idempotência do envio é responsabilidade do provider;
    // aqui só temos best-effort + sinal em caso de erro.
    const promisedBR = String(row.promisedDate).split("-").reverse().join("/");
    const valorStr = row.amount != null ? `R$ ${row.amount.toFixed(2).replace(".", ",")}` : "o valor combinado";
    const msg = `Olá! 🙋\n\nA gente tinha combinado o pagamento de ${valorStr} pra ${promisedBR}. Deu pra acertar?\n\nSe já pagou, é só me mandar o comprovante que aviso o time. Se precisar de mais um tempinho, me diz aqui — a gente ajusta juntos. 🙏`;
    let messageId: string | undefined;
    try { messageId = await MessageProviderService.sendMessage(row.channelId, row.phone, msg); }
    catch (e: any) {
      try {
        BusinessSignalService.publish(row.orgId, {
          domain: "collection", signalType: "promise_followup_send_failed", severity: "attention",
          basis: "fact", confidence: 1, sourceService: "CollectionPromiseService",
          sourceEntityType: "decision_action", sourceEntityId: row.actionId,
          evidence: { promiseId: row.promiseId, actionId: row.actionId, error: e?.message || String(e) },
          dedupeKey: `collection:promise_followup_send_failed:${row.promiseId}`,
        });
      } catch { /* noop */ }
      // Não avança checked_at — deixa próximo tick retry (G-4b.4-6).
      return "skipped";
    }

    // Marca broken + publica sinal severity=risk pro dono acompanhar.
    db.prepare(`UPDATE collection_payment_promises SET status = 'broken', checked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.promiseId);
    try {
      BusinessSignalService.publish(row.orgId, {
        domain: "collection", signalType: "promise_broken", severity: "risk",
        basis: "fact", confidence: 1,
        impactAmount: row.amount, impactUnit: row.amount != null ? "BRL" : null,
        sourceService: "CollectionPromiseService",
        sourceEntityType: row.receivableId ? "receivable" : "decision_action",
        sourceEntityId: row.receivableId || row.actionId,
        evidence: { promiseId: row.promiseId, actionId: row.actionId, receivableId: row.receivableId, promisedDate: row.promisedDate, amount: row.amount, followupMessageId: messageId || null },
        // Dedupe por promise (não por receivable) — se cliente promete 2x
        // e quebra 2x, quero 2 sinais distintos.
        dedupeKey: `collection:promise_broken:${row.promiseId}`,
      });
    } catch { /* noop */ }
    try {
      logAuthEvent(row.orgId, null, row.contactId, "RUNTIME_COLLECTION_PROMISE_BROKEN", {
        promiseId: row.promiseId, actionId: row.actionId, receivableId: row.receivableId,
        promisedDate: row.promisedDate, followupMessageId: messageId || null,
      });
    } catch { /* noop */ }
    return "broken";
  }

  /** Debug/UI helper — não usado hoje mas expõe pro futuro. */
  static isTerminal(status: string): boolean { return TERMINAL.has(String(status)); }
}

export default CollectionPromiseService;
