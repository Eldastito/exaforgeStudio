import db from "./db.js";
import { randomUUID } from "crypto";
import { PermissionService } from "./PermissionService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";

/**
 * BriefingService (Epic 3 — Fatia 4, ADR-139 / PRD §14).
 *
 * Preferências de briefing por (org, usuário) — canal, horário, dias, domínios
 * permitidos, modo — e a montagem do briefing matinal, curto e DETERMINÍSTICO:
 *   - no máximo 3 prioridades (reusa `ImpactPrioritizationService`);
 *   - respeita os domínios permitidos e o RBAC — usuário SEM permissão
 *     financeira NÃO recebe caixa/DRE/retiradas nas prioridades nem no rodapé
 *     (aceite do PRD);
 *   - entrega IDEMPOTENTE por `dedupe_key` (o reenvio do Scheduler não duplica).
 * Não envia nada — devolve o texto e registra a entrega; quem envia é o
 * Scheduler/webhook (fatia de wiring). Isolado por organization_id.
 */

const brl = (n: any) => `R$ ${(Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const FINANCE_DOMAINS = new Set(["finance", "financeiro"]);

export interface BriefingPrefs {
  enabled: boolean; channel: string; morningTime: string; days: number[] | null; domains: string[] | null; mode: string;
}

export class BriefingService {
  private static DEFAULTS: BriefingPrefs = { enabled: true, channel: "whatsapp", morningTime: "08:00", days: null, domains: null, mode: "gestor" };

  static getPrefs(orgId: string, userId: string): BriefingPrefs {
    const r = db.prepare("SELECT * FROM briefing_preferences WHERE organization_id = ? AND user_id = ?").get(orgId, userId) as any;
    if (!r) return { ...this.DEFAULTS };
    return {
      enabled: !!Number(r.enabled), channel: r.channel || "whatsapp", morningTime: r.morning_time || "08:00",
      days: r.days_json ? safeArr(r.days_json) : null, domains: r.domains_json ? safeArr(r.domains_json) : null, mode: r.mode || "gestor",
    };
  }

  /** Upsert das preferências (só os campos informados). */
  static setPrefs(orgId: string, userId: string, patch: Partial<BriefingPrefs>): BriefingPrefs {
    const cur = this.getPrefs(orgId, userId);
    const next: BriefingPrefs = { ...cur, ...patch };
    const exists = db.prepare("SELECT id FROM briefing_preferences WHERE organization_id = ? AND user_id = ?").get(orgId, userId) as any;
    const days = next.days ? JSON.stringify(next.days) : null;
    const domains = next.domains ? JSON.stringify(next.domains) : null;
    if (exists) {
      db.prepare("UPDATE briefing_preferences SET enabled=?, channel=?, morning_time=?, days_json=?, domains_json=?, mode=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(next.enabled ? 1 : 0, next.channel, next.morningTime, days, domains, next.mode, exists.id);
    } else {
      db.prepare("INSERT INTO briefing_preferences (id, organization_id, user_id, enabled, channel, morning_time, days_json, domains_json, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, userId, next.enabled ? 1 : 0, next.channel, next.morningTime, days, domains, next.mode);
    }
    return next;
  }

  /** O briefing deve sair neste dia da semana? (1=segunda … 7=domingo) */
  static scheduledForDay(prefs: BriefingPrefs, isoWeekday: number): boolean {
    if (!prefs.enabled) return false;
    if (!prefs.days || prefs.days.length === 0) return true;
    return prefs.days.includes(isoWeekday);
  }

  /**
   * Monta o briefing matinal para um usuário (≤3 prioridades), respeitando
   * domínios permitidos e RBAC financeiro. `user` traz role/perfil.
   */
  static buildMorning(orgId: string, user: any): { text: string; priorityCount: number } {
    const prefs = this.getPrefs(orgId, user?.userId || user?.id);
    const canFinance = PermissionService.can(orgId, user, "financeiro", "read");
    const allowed = prefs.domains && prefs.domains.length ? new Set(prefs.domains) : null;

    const all = ImpactPrioritizationService.prioritize(orgId)?.global || [];
    const filtered = all.filter((p: any) => {
      if (allowed && !allowed.has(p.domain)) return false;
      if (FINANCE_DOMAINS.has(p.domain) && !canFinance) return false; // sem permissão → não recebe finanças
      return true;
    }).slice(0, 3);

    const name = String(user?.name || "").trim().split(/\s+/)[0] || "";
    const lines: string[] = [`☀️ *Bom dia${name ? `, ${name}` : ""}!* Seu resumo de hoje:`];
    if (filtered.length) {
      lines.push("", "*Prioridades:*");
      filtered.forEach((p: any, i: number) => {
        const imp = p.impact ? ` (${p.impact.unit === "BRL" ? brl(p.impact.amount) : `${p.impact.amount} ${p.impact.unit || ""}`.trim()})` : "";
        lines.push(`${i + 1}. ${p.recommendedAction}${imp}`);
      });
    } else {
      lines.push("", "Nada urgente hoje — sob controle. 👍");
    }
    // Rodapé financeiro só para quem tem permissão (aceite do PRD).
    if (canFinance) {
      const s = FinancialLedgerService.summary(orgId);
      lines.push("", `💰 Caixa ${brl(s.caixaAtual)} · a receber ${brl(s.aReceber)} · a pagar ${brl(s.aPagar)}`);
    }
    return { text: lines.join("\n"), priorityCount: filtered.length };
  }

  /**
   * Registra (idempotente) a entrega de um briefing. Devolve `deduped:true` se
   * já houve entrega para o mesmo (org, usuário, slot, dia) — sem regerar/reenviar.
   */
  static deliver(orgId: string, user: any, slot: string, refDate: string): { delivered: boolean; deduped: boolean; text?: string } {
    const userId = user?.userId || user?.id;
    const dedupeKey = `${userId}:${slot}:${refDate}`;
    const existing = db.prepare("SELECT id FROM briefing_delivery WHERE organization_id = ? AND dedupe_key = ?").get(orgId, dedupeKey) as any;
    if (existing) return { delivered: false, deduped: true };
    const { text } = slot === "morning" ? this.buildMorning(orgId, user) : { text: "" };
    try {
      db.prepare("INSERT INTO briefing_delivery (id, organization_id, user_id, slot, ref_date, dedupe_key, text_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, userId, slot, refDate, dedupeKey, text);
    } catch {
      return { delivered: false, deduped: true }; // corrida com a UNIQUE
    }
    return { delivered: true, deduped: false, text };
  }
}

function safeArr(s: string): any[] | null { try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; } }

export default BriefingService;
