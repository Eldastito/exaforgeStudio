/**
 * Grade de planos ZappFlow (ADR-091 + ADR-153). Fonte única da verdade dos 5
 * tiers comerciais + a migração idempotente das orgs que estavam na grade
 * antiga (Starter/Pro/Business → Autônomo/Growth/Scale).
 *
 * Regra de módulos (ADR-091 §2 + ADR-092): cada tier HERDA o de baixo e adiciona.
 * `features.modules` é o TETO do plano — `ModuleService.isEnabled` intersecciona
 * isso com os módulos ligados pela vertical/dono.
 *
 * ADR-153 F2.1 (Decisão #1): `copiloto` (Comigo) é AGORA persistente em TODOS os
 * planos, não mais exclusivo do Autônomo. Motivação: upgrade Autônomo→Start
 * removia silenciosamente o balcão de peixaria/chaveiro, violando G-153-2
 * ("upgrade nunca remove capacidade"). O plano Autônomo continua sendo o
 * "produto Comigo" comercial; nos superiores o Comigo fica como capability
 * base (útil pra multi-branch: matriz + subsidiárias podem usar).
 *
 * `valor` (Painel de Valor Gerado) entra no Scale+.
 *
 * Limites (§3): ai_monthly_limit / contacts_limit / channels_limit / users_limit.
 * Valor 0 = sem trava (Enterprise é negociado). trial_days = 30 em toda a grade.
 * `price` é o mensal; `price_annual_month` é o equivalente mensal no plano anual.
 */

const AUTONOMO = ["catalogo", "agenda", "vendas", "pagamentos", "integracoes", "loja", "copiloto"];
// ADR-153 F2.1: START/GROWTH/SCALE/ENTERPRISE agora herdam AUTONOMO (via spread)
// pra garantir `copiloto` presente em TODOS os planos — impede que upgrade
// remova o balcão de negócios que dependem dele (peixaria, chaveiro, autônomos).
const START = [...AUTONOMO, "campanhas", "areas", "diretor"];
const GROWTH = [...START, "cadencias", "assinaturas", "orcamentos", "reservas", "estudio"];
const SCALE = [...GROWTH, "compras", "eventos", "rie", "execucao", "radar", "retail", "valor"];
const ENTERPRISE = [...SCALE, "vms", "clinica", "prospect"];

export type PlanGradeRow = {
  id: string;
  name: string;
  price: number;
  features: {
    ai_monthly_limit: number;
    contacts_limit: number;
    channels_limit: number;
    users_limit: number;
    trial_days: number;
    price_annual_month: number | null;
    modules: string[];
  };
};

export const PLAN_GRADE: PlanGradeRow[] = [
  { id: "autonomo", name: "Autônomo", price: 247, features: { ai_monthly_limit: 500, contacts_limit: 1000, channels_limit: 1, users_limit: 1, trial_days: 30, price_annual_month: 197, modules: AUTONOMO } },
  { id: "start", name: "Start", price: 597, features: { ai_monthly_limit: 3000, contacts_limit: 3000, channels_limit: 1, users_limit: 2, trial_days: 30, price_annual_month: 497, modules: START } },
  { id: "growth", name: "Growth", price: 1797, features: { ai_monthly_limit: 10000, contacts_limit: 10000, channels_limit: 3, users_limit: 5, trial_days: 30, price_annual_month: 1497, modules: GROWTH } },
  { id: "scale", name: "Scale", price: 4797, features: { ai_monthly_limit: 30000, contacts_limit: 50000, channels_limit: 10, users_limit: 20, trial_days: 30, price_annual_month: 3997, modules: SCALE } },
  { id: "enterprise", name: "Enterprise", price: 8000, features: { ai_monthly_limit: 0, contacts_limit: 0, channels_limit: 0, users_limit: 0, trial_days: 30, price_annual_month: null, modules: ENTERPRISE } },
];

/** Mapeamento da grade antiga → nova (ADR-091 §7, sem grandfathering). */
export const LEGACY_PLAN_MAP: Record<string, string> = {
  starter: "autonomo",
  pro: "growth",
  business: "scale",
};

/**
 * Aplica a grade nova de forma IDEMPOTENTE:
 *  1. Garante os 5 tiers (INSERT OR IGNORE — não sobrescreve edição do admin).
 *  2. Migra as orgs da grade antiga para a nova.
 *  3. Remove os planos legados (starter/pro/business) para a listagem só
 *     mostrar a grade nova (+ cortesia).
 * Recebe o handle do banco para evitar import circular com db.ts.
 */
export function applyPlanGrade(db: any): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`);
  for (const p of PLAN_GRADE) ins.run(p.id, p.name, p.price, JSON.stringify(p.features));

  const upd = db.prepare(`UPDATE organization_settings SET plan_id = ? WHERE plan_id = ?`);
  for (const [oldId, newId] of Object.entries(LEGACY_PLAN_MAP)) upd.run(newId, oldId);

  db.prepare(`DELETE FROM plans WHERE id IN ('starter', 'pro', 'business')`).run();
}
