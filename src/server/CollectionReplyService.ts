import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { classify, type IntentLabel } from "./CollectionIntentClassifier.js";
import { CollectionResendPixService } from "./CollectionResendPixService.js";
import { CollectionPromiseService } from "./CollectionPromiseService.js";

/**
 * Reply router de cobrança (ADR-152 F4b.2).
 *
 * Chamada de dentro do `webhookProcessor.processIncomingMessage` ANTES do
 * `AIOrchestratorService.processMessage` (mesmo padrão do
 * `ClinicReminderReplyService.tryHandle`). Se o contato tem UMA cobrança
 * viva (action_confirmation pending amarrada a um collection_send_reminder
 * approved), classifica a mensagem, publica sinal pro dono e devolve
 * `{handled:true, reply}` — o caller manda a resposta canned via
 * `deliverBotMessage`. Sem cobrança viva pro contato → `{handled:false}`
 * (deixa o fluxo AI seguir seu curso normal).
 *
 * Guardas F4b.2:
 *   G-4b.2-1: NUNCA age direto. Não regenera PIX, não altera receivable,
 *             não confirma pagamento. Só publica `business_signal` +
 *             manda reply canned. Ação humana fica com o dono na aba
 *             Operações / painel de sinais.
 *   G-4b.2-2: sem cobrança viva pro contato → `{handled:false}`
 *             (não engole mensagem).
 *   G-4b.2-3: classifier devolve `unknown` quando LLM indisponível ou
 *             ambíguo — reply é neutra e sinal severity='info'.
 *   G-4b.2-4: idempotência por (org, dedupeKey do BusinessSignal). O mesmo
 *             intent do mesmo receivable ATUALIZA o sinal (não abre novo);
 *             evita spam quando cliente manda 3 msgs "vou pagar amanhã".
 *   G-4b.2-5: 1 canned reply por mensagem inbound — retornar `handled:true`
 *             interrompe pipeline do webhookProcessor (ele dá `return`).
 *
 * Correlação (qual receivable é esse contato?):
 *   Query em `action_confirmations` pending JOIN `decision_actions` com
 *   command_type='collection_send_reminder' status='approved'; filtra em
 *   JS pelo `contactId` (ou `phone`) do payload. Pega o mais recente.
 *   Determinístico: mesmo se o cliente tem 3 cobranças abertas, resolve
 *   pela mais recente — que é a que ACABOU DE receber o lembrete.
 *
 * MVP: intents `promise|dispute|resend_pix|claims_paid|installment|partial|
 * escalate_human|churn|hardship|callback_later|unknown` viram sinal +
 * reply canned. F4b.3 (cadência multi-tentativa) e uma futura integração
 * com o `ClinicReminderReplyService`-like pra promise (agendamento de
 * re-check) ficam pra depois — o dono decide o timing de re-cobrança.
 */

interface LiveCollection {
  actionId: string;
  confId: string;
  receivableId: string | null;
  phone: string | null;
  contactId: string | null;
  channelId: string | null;   // F4b.3 — precisamos disso pra re-enviar via MessageProviderService.
  amount: number | null;
  dueDate: string | null;
  paymentId: string | null;
}

export interface TryHandleResult {
  handled: boolean;
  reply?: string;
  intent?: IntentLabel;
  signalId?: string;
  receivableId?: string | null;
}

const NOT_HANDLED: TryHandleResult = { handled: false };

/**
 * Encontra a cobrança viva pro contato — a MAIS RECENTE.
 *
 * Design: query dá 20 pending (ordenadas por created_at DESC) e filtra
 * em JS por contactId OU phone. Não usa LIKE em JSON pra evitar false
 * positives (payload pode ter contactId aparecendo em outro campo).
 */
