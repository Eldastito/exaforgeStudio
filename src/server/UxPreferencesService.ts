/**
 * UxPreferencesService — PRD 6 / ADR-163 F13 (§53/§68, D7): preferências do dono.
 *
 * Fecha o ÚNICO gap de persistência genuíno que a F0 apontou (auditoria item 10):
 * a janela "acordado" (quiet hours) e o limiar de alerta eram CONSTANTES de código
 * no `FalaTuProactiveService` (AWAKE_START=7/AWAKE_END=22), não preferências. Aqui
 * viram colunas opt-in em `organization_settings` — NULL = usa o default do sistema
 * (0 regressão). Config conversacional (§54): set com preview/confirm implícito +
 * auditoria + undo (basta setar de volta).
 *
 * GUARDRAIL D7/RN-UX-4: nunca silencia o crítico. `isAwake`/`shouldAlert` só filtram
 * o proativo NÃO-crítico; o caller (proatividade) mantém a exceção pro urgente/crítico
 * (§45 já separa urgência). Isolado por org; auditável.
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

// Defaults do sistema (espelham as constantes históricas do FalaTuProactiveService).
export const DEFAULT_AWAKE_START = 7;   // 07h SP
export const DEFAULT_AWAKE_END = 22;    // 22h SP (exclusivo)

export interface UxPreferences {
  // Janela "acordado" [awakeStart, awakeEnd) em hora SP — fora dela é quiet hours.
  awakeStart: number; awakeEnd: number; alertMinAmount: number;
  source: "default" | "custom";
}

function clampHour(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : NaN as any;
}

export class UxPreferencesService {
  /** Preferências efetivas (com fallback pro default do sistema). */
  static effective(orgId: string): UxPreferences {
    const r = db.prepare(
      `SELECT proactive_awake_start s, proactive_awake_end e, alert_min_amount a FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any || {};
    const hasCustom = r.s != null || r.e != null || r.a != null;
    return {
      awakeStart: r.s != null ? Number(r.s) : DEFAULT_AWAKE_START,
      awakeEnd: r.e != null ? Number(r.e) : DEFAULT_AWAKE_END,
      alertMinAmount: r.a != null ? Number(r.a) : 0,
      source: hasCustom ? "custom" : "default",
    };
  }

  /**
   * Grava as preferências informadas (só as presentes; o resto fica). Valida forma
   * (hora 0-23; limiar ≥ 0). Auditável. `null` explícito volta ao default (undo, §54).
   */
  static set(orgId: string, actorId: string | undefined, input: { awakeStart?: number | null; awakeEnd?: number | null; alertMinAmount?: number | null }): UxPreferences {
    const sets: string[] = [];
    const params: any[] = [];
    if ("awakeStart" in input) {
      const h = clampHour(input.awakeStart);
      if (Number.isNaN(h as any)) throw new Error("awakeStart deve ser hora 0-23 ou null.");
      sets.push("proactive_awake_start = ?"); params.push(h);
    }
    if ("awakeEnd" in input) {
      const h = clampHour(input.awakeEnd);
      if (Number.isNaN(h as any)) throw new Error("awakeEnd deve ser hora 0-23 ou null.");
      sets.push("proactive_awake_end = ?"); params.push(h);
    }
    if ("alertMinAmount" in input) {
      let a: number | null = null;
      if (input.alertMinAmount != null && input.alertMinAmount !== ("" as any)) {
        a = Number(input.alertMinAmount);
        if (!(a >= 0)) throw new Error("alertMinAmount deve ser ≥ 0 ou null.");
      }
      sets.push("alert_min_amount = ?"); params.push(a);
    }
    if (!sets.length) return this.effective(orgId);
    params.push(orgId);
    db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...params);
    const eff = this.effective(orgId);
    logAuthEvent(orgId, actorId, null, "UX_PREFERENCES_UPDATED", { awakeStart: eff.awakeStart, awakeEnd: eff.awakeEnd, alertMinAmount: eff.alertMinAmount });
    return eff;
  }

  /**
   * A hora SP está na janela "acordado"? Trata virada de meia-noite (start>end).
   * start==end → 24h acordado (sem quiet hours). Quiet = !isAwake.
   */
  static isAwake(orgId: string, hourSP: number): boolean {
    const { awakeStart: start, awakeEnd: end } = this.effective(orgId);
    const h = Math.trunc(hourSP);
    if (start === end) return true;                 // sem janela de silêncio
    if (start < end) return h >= start && h < end;  // janela normal (ex.: 7..22)
    return h >= start || h < end;                   // janela cruza a meia-noite
  }

  /** Um alerta de valor `amount` passa o limiar do dono? Sem valor → sempre passa. */
  static shouldAlert(orgId: string, amount: number | null | undefined): boolean {
    if (amount == null) return true;                // alerta não-financeiro nunca é filtrado por limiar
    return Math.abs(Number(amount)) >= this.effective(orgId).alertMinAmount;
  }
}

export default UxPreferencesService;
