/**
 * Retail Network Ops — Ativação opt-in (ADR-084 D2, Fatia 2).
 *
 * O par do "corte" da Fatia 1: aquela removeu o auto-on de `retail` do preset de
 * varejo; esta dá o "liga explícito". Habilita o módulo `retail` e liga as
 * automações operacionais (`retail_*`) nos defaults já estabelecidos — sem
 * decisão nova: são os mesmos valores que o Quick-Start usava antes do corte.
 *
 * NÃO cadastra lojas/cotas nem semeia áreas (isso é configuração/onboarding à
 * parte). Só liga a capacidade. Idempotente e isolado por organização.
 */
import db from "./db.js";
import { ModuleService } from "./ModuleService.js";
import { logAuthEvent } from "./auditLog.js";

// Flags de automação do Retail Ops, ligadas na ativação. due_hour/retry_minutes
// ficam nos defaults da coluna (21h / 30min) e não são forçados aqui, para não
// sobrescrever um ajuste que a org já tenha feito.
const RETAIL_AUTOMATION_FLAGS = [
  "retail_daily_closing_enabled",
  "retail_malote_enabled",
  "retail_scale_reminder_enabled",
  "retail_quota_enabled",
  "retail_stock_negative_alert_enabled",
  "retail_commission_enabled",
  "retail_monthly_close_enabled",
];

export class RetailActivationService {
  /** Liga o Retail Network Ops para a org (módulo + automações). Idempotente. */
  static activate(orgId: string, actorId?: string): { active: boolean; modules: string[]; automations: Record<string, number> } {
    const modules = ModuleService.enableModule(orgId, "retail");
    const cols = RETAIL_AUTOMATION_FLAGS.map((c) => `${c} = 1`).join(", ");
    db.prepare(`UPDATE organization_settings SET ${cols} WHERE organization_id = ?`).run(orgId);
    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_OPS_ACTIVATED", {}); } catch { /* noop */ }
    return this.status(orgId);
  }

  /** Desliga as automações do Retail Ops (mantém o módulo/dados). Idempotente. */
  static deactivate(orgId: string, actorId?: string): { active: boolean; modules: string[]; automations: Record<string, number> } {
    const cols = RETAIL_AUTOMATION_FLAGS.map((c) => `${c} = 0`).join(", ");
    db.prepare(`UPDATE organization_settings SET ${cols} WHERE organization_id = ?`).run(orgId);
    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_OPS_DEACTIVATED", {}); } catch { /* noop */ }
    return this.status(orgId);
  }

  /** Situação atual: módulo habilitado + estado das automações. */
  static status(orgId: string): { active: boolean; modules: string[]; automations: Record<string, number> } {
    const moduleOn = ModuleService.isEnabled(orgId, "retail");
    const row = (db.prepare(
      `SELECT ${RETAIL_AUTOMATION_FLAGS.join(", ")} FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any) || {};
    const automations: Record<string, number> = {};
    for (const c of RETAIL_AUTOMATION_FLAGS) automations[c] = Number(row[c] || 0);
    const anyAutomation = Object.values(automations).some((v) => v === 1);
    return { active: moduleOn && anyAutomation, modules: ModuleService.enabledModules(orgId) || [], automations };
  }
}