function findLiveForContact(orgId: string, contactId: string | null | undefined, phone: string | null | undefined): LiveCollection | null {
  const rows = db.prepare(`
    SELECT c.id AS conf_id, c.external_ref AS payment_id, a.id AS action_id, a.command_payload_json
    FROM action_confirmations c
    JOIN decision_actions a ON a.id = c.action_id AND a.organization_id = c.organization_id
    WHERE c.organization_id = ?
      AND c.status = 'pending'
      AND a.command_type = 'collection_send_reminder'
      AND a.status = 'approved'
    ORDER BY c.created_at DESC, c.rowid DESC
    LIMIT 20
  `).all(orgId) as any[];

  const normPhone = phone ? String(phone).replace(/\D/g, "") : null;

  for (const r of rows) {
    let payload: any = null;
    try { payload = r.command_payload_json ? JSON.parse(r.command_payload_json) : null; } catch { /* pula */ }
    if (!payload) continue;
    const pContactId = payload.contactId ? String(payload.contactId) : null;
    const pPhoneNorm = payload.phone ? String(payload.phone).replace(/\D/g, "") : null;

    const contactMatch = contactId && pContactId && pContactId === String(contactId);
    const phoneMatch = normPhone && pPhoneNorm && pPhoneNorm === normPhone;
    if (contactMatch || phoneMatch) {
      return {
        actionId: r.action_id,
        confId: r.conf_id,
        receivableId: payload.receivableId || null,
        phone: payload.phone || null,
        contactId: payload.contactId || null,
        channelId: payload.channelId || null,
        amount: payload.amount != null ? Number(payload.amount) : null,
        dueDate: payload.dueDate || null,
        paymentId: r.payment_id || null,
      };
    }
  }
  return null;
}

interface IntentMeta { severity: "info" | "attention" | "risk" | "critical"; reply: (amount: number | null, dueDate: string | null) => string; }

const INTENT_META: Record<Exclude<IntentLabel, "unknown">, IntentMeta> = {
  promise: {
    severity: "attention",
    reply: () => "Combinado! Vou anotar aqui. Se precisar de outro PIX ou de conversar sobre o valor, é só me chamar. 🤝",
  },
  resend_pix: {
    severity: "attention",
    // F4b.3: reply canned genérico é um FALLBACK — quando a re-emissão
    // automática do PIX consegue, sobrescrevemos abaixo com uma reply
    // que confirma "reenviei". Aqui fica só o backstop pra quando o
    // Asaas está indisponível ou a re-emissão falha.
    reply: () => "Beleza! Vou reenviar o PIX aqui — se não chegar em 1 min, me avisa que a gente resolve. 🙏",
  },
  claims_paid: {
    severity: "attention",
    reply: () => "Perfeito — vou checar no sistema e te confirmo assim que aparecer. Se puder mandar o comprovante ajuda a agilizar! 🙏",
  },
  dispute: {
    severity: "risk",
    reply: () => "Entendi. Anotei aqui e o time vai revisar pra te dar um retorno. Obrigado por avisar. 🙏",
  },
  installment: {
    severity: "attention",
    reply: () => "Certo — vou passar sua proposta pro time e retornamos com as opções de parcelamento. 🙏",
  },
  partial: {
    severity: "attention",
    reply: () => "Entendi. Vou passar pro time pra ver se aceitamos pagamento parcial e te retorno. 🙏",
  },
  escalate_human: {
    severity: "attention",
    reply: () => "Claro! Vou avisar o time financeiro pra entrar em contato com você. 🙏",
  },
  churn: {
    severity: "risk",
    reply: () => "Anotado. Vou passar pro time pra entender melhor e te retornar. 🙏",
  },
  hardship: {
    severity: "attention",
    reply: () => "Sinto muito pela situação. Vou passar pro time pra ver como podemos ajudar. 🙏",
  },
  callback_later: {
    severity: "info",
    reply: () => "Sem problema — te procuro mais pra frente. Qualquer coisa antes disso, é só me chamar. 👍",
  },
};

const UNKNOWN_REPLY = "Recebi sua mensagem — vou avisar o time aqui pra te retornar. 🙏";

