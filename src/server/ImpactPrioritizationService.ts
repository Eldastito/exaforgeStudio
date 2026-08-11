import db from "./db.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";

/**
 * ImpactPrioritizationService (ADR-136, Epic 2 — C3).
 *
 * Motor de Concentração de Impacto / Pareto (PRD §9). Ranqueia os sinais
 * ABERTOS por um score DETERMINÍSTICO (sem LLM, reproduzível em teste) para
 * responder "o que atacar primeiro" — no máximo 3 prioridades globais e até 3
 * por domínio. Cada prioridade explica seu ranking e traz os campos do §9.3.
 *
 * Score (PRD §9.2):
 *   priority_score = normalized_impact*0.40 + urgency*0.20 + confidence*0.15
 *                  + strategic_weight*0.15 + actionability*0.10
 * Sobre o score-base, BOOSTS situacionais MULTIPLICATIVOS (default 0 = identidade):
 *   F5 (§30-31) goal-relevance · F7 (§38) SLA (pressão de prazo) + irreversibilidade.
 *
 * Regras: impacto normalizado DENTRO da mesma unidade; BRL tem preferência;
 * eventos críticos de segurança/compliance podem ultrapassar o ranking
 * financeiro; sinais do mesmo tipo/evento são agrupados. Isolado por org.
 */

const WEIGHTS = { impact: 0.4, urgency: 0.2, confidence: 0.15, strategic: 0.15, actionability: 0.1 };

// PRD 2 F5 (§30-31) — Goal-aware: um sinal que ameaça uma meta ATRASADA sobe na
// prioridade. Boost MULTIPLICATIVO (0 sem meta atrasada → score idêntico ao
// pré-F5, zero regressão). Mapa meta→domínios que a afetam.
const GOAL_DOMAINS: Record<string, string[]> = {
  revenue: ["sales", "retail_ops", "retail_floor", "churn", "finance"],
  appointments: ["agenda", "clinic"],
};
const GOAL_BOOST = 0.5; // até +50% quando a meta está 100% abaixo do ritmo

// PRD 2 F7 (§38) — dois FATORES SITUACIONAIS que o score de 5 fatores (§9.2) não
// media: PRESSÃO DE PRAZO (SLA) e IRREVERSIBILIDADE. Ambos são boosts
// MULTIPLICATIVOS que DEFAULTAM A 0 (identidade) quando o sinal não os carrega —
// mesma mecânica da F5 (goal), zero regressão pra sinais sem prazo/reversibilidade.
// Derivam SÓ do que o sinal traz (`expires_at` e um hint `evidence.reversibility`):
// o detector DECLARA, o scorer HONRA (padrão F4.2/F8) — o scorer não inventa.
const SLA_BOOST = 0.4;             // até +40% quando o prazo já estourou/está no fio
const IRREVERSIBILITY_BOOST = 0.3; // até +30% quando a janela de reação fecha (irreversível)
// Horizonte de pressão de prazo: só o prazo DENTRO desta janela pesa; mais longe
// que isso → 0 (não é urgência de SLA ainda). Passado do prazo → pressão máxima.
const SLA_HORIZON_MS = 72 * 3600 * 1000;
// Hint de reversibilidade → irreversibilidade (0..1). Quanto MENOS reversível a
// situação, MAIOR a prioridade (a janela pra evitar o dano está fechando).
const REVERSIBILITY_HINT: Record<string, number> = { low: 1.0, medium: 0.5, high: 0.0, irreversible: 1.0, reversible: 0.0 };

// Peso estratégico por domínio (0..1). Segurança/compliance no topo (podem
// ultrapassar o financeiro via override abaixo).
const STRATEGIC: Record<string, number> = {
  security: 1.0, compliance: 1.0,
  finance: 1.0, procurement: 0.85, inventory: 0.85, sales: 0.8, education: 0.8, retail_ops: 0.7, tasks: 0.55,
  // ADR-153 F7.1: domínio `plan` (recomendação de upgrade) — peso alto porque
  // afeta capacidade operacional imediata + tem custo comercial claro. Fica
  // abaixo de segurança/compliance/finance (que representam risco existencial)
  // mas acima de sales/education (que são otimizações).
  plan: 0.9,
};
const STRATEGIC_DEFAULT = 0.6;

