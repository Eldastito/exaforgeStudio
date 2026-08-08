import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { classify, type SalesReplyIntent } from "./SalesRecoveryReplyClassifier.js";
import { SalesRecoveryCopy } from "./SalesRecoveryCopy.js";

/**
 * Reply router de recuperação comercial (ADR-152 F4c.2).
 *
 * Chamado dentro do `webhookProcessor.processIncomingMessage` ANTES do
 * `AIOrchestratorService.processMessage`. Se o contato tem um "touch"
 * de recuperação recente (`sales_recovery_touches` em janela default 14d),
 * classifica a mensagem, publica sinal categorizado pro dono e devolve
 * `{handled:true, reply}`. Sem touch recente → `{handled:false}`.
 *
 * Ordem no webhookProcessor: clinic → collection (F4b.2) → sales_recovery
 * (F4c.2) → AI. Cobrança tem PRIORIDADE sobre recuperação (uma cobrança
 * viva é um SLA duro; recuperação é conversa aberta).
 *
 * Intents (padrão F4b.2 do reply canned):
 *   - interested / meeting_request → severity=attention, dono decide
 *     próximo passo (marcar reunião, enviar proposta).
 *   - objection → severity=attention, dono conversa (rebate objeção
 *     ou reagenda).
 *   - not_now / already_bought → severity=info, dono só ciente.
 *   - remove_me → severity=risk + SETA `contacts.marketing_opt_out=1`
 *     (LGPD Art.8 §5 — direito de revogar consentimento). Detector
 *     F4c honra essa flag e nunca mais propõe pra esse contato.
 *   - unknown → severity=info, dedupe por hash da msg.
 *
 * Guardas F4c.2 (documentadas + testadas):
 *   G-4c.2-1: sem touch recente pro contato → `{handled:false}` (não
 *             engole msg — deixa AI seguir).
 *   G-4c.2-2: janela configurável por-org
 *             (`sales_recovery_reply_window_days`, default 14).
 *   G-4c.2-3: intent=`remove_me` seta `contacts.marketing_opt_out=1`
 *             ATOMICAMENTE — LGPD; o F4c detector já filtra pela
 *             flag na próxima varredura.
 *   G-4c.2-4: sem OPENAI_API_KEY → intent=unknown (não mal-interpreta).
 *   G-4c.2-5: idempotência via dedupeKey do BusinessSignal (touch+intent).
 *   G-4c.2-6: 1 reply canned por msg inbound (`handled:true` interrompe
 *             pipeline).
 *   G-4c.2-7: touch é atualizado com reply_intent + reply_signal_id
 *             pra dono ver histórico completo.
 *   G-4c.2-8: isolamento cross-tenant.
 *   G-4c.2-9: NUNCA marca deal como ganho ou perdido autonomamente —
 *             só sinal + reply. Dono decide.
 *   G-4c.2-10: remove_me publica sinal severity=risk (não info) —
 *              LGPD é evento noticiável, não rotina.
 */

const DEFAULT_WINDOW_DAYS = 14;

interface LiveTouch {
  touchId: string;
  ticketId: string;
  contactId: string;
  phone: string;
  channelId: string;
  proposedSignalId: string | null;
  sentAt: string;
}

export interface TryHandleResult {
  handled: boolean;
  reply?: string;
  intent?: SalesReplyIntent;
  signalId?: string;
  ticketId?: string | null;
  optedOut?: boolean;
}

const NOT_HANDLED: TryHandleResult = { handled: false };

function normPhone(p?: string | null): string | null {
  if (!p) return null;
  return String(p).replace(/\D/g, "") || null;
}

/**
 * Encontra o touch MAIS RECENTE pro contato dentro da janela. Se há
 * múltiplos (várias recuperações históricas), pega o último — assume-se
 * que a reply é sobre esse.
 */
