import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Add-ons contratáveis (ADR-091 §5, Bloco D). Um add-on é um MÓDULO acima do
 * teto do plano que a org contrata avulso (cobrança mensal). Contratar estende
 * o teto de módulos do plano (PlanService.modulesForPlan une os add-ons ativos).
 *
 * Preços seguem a regra anti-canibalização do ADR (§112): 2 add-ons no mesmo
 * tier custam mais que o plano de cima — o dono é levado a considerar o upgrade.
 *
 * Decoupled (lê o db direto): PlanService importa AddonService, nunca o contrário.
 * A cobrança real (fatura mensal via ASAAS) é plugada quando o Bloco B estiver
 * ligado; aqui só registramos a contratação (modo beta/mock).
 */
export class AddonService {
  // Add-ons disponíveis por plano (chave = módulo). ADR-091 §5.
  static ADDON_CATALOG: Record<string, { key: string; price: number }[]> = {
    start: [
      { key: "reservas", price: 800 },
      { key: "assinaturas", price: 800 },
      { key: "orcamentos", price: 800 },
      { key: "estudio", price: 900 },
      { key: "cadencias", price: 800 },
    ],
    growth: [
      { key: "compras", price: 1500 },
      { key: "eventos", price: 1500 },
      { key: "radar", price: 1800 },
      { key: "retail", price: 2000 },
    ],
    scale: [
      { key: "vms", price: 3500 },
      { key: "clinica", price: 3000 },
      { key: "prospect", price: 3500 },
    ],
  };

  private static planId(orgId: string): string | undefined {
    return (db.prepare(`SELECT plan_id FROM organization_settings WHERE organization_id = ?`).get(orgId) as any)?.plan_id;
  }

  private static catalogFor(orgId: string): { key: string; price: number }[] {
    return this.ADDON_CATALOG[this.planId(orgId) || ""] || [];
  }

  /** Módulos de add-ons ATIVOS da org (usado por PlanService.modulesForPlan). */
  static activeModules(orgId: string): string[] {
    return (db.prepare(`SELECT addon_key FROM org_addons WHERE organization_id = ? AND status = 'active'`).all(orgId) as any[]).map(r => r.addon_key);
  }

  static isActive(orgId: string, key: string): boolean {
    return !!db.prepare(`SELECT 1 FROM org_addons WHERE organization_id = ? AND addon_key = ? AND status = 'active'`).get(orgId, key);
  }

  /** Catálogo p/ a UI: disponíveis (do plano, não contratados) + ativos. */
  static list(orgId: string) {
    const active = (db.prepare(`SELECT addon_key AS key, price, created_at AS since FROM org_addons WHERE organization_id = ? AND status = 'active'`).all(orgId) as any[]);
    const activeKeys = new Set(active.map(a => a.key));
    const available = this.catalogFor(orgId).filter(c => !activeKeys.has(c.key));
    return { available, active };
  }

  /** Contrata um add-on (valida que pertence ao catálogo do plano). Idempotente. */
  static contract(orgId: string, key: string): { ok: boolean; reason?: string; price?: number } {
    const item = this.catalogFor(orgId).find(c => c.key === key);
    if (!item) return { ok: false, reason: "Add-on indisponível para o seu plano." };
    if (this.isActive(orgId, key)) return { ok: true, price: item.price };
    db.prepare(`INSERT INTO org_addons (id, organization_id, addon_key, price, status) VALUES (?, ?, ?, ?, 'active')`).run(uuidv4(), orgId, key, item.price);
    return { ok: true, price: item.price };
  }

  /** Cancela um add-on ativo (o módulo perde acesso pelo teto no próximo isEnabled). */
  static cancel(orgId: string, key: string): { ok: boolean } {
    db.prepare(`UPDATE org_addons SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND addon_key = ? AND status = 'active'`).run(orgId, key);
    return { ok: true };
  }
}
