/**
 * ClientQuietHoursGuardService (ADR-169 F5-transversal-B / BEAUTY-011b) —
 * gate transversal de JANELA SILENCIOSA antes de disparar comunicação
 * outbound pra CLIENTES.
 *
 * ONDE ENTRA: `MessageProviderService.sendMessage` — o mesmo sink canônico
 * onde o guard de consent (F5-transversal-A) já roda. A ordem é:
 *
 *   1. `OutboundConsentGuardService.evaluate` (LGPD Art.14)
 *   2. `ClientQuietHoursGuardService.evaluate` (respeito ao descanso)
 *   3. fetch pro provider (WA Cloud/Evolution/Instagram)
 *
 * Cada guard é INDEPENDENTE (compõem por E lógico); a ordem é: consent primeiro
 * porque "não pode falar" é mais duro que "pode mas não agora".
 *
 * POR QUE UM GUARD ≠ UxPreferences: `UxPreferencesService.isAwake` já modela
 * quiet-hours (ADR-163 F13), MAS pra o DONO — é o intervalo em que o dono
 * quer/não quer receber PUSH. Esta fatia é pra o CLIENTE — o intervalo em
 * que NÃO devemos incomodar a cliente cadastrada no tenant. Semanticamente
 * é outra coisa: o dono pode querer receber alerta às 6h da manhã, mas isso
 * NÃO significa que a cliente pode receber lembrete às 6h da manhã. Data
 * diferente, política diferente, coluna diferente.
 *
 * POSTURA: OPT-IN + 0-REGRESSÃO. Flag `client_quiet_hours_enforced` default 0.
 * Sem a flag, o guard SEMPRE PERMITE. Nenhum caller existente muda de
 * comportamento sem o dono ligar a chave. Ativada, a janela default é
 * 22h→8h (SP TZ) — cobre o "não me incomode de madrugada". Dono pode
 * customizar `client_quiet_hours_start_hour` / `client_quiet_hours_end_hour`.
 *
 * JANELA COM VIRADA DE MEIA-NOITE: `start > end` (ex.: 22→8) é o CASO NORMAL.
 * `start < end` (ex.: 8→22) inverte — quiet DURANTE o dia (raro, mas
 * suportado; ex.: SPA fechado 8h-22h). `start == end` = 24h silêncio
 * (efetivamente pausa TODOS os envios; caller deve entender isso como
 * "estou em férias"). Mesma matemática que `UxPreferencesService.isAwake`,
 * invertida.
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-11 (nunca infere): sem valor customizado, usa default explícito
 *    (22, 8) — nunca "chuta" janela por vertical.
 *  - RN-BS-12 (autopilot nunca vai direto pra GA): guard é o freio automático
 *    pra follow-ups da F11+. Autopilot que respeita quiet-hours é mais aceito
 *    pelas clientes.
 *  - Isolamento por org (RN-BS-07): flag e horas lidas da MESMA org do canal.
 *
 * NÃO SILENCIA CRÍTICO: o guard vive no sink OUTBOUND — se um caller quiser
 * de fato bipassar (mensagem CRÍTICA operacional, ex.: "sua reserva foi
 * CANCELADA agora"), o padrão é o caller NÃO chamar sendMessage e usar
 * outro canal (email/push interno). Bipassar aqui de código violaria o
 * princípio "sink único = política única". Se surgir um caller legítimo
 * (nunca surgiu ainda), documentamos o critério aqui — não hoje.
 *
 * TESTABILIDADE: `evaluate(orgId, now?)` aceita `now` opcional pra testes
 * determinísticos (fixa a hora sem esperar meia-noite passar). Em produção,
 * `now` = `new Date()` implícito.
 */
import db from "./db.js";

// Defaults do sistema: madrugada silenciosa (22h→8h SP).
export const CLIENT_QUIET_DEFAULT_START_HOUR = 22;
export const CLIENT_QUIET_DEFAULT_END_HOUR = 8;

export type QuietGuardDecision =
  | { allow: true; reason: "flag_off" | "outside_quiet_window"; hourSP: number }
  | { allow: false; reason: "within_quiet_window"; hourSP: number; startHour: number; endHour: number };

/** Hora SP (0-23) determinística pra teste — espelha `FalaTuBriefingDigestService.spParts`. */
function spHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value || 0);
}

/** `[start, end)` em horas, cross-midnight aware. `start==end` = 24h dentro. */
function withinWindow(hour: number, start: number, end: number): boolean {
  const h = Math.trunc(hour);
  if (start === end) return true;                    // 24h silêncio
  if (start < end) return h >= start && h < end;     // janela normal (ex.: 8..22)
  return h >= start || h < end;                      // janela cruza meia-noite (ex.: 22..8)
}