function findRecentTouch(orgId: string, contactId: string, phone: string, windowDays: number): LiveTouch | null {
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
  // Prioriza match por contactId; fallback por phone (contato pode ter
  // sido recadastrado). Mesma lógica do CollectionReplyService.
  const np = normPhone(phone);
  // NÃO filtrar por `reply_intent IS NULL`: LGPD exige que remove_me
  // seja honrado MESMO se o cliente já respondeu antes com outro intent
  // (ex: "muito caro" → "para de me mandar msg"). Dedupe do BusinessSignal
  // por (touch, intent) evita spam quando o cliente insiste no mesmo
  // intent. Última resposta interpretada sobrescreve reply_intent do touch.
  const rows = db.prepare(`
    SELECT id AS touchId, ticket_id AS ticketId, contact_id AS contactId,
           phone, channel_id AS channelId, proposed_signal_id AS proposedSignalId,
           sent_at AS sentAt
      FROM sales_recovery_touches
     WHERE organization_id = ?
       AND (contact_id = ? OR phone = ?)
       AND sent_at >= ?
     ORDER BY sent_at DESC, rowid DESC
     LIMIT 5
  `).all(orgId, contactId, np || "", cutoff) as any[];

  for (const r of rows) {
    const rowPhone = normPhone(r.phone);
    if (r.contactId === contactId || (rowPhone && np && rowPhone === np)) {
      return {
        touchId: r.touchId, ticketId: r.ticketId, contactId: r.contactId,
        phone: r.phone, channelId: r.channelId,
        proposedSignalId: r.proposedSignalId, sentAt: r.sentAt,
      };
    }
  }
  return null;
}

interface IntentMeta { severity: "info" | "attention" | "risk" | "critical"; reply: string; }

const INTENT_META: Record<Exclude<SalesReplyIntent, "unknown">, IntentMeta> = {
  interested: {
    severity: "attention",
    reply: "Que bom saber! 🙌 Vou avisar o time pra te dar os próximos passos. Se quiser adiantar algo, é só me falar aqui.",
  },
  meeting_request: {
    severity: "attention",
    reply: "Perfeito! Vou pedir pro time entrar em contato pra combinar. Se preferir sugerir um horário, é só me mandar. 📅",
  },
  not_now: {
    severity: "info",
    reply: "Sem problema, entendi. Fico aqui à disposição — quando fizer sentido pra você, é só me chamar. 👍",
  },
  objection: {
    severity: "attention",
    reply: "Anotei o que você me disse. Vou passar pro time pra pensar em como podemos ajustar. Retorno em breve. 🙏",
  },
  remove_me: {
    severity: "risk",
    reply: "Entendido — não te mando mais mensagens sobre isso. Se um dia mudar de ideia, é só me chamar. Obrigado. 🙏",
  },
  already_bought: {
    severity: "info",
    reply: "Ah, que ótimo que já se resolveu! 🙂 Fico à disposição pra qualquer coisa no futuro. Obrigado por avisar.",
  },
};

const UNKNOWN_REPLY = "Recebi sua mensagem — vou repassar pro time pra te retornar. 🙏";

