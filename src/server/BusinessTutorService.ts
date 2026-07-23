import db from "./db.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
import { ComigoHealthService } from "./ComigoHealthService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { onlyDigits } from "./phoneMatch.js";

/**
 * Tutor de Gestão no WhatsApp (ADR-131, Fatia 1: resumo da manhã).
 *
 * Empurra a inteligência da Central de Saúde PARA o dono, pelo WhatsApp, uma vez
 * por dia de manhã — em vez de esperar ele abrir a tela. Conteúdo DETERMINÍSTICO
 * (zero-token): reusa BusinessHealthService.overview() (status + top-3
 * prioridades + KPIs). Opt-in por org, deduplicado por dia, isolado por
 * organization_id. O envio real (canal/provedor) é injetado — o serviço só
 * decide o QUÊ e o QUANDO, o que o torna testável sem rede.
 */

const brl = (n: any) => `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`;

export interface TutorSendResult {
  sent: boolean;
  reason?: "disabled" | "outside_window" | "already_sent" | "no_phone" | "no_breakeven";
  phone?: string;
  text?: string;
}

export class BusinessTutorService {
  // Janela da manhã (hora local de São Paulo). Resiliente a um tick perdido:
  // dispara em qualquer hora da janela, mas só uma vez por dia (dedupe por data).
  private static MORNING_START = 7;
  private static MORNING_END = 12; // exclusivo
  private static MIDDAY_START = 12;
  private static MIDDAY_END = 16; // exclusivo
  private static EVENING_START = 18;
  private static EVENING_END = 22; // exclusivo

  /** Data e hora em São Paulo a partir de um Date (determinístico p/ teste). */
  static spParts(now: Date): { dateSP: string; hourSP: number } {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return { dateSP: `${get("year")}-${get("month")}-${get("day")}`, hourSP: Number(get("hour")) };
  }

