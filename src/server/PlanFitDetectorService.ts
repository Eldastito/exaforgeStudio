/**
 * PlanFitDetectorService (ADR-153 F7.1 + F7.2) — scanner puro pra recomendação
 * de plano com SCORE 0-100 e EXPLICABILIDADE por dimensão (PRD §14/§16).
 *
 * F7.1 entregou 4 detectores near_limit (ai/contacts/channels/users) com
 * severity determinística por faixa. F7.2 ADICIONA:
 *   - Novo detector `plan_module_gap` — blueprint diz "esse módulo faz
 *     sentido pra você" mas plano não cobre → sinal por módulo.
 *   - Score 0-100 em 6 dimensões (PRD §14): necessidade / uso / ganho
 *     financeiro / recorrência / adequação vertical / confiança.
 *   - `impactAmount` em BRL — uplift estimado (3× diferença de preço do
 *     upgrade — payback conservador).
 *   - `evidence.scoreBreakdown` — cada dimensão exposta pro card explicar.
 *   - Threshold DURO: score < 60 → NÃO publica (PRD §14 "abaixo de 60: não
 *     recomendar"). Publisher recebe só candidatos elegíveis.
 *
 * Backward compat: severity ainda deriva de pct (near_limit) — score é
 * DIMENSÃO ORTOGONAL, filtra por threshold. Sinais F7.1 já publicados
 * continuam válidos; refresh do publisher recomputa score.
 *
 * PURO — sem side effects. Publisher (F7.1) faz dedupe/publish.
 *
 * G-153-6: severity + score determinísticos, sem IA. Auditor pode reproduzir.
 * PRD §12.2 (sinais proibidos): NÃO usa contagem de visitas à tela, nem
 * "plano superior existe" como razão isolada — sempre exige uso real.
 *
 * RN-153-F7.1-001: orgId 1º arg; toda query filtra organization_id.
 * RN-153-F7.1-002: cortesia NÃO dispara.
 * RN-153-F7.1-003: billing_status blocked/cancelled/past_due NÃO dispara.
 * RN-153-F7.2-001: score < 60 NÃO publica (§14).
 * RN-153-F7.2-002: `plan_module_gap` cap 3 sinais por org por rodada.
 */
import db from "./db.js";
import { PlanService } from "./PlanService.js";
import { PLAN_GRADE } from "./plansGrade.js";
import { VerticalBlueprintService } from "./VerticalBlueprintService.js";

export type PlanFitSignalType =
  | "plan_near_limit_ai"
  | "plan_near_limit_contacts"
  | "plan_near_limit_channels"
  | "plan_near_limit_users"
  | "plan_module_gap";

export type PlanFitSeverity = "info" | "attention" | "risk" | "critical";

// PRD §14 — 6 dimensões, total = 100.
export interface ScoreBreakdown {
  necessidade_operacional: number;   // max 30
  uso_proximo_limite: number;        // max 20
  ganho_financeiro_provavel: number; // max 20
  recorrencia_necessidade: number;   // max 15
  adequacao_vertical: number;        // max 10
  confianca_dados: number;           // max 5
  total: number;                     // soma
}

export interface PlanFitCandidate {
  signalType: PlanFitSignalType;
  severity: PlanFitSeverity;
  score: number;                    // 0-100
  metric: string;                   // "ai" | "contacts" | ... | "module:<key>"
  used: number;                     // pra near_limit
  limit: number;                    // idem
  pct: number;                      // 0-∞
  planId: string;
  targetPlanId: string | null;
  impactAmount: number | null;      // uplift em BRL/mês (F7.2)
  impactUnit: "BRL" | null;
  evidence: {
    metric: string;
    used?: number;
    limit?: number;
    pctInt?: number;
    moduleKey?: string;
    currentPlan: string;
    upgradeTargetPlan: string | null;
    upgradeTargetLimit: number | null;
    scoreBreakdown: ScoreBreakdown;
    estimatedUpliftMonthly: number | null;
    blueprintKey?: string | null;
  };
  dedupeKey: string;
}

function severityFor(pct: number): PlanFitSeverity | null {
  if (pct < 80) return null;
  if (pct < 90) return "attention";
  if (pct < 100) return "risk";
  return "critical";
}