const URGENCY: Record<string, number> = { critical: 1.0, risk: 0.7, attention: 0.4, info: 0.15 };

// Preferência por unidade (PRD §9.2: "Impacto em BRL tem preferência").
const UNIT_PREF: Record<string, number> = { BRL: 1.0, hours: 0.85, units: 0.85, percent: 0.85, score: 0.85 };

// Mapa sinal → ação recomendada (rótulo + action_type p/ resolver a aprovação).
const ACTION_MAP: Record<string, { actionType: string; label: string }> = {
  receivable_overdue: { actionType: "collection", label: "Cobrar recebíveis vencidos" },
  cash_below_minimum: { actionType: "collection", label: "Reforçar o caixa (cobrar/negociar)" },
  cash_break_risk: { actionType: "collection", label: "Antecipar entradas e postergar saídas" },
  payable_due_soon: { actionType: "prepare_purchase", label: "Revisar contas a vencer" },
  owner_draw_excess: { actionType: "create_task", label: "Revisar retiradas do proprietário" },
  data_quality_low: { actionType: "create_task", label: "Corrigir a qualidade dos dados" },
  retail_online_reserve_out: { actionType: "create_task", label: "Reabastecer a reserva da loja online" },
  retail_product_no_online_sales: { actionType: "create_task", label: "Revisar vitrine/preço do produto sem giro" },
  retail_sales_concentration: { actionType: "create_task", label: "Diversificar o mix (dependência de um produto)" },
  retail_writeback_backlog: { actionType: "create_task", label: "Lançar as baixas pendentes no PDV" },
  retail_seller_below_quota: { actionType: "create_task", label: "Acompanhar vendedor abaixo da meta" },
  meta_nao_batida_recorrente: { actionType: "create_task", label: "Rever metas/execução da loja abaixo da meta" },
  fechamento_atrasado_recorrente: { actionType: "create_task", label: "Cobrar o fechamento no prazo" },
  retail_reserve_low: { actionType: "create_task", label: "Reabastecer a reserva antes de esgotar" },
  retail_store_stockout: { actionType: "create_task", label: "Repor o estoque da loja (rupturas ativas)" },
  retail_transfer_suggested: { actionType: "retail_transfer", label: "Transferir da loja com sobra para a loja com falta" },
  retail_seller_concentration: { actionType: "create_task", label: "Distribuir vendas / formar mais vendedores" },
  producao_atrasada_recorrente: { actionType: "create_task", label: "Atacar o gargalo de produção (capacidade/material)" },
  fornecedor_divergencia_recorrente: { actionType: "create_task", label: "Cobrar o fornecedor e reforçar a conferência" },
  fornecedor_atraso_recorrente: { actionType: "prepare_purchase", label: "Renegociar prazo ou buscar fornecedor alternativo" },
  cliente_pagamento_atrasado_recorrente: { actionType: "collection", label: "Rever prazo/limite do cliente que atrasa" },
  categoria_despesa_estoura_recorrente: { actionType: "create_task", label: "Revisar e cortar a categoria de despesa em alta" },
  vendedor_queda_recorrente: { actionType: "create_task", label: "Apoiar o vendedor em queda (meta/coaching)" },
  produto_ruptura_recorrente: { actionType: "prepare_purchase", label: "Recalibrar ponto de pedido do produto que rompe" },
  consumo_cobertura_baixa: { actionType: "prepare_purchase", label: "Repor antes de romper (cobertura baixa)" },
  consumo_acima_padrao: { actionType: "create_task", label: "Investigar consumo acima do padrão" },
  consumo_estoque_parado: { actionType: "create_task", label: "Revisar estoque parado (capital imobilizado)" },
  cliente_no_show_recorrente: { actionType: "create_task", label: "Confirmar presença / pedir sinal do cliente que falta" },
  horario_no_show_recorrente: { actionType: "create_task", label: "Reforçar lembrete / rever encaixe no horário de faltas" },
  produto_queda_giro_recorrente: { actionType: "create_task", label: "Reagir à queda de giro do produto (preço/vitrine/campanha)" },
  categoria_queda_giro_recorrente: { actionType: "create_task", label: "Rever mix e exposição da categoria em queda" },
  // ADR-153 F7.1 — sinais de recomendação de plano (domínio `plan`).
  // Todos apontam pra `propose_upgrade` — action handler concreto vem em F7.4/F7.5
  // (por ora fica como recomendação visível no painel Plano e Expansões).
  plan_near_limit_ai: { actionType: "propose_upgrade", label: "Uso de IA perto do limite — considerar upgrade" },
  plan_near_limit_contacts: { actionType: "propose_upgrade", label: "Base de contatos perto do limite — considerar upgrade" },
  plan_near_limit_channels: { actionType: "propose_upgrade", label: "Canais conectados no limite — considerar upgrade" },
  plan_near_limit_users: { actionType: "propose_upgrade", label: "Usuários no limite — considerar upgrade" },
  plan_module_gap: { actionType: "propose_upgrade", label: "Módulo do seu nicho fora do plano — considerar upgrade" },
  // Módulo Escola (ADR-144) — sinais de coordenação no domínio `education`.
  student_absence: { actionType: "create_task", label: "Falar com a família sobre a falta do aluno" },
  class_not_held: { actionType: "create_task", label: "Cobrir a aula não realizada (professor/substituto)" },
  turma_sem_professor: { actionType: "create_task", label: "Alocar professor para a turma sem grade" },
  falta_recorrente: { actionType: "create_task", label: "Acionar a família do aluno com faltas recorrentes" },
  aula_cancelada_recorrente: { actionType: "create_task", label: "Resolver a lacuna crônica de professor na turma" },
  atividade_lista_espera: { actionType: "create_task", label: "Abrir vaga/turma para a atividade com lista de espera" },
};

