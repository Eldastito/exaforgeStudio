/**
 * Catálogo comercial do FalaTu (ADR-154 F2.2 — Fatia A da monetização B2C).
 *
 * Os 3 planos de assinatura self-serve do FalaTu — Solo / Pro / Família — como
 * registros REAIS na tabela `plans`, pra que o checkout (Fatia B) possa amarrar
 * `organization_settings.plan_id` a eles e o enforcement (Fatia C) leia a cota.
 *
 * ⚠️ SCAFFOLD — "planos que eu defino depois": os PREÇOS já são definitivos
 * (R$19/29/49), mas o que cada tier LIBERA (`falatu_features`), a COTA DE IA
 * (`ai_monthly_limit`) e o TRIAL (`trial_days`) são PLACEHOLDERS. Ajuste
 * `FALATU_PLANS` abaixo quando a definição comercial fechar. Esta fatia é só o
 * CATÁLOGO — não liga checkout nem muda enforcement.
 *
 * Ids namespaced `falatu_*` de propósito:
 *  - evita o `DELETE ... id IN ('starter','pro','business')` de applyPlanGrade
 *    (um plano cru `pro` seria apagado a cada boot);
 *  - deixa PlanService.listPlans() manter o catálogo B2C FORA do seletor B2B
 *    (filtro por prefixo), sem precisar de coluna nova na tabela `plans`.
 */

export const FALATU_PLAN_IDS = ["falatu_solo", "falatu_pro", "falatu_familia"] as const;
export type FalatuPlanId = (typeof FALATU_PLAN_IDS)[number];

/** Prefixo que discrimina o catálogo B2C do FalaTu do catálogo B2B do ZappFlow. */
export const FALATU_PLAN_PREFIX = "falatu_";
export function isFalatuPlanId(id: string | null | undefined): boolean {
  return !!id && String(id).startsWith(FALATU_PLAN_PREFIX);
}

export type FalatuPlanRow = {
  id: FalatuPlanId;
  name: string;
  price: number;               // R$ mensal — DEFINITIVO
  features: {
    audience: "falatu";        // discriminador do catálogo B2C (além do id)
    modules: string[];         // FalaTu é o núcleo; todos incluem "falatu"
    ai_monthly_limit: number;  // ⚠️ PLACEHOLDER — definir a cota real por tier
    trial_days: number;        // ⚠️ PLACEHOLDER — definir o período de teste
    // ⚠️ DEFINIR: recursos por tier. Hoje memória/WhatsApp/protocolos são
    //    feature-flags do FalaTu (organization_settings.falatu_*_enabled), não
    //    módulos — a Fatia C (enforcement) vai amarrar esta lista aos flags.
    falatu_features: string[];
  };
};

// ⚠️ Preços definitivos; `features` PLACEHOLDER — ajuste quando fechar a oferta.
export const FALATU_PLANS: FalatuPlanRow[] = [
  {
    id: "falatu_solo", name: "Solo", price: 19,
    features: { audience: "falatu", modules: ["falatu"], ai_monthly_limit: 100, trial_days: 7,
      falatu_features: ["captura_voz_texto", "lembretes_tarefas", "briefing_diario"] },
  },
  {
    id: "falatu_pro", name: "Pro", price: 29,
    features: { audience: "falatu", modules: ["falatu"], ai_monthly_limit: 300, trial_days: 7,
      falatu_features: ["tudo_do_solo", "whatsapp", "compras_conferencia", "memoria_contexto", "briefing_email_push"] },
  },
  {
    id: "falatu_familia", name: "Família", price: 49,
    features: { audience: "falatu", modules: ["falatu"], ai_monthly_limit: 600, trial_days: 7,
      falatu_features: ["tudo_do_pro", "multiplos_perfis", "protocolos", "prioridade"] },
  },
];

/**
 * Seed idempotente (mesmo molde de applyPlanGrade): INSERT OR IGNORE preserva
 * edição do admin. Recebe o handle do banco pra evitar import circular com db.ts.
 */
export function applyFalatuPlans(db: any): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`);
  for (const p of FALATU_PLANS) ins.run(p.id, p.name, p.price, JSON.stringify(p.features));
}