function findUpgradeForLimit(currentPlanId: string, metric: "ai" | "contacts" | "channels" | "users", currentLimit: number): { planId: string; limit: number } | null {
  const order = ["autonomo", "start", "growth", "scale", "enterprise"];
  const idx = order.indexOf(currentPlanId);
  if (idx < 0) return null;
  const featureField: Record<string, keyof (typeof PLAN_GRADE)[0]["features"]> = {
    ai: "ai_monthly_limit",
    contacts: "contacts_limit",
    channels: "channels_limit",
    users: "users_limit",
  };
  const field = featureField[metric];
  for (let i = idx + 1; i < order.length; i++) {
    const p = PLAN_GRADE.find((pl) => pl.id === order[i]);
    if (!p) continue;
    const lim = Number(p.features[field] as any);
    if (lim === 0 || lim > currentLimit) return { planId: p.id, limit: lim };
  }
  return null;
}

// Menor plano que INCLUI o módulo — usado pelo detector `plan_module_gap`.
function findUpgradeForModule(currentPlanId: string, moduleKey: string): string | null {
  const order = ["autonomo", "start", "growth", "scale", "enterprise"];
  const idx = order.indexOf(currentPlanId);
  if (idx < 0) return null;
  for (let i = idx + 1; i < order.length; i++) {
    const p = PLAN_GRADE.find((pl) => pl.id === order[i]);
    if (p?.features.modules?.includes(moduleKey)) return p.id;
  }
  return null;
}

// F7.2 — uplift em BRL/mês. Payback conservador: 3× a diferença de preço
// do upgrade. Ex.: autonomo (R$247) → growth (R$1797): uplift = 3×R$1550 =
// R$4650/mês. Racional: cliente que precisa de mais capacidade tá deixando
// receita/tempo na mesa proporcionalmente. F futuro pode refinar por
// vertical (clínica ganha mais que autônomo por upgrade).
function estimateUpliftBrl(currentPlanId: string, targetPlanId: string | null): number | null {
  if (!targetPlanId) return null;
  const cur = PLAN_GRADE.find((p) => p.id === currentPlanId);
  const tgt = PLAN_GRADE.find((p) => p.id === targetPlanId);
  if (!cur || !tgt) return null;
  const diff = Math.max(0, tgt.price - cur.price);
  return diff * 3;
}

function ymNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// F7.2 — Score 0-100 (PRD §14). Cada dimensão retorna 0..max_dim.
// Deterministic. Auditor lê breakdown e refuta se quiser.
function computeNearLimitScore(pct: number, targetPlanId: string | null, upliftBrl: number | null, isInBlueprint: boolean): ScoreBreakdown {
  // 1) NECESSIDADE OPERACIONAL (max 30)
  // Proporcional ao pct — orgs em 100%+ estão travadas, orgs em 80% ainda
  // têm folga. Curva linear normalizada em 80..120 → 0..30.
  const necessidade = Math.max(0, Math.min(30, ((pct - 80) / 40) * 30));

  // 2) USO PRÓXIMO AO LIMITE (max 20) — mesma info, ângulo diferente.
  // Sinal: quanto MAIS perto/acima, MAIS urgente. Linear 80..100+ → 0..20.
  const uso = Math.max(0, Math.min(20, ((pct - 80) / 20) * 20));

  // 3) GANHO FINANCEIRO PROVÁVEL (max 20)
  // Se estimativa de uplift existe → 20 (upgrade tem retorno claro). Sem
  // upgrade path (Enterprise): 5 (uplift indireto por top-up etc). Sem
  // estimativa: 10 (indefinido).
  const ganho = upliftBrl != null && upliftBrl > 0 ? 20 : (targetPlanId ? 10 : 5);

  // 4) RECORRÊNCIA (max 15)
  // MVP F7.2: proxy pelo pct — quanto mais alto, mais provavelmente é
  // recorrente. F futuro pode consultar histórico de sinais similares.
  const recorrencia = pct >= 95 ? 15 : pct >= 85 ? 10 : 5;

  // 5) ADEQUAÇÃO VERTICAL (max 10)
  // Se blueprint hint sinaliza que essa métrica/módulo faz sentido = 10.
  // Sem blueprint / módulo não incluído explicitamente = 5 (neutro).
  const adequacao = isInBlueprint ? 10 : 5;

  // 6) CONFIANÇA (max 5) — near_limit é FATO (contagem SQL).
  const confianca = 5;

  const total = Math.round(necessidade + uso + ganho + recorrencia + adequacao + confianca);
  return {
    necessidade_operacional: Math.round(necessidade),
    uso_proximo_limite: Math.round(uso),
    ganho_financeiro_provavel: ganho,
    recorrencia_necessidade: recorrencia,
    adequacao_vertical: adequacao,
    confianca_dados: confianca,
    total,
  };
}

