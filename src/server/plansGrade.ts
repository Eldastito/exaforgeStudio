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
const ENTERPRISE = [...SCALE, "vms", "clinica", "prospect", "advocacia", "escola"];

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
 * ADR-153 F2.2 — Bundles verticais (produtos "prontos" pra nicho).
 *
 * Um bundle é uma OFERTA COMERCIAL pré-composta: `plano base + add-ons +
 * blueprint hint`. Serve pra vender pra nichos onde o plano genérico não
 * inclui o módulo central da vertical (ex.: Clínica só existe em Enterprise
 * hoje, mas o público-alvo de Clínica não paga Enterprise — bundle Growth +
 * Clínica resolve o mismatch comercial identificado no PRD §10.3).
 *
 * Decisão #5 aprovada (Opção A): bundle `Growth + Clínica`. Add-on Clínica
 * hoje mora em ADDON_CATALOG.scale (R$3000); no bundle o preço agregado é
 * R$3500 (bundle discount ~27% vs comprar avulso: R$1797 growth + R$3000
 * clinica add-on ao Scale = R$4797). Preço final ajustável pelo Master Admin
 * via plans table quando F5 ligar o checkout real.
 *
 * F5.2 (SubscriptionOrchestratorService) vai orquestrar a compra:
 *   1. Cria assinatura Asaas no `basePlan` (com valor do bundle).
 *   2. Grava `org_addons` pra cada addon do bundle.
 *   3. Chama ModuleService.enableModule pra cada addon (idempotente).
 *   4. Grava origem em `subscription_change_requests` com bundle_key.
 *
 * F1.3+ (frontend): a aba "Plano e Expansões" (placeholder da fatia F1.3)
 * vai listar `bundles` do GET /api/plans junto dos `plans` genéricos.
 *
 * `verticalHints` guia o onboarding: quando dono escolhe vertical `saude`,
 * o wizard sugere o bundle recomendado (F3.2 + F8 rollout).
 */
export type PlanBundle = {
  key: string;
  name: string;
  description: string;
  basePlan: string;             // id em PLAN_GRADE
  addons: string[];             // module keys (mesmo namespace do AddonService)
  priceMonthly: number;         // R$ mensal (bundle discount aplicado)
  priceAnnualMonth: number | null;
  verticalHints: string[];      // verticais recomendadas (usa no onboarding)
  bundleDiscount: {             // pra UX explicar o desconto no checkout
    avulsoTotal: number;        // basePlan.price + soma dos addons avulsos
    savingsMonthly: number;     // avulsoTotal - priceMonthly
    savingsPercent: number;     // arredondado
  };
};

export const PLAN_BUNDLES: PlanBundle[] = [
  {
    key: "growth_clinica",
    name: "Growth + Clínica",
    description:
      "Bundle recomendado para clínicas multiespecialidade E petshops/veterinárias — plano Growth (cadências, assinaturas, Diretor IA, RIE) + módulo Clínica (agenda clínica, prontuário, portal do paciente; no petshop dá corpo à parte veterinária: cirurgia, internação, banho & tosa) incluído.",
    basePlan: "growth",
    addons: ["clinica"],
    priceMonthly: 3500,
    priceAnnualMonth: 2997,
    // `petshop` consome o MÓDULO `clinica` (parte veterinária) igual `saude` —
    // sem este hint, um petshop no Growth ficaria sem caminho pro módulo central
    // da própria vertical (mesmo mismatch comercial que motivou o bundle). §10.3.
    verticalHints: ["saude", "petshop"],
    bundleDiscount: {
      // Growth (1797) + addon Clinica normal (Scale-tier R$3000) = 4797 avulso
      avulsoTotal: 4797,
      savingsMonthly: 1297,       // 4797 - 3500
      savingsPercent: 27,         // arred.
    },
  },
  {
    // Mesma tese comercial da Clínica (PRD §10.3): o público-alvo de Escola
    // (escolas/cursos) raramente paga Enterprise, então Growth + add-on Escola
    // resolve o mismatch. Números espelham `growth_clinica` (add-on Escola no
    // Scale = R$3000). Preço final ajustável pelo Master Admin.
    key: "growth_escola",
    name: "Growth + Escola",
    description:
      "Bundle recomendado para escolas e cursos — plano Growth (cadências, assinaturas, Diretor IA, RIE) + módulo Escola (secretaria virtual, resumo diário à família, professores e extracurriculares) incluído.",
    basePlan: "growth",
    addons: ["escola"],
    priceMonthly: 3500,
    priceAnnualMonth: 2997,
    verticalHints: ["educacao"],
    bundleDiscount: {
      avulsoTotal: 4797,          // Growth (1797) + addon Escola (Scale-tier R$3000)
      savingsMonthly: 1297,       // 4797 - 3500
      savingsPercent: 27,
    },
  },
  {
    // Idem para Advocacia: escritórios não pagam Enterprise, Growth + add-on
    // Advocacia resolve. Números espelham `growth_clinica`. Ajustável no Master.
    key: "growth_advocacia",
    name: "Growth + Advocacia",
    description:
      "Bundle recomendado para escritórios de advocacia — plano Growth (cadências, assinaturas, Diretor IA, RIE) + módulo Advocacia (processos, prazos em dias úteis, audiências, documentos e honorários) incluído.",
    basePlan: "growth",
    addons: ["advocacia"],
    priceMonthly: 3500,
    priceAnnualMonth: 2997,
    verticalHints: ["advocacia"],
    bundleDiscount: {
      avulsoTotal: 4797,          // Growth (1797) + addon Advocacia (Scale-tier R$3000)
      savingsMonthly: 1297,       // 4797 - 3500
      savingsPercent: 27,
    },
  },
];

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