export class ClientQuietHoursGuardService {
  /**
   * Decide se pode enviar agora à cliente. Determinístico, síncrono, sem
   * side-effect. Aceita `now` opcional pra teste.
   */
  static evaluate(orgId: string, now: Date = new Date()): QuietGuardDecision {
    const hourSP = spHour(now);
    if (!this.isEnabled(orgId)) {
      return { allow: true, reason: "flag_off", hourSP };
    }
    const { startHour, endHour } = this.effectiveWindow(orgId);
    if (withinWindow(hourSP, startHour, endHour)) {
      return {
        allow: false,
        reason: "within_quiet_window",
        hourSP,
        startHour,
        endHour,
      };
    }
    return { allow: true, reason: "outside_quiet_window", hourSP };
  }

  /** A flag `client_quiet_hours_enforced` está ligada nesta org? */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(
          `SELECT client_quiet_hours_enforced FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { client_quiet_hours_enforced?: number } | undefined;
      return Number(r?.client_quiet_hours_enforced || 0) === 1;
    } catch {
      return false;
    }
  }

  /** Liga/desliga a flag. Idempotente. */
  static setEnabled(orgId: string, enabled: boolean): void {
    db.prepare(
      `UPDATE organization_settings SET client_quiet_hours_enforced = ? WHERE organization_id = ?`,
    ).run(enabled ? 1 : 0, orgId);
  }

  /**
   * Janela efetiva pra esta org (custom OU default). `startHour`/`endHour`
   * são 0-23; a semântica é `[start, end)` com virada de meia-noite quando
   * `start > end` (o caso comum 22→8).
   */
  static effectiveWindow(orgId: string): {
    startHour: number;
    endHour: number;
    source: "default" | "custom";
  } {
    try {
      const r = db
        .prepare(
          `SELECT client_quiet_hours_start_hour s, client_quiet_hours_end_hour e
             FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { s?: number | null; e?: number | null } | undefined;
      const s = r?.s;
      const e = r?.e;
      const hasCustom = s != null || e != null;
      return {
        startHour: s != null ? Number(s) : CLIENT_QUIET_DEFAULT_START_HOUR,
        endHour: e != null ? Number(e) : CLIENT_QUIET_DEFAULT_END_HOUR,
        source: hasCustom ? "custom" : "default",
      };
    } catch {
      return {
        startHour: CLIENT_QUIET_DEFAULT_START_HOUR,
        endHour: CLIENT_QUIET_DEFAULT_END_HOUR,
        source: "default",
      };
    }
  }

  /**
   * Ajusta a janela. `null` explícito volta pro default (undo idempotente).
   * Valida 0-23 em cada hora.
   */
  static setWindow(
    orgId: string,
    input: { startHour?: number | null; endHour?: number | null },
  ): void {
    const sets: string[] = [];
    const params: any[] = [];
    if ("startHour" in input) {
      const h = normalizeHour(input.startHour);
      sets.push("client_quiet_hours_start_hour = ?");
      params.push(h);
    }
    if ("endHour" in input) {
      const h = normalizeHour(input.endHour);
      sets.push("client_quiet_hours_end_hour = ?");
      params.push(h);
    }
    if (!sets.length) return;
    params.push(orgId);
    db.prepare(
      `UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`,
    ).run(...params);
  }
}

function normalizeHour(v: number | null | undefined): number | null {
  if (v == null || v === ("" as any)) return null;
  const n = Math.trunc(Number(v));
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    throw new Error("Hora deve ser inteiro 0-23 ou null.");
  }
  return n;
}

/**
 * Erro específico pro sink. `code` tipada pro caller detectar e degradar
 * (marcar delivery como `blocked_quiet_hours` em vez de `failed`). Inclui
 * `hourSP` + janela pra observability.
 */
export class OutboundQuietHoursError extends Error {
  code: string;
  hourSP: number;
  startHour: number;
  endHour: number;
  constructor(hourSP: number, startHour: number, endHour: number) {
    super(
      `Envio bloqueado por janela silenciosa (hora SP=${hourSP}h, janela ${startHour}h→${endHour}h). Reenvie após a janela.`,
    );
    this.name = "OutboundQuietHoursError";
    this.code = "outbound_blocked:quiet_hours";
    this.hourSP = hourSP;
    this.startHour = startHour;
    this.endHour = endHour;
  }
}

export default ClientQuietHoursGuardService;