// F7.2 — Score pra `plan_module_gap`. Baseline mais baixo que near_limit
// (informativo — dono não está travado, só perde valor potencial).
function computeModuleGapScore(isRequired: boolean, upliftBrl: number | null): ScoreBreakdown {
  // Necessidade média: se é `required` do blueprint → 25 (deveria ter).
  // Se é `optional` → 15 (agrega valor mas dá pra viver sem).
  const necessidade = isRequired ? 25 : 15;
  const uso = 5; // Sem sinal de USO real ainda (F7.2 é gap conceitual).
  const ganho = upliftBrl != null && upliftBrl > 0 ? 15 : 5;
  const recorrencia = 5; // gap é constante; não é evento.
  const adequacao = 10; // por definição estamos falando de módulo no blueprint.
  const confianca = 5;
  const total = Math.round(necessidade + uso + ganho + recorrencia + adequacao + confianca);
  return {
    necessidade_operacional: necessidade,
    uso_proximo_limite: uso,
    ganho_financeiro_provavel: ganho,
    recorrencia_necessidade: recorrencia,
    adequacao_vertical: adequacao,
    confianca_dados: confianca,
    total,
  };
}

export class PlanFitDetectorService {
  /** Threshold PRD §14 — score abaixo NÃO publica. */
  static readonly MIN_PUBLISH_SCORE = 60;