// Prazo sugerido por severidade (determinístico; sem calendário).
const DUE_HINT: Record<string, string> = { critical: "hoje", risk: "esta semana", attention: "este mês", info: "sem prazo" };

// Responsável sugerido por domínio (perfil, não pessoa).
const OWNER_HINT: Record<string, string> = { finance: "owner", procurement: "admin", inventory: "admin", sales: "admin", retail_ops: "admin", education: "coordenacao", tasks: "admin" };

// ── Decision Intelligence DI-1 (aditivo sobre ADR-135/136 — ver
// docs/decision-intelligence/). Classificação de impacto L0–L4 + perfil de
// análise recomendado. DETERMINÍSTICO (sem LLM), derivado só do que o sinal já
// carrega (severidade, impacto BRL, override). É o ROTEADOR DE PROFUNDIDADE que
// a DI-2 (estratégias premortem/red_team/advocate) vai consultar — NÃO é o gate
// de execução: autonomia/RBAC continuam em ApprovalPolicyService/agent_policies
// (PRD §35: o Decision Gate CONSULTA o RBAC, não o substitui). Por isso
// `analysis.humanApprovalRequired` é ADVISÓRIO, não uma autorização.
const LEVEL_LABEL = ["operacional", "baixo impacto", "impacto moderado", "alto impacto", "crítico"];
// Severidade → nível implícito.
const SEV_LEVEL: Record<string, number> = { critical: 3, risk: 2, attention: 1, info: 0 };
// Valor financeiro (BRL) → nível implícito. Dinheiro sozinho chega no MÁXIMO a
// L3 ("alto"); L4 ("crítico") exige severidade crítica combinada (ou override
// de segurança/compliance) — porque irreversibilidade/risco jurídico ainda não
// são medidos aqui (entram na DI-2). Ordem decrescente; primeiro match vence.
const BRL_LEVEL: Array<[number, number]> = [[100000, 3], [20000, 3], [5000, 2], [500, 1]];

