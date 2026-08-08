import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { EvidencePackageService } from "./EvidencePackageService.js";
import { DecisionSimulatorService } from "./DecisionSimulatorService.js";
import { DecisionRiskService, PredictedRisk } from "./DecisionRiskService.js";

/**
 * DecisionEngine — o "cérebro decisório" (DI-2, aditivo sobre ADR-135/136).
 * Ver docs/decision-intelligence/PLANO-E-FATIAS.md.
 *
 * Pre-Mortem / Red Team / Advocate são ESTRATÉGIAS (modos), NÃO agentes
 * residentes nem serviços/tabelas próprios (PRD §13/§37). Rodam sobre o Evidence
 * Package (DI-1) — evidência antes de opinião — e são DETERMINÍSTICAS (zero-token,
 * reproduzíveis em CI sem chave de IA): derivam riscos/desafios/cenários das
 * evidências e do contexto da decisão por regra. A narração em linguagem natural
 * (LLM) é uma borda OPCIONAL de quem consome — aqui devolvemos estrutura.
 *
 * ROTEAMENTO POR IMPACTO (PRD §14/§16, critério de aceite §8): decisões de baixo
 * impacto (L0/L1) NÃO disparam análise profunda. O nível vem do DI-1
 * (ImpactPrioritizationService.levelFor). `mode` explícito força uma estratégia.
 *
 * GUARDRAIL: o resultado é ADVISÓRIO. O gate real de execução (autonomia/RBAC)
 * segue em ApprovalPolicyService/agent_policies (PRD §35). Persistir riscos usa
 * DecisionRiskService, que publica no ledger business_signals existente (nunca
 * cria alerta próprio — convenção nº 12). Isolado por organization_id.
 */

export interface DecisionInput {
  title: string;
  decisionType?: string;                 // purchase|campaign|hire|investment|expansion|generic
  impactAmount?: number | null;
  impactUnit?: string | null;            // BRL...
  severity?: string;                     // dica opcional de severidade
  expectedValue?: number | null;         // retorno esperado (p/ cenários/advocate)
  premises?: Array<{ label: string; basis?: "fact" | "estimate"; confidence?: number; hasEvidence?: boolean }>;
  decisionId?: string | null;            // liga a uma decision_actions
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const brl = (n: any) => `R$ ${(Number(n) || 0).toFixed(2).replace(".", ",")}`;

export class DecisionEngine {
  /**
   * Analisa uma decisão. `mode`: premortem|red_team|advocate|all|auto (default
   * auto — deriva do nível de impacto). `persist` grava os riscos do Pre-Mortem.
   */
  static analyze(orgId: string, input: DecisionInput, opts: { mode?: string; persist?: boolean } = {}): any {
    const level = ImpactPrioritizationService.levelFor({ severity: input.severity, impactAmount: input.impactAmount, impactUnit: input.impactUnit });
    const mode = opts.mode || "auto";

    // Quais estratégias rodam.
    const run = { premortem: false, redTeam: false, advocate: false };
    if (mode === "auto") {
      if (level.analysis.deepAnalysis) { run.premortem = run.redTeam = run.advocate = true; }
      else if (level.n === 2) { run.premortem = true; }        // L2: premortem opcional
      // L0/L1: nenhuma análise profunda (PRD §16 / critério §8)
    } else if (mode === "all") {
      run.premortem = run.redTeam = run.advocate = true;
    } else if (mode === "premortem") run.premortem = true;
    else if (mode === "red_team") run.redTeam = true;
    else if (mode === "advocate") run.advocate = true;

    const applied = Object.keys(run).filter((k) => (run as any)[k]);
    if (!applied.length) {
      return { level: level.level, levelLabel: level.label, analysisProfile: level.analysis, applied: [], skipped: true, reason: "Baixo impacto — sem análise profunda (roteador de profundidade DI-1).", recommendation: { stance: "proceed", headline: `Decisão de ${level.label}: pode seguir dentro das permissões existentes.`, why: [] } };
    }

    // Evidência (reusa o Evidence Package — não recalcula domínio).
    const evidence = EvidencePackageService.build(orgId);
    const scenarios = DecisionSimulatorService.scenarios(orgId, { base: input.expectedValue ?? input.impactAmount ?? null });

    const out: any = {
      level: level.level, levelLabel: level.label, analysisProfile: level.analysis,
      applied, skipped: false,
      evidence: { subject: evidence.subject, confidence: evidence.confidence, freshness: evidence.freshness, sources: evidence.sources },
      scenarios,
    };
    if (run.premortem) out.premortem = { risks: this.premortem(input, evidence) };
    if (run.redTeam) out.redTeam = { challenges: this.redTeam(input, evidence) };
    if (run.advocate) out.advocate = this.advocate(input, evidence, scenarios);

    out.recommendation = this.synthesize(level, out);

    if (opts.persist && run.premortem && out.premortem.risks.length) {
      out.persisted = DecisionRiskService.record(orgId, { decisionId: input.decisionId ?? null, source: "premortem", risks: out.premortem.risks });
    }
    return out;
  }