  /** Número do dono para o tutor: o configurado; senão o telefone do usuário dono/admin. */
  static ownerPhone(orgId: string): string {
    const s = db.prepare("SELECT tutor_wa_phone FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const configured = onlyDigits(s?.tutor_wa_phone);
    if (configured) return configured;
    const u = db.prepare(
      "SELECT phone FROM users WHERE organization_id = ? AND phone IS NOT NULL AND phone <> '' ORDER BY (role='owner') DESC, (role='admin') DESC, created_at ASC LIMIT 1"
    ).get(orgId) as any;
    return onlyDigits(u?.phone);
  }

  /** Texto do resumo da manhã — determinístico a partir da Central de Saúde. */
  static morningBrief(orgId: string): { text: string; priorityCount: number; status: string } {
    const ov = BusinessHealthService.overview(orgId) as any;
    const priorities = Array.isArray(ov?.priorities) ? ov.priorities : [];
    const lines: string[] = [];
    lines.push("☀️ *Bom dia!* Seu resumo de gestão de hoje:");
    lines.push("");
    lines.push(`*Situação:* ${ov?.statusLabel || "Saudável"}. ${ov?.synthesis || ""}`.trim());

    if (priorities.length) {
      lines.push("");
      lines.push("*Prioridades de hoje:*");
      priorities.slice(0, 3).forEach((p: any, i: number) => {
        const imp = Number(p?.impact) > 0 ? ` (impacto ~${brl(p.impact)})` : "";
        lines.push(`${i + 1}. ${p.title}${imp}`);
      });
    } else {
      lines.push("");
      lines.push("Nenhuma urgência hoje — caixa e prioridades sob controle. 👍");
    }

    const k = ov?.kpis || {};
    const kpiParts = [`Caixa ${brl(k.caixaAtual)}`, `a receber ${brl(k.aReceber)}`, `a pagar ${brl(k.aPagar)}`];
    if (Number.isFinite(k.survivalDays) && k.survivalDays > 0 && k.survivalDays < 999) kpiParts.push(`~${Math.round(k.survivalDays)} dias de caixa`);
    lines.push("");
    lines.push(`💰 ${kpiParts.join(" · ")}`);
    lines.push("");
    lines.push("Abra a *Central de Saúde* no ZappFlow para agir. 💪");

    return { text: lines.join("\n"), priorityCount: priorities.length, status: ov?.status || "saudavel" };
  }

  /**
   * Passe da manhã para uma org (injeta o envio). Só envia se: opt-in ligado,
   * dentro da janela da manhã (SP), ainda não enviado hoje, e há número do dono.
   * Marca a data só APÓS o envio (retenta no próximo tick se o envio falhar).
   */
  static async runMorningPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any }): Promise<TutorSendResult> {
    const s = db.prepare("SELECT tutor_wa_enabled, tutor_wa_last_morning FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (!s || !Number(s.tutor_wa_enabled)) return { sent: false, reason: "disabled" };
    const { dateSP, hourSP } = this.spParts(opts.now);
    if (hourSP < this.MORNING_START || hourSP >= this.MORNING_END) return { sent: false, reason: "outside_window" };
    if (s.tutor_wa_last_morning === dateSP) return { sent: false, reason: "already_sent" };
    const phone = this.ownerPhone(orgId);
    if (!phone) return { sent: false, reason: "no_phone" };
    const { text } = this.morningBrief(orgId);
    await opts.send(phone, text);
    db.prepare("UPDATE organization_settings SET tutor_wa_last_morning = ? WHERE organization_id = ?").run(dateSP, orgId);
    return { sent: true, phone, text };
  }

  /**
   * Texto do "durante o dia" (ADR-131 Fatia 2): quanto do ponto de equilíbrio o
   * dia já cobriu. Só se aplica quando há custo fixo informado e breakeven > 0
   * (senão não há o que reportar — o passe pula sem enviar). Zero-token.
   */
  static middayBrief(orgId: string): { text: string; applicable: boolean } {
    const be = ComigoHealthService.breakEven(orgId) as any;
    const applicable = !!be?.hasFixedCosts && Number(be?.breakEvenRevenue) > 0;
    if (!applicable) return { text: "", applicable: false };
    const pct = Math.round(Number(be.progress || 0) * 100);
    const falta = Math.max(0, Number(be.breakEvenRevenue) - Number(be.achievedRevenue));
    const lines: string[] = [];
    lines.push("☕ *Meio-dia* — como vai o dia:");
    lines.push("");
    lines.push(`Você já fez ${brl(be.achievedRevenue)} — *${pct}%* do ponto de equilíbrio (${brl(be.breakEvenRevenue)}).`);
    if (pct >= 100) {
      lines.push("Já pagou o dia! Daqui pra frente é lucro. 🎉");
    } else {
      const ped = Number(be.avgTicket) > 0 ? ` (~${Math.ceil(falta / Number(be.avgTicket))} pedido(s))` : "";
      lines.push(`Faltam ${brl(falta)}${ped} pra virar o dia no azul. 💪`);
    }
    return { text: lines.join("\n"), applicable: true };
  }

  /**
   * Passe do meio-dia para uma org. Só envia com opt-in ligado, na janela do
   * meio-dia (SP), ainda não enviado hoje, com número do dono E breakeven
   * aplicável. Não marca a data se pulou (breakeven pode ficar pronto mais tarde).
   */
  static async runMiddayPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any }): Promise<TutorSendResult> {
    const s = db.prepare("SELECT tutor_wa_enabled, tutor_wa_last_midday FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (!s || !Number(s.tutor_wa_enabled)) return { sent: false, reason: "disabled" };
    const { dateSP, hourSP } = this.spParts(opts.now);
    if (hourSP < this.MIDDAY_START || hourSP >= this.MIDDAY_END) return { sent: false, reason: "outside_window" };
    if (s.tutor_wa_last_midday === dateSP) return { sent: false, reason: "already_sent" };
    const phone = this.ownerPhone(orgId);
    if (!phone) return { sent: false, reason: "no_phone" };
    const { text, applicable } = this.middayBrief(orgId);
    if (!applicable) return { sent: false, reason: "no_breakeven" };
    await opts.send(phone, text);
    db.prepare("UPDATE organization_settings SET tutor_wa_last_midday = ? WHERE organization_id = ?").run(dateSP, orgId);
    return { sent: true, phone, text };
  }

  /**
   * Texto do "fim do dia" (ADR-131 Fatia 3): quanto vendeu, quanto entrou no
   * caixa, margem estimada e o que ficou a receber. Determinístico: vendas/margem
   * do dia via ComigoHealthService; recebido/pendente via FinancialLedgerService.
   * O "sim, cobre amanhã" (loop conversacional) fica para a Fatia 4.
   */
  static eveningBrief(orgId: string): { text: string } {
    const today = new Date().toISOString().slice(0, 10);
    const day = ComigoHealthService.rangeResult(orgId, today, today) as any;
    const sum = FinancialLedgerService.summary(orgId) as any;
    const aReceber = Number(sum?.aReceber) || 0;
    const lines: string[] = [];
    lines.push("📊 *Fim do dia* — o resumo de hoje:");
    lines.push("");
    lines.push(`🛒 Vendas: ${brl(day.revenue)}${Number(day.orders) > 0 ? ` (${day.orders} pedido(s))` : ""}`);
    lines.push(`💵 Entrou no caixa: ${brl(sum?.realizadoHoje)}`);
    lines.push(`📈 Margem estimada: ${brl(day.profit)}`);
    if (aReceber > 0) {
      lines.push("");
      lines.push(`Ainda há ${brl(aReceber)} a receber em aberto. Amanhã cedo eu te lembro de cobrar. 💬`);
    } else {
      lines.push("");
      lines.push("Nada em aberto por hoje. Bom descanso! 🌙");
    }
    return { text: lines.join("\n") };
  }

  /**
   * Passe do fim do dia para uma org. Opt-in ligado, janela da noite (SP), ainda
   * não enviado hoje, com número do dono. É o fechamento do dia — sempre envia
   * (mesmo dia parado), pois é o ritual que o dono pediu.
   */
  static async runEveningPass(orgId: string, opts: { now: Date; send: (phone: string, text: string) => any }): Promise<TutorSendResult> {
    const s = db.prepare("SELECT tutor_wa_enabled, tutor_wa_last_evening FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (!s || !Number(s.tutor_wa_enabled)) return { sent: false, reason: "disabled" };
    const { dateSP, hourSP } = this.spParts(opts.now);
    if (hourSP < this.EVENING_START || hourSP >= this.EVENING_END) return { sent: false, reason: "outside_window" };
    if (s.tutor_wa_last_evening === dateSP) return { sent: false, reason: "already_sent" };
    const phone = this.ownerPhone(orgId);
    if (!phone) return { sent: false, reason: "no_phone" };
    const { text } = this.eveningBrief(orgId);
    await opts.send(phone, text);
    db.prepare("UPDATE organization_settings SET tutor_wa_last_evening = ? WHERE organization_id = ?").run(dateSP, orgId);
    return { sent: true, phone, text };
  }

  /** Envio manual (botão "enviar teste") — ignora janela e dedupe. */
  static async sendNow(orgId: string, opts: { send: (phone: string, text: string) => any }): Promise<{ ok: boolean; error?: string; phone?: string }> {
    const enabled = db.prepare("SELECT tutor_wa_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (!enabled || !Number(enabled.tutor_wa_enabled)) return { ok: false, error: "Ative o tutor primeiro." };
    const phone = this.ownerPhone(orgId);
    if (!phone) return { ok: false, error: "Defina o número do WhatsApp do dono." };
    const { text } = this.morningBrief(orgId);
    await opts.send(phone, text);
    return { ok: true, phone };
  }
}

export default BusinessTutorService;