function hashShort(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

export class SalesRecoveryReplyService {
  /**
   * Handler chamado pelo webhookProcessor. Best-effort — nunca lança.
   * Retorna `{handled:false}` em qualquer falha pra a mensagem cair no
   * fluxo normal (IA).
   */
  static async tryHandle(orgId: string, contactId: string, phone: string, text: string): Promise<TryHandleResult> {
    if (!orgId || !contactId || !text) return NOT_HANDLED;

    // Janela configurável.
    let windowDays = DEFAULT_WINDOW_DAYS;
    try {
      const row = db.prepare(`SELECT COALESCE(sales_recovery_reply_window_days, ?) AS d FROM organization_settings WHERE organization_id = ?`).get(DEFAULT_WINDOW_DAYS, orgId) as any;
      if (row?.d) windowDays = Number(row.d);
    } catch { /* usa default */ }

    let touch: LiveTouch | null = null;
    try { touch = findRecentTouch(orgId, contactId, phone, windowDays); }
    catch (e) { console.warn("[Sales Recovery F4c.2] findRecentTouch falhou", e); return NOT_HANDLED; }
    if (!touch) return NOT_HANDLED;

    // Classifica.
    let result: Awaited<ReturnType<typeof classify>>;
    try { result = await classify(text); }
    catch (e: any) { result = { intent: "unknown", confidence: 0, rationale: `classifier throw: ${e?.message || e}` }; }

    const intent = result.intent;
    const isKnown = intent !== "unknown";

    let severity: IntentMeta["severity"];
    let dedupeKey: string;
    let reply: string;
    if (isKnown) {
      const meta = INTENT_META[intent as Exclude<SalesReplyIntent, "unknown">];
      severity = meta.severity;
      dedupeKey = `sales_recovery:reply_${intent}:${touch.touchId}`;
      reply = meta.reply;
    } else {
      severity = "info";
      dedupeKey = `sales_recovery:reply_unknown:${touch.touchId}:${hashShort(text)}`;
      reply = UNKNOWN_REPLY;
    }

    // G-4c.2-3: intent=remove_me → set contacts.marketing_opt_out=1 ATOMICAMENTE.
    // Isso é LGPD Art.8 §5 (revogação de consentimento) — o F4c detector
    // já filtra pela flag no join com contacts.
    let optedOut = false;
    if (intent === "remove_me") {
      try {
        const r = db.prepare(`UPDATE contacts SET marketing_opt_out = 1 WHERE id = ? AND organization_id = ?`).run(touch.contactId, orgId);
        optedOut = r.changes > 0;
      } catch (e) { console.warn("[Sales Recovery F4c.2] opt-out falhou", e); }
      try {
        logAuthEvent(orgId, null, touch.contactId, "RUNTIME_SALES_RECOVERY_OPT_OUT", {
          touchId: touch.touchId, ticketId: touch.ticketId, phone: touch.phone,
        });
      } catch { /* noop */ }
    }

    // Publica sinal.
    let signalId: string | null = null;
    try {
      const pub = BusinessSignalService.publish(orgId, {
        domain: "sales",
        signalType: `reply_${intent}`,
        severity,
        basis: "fact",
        confidence: result.confidence,
        sourceService: "SalesRecoveryReplyService",
        sourceEntityType: "ticket",
        sourceEntityId: touch.ticketId,
        evidence: {
          touchId: touch.touchId,
          ticketId: touch.ticketId,
          contactId: touch.contactId,
          phone: touch.phone,
          proposedSignalId: touch.proposedSignalId,
          reply_text_sample: String(text).slice(0, 280),
          rationale: result.rationale,
          intent,
          optedOut,
        },
        dedupeKey,
      });
      signalId = pub.id;
    } catch (e) { console.warn("[Sales Recovery F4c.2] BusinessSignal.publish falhou", e); }

    // G-4c.2-7: fecha o loop no touch — dono vê histórico completo
    // (send → resposta interpretada).
    try {
      db.prepare(`UPDATE sales_recovery_touches SET reply_received_at = CURRENT_TIMESTAMP, reply_intent = ?, reply_signal_id = ? WHERE id = ? AND organization_id = ?`)
        .run(intent, signalId, touch.touchId, orgId);
    } catch { /* noop */ }

    try {
      logAuthEvent(orgId, null, contactId, "RUNTIME_SALES_RECOVERY_REPLY_INTERPRETED", {
        intent, touchId: touch.touchId, ticketId: touch.ticketId, signalId,
        optedOut, confidence: result.confidence, viaLLM: !!process.env.OPENAI_API_KEY,
      });
    } catch { /* noop */ }

    return { handled: true, reply, intent, signalId: signalId || undefined, ticketId: touch.ticketId, optedOut };
  }

  /**
   * Registra um touch (chamado por SalesRecoveryPlaybookService.approve
   * após envio bem-sucedido). Idempotência é responsabilidade do caller
   * — approve() só é chamado uma vez por aprovação.
   */
  static recordTouch(orgId: string, opts: {
    ticketId: string; contactId: string; phone: string; channelId: string;
    proposedSignalId?: string | null; approvedBy?: string | null; messageId?: string | null;
  }): { id: string } {
    if (!orgId || !opts?.ticketId || !opts?.contactId || !opts?.phone || !opts?.channelId) {
      throw new Error("recordTouch: params obrigatórios ausentes");
    }
    const id = randomUUID();
    // ADR-155 F3.2 — carimba a variante de copy da org (control|calibrated) no
    // touch, congelando o que a medição do A/B vai correlacionar. Determinística
    // por-org (variantFor lê o setting), então recomputar aqui = o que a F3.1
    // usou no envio; se a org virar o A/B entre gerar e aprovar (edge raro), o
    // KPI se auto-corrige na amostra. Best-effort — nunca derruba o registro.
    let variant = "control";
    try { variant = SalesRecoveryCopy.variantFor(orgId); } catch { /* default control */ }
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, proposed_signal_id, approved_by, message_id, variant) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, opts.ticketId, opts.contactId, opts.phone, opts.channelId,
           opts.proposedSignalId || null, opts.approvedBy || null, opts.messageId || null, variant);
    return { id };
  }
}

export default SalesRecoveryReplyService;
