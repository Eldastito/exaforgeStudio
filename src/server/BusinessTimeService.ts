/**
 * BusinessTimeService — data COMERCIAL no fuso da organização (PDR Estabilização
 * TOULON, Fatia A / TIME-001..004).
 *
 * A raiz do bug "boletas somem no reload após 21h" é a UI calcular "hoje" em UTC
 * (`new Date().toISOString().slice(0,10)`). No Rio (UTC-3), após 21h a data UTC já
 * é o dia seguinte, e o painel passa a consultar `(org, loja, dia+1)` — chave vazia.
 * Este serviço centraliza a data comercial no fuso da org (fallback
 * `America/Sao_Paulo`), determinada NO SERVIDOR — o cliente nunca dita o dia atual.
 *
 * Determinístico, sem lib (via `Intl`). Isolado por organização.
 *
 * Guardrails:
 *  - RN-TIME-1: data comercial é do fuso da org, NUNCA do relógio UTC do host.
 *  - RN-TIME-2: correção sistêmica (fuso), jamais "-3h" fixo (quebraria no DST).
 *  - RN-TIME-3: o horário do evento (clique) continua sendo timestamp do servidor.
 */
import db from "./db.js";
import { RetailFeatureFlagService } from "./RetailFeatureFlagService.js";

const DEFAULT_TZ = "America/Sao_Paulo";

/** Offset (min) em que o horário LOCAL da tz está à frente do UTC, no instante. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: any = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - instant.getTime()) / 60000);
}

/** Instante UTC do horário de PAREDE local (y,mo,d 00:00) numa timezone IANA. */
function zonedMidnightToUtc(y: number, mo: number, d: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const off1 = tzOffsetMinutes(new Date(guess), timeZone);
  let utc = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(utc), timeZone);
  if (off2 !== off1) utc = guess - off2 * 60000; // reajuste na virada de DST
  return new Date(utc);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BusinessTimeService {
  /** Timezone IANA da org (coluna aditiva `organization_settings.timezone`); fallback SP. */
  static timezoneFor(orgId: string): string {
    try {
      const row = db.prepare(`SELECT timezone FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      const tz = row?.timezone ? String(row.timezone).trim() : "";
      // valida a tz antes de usar (Intl lança em tz inválida)
      if (tz) { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; }
    } catch { /* tz inválida/coluna ausente → fallback */ }
    return DEFAULT_TZ;
  }

  /** Data comercial (YYYY-MM-DD) no fuso da org para o instante dado (default: agora).
   *  Kill-switch Fase 6B: com `retail_business_date_v1 = 0`, volta ao UTC (legado
   *  pré-Fatia 1A) — usado só se a correção de fuso precisar ser revertida no
   *  piloto. É o choke point: `writeDay`/`context` derivam daqui. */
  static businessDate(orgId: string, now: Date = new Date()): string {
    if (!RetailFeatureFlagService.businessDateV1(orgId)) {
      return now.toISOString().slice(0, 10); // legado: dia UTC (RN-TIME revertida)
    }
    const tz = this.timezoneFor(orgId);
    // en-CA formata como YYYY-MM-DD; timeZone faz a conversão de fuso.
    return now.toLocaleDateString("en-CA", { timeZone: tz });
  }

  /** Janela UTC [início, fim) do dia comercial `day` (YYYY-MM-DD) no fuso da org. */
  static dayBounds(orgId: string, day: string): { startUtc: string; endUtc: string } {
    if (!DATE_RE.test(String(day || ""))) throw new Error("day inválido (YYYY-MM-DD).");
    const tz = this.timezoneFor(orgId);
    const [y, mo, d] = day.split("-").map(Number);
    const start = zonedMidnightToUtc(y, mo, d, tz);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    // recomputa o fim como meia-noite local do dia seguinte (absorve DST)
    const next = new Date(start.getTime() + 26 * 3600 * 1000); // seguramente no dia D+1
    const nl = next.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number);
    const endLocal = zonedMidnightToUtc(nl[0], nl[1], nl[2], tz);
    return { startUtc: start.toISOString(), endUtc: (isNaN(endLocal.getTime()) ? end : endLocal).toISOString() };
  }

  /** Contexto comercial para o bootstrap/consulta do cliente. */
  static context(orgId: string, now: Date = new Date()): { timezone: string; businessDate: string; serverNow: string } {
    return { timezone: this.timezoneFor(orgId), businessDate: this.businessDate(orgId, now), serverNow: now.toISOString() };
  }

  /**
   * Resolve o `day` a usar numa OPERAÇÃO de escrita do dia atual (boleta):
   * o servidor SEMPRE determina a data comercial; ignora o `day` do cliente
   * (TIME-003 — o cliente não lança em outro dia mudando o payload).
   */
  static writeDay(orgId: string, now: Date = new Date()): string {
    return this.businessDate(orgId, now);
  }
}

export default BusinessTimeService;
