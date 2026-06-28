import db from "./db.js";

// Fuso de Brasília (sem horário de verão desde 2019) = UTC-3. A IA gera os
// horários com offset -03:00; aqui usamos o mesmo offset fixo para a aritmética
// de slots. Configurável por env se um dia precisar.
const TZ_OFFSET_MIN = Number(process.env.APP_TZ_OFFSET_MINUTES ?? -180);
const TZ = process.env.APP_TIMEZONE || "America/Sao_Paulo";

const DAY_LABEL: Record<number, string> = { 1: "seg", 2: "ter", 3: "qua", 4: "qui", 5: "sex", 6: "sáb", 7: "dom" };

export interface AgendaConfig {
  openHour: number;   // hora de abertura (0-23)
  closeHour: number;  // hora de fechamento (0-24)
  slotMin: number;    // duração do atendimento em minutos
  days: number[];     // dias da semana atendidos (ISO: 1=seg .. 7=dom)
  capacity: number;   // atendimentos simultâneos por horário
}

/**
 * Gestão de disponibilidade da Agenda. Garante que a IA (e o servidor) só
 * marquem em horários LIVRES, dentro do funcionamento, e NUNCA dois clientes
 * no mesmo dia+horário (até a capacidade configurada). Também produz o bloco de
 * contexto que a IA lê antes de propor horários.
 */
export class AppointmentService {
  static config(orgId: string): AgendaConfig {
    let row: any = {};
    try {
      row = db.prepare(
        "SELECT agenda_open_hour, agenda_close_hour, agenda_slot_minutes, agenda_days, agenda_capacity FROM organization_settings WHERE organization_id = ?"
      ).get(orgId) || {};
    } catch { /* colunas podem não existir ainda */ }
    let days: number[] = [1, 2, 3, 4, 5];
    if (typeof row.agenda_days === "string" && row.agenda_days.trim()) {
      const parsed = row.agenda_days.split(",").map((s: string) => parseInt(s, 10)).filter((n: number) => n >= 1 && n <= 7);
      if (parsed.length) days = parsed;
    }
    return {
      openHour: Number.isFinite(row.agenda_open_hour) ? row.agenda_open_hour : 8,
      closeHour: Number.isFinite(row.agenda_close_hour) ? row.agenda_close_hour : 18,
      slotMin: row.agenda_slot_minutes && row.agenda_slot_minutes > 0 ? row.agenda_slot_minutes : 60,
      days,
      capacity: row.agenda_capacity && row.agenda_capacity > 0 ? row.agenda_capacity : 1,
    };
  }

  /**
   * Persiste a configuração da Agenda (parcial). Sanitiza tudo: horas em 0-24,
   * fechamento > abertura, slot >= 5 min, dias ISO 1-7 (sem repetição) e
   * capacidade >= 1. Retorna a configuração efetiva já normalizada.
   */
  static saveConfig(orgId: string, patch: Partial<AgendaConfig>): AgendaConfig {
    const cur = this.config(orgId);
    const next: AgendaConfig = { ...cur };

    if (patch.openHour != null && Number.isFinite(patch.openHour)) {
      next.openHour = Math.min(23, Math.max(0, Math.round(patch.openHour)));
    }
    if (patch.closeHour != null && Number.isFinite(patch.closeHour)) {
      next.closeHour = Math.min(24, Math.max(1, Math.round(patch.closeHour)));
    }
    // fechamento sempre depois da abertura (pelo menos 1h)
    if (next.closeHour <= next.openHour) next.closeHour = Math.min(24, next.openHour + 1);

    if (patch.slotMin != null && Number.isFinite(patch.slotMin)) {
      next.slotMin = Math.min(480, Math.max(5, Math.round(patch.slotMin)));
    }
    if (Array.isArray(patch.days)) {
      const clean = Array.from(new Set(
        patch.days.map(n => parseInt(String(n), 10)).filter(n => n >= 1 && n <= 7)
      )).sort((a, b) => a - b);
      if (clean.length) next.days = clean;
    }
    if (patch.capacity != null && Number.isFinite(patch.capacity)) {
      next.capacity = Math.min(99, Math.max(1, Math.round(patch.capacity)));
    }

    db.prepare(
      "UPDATE organization_settings SET agenda_open_hour = ?, agenda_close_hour = ?, agenda_slot_minutes = ?, agenda_days = ?, agenda_capacity = ? WHERE organization_id = ?"
    ).run(next.openHour, next.closeHour, next.slotMin, next.days.join(","), next.capacity, orgId);

    return next;
  }

  /** Epoch ms de um datetime do banco (aceita ...Z, ...+/-hh:mm ou "YYYY-MM-DD HH:MM:SS" UTC). */
  static ms(s?: string | null): number | null {
    if (!s) return null;
    const v = String(s).trim();
    const norm = /(z|[+-]\d\d:?\d\d)$/i.test(v) ? v : v.replace(" ", "T") + "Z";
    const t = Date.parse(norm);
    return isNaN(t) ? null : t;
  }

