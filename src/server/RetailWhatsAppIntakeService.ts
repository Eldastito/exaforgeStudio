/**
 * Retail Ops — Fechamento pelo WhatsApp da loja (ADR-083, Fase C / pedido TOULON).
 *
 * A ponta que faltava: a loja manda o FECHAMENTO do dia no WhatsApp — foto da
 * folha (a IA lê por OCR) OU o valor total em texto — e o ZappFlow registra o
 * fechamento do dia daquela loja, calcula o desvio vs cota e responde com o
 * resumo. Também dá baixa na pendência 'fechamento' do checklist (a cobrança
 * para de insistir).
 *
 * O canal é o NÚMERO da loja (`retail_stores.whatsapp_identifier`) — população
 * distinta do gestor autorizado (que cadastra estoque). Casamento tolerante ao
 * 9º dígito BR. Só intercepta quando há intenção clara de fechamento (foto,
 * valor, ou pendência de fechamento aberta no dia); caso contrário devolve null
 * e a mensagem segue o fluxo normal — nunca sequestra uma conversa qualquer.
 */
import db from "./db.js";
import { RetailStoreService } from "./RetailStoreService.js";
import { RetailClosingService, RetailTaskService } from "./RetailOpsService.js";
import { logAuthEvent } from "./auditLog.js";

export interface RetailInboundPayload {
  text?: string;
  imageBase64?: string;
  imageMime?: string;
  contactId?: string | null;
  senderId: string;
  date?: string; // 'YYYY-MM-DD' (default: hoje)
}

export class RetailWhatsAppIntakeService {
  /** Casa o remetente com uma loja ativa pelo whatsapp_identifier (tolerante ao 9º dígito). */
  static matchStore(orgId: string, senderId: string): any | null {
    for (const v of phoneVariants(senderId)) {
      const s = RetailStoreService.findByWhatsapp(orgId, v);
      if (s) return s;
    }
    return null;
  }

  /**
   * Processa uma mensagem do número de uma loja. Retorna `{ reply }` quando
   * tratou (fechamento por foto/valor, ou orientação com pendência aberta) ou
   * `null` quando não é caso de fechamento (deixa seguir o fluxo normal).
   */
  static async handleInbound(orgId: string, store: any, payload: RetailInboundPayload): Promise<{ reply: string } | null> {
    const date = payload.date || new Date().toISOString().slice(0, 10);

    // 1) FOTO da folha → OCR → registra o fechamento do dia.
    if (payload.imageBase64) {
      const res = await RetailClosingService.submitFromImage(
        orgId, store.id, date, payload.imageBase64, payload.imageMime || "image/jpeg",
        { source: "whatsapp_photo", submittedByContactId: payload.contactId || null, submittedByIdentifier: payload.senderId },
      );
      if (!res) return { reply: "Não consegui registrar o fechamento agora. Pode tentar de novo em instantes? 🙏" };
      this.markClosingTaskSubmitted(orgId, store.id, date, payload.contactId || null);
      try { logAuthEvent(orgId, "system", store.id, "RETAIL_CLOSING_WHATSAPP_PHOTO", { date, needsReview: res.extraction?.needsReview }); } catch { /* noop */ }
      return { reply: this.confirmationText(store, res.closing, res.extraction, true) };
    }

    // 2) VALOR total em texto → registra manualmente.
    const amount = payload.text != null ? parseBrlAmount(payload.text) : null;
    if (amount != null && amount > 0) {
      const closing = RetailClosingService.getOrCreate(orgId, store.id, date);
      const updated = RetailClosingService.setInformed(orgId, closing.id, {
        informedTotal: amount, source: "whatsapp_text",
        submittedByContactId: payload.contactId || null, submittedByIdentifier: payload.senderId,
      });
      this.markClosingTaskSubmitted(orgId, store.id, date, payload.contactId || null);
      try { logAuthEvent(orgId, "system", store.id, "RETAIL_CLOSING_WHATSAPP_TEXT", { date, amount }); } catch { /* noop */ }
      return { reply: this.confirmationText(store, updated, { informedTotal: amount }, false) };
    }

    // 3) Sem foto nem valor: só orienta SE houver pendência de fechamento aberta hoje.
    if (this.hasOpenClosingTask(orgId, store.id, date)) {
      return { reply: `Oi! Para registrar o fechamento da loja *${store.name}* de hoje, é só me enviar a *foto da folha* de fechamento ou o *valor total* do dia (ex.: R$ 4.850,00). 🙏` };
    }

    // Não é caso de fechamento → segue o fluxo normal de atendimento.
    return null;
  }