  /** Pre-Mortem: "assuma que falhou — por quê?". Riscos derivados por regra. */
  private static premortem(input: DecisionInput, evidence: any): PredictedRisk[] {
    const risks: PredictedRisk[] = [];
    const dtype = input.decisionType || "generic";
    const spends = input.impactUnit === "BRL" && Number(input.impactAmount) > 0;
    const amount = Number(input.impactAmount) || 0;
    const fin = evidence?.internalEvidence?.finance;
    const finOk = fin && fin.available !== false;
    const caixa = finOk ? Number(fin?.caixa?.value) || 0 : 0;
    const survivalDays = finOk && fin?.previsaoCaixa?.survivalDays != null ? Number(fin.previsaoCaixa.survivalDays) : null;

    // 1) Pressão de caixa (decisões que gastam).
    if (spends) {
      const ratio = caixa > 0 ? amount / caixa : null;
      let probability: PredictedRisk["probability"] = "low";
      if ((survivalDays != null && survivalDays < 30) || (ratio != null && ratio > 0.5)) probability = "high";
      else if (ratio != null && ratio > 0.25) probability = "medium";
      const severity: PredictedRisk["severity"] = survivalDays != null && survivalDays < 15 ? "critical" : probability === "high" ? "risk" : probability === "medium" ? "attention" : "info";
      risks.push({
        description: `Pressão de caixa: comprometer ${brl(amount)}${ratio != null ? ` (~${Math.round(ratio * 100)}% do caixa atual)` : ""} pode faltar liquidez${survivalDays != null ? ` (fôlego atual ~${survivalDays} dias)` : ""}.`,
        probability, severity, impactAmount: amount, impactUnit: "BRL",
        leadingIndicator: "saldo_projetado_caixa",
        threshold: "saldo projetado < 0 nas próximas semanas",
        mitigation: "Faseie o desembolso e/ou antecipe recebíveis antes de comprometer o valor cheio.",
        dedupeKey: `${dtype}:cash_pressure`,
      });
    }

    // 2) Demanda/retorno abaixo do esperado.
    if (dtype === "purchase" || dtype === "campaign" || dtype === "investment" || dtype === "expansion" || spends) {
      const isCampaign = dtype === "campaign";
      risks.push({
        description: isCampaign ? "Conversão abaixo do esperado: a campanha pode não converter no ritmo assumido." : "Demanda/giro abaixo do esperado: o retorno pode vir mais devagar que a projeção.",
        probability: "medium", severity: "attention",
        leadingIndicator: isCampaign ? "conversion_rate" : "giro_primeiras_semanas",
        threshold: isCampaign ? "conversão < 18% na 1ª semana" : "giro < 50% do previsto em 3 semanas",
        mitigation: isCampaign ? "Comece com verba menor e escale conforme a conversão observada." : "Compre/execute em lotes e condicione a continuação ao giro real.",
        dedupeKey: `${dtype}:demand_below_expected`,
      });
    }

    // 3) Dados incompletos (baixa confiança da evidência).
    if (evidence?.confidence != null && evidence.confidence < 0.6) {
      risks.push({
        description: `Decisão sobre dados incompletos: a confiança das evidências está em ${Math.round(evidence.confidence * 100)}%.`,
        probability: "medium", severity: "attention",
        leadingIndicator: "qualidade_dados", threshold: "confiança < 60%",
        mitigation: "Complete caixa/vendas/custos antes de comprometer valores altos.",
        dedupeKey: `${dtype}:data_incomplete`,
      });
    }

    // 4) Piora de riscos já existentes (top prioridades do negócio).
    const pri = Array.isArray(evidence?.topPriorities) ? evidence.topPriorities.slice(0, 2) : [];
    pri.forEach((p: any, i: number) => {
      const t = p?.title || p?.fact || "risco existente";
      risks.push({
        description: `Interação com risco existente: "${t}"${p?.risco ? ` — ${p.risco}` : ""}.`,
        probability: "medium", severity: "attention",
        leadingIndicator: "prioridade_aberta", threshold: "prioridade segue aberta ao executar",
        mitigation: p?.action || "Enderece a prioridade existente antes ou em paralelo à decisão.",
        dedupeKey: `${dtype}:pre_existing:${i}`,
      });
    });

    return risks;
  }

