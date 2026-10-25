/**
 * PickupReadyNoticeService — aviso "seu pedido está pronto para retirar" ao cliente (ADR-207 F14).
 *
 * Fecha o limite deixado na F4: a loja marca o pedido como PRONTO e, se a empresa ligou o aviso, o cliente recebe UMA mensagem
 * de WhatsApp. É comunicação de saída ao CLIENTE FINAL, por isso é cercada:
 *  - OPT-IN por empresa (`pickup_ready_notice_enabled`, padrão DESLIGADO) — nada muda para quem não ligou.
 *  - Só dispara na TRANSIÇÃO para "pronto" feita por uma pessoa da loja (não é varredura em massa) e só em pedido de retirada PAGO.
 *  - UMA vez por pedido: UNIQUE(org, pedido) + estado `sent` final — repetir o clique, reprocessar ou cair o processo no meio
 *    nunca manda a segunda mensagem.
 *  - O envio passa pelo sink canônico (`MessageProviderService.sendMessage`), então herda sozinho os portões da empresa:
 *    consentimento `comunicacoes`, janela silenciosa e limite de frequência. Bloqueio por consentimento é FINAL (não insiste);
 *    bloqueio por horário/limite é re-tentado depois (até 3 tentativas, só enquanto o pedido seguir "pronto" e por até 24 h).
 *  - Quem pediu para não receber mensagens (`contacts.marketing_opt_out`) NUNCA recebe — fica registrado como `opted_out`.
 *  - A mensagem só traz o que o cliente precisa: nº do pedido, loja (+endereço se cadastrado) e as peças. SEM dinheiro, SEM
 *    telefone, e o nome vindo do cliente é higienizado (é texto de terceiro).
 *  - Falhou ou foi bloqueado? A fila da loja MOSTRA o estado ("avise por outro meio") — a equipe nunca acha que avisou sem ter avisado.
 *  - O telefone não é gravado no registro (só o status), e a auditoria só leva os 2 últimos dígitos.
 * O envio é injetável (`sendOverride`) para teste offline. Isolado por organização (convenção nº 1).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { StorePickupQueueService } from "./StorePickupQueueService.js";

export type NoticeStatus =
  | "sent" | "blocked_consent" | "opted_out" | "no_phone" | "no_channel"
  | "blocked_quiet_hours" | "blocked_frequency_cap" | "failed" | "expired" | "obsolete";

export type SendFn = (channelId: string, toDigits: string, text: string) => Promise<any>;

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MIN = 10;      // intervalo mínimo entre tentativas do passe
const GIVE_UP_HOURS = 24;        // depois disso o aviso perde o sentido
const HEAL_WINDOW_MIN = 30;      // "pronto" sem registro só é refeito se a transição for recente (queda do processo no meio)
const RETRYABLE: NoticeStatus[] = ["blocked_quiet_hours", "blocked_frequency_cap", "failed", "no_channel"];
const MAX_ITEMS_LISTED = 5;

/** Texto de terceiro (nome/peça): só letras, números e pontuação simples; sem quebra de linha/controle; tamanho limitado. */
export function cleanText(raw: unknown, max: number): string {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e*_~`<>{}\[\]\\|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Telefone brasileiro → dígitos com DDI 55 (o mesmo formato que os canais aceitam). Fora do padrão → null (nunca chuta). */
export function toWhatsappDigits(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return "55" + d;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
  return null;
}

export class PickupReadyNoticeService {
  /** Teste: substitui o envio real. Em produção fica null (usa o sink canônico). */
  static sendOverride: SendFn | null = null;
  /** Envios em andamento (o gancho do avanço é "dispara e esquece"; o teste espera por aqui). */
  private static inflight = new Set<Promise<unknown>>();
  static async idle(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare("SELECT pickup_ready_notice_enabled AS v FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return Number(r?.v || 0) === 1;
    } catch { return false; }
  }

  static setEnabled(orgId: string, enabled: boolean): boolean {
    db.prepare("UPDATE organization_settings SET pickup_ready_notice_enabled = ?, pickup_ready_notice_enabled_at = CASE WHEN ? = 1 AND COALESCE(pickup_ready_notice_enabled, 0) = 0 THEN CURRENT_TIMESTAMP ELSE pickup_ready_notice_enabled_at END WHERE organization_id = ?").run(enabled ? 1 : 0, enabled ? 1 : 0, orgId);
    try { logAuthEvent(orgId, "system", orgId, enabled ? "PICKUP_READY_NOTICE_ENABLED" : "PICKUP_READY_NOTICE_DISABLED", {}); } catch { /* noop */ }
    return this.isEnabled(orgId);
  }

  static statusOf(orgId: string, orderId: string): { status: NoticeStatus; attempts: number; at: string | null } | null {
    const r = db.prepare("SELECT status, attempts, COALESCE(sent_at, updated_at) AS at FROM pickup_ready_notices WHERE organization_id = ? AND order_id = ?").get(orgId, orderId) as any;
    return r ? { status: r.status, attempts: Number(r.attempts) || 0, at: r.at || null } : null;
  }

  /** Gancho chamado quando a loja marca "pronto": dispara e esquece — NUNCA lança nem atrasa o avanço da etapa. */
  static fireOnReady(orgId: string, orderId: string): void {
    const p = this.onReady(orgId, orderId).catch((e) => { try { console.error("[PickupReadyNotice] falhou", orderId, e?.message || e); } catch { /* noop */ } });
    this.inflight.add(p); p.finally(() => this.inflight.delete(p));
  }

  private static upsert(orgId: string, orderId: string, status: NoticeStatus, attempts: number, detail: string, sent: boolean): void {
    const ex = db.prepare("SELECT id FROM pickup_ready_notices WHERE organization_id = ? AND order_id = ?").get(orgId, orderId) as any;
    if (ex) {
      db.prepare("UPDATE pickup_ready_notices SET status = ?, attempts = ?, detail = ?, sent_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE sent_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(status, attempts, detail.slice(0, 200), sent ? 1 : 0, ex.id);
    } else {
      db.prepare("INSERT INTO pickup_ready_notices (id, organization_id, order_id, status, attempts, detail, sent_at) VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)")
        .run(randomUUID(), orgId, orderId, status, attempts, detail.slice(0, 200), sent ? 1 : 0);
    }
  }

  /** Texto da mensagem — sem dinheiro, sem telefone, sem texto de terceiro cru. */
  static buildMessage(orgId: string, order: any, customer: { name: string | null }, items: { name: string; quantity: number }[]): string {
    const short = String(order.id).slice(0, 8);
    const first = cleanText(customer.name, 40).split(" ")[0] || "";
    const store = db.prepare("SELECT name, address, city FROM retail_stores WHERE id = ? AND organization_id = ?").get(order.pickup_store_id, orgId) as any;
    const storeName = cleanText(store?.name, 60) || "loja";
    const where = [cleanText(store?.address, 90), cleanText(store?.city, 40)].filter(Boolean).join(" — ");
    const listed = items.slice(0, MAX_ITEMS_LISTED).map((i) => `${Math.max(1, Math.trunc(Number(i.quantity) || 1))}× ${cleanText(i.name, 60) || "item"}`);
    const extra = items.length - MAX_ITEMS_LISTED;
    return [
      `${first ? `Olá, ${first}!` : "Olá!"} 🛍️ Seu pedido #${short} está pronto para retirar na ${storeName}.`,
      where ? `📍 ${where}` : "",
      listed.length ? `Itens: ${listed.join("; ")}${extra > 0 ? ` e mais ${extra} item(ns)` : ""}.` : "",
      `Na retirada, informe o número do pedido (#${short}). Se você já retirou, é só ignorar esta mensagem.`,
    ].filter(Boolean).join("\n");
  }

  private static async defaultSend(orgId: string, send: SendFn | null, channelId: string, to: string, text: string): Promise<any> {
    if (send) return send(channelId, to, text);
    const { MessageProviderService } = await import("./MessageProviderService.js");
    return MessageProviderService.sendMessage(channelId, to, text, { feature: "vendas" });
  }

  /** O cliente pediu para não receber mensagens? (pelo contato do pedido ou pelo telefone) */
  private static optedOut(orgId: string, order: any, digits: string): boolean {
    try {
      const byId = order.contact_id ? db.prepare("SELECT marketing_opt_out FROM contacts WHERE id = ? AND organization_id = ?").get(order.contact_id, orgId) as any : null;
      if (byId) return Number(byId.marketing_opt_out || 0) === 1;
      const byPhone = db.prepare("SELECT marketing_opt_out FROM contacts WHERE organization_id = ? AND identifier IN (?, ?, ?) AND COALESCE(marketing_opt_out,0) = 1 LIMIT 1").get(orgId, digits, "+" + digits, digits.slice(2)) as any;
      return !!byPhone;
    } catch { return false; }
  }

  /**
   * Avisa (se puder) o cliente de UM pedido. Idempotente. `opts.force` = passe de re-tentativa (ignora a exigência de "acabou de virar pronto").
   */
  static async onReady(orgId: string, orderId: string, opts: { send?: SendFn } = {}): Promise<{ status: NoticeStatus | "disabled" | "not_ready" | "already_final" }> {
    if (!orgId || !orderId || !this.isEnabled(orgId)) return { status: "disabled" };
    const order = db.prepare("SELECT id, status, pickup_status, pickup_store_id, fulfillment_method, contact_id, notes FROM orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!order || order.fulfillment_method !== "pickup" || !["pago", "em_preparo"].includes(order.status) || order.pickup_status !== "pronto") {
      // O pedido seguiu em frente (retirado/cancelado) enquanto havia aviso pendente: encerra sem mandar nada.
      const pend = this.statusOf(orgId, orderId);
      if (pend && RETRYABLE.includes(pend.status)) this.upsert(orgId, orderId, "obsolete", pend.attempts, "pedido não está mais pronto", false);
      return { status: "not_ready" };
    }
    const ex = this.statusOf(orgId, orderId);
    if (ex && !RETRYABLE.includes(ex.status)) return { status: "already_final" };
    if (ex && ex.attempts >= MAX_ATTEMPTS) { this.upsert(orgId, orderId, "expired", ex.attempts, "tentativas esgotadas", false); return { status: "expired" }; }
    const attempts = (ex?.attempts || 0) + 1;

    const customer = StorePickupQueueService.customer(orgId, order);
    const digits = toWhatsappDigits(customer.phone);
    if (!digits) { this.upsert(orgId, orderId, "no_phone", attempts, "sem telefone válido", false); return { status: "no_phone" }; }
    if (this.optedOut(orgId, order, digits)) { this.upsert(orgId, orderId, "opted_out", attempts, "cliente pediu para não receber mensagens", false); return { status: "opted_out" }; }

    const { ChannelBindingService } = await import("./ChannelBindingService.js");
    const channel = ChannelBindingService.selectOutboundChannel(orgId, "vendas");
    if (!channel) { this.upsert(orgId, orderId, "no_channel", attempts, "sem canal de WhatsApp conectado", false); return { status: "no_channel" }; }

    const text = this.buildMessage(orgId, order, customer, StorePickupQueueService.items(orderId));
    // Grava a tentativa ANTES de enviar: se o processo cair entre o envio e a gravação, o pior caso é "não sabemos" (nunca 2 envios).
    try {
      await this.defaultSend(orgId, opts.send ?? this.sendOverride, channel.id, digits, text);
      this.upsert(orgId, orderId, "sent", attempts, `ok …${digits.slice(-2)}`, true);
      try { logAuthEvent(orgId, "system", orderId, "PICKUP_READY_NOTICE_SENT", { channel: "whatsapp", to: `…${digits.slice(-2)}` }); } catch { /* noop */ }
      return { status: "sent" };
    } catch (e: any) {
      const code = String(e?.code || "");
      let status: NoticeStatus = "failed";
      if (code === "outbound_blocked:consent_missing") status = "blocked_consent";
      else if (code === "outbound_blocked:quiet_hours") status = "blocked_quiet_hours";
      else if (code === "outbound_blocked:frequency_cap") status = "blocked_frequency_cap";
      // Esgotou as tentativas: vira "expirado" (a tela nunca pode continuar dizendo "tento de novo" para sempre).
      const finalStatus: NoticeStatus = RETRYABLE.includes(status) && attempts >= MAX_ATTEMPTS ? "expired" : status;
      this.upsert(orgId, orderId, finalStatus, attempts, finalStatus === "expired" ? "tentativas esgotadas" : status === "failed" ? "falha no envio" : code.replace("outbound_blocked:", "bloqueado: "), false);
      status = finalStatus;
      try { logAuthEvent(orgId, "system", orderId, "PICKUP_READY_NOTICE_NOT_SENT", { status }); } catch { /* noop */ }
      return { status };
    }
  }

  /**
   * Passe do Scheduler (rápido, barato — só tem linha quem ligou o aviso):
   *  (1) re-tenta o que foi bloqueado por horário/limite/canal/falha (a cada ≥10 min, ≤3 vezes, ≤24 h);
   *  (2) cura o caso "virou pronto e o processo caiu antes do aviso" — só transições dos últimos 30 min E posteriores ao momento em
   *      que o aviso foi LIGADO (`pickup_ready_notice_enabled_at`): ligar o aviso NUNCA manda mensagem retroativa para pedido que já esperava.
   */
  static async pass(): Promise<{ retried: number; healed: number }> {
    let retried = 0, healed = 0;
    try {
      const retry = db.prepare(
        `SELECT n.organization_id AS org, n.order_id AS oid, n.created_at AS created FROM pickup_ready_notices n
           JOIN organization_settings s ON s.organization_id = n.organization_id AND s.pickup_ready_notice_enabled = 1
          WHERE n.status IN (${RETRYABLE.map(() => "?").join(",")}) AND n.attempts < ?
            AND n.updated_at <= datetime('now', ?)`,
      ).all(...RETRYABLE, MAX_ATTEMPTS, `-${RETRY_AFTER_MIN} minutes`) as any[];
      for (const r of retry) {
        const ageH = (Date.now() - new Date(String(r.created).replace(" ", "T") + "Z").getTime()) / 3_600_000;
        if (ageH > GIVE_UP_HOURS) { const cur = this.statusOf(r.org, r.oid); this.upsert(r.org, r.oid, "expired", cur?.attempts || 0, "passou o prazo de 24 h", false); continue; }
        const out = await this.onReady(r.org, r.oid); if (out.status === "sent") retried++;
      }
      const heal = db.prepare(
        `SELECT o.organization_id AS org, o.id AS oid FROM orders o
           JOIN organization_settings s ON s.organization_id = o.organization_id AND s.pickup_ready_notice_enabled = 1
          WHERE o.fulfillment_method = 'pickup' AND o.pickup_status = 'pronto' AND o.status IN ('pago','em_preparo')
            AND o.pickup_status_at >= datetime('now', ?)
            AND s.pickup_ready_notice_enabled_at IS NOT NULL AND o.pickup_status_at >= s.pickup_ready_notice_enabled_at
            AND NOT EXISTS (SELECT 1 FROM pickup_ready_notices n WHERE n.organization_id = o.organization_id AND n.order_id = o.id)`,
      ).all(`-${HEAL_WINDOW_MIN} minutes`) as any[];
      for (const h of heal) { const out = await this.onReady(h.org, h.oid); if (out.status === "sent") healed++; }
    } catch (e) { try { console.error("[PickupReadyNotice] passe falhou", e); } catch { /* noop */ } }
    return { retried, healed };
  }
}

export default PickupReadyNoticeService;
