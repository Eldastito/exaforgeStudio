import db from "./db.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
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
  reason?: "disabled" | "outside_window" | "already_sent" | "no_phone";
  phone?: string;
  text?: string;
}

export class BusinessTutorService {
  // Janela da manhã (hora local de São Paulo). Resiliente a um tick perdido:
  // dispara em qualquer hora da janela, mas só uma vez por dia (dedupe por data).
  private static MORNING_START = 7;
  private static MORNING_END = 12; // exclusivo

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