  /** Red Team: desafia as premissas (fato ≠ estimativa; evidência insuficiente). */
  private static redTeam(input: DecisionInput, evidence: any): any[] {
    const challenges: any[] = [];
    const premises = input.premises || [];
    for (const pr of premises) {
      const weak = pr.basis === "estimate" || (pr.confidence != null && pr.confidence < 0.6) || pr.hasEvidence === false;
      if (weak) challenges.push({ premise: pr.label, issue: "Premissa estimada / com evidência insuficiente — trate como hipótese a validar.", severity: "attention" });
    }
    // Valor esperado sem nenhuma premissa de FATO que o sustente (espelha PRD §32).
    if (input.expectedValue != null && !premises.some((p) => p.basis === "fact")) {
      challenges.push({ premise: "valor esperado", issue: "A projeção depende de premissa sem evidência suficiente.", severity: "risk" });
    }
    if (evidence?.confidence != null && evidence.confidence < 0.6) {
      challenges.push({ premise: "base de dados", issue: `Confiança dos dados abaixo de 60% (${Math.round(evidence.confidence * 100)}%).`, severity: "attention" });
    }
    if (!premises.length) {
      challenges.push({ premise: "premissas", issue: "Decisão sem premissas declaradas para desafiar — explicite o que está assumindo.", severity: "info" });
    }
    return challenges;
  }

  /** Advocate: sustenta a decisão — tese + evidências favoráveis + upside. */
  private static advocate(input: DecisionInput, evidence: any, scenarios: any): any {
    const fin = evidence?.internalEvidence?.finance;
    const finOk = fin && fin.available !== false;
    const support: string[] = [];
    if (finOk && Number(fin?.caixa?.value) > 0) support.push(`Caixa atual positivo (${brl(fin.caixa.value)}).`);
    if (finOk && fin?.dre?.margemPct != null) support.push(`Margem atual de ${fin.dre.margemPct}%.`);
    if (scenarios?.ok) support.push(`Cenário base projeta ${brl(scenarios.base.value)} (upside até ${brl(scenarios.aggressive.value)}).`);
    if (evidence?.confidence != null) support.push(`Confiança das evidências: ${Math.round(evidence.confidence * 100)}%.`);
    return {
      thesis: `"${input.title}" tende a valer se o retorno esperado se confirmar e a execução for acompanhada.`,
      support,
      expectedValue: input.expectedValue ?? (scenarios?.ok ? scenarios.base.value : null),
      upside: scenarios?.ok ? scenarios.aggressive.value : null,
    };
  }

  /** Síntese determinística: postura + porquê (advisória — gate real é o RBAC). */
  private static synthesize(level: any, out: any): any {
    const highRisks = (out.premortem?.risks || []).filter((r: any) => r.probability === "high" || r.severity === "risk" || r.severity === "critical");
    const redFlags = (out.redTeam?.challenges || []).filter((c: any) => c.severity === "risk" || c.severity === "critical");

    let stance: string;
    let headline: string;
    if (level.n >= 4) { stance = "hold_for_human"; headline = "Decisão crítica: exige aprovação humana antes de executar."; }
    else if (highRisks.length || redFlags.length) { stance = "proceed_with_caution"; headline = "Prosseguir com cautela: há riscos altos ou premissas frágeis a mitigar primeiro."; }
    else { stance = "proceed"; headline = "Prosseguir com acompanhamento: sem riscos altos ou premissas frágeis identificados."; }

    const why: string[] = [];
    for (const r of highRisks.slice(0, 3)) why.push(r.description);
    for (const c of redFlags.slice(0, 2)) why.push(`${c.premise}: ${c.issue}`);
    return { stance, headline, why, advisory: true, note: "Recomendação advisória — o gate de execução continua no RBAC/ApprovalPolicy." };
  }
}

export default DecisionEngine;
