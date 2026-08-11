import db from "./db.js";
import {
  ModelProfile,
  ModelRequirements,
  ModelRoute,
  ModelCandidate,
  BudgetClass,
  LifecycleStatus,
  LIFECYCLE_STATUSES,
  modelMeets,
  rankModelCandidates,
  isRoutable,
} from "./skillosModel.js";
import { SkillOsProviderHealthService } from "./SkillOsProviderHealthService.js";

/**
 * SkillOsModelRouterService — PRD 4 F5 (§22/§23): o MODEL ROUTER.
 *
 * Dado `ModelRequirements` (a Capability/Skill PEDE capacidades — não um modelo),
 * escolhe o modelo DINAMICAMENTE e por REGRA: casa requisitos com o catálogo
 * (`skillos_model_profiles`) + a SAÚDE do provider (circuit breaker derivado, F5) +
 * custo/latência. Determinístico, sem IA. NÃO invoca modelo (isso é o Kernel/F4);
 * só DECIDE qual usar (a Skill nunca conhece modelo/provider — P1/P2).
 *
 * Catálogo de PLATAFORMA (universal, sem org_id — §49). Aditivo/inerte até registrar.
 *
 * GUARDRAILS (testados):
 *   - RN-MR-1 SEM IA / DETERMINÍSTICO: escolha por regra reproduzível (§22).
 *   - RN-MR-2 SAÚDE MANDA: modelo `open` (circuit breaker) é BARRADO do roteamento.
 *   - RN-MR-3 NÃO O MAIS PODEROSO: prefere saudável > barato > baixa latência (§11).
 *   - RN-MR-4 SEM SILÊNCIO (§65): sem modelo → routed:false + noModelReason.
 *   - RN-MR-5 REUSA: `modelMeets`/`rankModelCandidates` (F1) + health derivada (F5).
 */

export interface ModelProfileInput extends ModelProfile {
  budgetClass?: BudgetClass | null;
  status?: LifecycleStatus;
}

export interface RouteOpts {
  windowMinutes?: number;   // janela da saúde
  orgId?: string;           // escopo da saúde (default plataforma)
}

const j = (v: any) => JSON.stringify(v ?? []);
const p = (s: any) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

export class SkillOsModelRouterService {
  /** Registra/atualiza (upsert) um perfil de modelo no catálogo de plataforma. */
  static registerModel(m: ModelProfileInput): ModelProfileInput {
    if (!m?.model || !m?.provider) throw new Error("model e provider são obrigatórios.");
    db.prepare(`INSERT INTO skillos_model_profiles
      (model, provider, capabilities_json, context_tokens, typical_latency_ms, budget_class, status)
      VALUES (@model, @provider, @capabilities, @contextTokens, @typicalLatencyMs, @budgetClass, @status)
      ON CONFLICT(model) DO UPDATE SET
        provider=excluded.provider, capabilities_json=excluded.capabilities_json, context_tokens=excluded.context_tokens,
        typical_latency_ms=excluded.typical_latency_ms, budget_class=excluded.budget_class, status=excluded.status,
        updated_at=CURRENT_TIMESTAMP`)
      .run({
        model: m.model, provider: m.provider, capabilities: j(m.capabilities), contextTokens: m.contextTokens ?? null,
        typicalLatencyMs: m.typicalLatencyMs ?? null, budgetClass: m.budgetClass ?? null, status: m.status ?? "active",
      });
    return this.getModel(m.model)!;
  }

  static getModel(model: string): ModelProfileInput | null {
    const r = db.prepare("SELECT * FROM skillos_model_profiles WHERE model = ?").get(model) as any;
    return r ? rowToProfile(r) : null;
  }

  static listModels(opts: { provider?: string; status?: LifecycleStatus } = {}): ModelProfileInput[] {
    let sql = "SELECT * FROM skillos_model_profiles WHERE 1=1";
    const params: any[] = [];
    if (opts.provider) { sql += " AND provider = ?"; params.push(opts.provider); }
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY provider, model";
    return (db.prepare(sql).all(...params) as any[]).map(rowToProfile);
  }

  static setModelStatus(model: string, status: LifecycleStatus): ModelProfileInput {
    if (!LIFECYCLE_STATUSES.includes(status)) throw new Error(`status inválido: ${status}`);
    const r = db.prepare("UPDATE skillos_model_profiles SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE model = ?").run(status, model);
    if (!r.changes) throw new Error("Modelo não encontrado.");
    return this.getModel(model)!;
  }

  /**
   * §22 — roteia: casa requisitos + saúde + custo/latência → o melhor modelo.
   * `open` (circuit breaker) é barrado ANTES do ranqueamento (RN-MR-2). Sem modelo
   * → routed:false + razão (RN-MR-4).
   */
  static route(requirements: ModelRequirements, opts: RouteOpts = {}): ModelRoute {
    const active = this.listModels({ status: "active" });
    // 1. quais modelos ATENDEM os requisitos (§22, reusa modelMeets/F1).
    const meets = active.filter((m) => modelMeets(m, requirements));
    if (meets.length === 0) {
      return { routed: false, model: null, provider: null, health: null, reason: "Nenhum modelo ativo atende os requisitos declarados.", alternatives: [], noModelReason: "no_model_meets_requirements" };
    }
    // 2. anota saúde e barra os 'open'.
    const annotated: ModelCandidate[] = meets.map((m) => ({
      profile: m, budgetClass: m.budgetClass ?? null,
      health: SkillOsProviderHealthService.state(m.provider, { model: m.model, windowMinutes: opts.windowMinutes, orgId: opts.orgId }),
    }));
    const routable = annotated.filter((c) => isRoutable(c.health));
    if (routable.length === 0) {
      return { routed: false, model: null, provider: null, health: null, reason: `Todos os ${annotated.length} modelos elegíveis estão com o circuit breaker ABERTO.`, alternatives: [], noModelReason: "all_candidates_open" };
    }
    // 3. ranqueia (saudável > barato > baixa latência, §11).
    const ranked = rankModelCandidates(routable);
    const winner = ranked[0];
    return {
      routed: true,
      model: winner.profile.model,
      provider: winner.profile.provider,
      health: winner.health,
      reason: this.explain(winner, ranked),
      alternatives: ranked.slice(1).map((c) => ({ model: c.profile.model, provider: c.profile.provider, health: c.health })),
    };
  }

  private static explain(winner: ModelCandidate, ranked: ModelCandidate[]): string {
    if (ranked.length === 1) return `Único modelo roteável (${winner.profile.model}, ${winner.health}).`;
    const next = ranked[1];
    if (winner.health !== next.health) return `Mais saudável (${winner.health}) entre ${ranked.length} candidatos.`;
    if ((winner.budgetClass || "") !== (next.budgetClass || "")) return `Menor custo (budget=${winner.budgetClass ?? "n/d"}) entre ${ranked.length} saudáveis.`;
    return `Menor latência/desempate estável entre ${ranked.length} candidatos.`;
  }
}

function rowToProfile(r: any): ModelProfileInput {
  return {
    model: r.model, provider: r.provider, capabilities: p(r.capabilities_json),
    contextTokens: r.context_tokens ?? null, typicalLatencyMs: r.typical_latency_ms ?? null,
    budgetClass: r.budget_class ?? null, status: r.status,
  };
}

export default SkillOsModelRouterService;