  /**
   * Varre a org e devolve candidatos elegíveis (score ≥ 60). Puro.
   * F7.2 amplia F7.1: near_limit + module_gap + score + uplift.
   */
  static detect(orgId: string): PlanFitCandidate[] {
    const org = db.prepare(
      `SELECT plan_id, billing_status FROM organization_settings
        WHERE organization_id = ? AND deleted_at IS NULL`,
    ).get(orgId) as any;
    if (!org) return [];
    if (org.plan_id === "cortesia" || !org.plan_id) return [];
    if (["blocked", "cancelled", "past_due"].includes(String(org.billing_status || ""))) return [];

    const plan = PlanService.getCurrentPlan(orgId);
    if (!plan || !plan.features) return [];
    const usage = PlanService.getUsage(orgId);
    const ym = ymNow();
    const candidates: PlanFitCandidate[] = [];

    // Blueprint da org (F3.2) — usado pra adequacao_vertical + module_gap.
    let blueprint: Awaited<ReturnType<typeof VerticalBlueprintService.getBlueprint>> = null;
    try {
      const orgBp = VerticalBlueprintService.getForOrganization(orgId);
      if (orgBp) blueprint = VerticalBlueprintService.getBlueprint(orgBp.blueprintId);
    } catch { /* best-effort */ }

    // ── PARTE 1 — near_limit (F7.1 refactored com score) ──
    const nearMetrics: Array<{
      metric: "ai" | "contacts" | "channels" | "users";
      signalType: PlanFitSignalType;
      used: number;
      limit: number;
    }> = [
      { metric: "ai", signalType: "plan_near_limit_ai", used: usage.ai_this_month, limit: Number(plan.features.ai_monthly_limit || 0) },
      { metric: "contacts", signalType: "plan_near_limit_contacts", used: usage.contacts, limit: Number(plan.features.contacts_limit || 0) },
      { metric: "channels", signalType: "plan_near_limit_channels", used: usage.channels, limit: Number(plan.features.channels_limit || 0) },
      { metric: "users", signalType: "plan_near_limit_users", used: usage.users, limit: Number(plan.features.users_limit || 0) },
    ];

    for (const m of nearMetrics) {
      if (!m.limit || m.limit <= 0) continue;
      const pct = (m.used / m.limit) * 100;
      const severity = severityFor(pct);
      if (!severity) continue;

      const upgrade = findUpgradeForLimit(plan.id, m.metric, m.limit);
      const uplift = estimateUpliftBrl(plan.id, upgrade?.planId || null);

      // near_limit é sempre alinhado ao blueprint quando existe (org está
      // usando um recurso que faz parte do produto atual — natural que
      // adequacao seja alta). Sem blueprint: neutro.
      const isInBlueprint = !!blueprint;

      const scoreBreakdown = computeNearLimitScore(pct, upgrade?.planId || null, uplift, isInBlueprint);
      if (scoreBreakdown.total < this.MIN_PUBLISH_SCORE) continue;

      candidates.push({
        signalType: m.signalType,
        severity,
        score: scoreBreakdown.total,
        metric: m.metric,
        used: m.used,
        limit: m.limit,
        pct,
        planId: plan.id,
        targetPlanId: upgrade?.planId || null,
        impactAmount: uplift,
        impactUnit: uplift != null ? "BRL" : null,
        evidence: {
          metric: m.metric,
          used: m.used,
          limit: m.limit,
          pctInt: Math.round(pct),
          currentPlan: plan.id,
          upgradeTargetPlan: upgrade?.planId || null,
          upgradeTargetLimit: upgrade?.limit ?? null,
          scoreBreakdown,
          estimatedUpliftMonthly: uplift,
          blueprintKey: blueprint?.key || null,
        },
        dedupeKey: `plan:near_limit:${m.metric}:${ym}`,
      });
    }

    // ── PARTE 2 — plan_module_gap (F7.2 novo) ──
    // Só varre se org tem blueprint (evita spam em orgs sem blueprint —
    // vertical fallback é impreciso demais pra virar recomendação).
    if (blueprint) {
      const covered = new Set(plan.features.modules || []);
      const required = new Set(blueprint.config.requiredModules || []);
      const optional = new Set(blueprint.config.optionalModules || []);
      const candidates_gap: PlanFitCandidate[] = [];

      // Coleta gaps: módulos required OU optional do blueprint que o plano
      // atual NÃO cobre e existem em algum plano superior.
      const allGaps = [...required, ...optional];
      for (const moduleKey of allGaps) {
        if (covered.has(moduleKey)) continue;
        const targetPlan = findUpgradeForModule(plan.id, moduleKey);
        if (!targetPlan) continue; // módulo não existe em nenhum tier — bug de blueprint

        const uplift = estimateUpliftBrl(plan.id, targetPlan);
        const isRequired = required.has(moduleKey);
        const scoreBreakdown = computeModuleGapScore(isRequired, uplift);
        if (scoreBreakdown.total < this.MIN_PUBLISH_SCORE) continue;

        // severity fixa `info` — module_gap é oportunidade, não urgência.
        // Required = attention (mais forte); optional = info.
        const severity: PlanFitSeverity = isRequired ? "attention" : "info";

        candidates_gap.push({
          signalType: "plan_module_gap",
          severity,
          score: scoreBreakdown.total,
          metric: `module:${moduleKey}`,
          used: 0,
          limit: 0,
          pct: 0,
          planId: plan.id,
          targetPlanId: targetPlan,
          impactAmount: uplift,
          impactUnit: uplift != null ? "BRL" : null,
          evidence: {
            metric: `module:${moduleKey}`,
            moduleKey,
            currentPlan: plan.id,
            upgradeTargetPlan: targetPlan,
            upgradeTargetLimit: null,
            scoreBreakdown,
            estimatedUpliftMonthly: uplift,
            blueprintKey: blueprint.key,
          },
          // dedupe key com moduleKey pra 1 sinal por módulo por mês
          dedupeKey: `plan:module_gap:${moduleKey}:${ym}`,
        });
      }

      // RN-153-F7.2-002: cap 3 sinais de gap por org (top score primeiro).
      candidates_gap.sort((a, b) => b.score - a.score);
      candidates.push(...candidates_gap.slice(0, 3));
    }

    return candidates;
  }
}
