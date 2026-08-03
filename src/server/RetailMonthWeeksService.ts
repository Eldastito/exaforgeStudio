/**
 * Retail Ops — Corte VARIÁVEL das semanas do mês (ADR-083 Fase G2c).
 *
 * A planilha CARIOCA corta a semana no domingo e cola o começo de mês < 4
 * dias na semana seguinte (RN-G2-003). Quando o cliente prefere cortes
 * diferentes ("sem1 01→10, sem2 11→18, sem3 19→25, sem4 26→31" pra alinhar
 * com a operação real), este serviço permite gravar o override por mês.
 *
 * Decisões:
 *  - **RN-G2c-001 — Override é REDE-WIDE.** A corrida CARIOCA cruza lojas
 *    (ranking de desvio, ranking semanal, campeões da rede), então cortes
 *    diferentes por loja quebrariam a apuração. UMA definição por mês vale
 *    pra rede toda.
 *  - **RN-G2c-002 — Fallback silencioso.** Sem override cadastrado, tudo
 *    continua como estava (RetailCommissionRaceService.weeksOfMonth), zero
 *    breaking change.
 *  - **RN-G2c-003 — Cobertura total obrigatória.** As semanas cadastradas
 *    precisam cobrir do dia 01 até o último dia do mês, sem lacunas e sem
 *    sobreposição. Validado no save.
 *  - Não é aditivo em cima do padrão: quando existe override, a lista
 *    cadastrada É a lista definitiva do mês. Isso mantém o modelo mental
 *    simples ("o que eu digitei = o que vale").
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type MonthWeek = { start: string; end: string };

function safeParse<T>(s: any): T | null { try { return JSON.parse(s ?? "null"); } catch { return null; } }
function lastDayOf(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export class RetailMonthWeeksService {
  /** Lê o override do mês, ou null se não configurado. */
  static getOverride(orgId: string, month: string): MonthWeek[] | null {
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    const row = db.prepare(
      `SELECT weeks_json FROM retail_month_weeks WHERE organization_id = ? AND year_month = ?`
    ).get(orgId, month) as any;
    const parsed = safeParse<MonthWeek[]>(row?.weeks_json);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  }

  /**
   * Valida e grava (ou APAGA, se `weeks` vazio) o override do mês.
   * Regras:
   *  - Cada entrada precisa ter start ≤ end e ambos no formato YYYY-MM-DD.
   *  - As entradas precisam ser contíguas e cobrir 01 até o último dia do mês.
   *  - Sem sobreposição (o `end` anterior + 1 == `start` seguinte).
   */
  static save(orgId: string, month: string, weeks: MonthWeek[], actorId?: string): MonthWeek[] {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    // Vazio => deleta o override (volta ao fallback).
    if (!Array.isArray(weeks) || weeks.length === 0) {
      db.prepare(`DELETE FROM retail_month_weeks WHERE organization_id = ? AND year_month = ?`).run(orgId, month);
      try { logAuthEvent(orgId, actorId || "system", month, "RETAIL_MONTH_WEEKS_CLEARED", { month }); } catch { /* noop */ }
      return [];
    }
    const clean: MonthWeek[] = [];
    for (const w of weeks) {
      const s = String(w?.start || "").slice(0, 10);
      const e = String(w?.end || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw new Error("cada semana precisa de start e end YYYY-MM-DD");
      if (!s.startsWith(month) || !e.startsWith(month)) throw new Error(`todas as datas precisam ser do mês ${month}`);
      if (s > e) throw new Error(`intervalo inválido: ${s} > ${e}`);
      clean.push({ start: s, end: e });
    }
    // Ordena e valida cobertura contígua.
    clean.sort((a, b) => a.start.localeCompare(b.start));
    const expectedStart = `${month}-01`;
    const expectedEnd = `${month}-${String(lastDayOf(month)).padStart(2, "0")}`;
    if (clean[0].start !== expectedStart) throw new Error(`primeira semana precisa começar em ${expectedStart}`);
    if (clean[clean.length - 1].end !== expectedEnd) throw new Error(`última semana precisa terminar em ${expectedEnd}`);
    for (let i = 1; i < clean.length; i++) {
      const prevEnd = new Date(Date.parse(clean[i - 1].end + "T00:00:00Z"));
      const nextExpected = new Date(prevEnd.getTime() + 86400000).toISOString().slice(0, 10);
      if (clean[i].start !== nextExpected) throw new Error(`lacuna ou sobreposição entre ${clean[i - 1].end} e ${clean[i].start} (esperado ${nextExpected})`);
    }
    // Upsert.
    const existing = db.prepare(`SELECT id FROM retail_month_weeks WHERE organization_id = ? AND year_month = ?`).get(orgId, month) as any;
    if (existing) {
      db.prepare(`UPDATE retail_month_weeks SET weeks_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(clean), existing.id);
    } else {
      db.prepare(`INSERT INTO retail_month_weeks (id, organization_id, year_month, weeks_json, created_by) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), orgId, month, JSON.stringify(clean), actorId || null);
    }
    try { logAuthEvent(orgId, actorId || "system", month, "RETAIL_MONTH_WEEKS_SAVED", { month, weeks: clean.length }); } catch { /* noop */ }
    return clean;
  }
}