  /** Dá baixa na pendência 'fechamento' do dia (a cobrança para de insistir). */
  private static markClosingTaskSubmitted(orgId: string, storeId: string, date: string, contactId: string | null): void {
    try {
      const task = db.prepare(
        `SELECT id FROM retail_store_daily_tasks
          WHERE organization_id = ? AND store_id = ? AND task_date = ? AND task_type = 'fechamento' AND status != 'submitted'
          LIMIT 1`
      ).get(orgId, storeId, date) as any;
      if (task?.id) RetailTaskService.markSubmitted(orgId, task.id, { contactId });
    } catch { /* noop */ }
  }

  private static hasOpenClosingTask(orgId: string, storeId: string, date: string): boolean {
    try {
      const t = db.prepare(
        `SELECT 1 FROM retail_store_daily_tasks
          WHERE organization_id = ? AND store_id = ? AND task_date = ? AND task_type = 'fechamento' AND status IN ('pending','late') LIMIT 1`
      ).get(orgId, storeId, date);
      return !!t;
    } catch { return false; }
  }

  /** Monta a confirmação amigável com total, formas de pagamento e desvio vs cota. */
  private static confirmationText(store: any, closing: any, extraction: any, fromPhoto: boolean): string {
    const total = Number(closing?.informed_total ?? extraction?.informedTotal ?? 0);
    const quota = Number(closing?.quota_amount ?? 0);
    const variance = Number(closing?.variance_amount ?? (total - quota));
    const lines: string[] = [];
    lines.push(`✅ Fechamento da loja *${store.name}* recebido!`);
    lines.push(`💰 Total: *${brl(total)}*`);

    const items: any[] = Array.isArray(closing?.items) ? closing.items : [];
    if (items.length) {
      const formas = items.map((i) => `${labelForma(i.payment_method)}: ${brl(Number(i.informed_amount || 0))}`).join(" · ");
      lines.push(`🧾 ${formas}`);
    }

    if (quota > 0) {
      if (variance >= 0) lines.push(`🎯 Meta: ${brl(quota)} — *bateu* e passou ${brl(variance)}. 👏`);
      else lines.push(`🎯 Meta: ${brl(quota)} — faltou ${brl(Math.abs(variance))} para bater.`);
    }

    if (fromPhoto && extraction?.needsReview) {
      lines.push(`\n⚠️ Não tive certeza total na leitura da foto — o time vai *conferir* antes de aprovar. Se algum valor estiver errado, pode me mandar o total certo.`);
    } else {
      lines.push(`\nObrigado! Já está registrado. 🙌`);
    }
    return lines.join("\n");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Variações do número BR (com/sem 9º dígito) para casar o identificador. */
function phoneVariants(raw: string): string[] {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return [];
  const variants = new Set<string>([digits, raw]);
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const subscriber = digits.slice(4);
    if (subscriber.length === 9 && subscriber.startsWith("9")) variants.add(`55${ddd}${subscriber.slice(1)}`);
    else if (subscriber.length === 8) variants.add(`55${ddd}9${subscriber}`);
  }
  return Array.from(variants);
}

/**
 * Extrai um valor em reais de um texto curto. Aceita "R$ 4.850,00", "4850",
 * "4.850,00", "4850.00". Retorna null quando o texto não é essencialmente um
 * número (para não confundir uma frase qualquer com um total).
 */
export function parseBrlAmount(text: string): number | null {
  const raw = String(text || "").trim();
  // Só considera se o texto é predominantemente numérico (evita sequestrar frases).
  const stripped = raw.replace(/(r\$|reais|total|fechamento|hoje|foi|de|:|\s)/gi, "");
  if (!/^[\d.,]+$/.test(stripped) || !/\d/.test(stripped)) return null;
  let s = stripped;
  if (s.includes(",")) {
    // formato BR: ponto = milhar, vírgula = decimal
    s = s.replace(/\./g, "").replace(",", ".");
  } else if ((s.match(/\./g) || []).length > 1) {
    // múltiplos pontos = separador de milhar (ex.: 4.850.000)
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function brl(n: number): string {
  return `R$ ${Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function labelForma(method: string): string {
  const map: Record<string, string> = {
    dinheiro: "Dinheiro", pix: "Pix", credito: "Crédito", debito: "Débito",
    voucher: "Voucher", troca: "Troca", outros: "Outros",
  };
  return map[String(method || "").toLowerCase()] || String(method || "Outros");
}