  // Agendamentos ATIVOS que se sobrepõem à janela [fromMs, toMs).
  private static activeOverlapping(orgId: string, fromMs: number, toMs: number) {
    const slotMs = this.config(orgId).slotMin * 60000;
    let rows: any[] = [];
    try {
      rows = db.prepare(
        "SELECT scheduled_start, scheduled_end, contact_id FROM appointments WHERE organization_id = ? AND status NOT IN ('cancelled','no_show')"
      ).all(orgId) as any[];
    } catch { return []; }
    const out: { st: number; en: number; contactId: string | null }[] = [];
    for (const r of rows) {
      const st = this.ms(r.scheduled_start);
      if (st == null) continue;
      const en = this.ms(r.scheduled_end) ?? (st + slotMs);
      if (en > fromMs && st < toMs) out.push({ st, en, contactId: r.contact_id || null });
    }
    return out;
  }

  /** Quantos atendimentos ativos ocupam o slot que começa em startMs. */
  static conflictCount(orgId: string, startMs: number): number {
    const slotMs = this.config(orgId).slotMin * 60000;
    return this.activeOverlapping(orgId, startMs, startMs + slotMs).length;
  }

  /** O slot que começa em startMs ainda tem vaga (abaixo da capacidade)? */
  static isFree(orgId: string, startMs: number): boolean {
    return this.conflictCount(orgId, startMs) < this.config(orgId).capacity;
  }

  /** Este contato JÁ tem um agendamento ativo nesse mesmo slot? (anti-duplicidade) */
  static duplicateForContact(orgId: string, contactId: string | null | undefined, startMs: number): boolean {
    if (!contactId) return false;
    const slotMs = this.config(orgId).slotMin * 60000;
    return this.activeOverlapping(orgId, startMs, startMs + slotMs).some(a => a.contactId === contactId);
  }

  // ----- aritmética de fuso (offset fixo BR) -----
  private static brParts(ms: number) {
    const d = new Date(ms + TZ_OFFSET_MIN * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() === 0 ? 7 : d.getUTCDay() };
  }
  private static brToMs(y: number, mo: number, da: number, h: number, mi: number): number {
    return Date.UTC(y, mo, da, h, mi) - TZ_OFFSET_MIN * 60000;
  }

  /** Rótulo amigável em pt-BR no fuso do negócio (ex.: "qua, 02/jul 14:00"). */
  static label(ms: number): string {
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      }).format(new Date(ms)).replace(",", "");
    } catch {
      return new Date(ms).toISOString();
    }
  }

  /**
   * Próximos N horários LIVRES a partir de `fromMs` (padrão agora), respeitando
   * funcionamento e capacidade. Começa pelo mais cedo do dia e avança para os
   * dias seguintes — exatamente o padrão de marcação desejado.
   */
  static nextFreeSlots(orgId: string, n = 6, fromMs: number = Date.now()): number[] {
    const c = this.config(orgId);
    const slotMs = c.slotMin * 60000;
    const out: number[] = [];
    let cur = fromMs;
    let guard = 0;
    const maxIter = Math.ceil(((24 * 60) / c.slotMin) * 21) + 50; // ~21 dias de busca
    while (out.length < n && guard < maxIter) {
      guard++;
      const p = this.brParts(cur);
      if (!c.days.includes(p.dow)) { cur = this.brToMs(p.y, p.mo, p.da + 1, c.openHour, 0); continue; }
      const curMin = p.h * 60 + p.mi;
      if (curMin < c.openHour * 60) { cur = this.brToMs(p.y, p.mo, p.da, c.openHour, 0); continue; }
      if (curMin >= c.closeHour * 60) { cur = this.brToMs(p.y, p.mo, p.da + 1, c.openHour, 0); continue; }
      // alinha ao grid de slots a partir da abertura
      const sinceOpen = curMin - c.openHour * 60;
      const idx = Math.ceil(sinceOpen / c.slotMin);
      const slotMin0 = c.openHour * 60 + idx * c.slotMin;
      if (slotMin0 + c.slotMin > c.closeHour * 60) { cur = this.brToMs(p.y, p.mo, p.da + 1, c.openHour, 0); continue; }
      const slotStart = this.brToMs(p.y, p.mo, p.da, Math.floor(slotMin0 / 60), slotMin0 % 60);
      if (slotStart < fromMs) { cur = slotStart + slotMs; continue; }
      if (this.isFree(orgId, slotStart)) out.push(slotStart);
      cur = slotStart + slotMs;
    }
    return out;
  }

  /** Bloco de contexto da agenda para o prompt da IA. */
  static agendaText(orgId: string): string {
    const c = this.config(orgId);
    const free = this.nextFreeSlots(orgId, 6);
    const dias = c.days.map(d => DAY_LABEL[d]).join("/");
    const header = `AGENDA INTERNA (atendimentos já marcados no sistema). Funcionamento: ${dias} ${c.openHour}h–${c.closeHour}h · atendimentos de ${c.slotMin} min · ${c.capacity} por horário.`;
    if (!free.length) {
      return `${header}\nNÃO há horários livres nos próximos dias — diga ao cliente que vai verificar com a equipe e NÃO confirme um horário.`;
    }
    const labels = free.map(ms => this.label(ms)).join(" · ");
    return `${header}\n` +
      `PRÓXIMOS HORÁRIOS LIVRES (ofereça SEMPRE o mais cedo primeiro; quando o dia encher, passe ao próximo dia): ${labels}.\n` +
      `REGRA: só ofereça/confirme horários desta lista de livres. NUNCA proponha um horário ocupado e NUNCA marque dois clientes no mesmo dia e horário.`;
  }
}
