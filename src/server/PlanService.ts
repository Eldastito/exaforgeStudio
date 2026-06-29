import db from "./db.js";

/**
 * Gestão de planos e billing.
 *
 * - Cada plano tem um JSON em `features` com os limites (IA/mês, contatos, canais, usuários).
 * - O `organization_settings.plan_id` aponta para o plano vigente; `billing_status`
 *   reflete o estado (`trialing | active | past_due | suspended | blocked | cancelled`).
 * - Limites são CONSULTADOS (UI mostra uso); o enforcement crítico é só na IA.
 */
export type PlanFeatures = {
  ai_monthly_limit?: number;
  contacts_limit?: number;
  channels_limit?: number;
  users_limit?: number;
  trial_days?: number;
  studio_images_monthly?: number; // limite de imagens do Estúdio por mês
  studio_videos_monthly?: number; // limite de vídeos do Estúdio por mês
};

export type Plan = {
  id: string;
  name: string;
  price: number;
  features: PlanFeatures;
};

export class PlanService {
  /** Lista todos os planos disponíveis (ordenados pelo preço). */
  static listPlans(): Plan[] {
    const rows = db.prepare(`SELECT * FROM plans ORDER BY price ASC`).all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      price: r.price || 0,
      features: this.parseFeatures(r.features),
    }));
  }

  /** Retorna o plano atual da organização (ou null se ainda não escolheu). */
  static getCurrentPlan(orgId: string): Plan | null {
    const org = db.prepare(
      `SELECT plan_id FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    if (!org?.plan_id) return null;
    const plan = db.prepare(`SELECT * FROM plans WHERE id = ?`).get(org.plan_id) as any;
    if (!plan) return null;
    return { id: plan.id, name: plan.name, price: plan.price || 0, features: this.parseFeatures(plan.features) };
  }

  /** Snapshot completo do billing da org: plano + status + uso vs limites. */
  static getBillingSnapshot(orgId: string) {
    const org = db.prepare(`
      SELECT plan_id, billing_status, status, trial_ends_at, current_period_start, current_period_end
      FROM organization_settings WHERE organization_id = ?
    `).get(orgId) as any;

    const plan = this.getCurrentPlan(orgId);
    const usage = this.getUsage(orgId);

    const trialDaysLeft = (() => {
      if (!org?.trial_ends_at) return null;
      const ms = new Date(org.trial_ends_at).getTime() - Date.now();
      return ms > 0 ? Math.ceil(ms / 86400000) : 0;
    })();

    return {
      plan,
      billingStatus: org?.billing_status || 'active',
      orgStatus: org?.status || 'active',
      trialEndsAt: org?.trial_ends_at || null,
      trialDaysLeft,
      currentPeriodStart: org?.current_period_start || null,
      currentPeriodEnd: org?.current_period_end || null,
      usage,
      limits: plan?.features || {},
    };
  }

  /** Uso atual da organização (mês corrente para IA; total para contatos/canais/usuários). */
  static getUsage(orgId: string) {
    const safe = (sql: string, args: any[] = []): number => {
      try { return (db.prepare(sql).get(...args) as any)?.c || 0; } catch (e) { return 0; }
    };
    return {
      ai_this_month: safe(
        `SELECT COUNT(*) as c FROM ai_interactions_log
         WHERE organization_id = ? AND created_at >= datetime('now','start of month')`,
        [orgId]
      ),
      contacts: safe(`SELECT COUNT(*) as c FROM contacts WHERE organization_id = ?`, [orgId]),
      channels: safe(`SELECT COUNT(*) as c FROM channels WHERE organization_id = ? AND status != 'disabled'`, [orgId]),
      users: safe(`SELECT COUNT(*) as c FROM users WHERE organization_id = ?`, [orgId]),
    };
  }

  /**
   * Define o plano da organização. Se ela ainda não tinha plano, inicia o trial
   * conforme `trial_days` do plano escolhido. Se já tinha, apenas troca o plano
   * (não mexe em billing_status — quem faz isso é o gateway/admin).
   */
  static selectPlan(orgId: string, planId: string): { ok: boolean; reason?: string } {
    const plan = db.prepare(`SELECT * FROM plans WHERE id = ?`).get(planId) as any;
    if (!plan) return { ok: false, reason: "Plano não encontrado." };

    const features = this.parseFeatures(plan.features);
    const org = db.prepare(`SELECT plan_id, trial_ends_at FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const isFirstChoice = !org?.plan_id;

    if (isFirstChoice) {
      const trialDays = features.trial_days || 14;
      const trialEnds = new Date(Date.now() + trialDays * 86400000).toISOString();
      db.prepare(`
        UPDATE organization_settings
        SET plan_id = ?, billing_status = 'trialing', trial_ends_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE organization_id = ?
      `).run(planId, trialEnds, orgId);
    } else {
      db.prepare(`
        UPDATE organization_settings SET plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?
      `).run(planId, orgId);
    }
    return { ok: true };
  }

  /**
   * Enforcement no atendimento da IA: bloqueia respostas se a empresa está
   * bloqueada/cancelada ou excedeu o limite mensal do plano.
   * Retorna { allowed:true } quando não há motivo para bloquear.
   */
  static aiAllowed(orgId: string): { allowed: boolean; reason?: string } {
    const org = db.prepare(`
      SELECT billing_status, status, plan_id FROM organization_settings WHERE organization_id = ?
    `).get(orgId) as any;
    if (!org) return { allowed: true };

    if (org.status === 'blocked' || org.status === 'cancelled') {
      return { allowed: false, reason: 'org_blocked' };
    }
    if (org.billing_status === 'blocked' || org.billing_status === 'cancelled' || org.billing_status === 'suspended') {
      return { allowed: false, reason: 'billing_blocked' };
    }

    // Limite mensal de IA pelo plano.
    if (org.plan_id) {
      const plan = db.prepare(`SELECT features FROM plans WHERE id = ?`).get(org.plan_id) as any;
      const features = this.parseFeatures(plan?.features);
      const limit = features.ai_monthly_limit || 0;
      if (limit > 0) {
        const used = this.getUsage(orgId).ai_this_month;
        if (used >= limit) return { allowed: false, reason: 'monthly_limit' };
      }
    }
    return { allowed: true };
  }

  /** Consumo do Estúdio (imagens/vídeos) no mês corrente. */
  static studioUsage(orgId: string): { images: number; videos: number } {
    const row = (kind: string) => {
      try {
        return (db.prepare(
          `SELECT COUNT(*) as c FROM studio_creations WHERE organization_id = ? AND kind = ? AND created_at >= datetime('now','start of month')`
        ).get(orgId, kind) as any)?.c || 0;
      } catch { return 0; }
    };
    return { images: row("image"), videos: row("video") };
  }

  /**
   * O Estúdio pode gerar mais um item (imagem/vídeo) este mês? Respeita o
   * bloqueio de billing e o limite mensal do plano. Limite não definido cai num
   * padrão por env (para não travar durante a configuração dos planos).
   */
  static studioAllowed(orgId: string, kind: "image" | "video"): { allowed: boolean; reason?: string; limit: number; used: number } {
    const org = db.prepare(`SELECT billing_status, status, plan_id FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const used = this.studioUsage(orgId)[kind === "image" ? "images" : "videos"];
    if (org && (org.status === 'blocked' || org.status === 'cancelled')) return { allowed: false, reason: 'org_blocked', limit: 0, used };
    if (org && ['blocked', 'cancelled', 'suspended'].includes(org.billing_status)) return { allowed: false, reason: 'billing_blocked', limit: 0, used };

    const features = org?.plan_id ? this.parseFeatures((db.prepare(`SELECT features FROM plans WHERE id = ?`).get(org.plan_id) as any)?.features) : {};
    const configured = kind === "image" ? features.studio_images_monthly : features.studio_videos_monthly;
    const fallback = Number((kind === "image" ? process.env.STUDIO_DEFAULT_IMAGES : process.env.STUDIO_DEFAULT_VIDEOS) || (kind === "image" ? 100 : 10));
    const limit = (configured == null) ? fallback : Number(configured);
    if (limit <= 0) return { allowed: false, reason: 'plan_no_studio', limit: 0, used };
    if (used >= limit) return { allowed: false, reason: 'monthly_limit', limit, used };
    return { allowed: true, limit, used };
  }

  private static parseFeatures(raw: any): PlanFeatures {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)) || {}; } catch (e) { return {}; }
  }
}