// Perfil de análise por nível (PRD §16: quanto menor o impacto, menos IA).
function analysisFor(n: number): any {
  return {
    aiDepth: ["minimal", "light", "normal", "deep", "deep"][n],
    externalResearch: n >= 3 ? "yes" : n === 2 ? "cache" : "no",
    premortem: n >= 3,
    premortemOptional: n === 2,       // §16: opcional no L2
    redTeam: n >= 3,
    advocate: n >= 3,
    deepAnalysis: n >= 3,             // §34: análise profunda só do L3 pra cima
    humanApprovalRequired: n >= 4,    // §35 L4 — ADVISÓRIO (gate real é o RBAC)
  };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class ImpactPrioritizationService {
  /** Ação recomendada para um tipo de sinal (rótulo + action_type), com default. */
  static actionFor(signalType: string): { actionType: string; label: string } {
    return ACTION_MAP[signalType] || { actionType: "create_task", label: "Registrar e acompanhar" };
  }

  /**
   * Classifica o impacto em L0–L4 + o perfil de análise recomendado (DI-1).
   * Determinístico e reutilizável pela DI-2. `override` = evento crítico de
   * segurança/compliance (vai direto pra L4).
   */
  static levelFor(input: { severity?: string; impactAmount?: number | null; impactUnit?: string | null; override?: boolean }): { level: string; n: number; label: string; analysis: any } {
    const sev = SEV_LEVEL[String(input.severity || "info")] ?? 0;
    let fin = 0;
    if (input.impactUnit === "BRL" && input.impactAmount != null) {
      const amt = Math.abs(Number(input.impactAmount) || 0);
      for (const [thr, lvl] of BRL_LEVEL) { if (amt >= thr) { fin = lvl; break; } }
    }
    let n = Math.max(sev, fin);
    if (input.override) n = 4;                    // segurança/compliance crítico
    else if (sev >= 3 && fin >= 3) n = 4;         // crítico + alto valor = crítico
    n = Math.max(0, Math.min(4, n));
    return { level: `L${n}`, n, label: LEVEL_LABEL[n], analysis: analysisFor(n) };
  }

  /**
   * Calcula as prioridades a partir dos sinais ABERTOS. Retorna `{ global, byDomain }`.
   * `global` = até 3 no total; `byDomain` = até 3 por domínio.
   */
  static prioritize(orgId: string, opts: { globalLimit?: number; perDomain?: number } = {}): any {
    const globalLimit = Math.max(1, Number(opts.globalLimit) || 3);
    const perDomain = Math.max(1, Number(opts.perDomain) || 3);

    const signals = db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND status = 'open'").all(orgId) as any[];
    if (!signals.length) return { global: [], byDomain: {}, generatedAt: nowIso() };

    // Máximo de |impacto| por unidade → normalização DENTRO da mesma unidade.
    const maxByUnit: Record<string, number> = {};
    for (const s of signals) {
      const unit = s.impact_unit || "_none";
      const amt = Math.abs(Number(s.impact_amount) || 0);
      if (amt > (maxByUnit[unit] || 0)) maxByUnit[unit] = amt;
    }

    // F5 — relevância de meta por domínio (0 sem meta atrasada). Best-effort:
    // qualquer falha ao ler metas NÃO derruba a priorização (fail-safe).
    const goalGaps = this.goalGapsByDomain(orgId, (opts as any).asOf);

    // Agrupa "consequência do mesmo evento": por (domínio, tipo) fica o de maior score.
    const byGroup = new Map<string, any>();
    for (const s of signals) {
      const scored = this.scoreSignal(orgId, s, maxByUnit, goalGaps);
      const key = `${s.domain}:${s.signal_type}`;
      const prev = byGroup.get(key);
      if (!prev) { byGroup.set(key, { ...scored, groupedCount: 1 }); }
      else {
        prev.groupedCount += 1;
        if (scored.score > prev.score) { byGroup.set(key, { ...scored, groupedCount: prev.groupedCount }); }
      }
    }

    const all = Array.from(byGroup.values()).sort(rank);
    const global = all.slice(0, globalLimit).map((p, i) => ({ ...p, rank: i + 1 }));

    const byDomain: Record<string, any[]> = {};
    for (const p of all) {
      (byDomain[p.domain] ||= []).push(p);
    }
    for (const d of Object.keys(byDomain)) {
      byDomain[d] = byDomain[d].slice(0, perDomain).map((p, i) => ({ ...p, rank: i + 1 }));
    }

    return { global, byDomain, generatedAt: nowIso() };
  }

  /**
   * PRD 3 F5 (§38/§39) — expõe a MESMA priorização por-sinal (score + affectedGoal
   * + SLA/irreversibilidade + ação recomendada) para UM sinal, sem passar pelo
   * agrupamento/limite do `prioritize`. É o mesmo cálculo (reúso do `scoreSignal`
   * privado — zero duplicação) com o MESMO contexto de normalização do batch:
   * `maxByUnit` e `goalGaps` derivam dos sinais ABERTOS da org, então o score de
   * um sinal isolado é idêntico ao que ele teria no feed. Usado pelo
   * SignalEnrichmentService (a ponte percepção→contexto pro Maestro). Isolado por
   * org; devolve null se o sinal não existe, não é da org, ou não está aberto
   * (só sinal vivo tem prioridade — não inventa lente pra sinal fechado).
   */
  static scoreOne(orgId: string, signalId: string, opts: { asOf?: string } = {}): any | null {
    const signal = db.prepare("SELECT * FROM business_signals WHERE id = ? AND organization_id = ? AND status = 'open'").get(signalId, orgId) as any;
    if (!signal) return null;
    const open = db.prepare("SELECT impact_unit, impact_amount FROM business_signals WHERE organization_id = ? AND status = 'open'").all(orgId) as any[];
    const maxByUnit: Record<string, number> = {};
    for (const s of open) {
      const unit = s.impact_unit || "_none";
      const amt = Math.abs(Number(s.impact_amount) || 0);
      if (amt > (maxByUnit[unit] || 0)) maxByUnit[unit] = amt;
    }
    const goalGaps = this.goalGapsByDomain(orgId, opts.asOf);
    return this.scoreSignal(orgId, signal, maxByUnit, goalGaps);
  }

  /** Score determinístico de um sinal + a saída obrigatória do §9.3. */
  /**
   * F5 (§30-31) — mapa domínio→{meta, gap} das metas ATRASADAS (paceStatus
   * 'behind'). gap = quão abaixo do ritmo esperado (0..1). Best-effort.
   */
  private static goalGapsByDomain(orgId: string, asOf?: string): Map<string, { metric: string; label: string; gap: number }> {
    const out = new Map<string, { metric: string; label: string; gap: number }>();
    try {
      const prog = BusinessGoalService.progress(orgId, asOf ? { asOf } : undefined);
      for (const g of prog.goals) {
        if (g.paceStatus !== "behind" || !(g.expectedByNow > 0)) continue;
        const gap = clamp01((g.expectedByNow - g.current) / g.expectedByNow);
        if (gap <= 0) continue;
        for (const dom of GOAL_DOMAINS[g.metric] || []) {
          const cur = out.get(dom);
          if (!cur || gap > cur.gap) out.set(dom, { metric: g.metric, label: g.label, gap });
        }
      }
    } catch { /* metas indisponíveis → sem boost (fail-safe) */ }
    return out;
  }

  /**
   * F7 (§38) — pressão de prazo (SLA) de um sinal, 0..1. Deriva do `expires_at`:
   * já passou → 1 (janela estourou); dentro do horizonte → cresce conforme se
   * aproxima; além do horizonte (ou sem prazo) → 0. `now` injetável pra teste.
   */
  static slaPressure(s: any, now = Date.now()): number {
    const raw = s?.expires_at || s?.expiresAt;
    if (!raw) return 0;
    const exp = Date.parse(String(raw));
    if (!Number.isFinite(exp)) return 0;
    const remaining = exp - now;
    if (remaining <= 0) return 1;                 // prazo estourado → pressão máxima
    if (remaining >= SLA_HORIZON_MS) return 0;    // ainda distante → sem pressão de SLA
    return clamp01(1 - remaining / SLA_HORIZON_MS);
  }

  /**
   * F7 (§38) — irreversibilidade de um sinal, 0..1. Deriva do hint que o detector
   * pode declarar em `evidence.reversibility` (low|medium|high|reversible|
   * irreversible). Ausente/desconhecido → 0 (assume reversível, sem boost —
   * fail-safe: o scorer NÃO presume irreversibilidade que o detector não afirmou).
   */
  static irreversibility(s: any): number {
    const ev = s && typeof s.evidence_json === "string" ? safeParse(s.evidence_json) : (s?.evidence || {});
    const hint = String(ev?.reversibility ?? "").toLowerCase();
    return REVERSIBILITY_HINT[hint] ?? 0;
  }

  private static scoreSignal(orgId: string, s: any, maxByUnit: Record<string, number>, goalGaps?: Map<string, { metric: string; label: string; gap: number }>): any {
    const severity = String(s.severity || "info");
    const urgency = URGENCY[severity] ?? 0.15;
    const confidence = clamp01(s.confidence);
    const strategicBase = STRATEGIC[s.domain] ?? STRATEGIC_DEFAULT;

    const unit = s.impact_unit || "_none";
    const amt = Math.abs(Number(s.impact_amount) || 0);
    const unitMax = maxByUnit[unit] || 0;
    const unitPref = UNIT_PREF[s.impact_unit] ?? 0.85;
    // Impacto normalizado DENTRO da unidade; sem valor → proxy pela urgência.
    const normalizedImpact = unitMax > 0 ? clamp01((amt / unitMax) * unitPref) : clamp01(urgency * 0.5);

    const action = ACTION_MAP[s.signal_type] || null;
    // Acionabilidade: fato > estimativa; ação conhecida soma.
    let actionability = s.basis === "fact" ? 0.9 : 0.6;
    if (action) actionability = clamp01(actionability + 0.1);

    // Override: crítico de segurança/compliance pode ultrapassar o financeiro.
    const override = (s.domain === "security" || s.domain === "compliance") && severity === "critical";
    const strategic = override ? 1.0 : strategicBase;

    const baseScore =
      normalizedImpact * WEIGHTS.impact +
      urgency * WEIGHTS.urgency +
      confidence * WEIGHTS.confidence +
      strategic * WEIGHTS.strategic +
      actionability * WEIGHTS.actionability;
    // F5 — boost de meta: sinal que ameaça uma meta atrasada sobe. 0 sem meta.
    const goal = goalGaps?.get(s.domain) || null;
    const goalRelevance = goal?.gap || 0;
    // F7 (§38) — pressão de prazo (SLA) + irreversibilidade. Ambos 0 quando o
    // sinal não os carrega → score idêntico ao pré-F7 (zero regressão).
    const slaPressure = ImpactPrioritizationService.slaPressure(s);
    const irreversibility = ImpactPrioritizationService.irreversibility(s);
    const score = round4(baseScore * (1 + GOAL_BOOST * goalRelevance + SLA_BOOST * slaPressure + IRREVERSIBILITY_BOOST * irreversibility));

    // Aprovação necessária p/ a ação recomendada (reusa a política da C2a).
    let approval: any = null;
    if (action) {
      const pol = ApprovalPolicyService.resolve(orgId, { domain: s.domain, actionType: action.actionType, expectedImpact: s.impact_amount });
      approval = { policy: pol.policy, requiredRole: pol.requiredRole };
    }

    const evidence = safeParse(s.evidence_json);
    // DI-1: nível de impacto L0–L4 + perfil de análise (roteador de profundidade).
    const cls = ImpactPrioritizationService.levelFor({ severity, impactAmount: s.impact_amount, impactUnit: s.impact_unit, override });
    return {
      signalId: s.id,
      domain: s.domain,
      signalType: s.signal_type,
      override,
      score,
      impactLevel: cls.level,
      impactLevelN: cls.n,
      impactLevelLabel: cls.label,
      analysis: cls.analysis,
      components: {
        normalizedImpact: round4(normalizedImpact),
        urgency: round4(urgency),
        confidence: round4(confidence),
        strategicWeight: round4(strategic),
        actionability: round4(actionability),
        goalRelevance: round4(goalRelevance),
        // F7 (§38) — fatores situacionais (0 quando o sinal não os carrega).
        slaPressure: round4(slaPressure),
        irreversibility: round4(irreversibility),
      },
      // F5 — qual meta este sinal ameaça (null se nenhuma atrasada no domínio).
      affectedGoal: goal ? { metric: goal.metric, label: goal.label, gapPct: round2(goal.gap * 100) } : null,
      // Saída obrigatória (PRD §9.3):
      fact: s.signal_type,
      interpretation: interpret(s),
      impact: s.impact_amount != null ? { amount: round2(s.impact_amount), unit: s.impact_unit || null } : null,
      basis: s.basis,
      confidence,
      evidence,
      source: s.source_service,
      recommendedAction: action?.label || "Registrar e acompanhar",
      recommendedActionType: action?.actionType || null,
      suggestedOwner: OWNER_HINT[s.domain] || "admin",
      dueHint: DUE_HINT[severity] || "sem prazo",
      approvalNeeded: approval,
      howMeasured: "Resultado registrado como outcome (esperado × realizado) ao concluir a ação.",
      reason: reason(s, severity, override),
    };
  }
}

// Ordenação: overrides de segurança/compliance primeiro; depois por score;
// desempate por severidade e impacto (determinístico e reproduzível).
function rank(a: any, b: any): number {
  if (a.override !== b.override) return a.override ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  const sev = (URGENCY[b.signalType] || 0) - (URGENCY[a.signalType] || 0);
  if (sev !== 0) return sev;
  const ia = a.impact?.amount != null ? Math.abs(a.impact.amount) : 0;
  const ib = b.impact?.amount != null ? Math.abs(b.impact.amount) : 0;
  if (ib !== ia) return ib - ia;
  return String(a.signalId).localeCompare(String(b.signalId));
}

function interpret(s: any): string {
  const impact = s.impact_amount != null ? (s.impact_unit === "BRL" ? brl(s.impact_amount) : `${round2(s.impact_amount)} ${s.impact_unit || ""}`.trim()) : "impacto não quantificado";
  return `Sinal '${s.signal_type}' no domínio ${s.domain}, ${s.basis === "fact" ? "comprovado" : "estimado"}, com impacto de ${impact}.`;
}

function reason(s: any, severity: string, override: boolean): string {
  if (override) return `Evento crítico de ${s.domain}: prioridade máxima por segurança/compliance, acima do ranking financeiro.`;
  const parts: string[] = [];
  if (s.impact_amount != null) parts.push(`impacto ${s.impact_unit === "BRL" ? brl(s.impact_amount) : `${round2(s.impact_amount)} ${s.impact_unit || ""}`.trim()}`);
  parts.push(`severidade ${severity}`);
  parts.push(`confiança ${Math.round(clamp01(s.confidence) * 100)}%`);
  parts.push(s.basis === "fact" ? "fato" : "estimativa");
  return `Priorizado por ${parts.join(", ")}.`;
}

function brl(n: number): string { return `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`; }
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }
function nowIso(): string { return new Date().toISOString(); }

export default ImpactPrioritizationService;