function hashShort(text: string): string {
  // Hash barato pra dedupe key de intents unknown (evita colidir "outra
  // msg unknown do mesmo cliente"). djb2 clássico.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

export class CollectionReplyService {
  /**
   * Handler chamado pelo webhookProcessor. Best-effort: `try` no caller
   * cobre erros mas este método também não lança — devolve NOT_HANDLED
   * em qualquer falha (a mensagem passa pra IA).
   */
  static async tryHandle(orgId: string, contactId: string, phone: string, text: string): Promise<TryHandleResult> {
    if (!orgId || !contactId || !text) return NOT_HANDLED;
    let live: LiveCollection | null = null;
    try { live = findLiveForContact(orgId, contactId, phone); }
    catch (e) { console.warn("[Cobrança] findLiveForContact falhou", e); return NOT_HANDLED; }
    if (!live) return NOT_HANDLED;

    let result: Awaited<ReturnType<typeof classify>>;
    try { result = await classify(text); }
    catch (e: any) { result = { intent: "unknown", confidence: 0, rationale: `classifier throw: ${e?.message || e}` }; }

    const intent = result.intent;
    const isKnown = intent !== "unknown";

    let severity: IntentMeta["severity"];
    let dedupeKey: string;
    let reply: string;
    if (isKnown) {
      const meta = INTENT_META[intent as Exclude<IntentLabel, "unknown">];
      severity = meta.severity;
      dedupeKey = `collection:${intent}:${live.receivableId || live.actionId}`;
      reply = meta.reply(live.amount, live.dueDate);
    } else {
      severity = "info";
      // Inclui hash pra sinais consecutivos "unknown" do mesmo contato
      // não somem num único sinal recorrente — o dono vê cada tentativa.
      dedupeKey = `collection:unknown:${live.receivableId || live.actionId}:${hashShort(text)}`;
      reply = UNKNOWN_REPLY;
    }

    let signalId: string | null = null;
    try {
      const pub = BusinessSignalService.publish(orgId, {
        domain: "collection",
        signalType: `reply_${intent}`,
        severity,
        basis: "fact",
        confidence: result.confidence,
        impactAmount: live.amount ?? null,
        impactUnit: live.amount != null ? "BRL" : null,
        sourceService: "CollectionReplyService",
        sourceEntityType: live.receivableId ? "receivable" : "decision_action",
        sourceEntityId: live.receivableId || live.actionId,
        evidence: {
          actionId: live.actionId,
          confId: live.confId,
          paymentId: live.paymentId,
          contactId: live.contactId || contactId,
          phone: live.phone || phone,
          receivableId: live.receivableId,
          amount: live.amount,
          dueDate: live.dueDate,
          reply_text_sample: String(text).slice(0, 280),
          rationale: result.rationale,
          intent,
        },
        dedupeKey,
      });
      signalId = pub.id;
    } catch (e) { console.warn("[Cobrança] BusinessSignal.publish falhou", e); }

    try {
      logAuthEvent(orgId, null, contactId, "RUNTIME_COLLECTION_REPLY_INTERPRETED", {
        intent, receivableId: live.receivableId, actionId: live.actionId, signalId,
        confidence: result.confidence, viaLLM: !!process.env.OPENAI_API_KEY,
      });
    } catch { /* noop */ }

    // ADR-152 F4b.4 — se intent=promise, cria linha em
    // `collection_payment_promises` pra o `Scheduler.collectionPromiseCheckPass`
    // fazer o re-check na data prometida. Só cria se temos channelId +
    // phone + dueDate (senão follow-up automático não conseguiria enviar).
    // Best-effort — nunca lança pro caller.
    if (intent === "promise" && live.channelId && live.phone && live.dueDate) {
      try {
        CollectionPromiseService.create(orgId, {
          actionId: live.actionId,
          receivableId: live.receivableId,
          contactId: live.contactId || contactId,
          phone: live.phone,
          channelId: live.channelId,
          amount: live.amount,
          dueDate: live.dueDate,
          promisedDate: result.promiseDate ?? null,
          signalId: signalId,
        });
      } catch (e) { console.warn("[Cobrança F4b.4] create promise falhou", e); }
    }

    // ADR-152 F4b.3 — re-emissão automática de PIX quando o cliente pediu.
    // Só dispara se temos paymentId + channelId + phone amarrados na
    // cobrança viva. Await inline (~1-2s Asaas + envio) — melhor UX que
    // "beleza vou reenviar" + silêncio. Se falha, o sinal
    // `resend_pix_failed` já é publicado pelo próprio ResendPixService e
    // o reply canned original ("vou reenviar…") vira o fallback.
    if (intent === "resend_pix" && live.paymentId && live.channelId && live.phone) {
      try {
        const resend = await CollectionResendPixService.sendNow(orgId, {
          actionId: live.actionId, paymentId: live.paymentId,
          channelId: live.channelId, phone: live.phone,
          amount: live.amount, dueDate: live.dueDate,
        });
        if (resend.sent) {
          // Reply mais assertivo — o cliente ACABOU de receber a msg do PIX.
          reply = "Prontinho, reenviei o PIX aqui em cima 👆 — se não abrir, me responde que a gente ajusta. 🙏";
        }
      } catch (e) { console.warn("[Cobrança F4b.3] resend PIX throw", e); }
    }

    return { handled: true, reply, intent, signalId: signalId || undefined, receivableId: live.receivableId };
  }
}

export default CollectionReplyService;
