import { chat } from "./llm.js";
import db from "./db.js";
import { BusinessContextService } from "./BusinessContextService.js";
import { RevenueAuditService } from "./RevenueAuditService.js";
import { BusinessSnapshotV2Service } from "./BusinessSnapshotV2Service.js";
import { RetailPatternMemoryService } from "./RetailPatternMemoryService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { PatternMemoryService } from "./PatternMemoryService.js";
import { ModuleService } from "./ModuleService.js";
import { RetailCommissionService } from "./RetailCommissionService.js";
import { UpgradeRecommendationService } from "./UpgradeRecommendationService.js";
import { PlanService } from "./PlanService.js";

/**
 * Diretor Executivo IA / Central de Agentes (Fase A da visão de SO Empresarial).
 *
 * O gestor pergunta em linguagem natural; o serviço monta o PANORAMA REAL do
 * negócio (BusinessContextService — números determinísticos, read-only) e a IA
 * APENAS narra e recomenda com base nele. Regra de ouro: nunca inventa número.
 */
export class ExecutiveAdvisorService {
  private static readonly GUARDRAILS = `Você é o DIRETOR EXECUTIVO IA do negócio — um conselheiro de gestão direto e prático.
REGRAS:
- Baseie-se SOMENTE nos números do PANORAMA abaixo. NUNCA invente métricas, valores ou fatos.
- Se faltar dado para responder algo, diga claramente o que falta (ex.: "ainda não há dados de X").
- Cite números concretos do panorama ao explicar.
- Seja conciso e termine com uma lista curta de AÇÕES PRIORIZADAS (no máximo 5), da mais impactante para a menos.
- Tom de conselheiro de confiança: honesto, sem enrolação, sem jargão.`;

  /**
   * Panorama consumido pelo Diretor. Base = BusinessContextService (compatível).
   * Sob feature-flag `diretor_snapshot_v2`, ANEXA o panorama V2 por DOMÍNIO
   * (finanças, vendas, estoque, compras, operação, tarefas) — ADR-135, Epic 1.
   * Desligada por padrão: organizações existentes não mudam de comportamento.
   */
  static buildPanorama(orgId: string): string {
    const base = BusinessContextService.build(orgId);
    return base + this.snapshotBlockV2(orgId) + this.retailPatternsBlock(orgId) + this.retailCommissionBlock(orgId) + this.businessSignalsBlock(orgId) + this.learnedEffectivenessBlock(orgId) + this.planRecommendationsBlock(orgId);
  }

  /**
   * ADR-153 F7.5 — bloco de recomendações de upgrade + plano atual + cooldowns.
   *
   * Quando dono pergunta "vale a pena upgrade?", "quanto custa o próximo plano?",
   * "estou perto do limite?", a IA precisa citar EVIDÊNCIA REAL — não improvisar.
   * Este bloco expõe:
   *   1. Plano atual (id, preço mensal).
   *   2. Recomendações PENDING (score + uplift BRL + target + módulo se gap).
   *   3. Recomendações DISMISSED com cooldown ATIVO (dias restantes) — LGPD §14:
   *      IA respeita a pausa; se dono perguntar, cita mas explica que está pausada.
   *   4. Recomendações ACCEPTED aguardando checkout (dono aceitou mas não finalizou).
   *
   * Framing (embutido no cabeçalho do bloco):
   *   - G-153-3: IA sugere clicar em "Cobrança"; NUNCA executa upgrade.
   *   - G-153-6: score é determinístico (motor F7.2); não inventar dimensão.
   *   - LGPD §14: cooldown ativo é rejeição — não pressionar.
   *
   * Bloco só aparece se há dados a citar (evita ruído em org sem recomendações).
   */
  static planRecommendationsBlock(orgId: string): string {
    try {
      // Plano atual (nome + preço) — contexto pra IA responder "quanto custa X"
      // sem depender de recomendação existente.
      const plan = PlanService.getCurrentPlan(orgId);
      const planLine = plan
        ? `- Plano atual: ${plan.name} (${plan.id}) — R$ ${Number(plan.price || 0).toFixed(2)}/mês`
        : "- Plano atual: sem dado";

      // Filtra o ledger: pending, dismissed com cooldown ATIVO, accepted.
      // includeExpired=false porque expired é ruído (não tem cooldown ativo).
      const recs = UpgradeRecommendationService.list(orgId, { includeExpired: false, limit: 30 });
      const nowIso = new Date().toISOString();
      const pending = recs.filter((r) => r.status === "pending");
      const dismissedActive = recs.filter(
        (r) => r.status === "dismissed" && r.cooldownUntil && r.cooldownUntil > nowIso,
      );
      const accepted = recs.filter((r) => r.status === "accepted");

      if (pending.length === 0 && dismissedActive.length === 0 && accepted.length === 0) {
        // Sem sinais → bloco mínimo (só plano atual) pra IA poder responder
        // "quanto custa hoje" mesmo sem recomendação. Não incluir cabeçalho
        // longo evita o modelo achar que tem 100 recomendações a citar.
        return `\n\n=== PLANO E RECOMENDAÇÕES DE UPGRADE (fatos; nenhuma recomendação ativa no momento) ===
${planLine}`;
      }

      const fmtRec = (r: any) => {
        const target = r.targetModuleKey
          ? `módulo "${r.targetModuleKey}" (via plano ${r.targetPlanId || "?"})`
          : `plano ${r.targetPlanId || "?"}`;
        const uplift = r.impactAmount != null && r.impactAmount > 0
          ? `, ganho ≈R$ ${Number(r.impactAmount).toFixed(0)}/mês`
          : "";
        const score = r.score > 0 ? `, score ${r.score}/100` : "";
        return `${target}${score}${uplift}`;
      };

      const lines: string[] = [planLine];

      if (pending.length > 0) {
        lines.push("- Pendentes (dono ainda não decidiu):");
        for (const r of pending.slice(0, 8)) lines.push(`   · ${fmtRec(r)}`);
      }

      if (dismissedActive.length > 0) {
        // Formato: cooldown restante em dias. IA respeita — não sugere de novo,
        // mas se dono perguntar direto, cita e explica que está pausada.
        lines.push("- Pausadas por rejeição recente (LGPD §14 — NÃO sugerir; se dono perguntar, dizer que está pausada):");
        for (const r of dismissedActive.slice(0, 8)) {
          const daysLeft = Math.ceil(
            (new Date(r.cooldownUntil!).getTime() - Date.now()) / (24 * 3600 * 1000),
          );
          lines.push(`   · ${fmtRec(r)} — pausada por mais ${daysLeft}d (${r.rejectionCount}ª rejeição)`);
        }
      }

      if (accepted.length > 0) {
        lines.push("- Aceitas aguardando checkout (dono aceitou mas ainda não finalizou em Cobrança):");
        for (const r of accepted.slice(0, 5)) lines.push(`   · ${fmtRec(r)}`);
      }

      return `\n\n=== PLANO E RECOMENDAÇÕES DE UPGRADE (fatos do ledger \`upgrade_recommendations\` — NUNCA invente score/uplift/cooldown; G-153-3: sugerir clicar em "Cobrança", NUNCA executar upgrade) ===
${lines.join("\n")}`;
    } catch (e) {
      // Best-effort — se o service falhar, IA continua respondendo sem esse bloco.
      console.error("[ExecutiveAdvisorService] planRecommendationsBlock falhou (best-effort)", e);
      return "";
    }
  }

  /**
   * VENDAS POR VENDEDOR do mês corrente (Retail Ops): permite o Diretor
   * responder "quanto o Marcos vendeu esse mês?" pelo WhatsApp com dado real —
   * fusão de ZappFlow + lançamento manual/foto + ERP + PDV, já respeitando a
   * loja de cada vendedor e a exclusão de PDV anômalo (`seller_source=manual`,
   * ver RetailCommissionService.salesBySellerStore). Só entra quando o módulo
   * `retail` está ativo; lista os TOP vendedores por venda (não o negócio
   * inteiro) para não estourar o contexto do prompt.
   */
  static retailCommissionBlock(orgId: string): string {
    try {
      if (!ModuleService.isEnabled(orgId, "retail")) return "";
      const now = new Date();
      const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const end = now.toISOString().slice(0, 10);
      const rows = RetailCommissionService.salesBySellerStore(orgId, start, end);
      if (!rows.length) return "";
      const top = [...rows].sort((a, b) => b.sales - a.sales).slice(0, 20);
      const lines = top.map((r) => `- ${r.sellerName} (${r.storeName}): R$ ${r.sales.toFixed(2)} em vendas, ${r.pecas} peça(s), ${r.orders} venda(s)`);
      return `\n\n=== VENDAS POR VENDEDOR — mês corrente ${start} a ${end} (fatos reais; se o vendedor perguntado não estiver na lista, diga que não há dado dele nesse período, NUNCA invente valor) ===\n${lines.join("\n")}`;
    } catch { return ""; }
  }

  /**
   * "O QUE COSTUMA FUNCIONAR" (ADR-142 Fatia 3, generalizada): a eficácia APRENDIDA
   * por tipo de ação, de TODOS os domínios (genéricos + varejo). Cada desfecho que
   * o dono registrou (funcionou/sem efeito/piorou) ajusta a eficácia do tipo; aqui
   * o Diretor passa a saber, com base no HISTÓRICO do próprio negócio, quais ações
   * costumam resolver — para priorizar o que funciona. Fatos, nunca invente número.
   */
  static learnedEffectiveness(orgId: string): any[] {
    const rows: any[] = [];
    try { for (const r of PatternMemoryService.allTypeStats(orgId)) rows.push({ ...r }); } catch { /* noop */ }
    try { for (const r of RetailPatternMemoryService.allTypeStats(orgId)) rows.push({ domain: "retail_ops", ...r }); } catch { /* noop */ }
    return rows
      .filter((r) => Number(r.acted) > 0)
      .map((r) => ({
        domain: r.domain, patternType: r.pattern_type,
        acted: Number(r.acted), worked: Number(r.worked), noEffect: Number(r.no_effect), backfired: Number(r.backfired),
        netImpact: Number(r.net_impact) || 0, effectiveness: Number(r.effectiveness) || 0,
        recommendedAction: ImpactPrioritizationService.actionFor(r.pattern_type).label,
      }))
      .sort((a, b) => (b.effectiveness - a.effectiveness) || (b.acted - a.acted));
  }

  static learnedEffectivenessBlock(orgId: string): string {
    try {
      const items = this.learnedEffectiveness(orgId);
      if (!items.length) return "";
      const lines = items.slice(0, 12).map((it) =>
        `- [${it.domain}] ${it.recommendedAction} (tipo ${it.patternType}): eficácia ${Math.round(it.effectiveness * 100)}% em ${it.acted} ação(ões) — funcionou ${it.worked}, sem efeito ${it.noEffect}, piorou ${it.backfired}`);
      return `\n\n=== O QUE COSTUMA FUNCIONAR (eficácia aprendida por tipo de ação; use p/ priorizar o que resolve; fatos) ===\n${lines.join("\n")}`;
    } catch { return ""; }
  }

  /**
   * PRIORIDADES DO NEGÓCIO (ADR-136): o Pareto dos sinais ABERTOS de TODOS os
   * domínios (finanças, produção, compras, pessoas, varejo, estoque, vendas…)
   * ranqueado por impacto — não só varejo. O Diretor narra e sugere a partir dos
   * fatos do ledger de sinais; NUNCA inventa número.
   */
  static businessSignalsBlock(orgId: string): string {
    try {
      const pri = ImpactPrioritizationService.prioritize(orgId, { globalLimit: 8 }).global;
      if (!pri.length) return "";
      const lines = pri.map((p: any) => {
        let imp = "";
        if (p.impact && Number(p.impact.amount) > 0) {
          if (p.impact.unit === "BRL") imp = ` (impacto R$ ${p.impact.amount})`;
          else if (p.impact.unit === "units") imp = ` (impacto ${p.impact.amount} un)`;
          else imp = ` (impacto ${p.impact.amount}${p.impact.unit ? ` ${p.impact.unit}` : ""})`;
        }
        const act = p.recommendedAction ? ` → ${p.recommendedAction}` : "";
        return `- [${p.domain}] ${p.interpretation || p.fact}${imp}${act}`;
      });
      return `\n\n=== PRIORIDADES DO NEGÓCIO (Pareto dos sinais abertos de todos os domínios; fatos, não invente número) ===\n${lines.join("\n")}`;
    } catch { return ""; }
  }

  /**
   * Padrões APRENDIDOS da(s) loja(s) (ADR-142 Fatia 2), sob a flag
   * `retail_pattern_memory`. Só os `validated` (confiança calculada por regra de
   * recorrência) entram — o Diretor passa a "conhecer" a loja. Desligada por
   * padrão. NUNCA vira ação automática (IA sugere, humano decide).
   */
  static retailPatternsBlock(orgId: string): string {
    try {
      if (!RetailPatternMemoryService.isEnabled(orgId)) return "";
      const patterns = RetailPatternMemoryService.list(orgId, { status: "validated" });
      if (!patterns.length) return "";
      const lines = patterns.slice(0, 12).map((p: any) => `- [${p.pattern_type}] ${p.description || ""} (confiança ${Math.round(Number(p.confidence) * 100)}%, visto ${p.occurrences}x)`);
      return `\n\n=== PADRÕES APRENDIDOS DA LOJA (recorrência determinística; use como contexto, não invente número) ===\n${lines.join("\n")}`;
    } catch { return ""; }
  }

  private static snapshotBlockV2(orgId: string): string {
    try {
      const s = db.prepare("SELECT diretor_snapshot_v2 FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      if (!s || !Number(s.diretor_snapshot_v2)) return "";
      const snap = BusinessSnapshotV2Service.read(orgId); // ADR-160 F2 — leitura cacheada quando o Evidence Layer está ligado
      return `\n\n=== PANORAMA EMPRESARIAL V2 (determinístico, por domínio) ===
Use EXATAMENTE estes números (finanças, vendas, estoque, compras, operação, tarefas). NUNCA invente valores; se um campo faltar ou vier available:false, diga explicitamente que o dado não está disponível.
DOMÍNIOS: ${JSON.stringify(snap.domains || {})}
PRIORIDADES: ${JSON.stringify(snap.topPriorities || [])}
QUALIDADE DOS DADOS: ${JSON.stringify(snap.dataQuality || {})}`;
    } catch { return ""; }
  }

  /** Responde uma pergunta do gestor usando o panorama real do negócio. */
  static async ask(orgId: string, question: string): Promise<string> {
    const q = String(question || "").trim();
    if (!q) return "Faça uma pergunta sobre o seu negócio (ex.: \"por que minhas vendas caíram?\").";
    const panorama = this.buildPanorama(orgId);
    const prompt = `${this.GUARDRAILS}

PANORAMA DO NEGÓCIO (dados reais, últimos 30 dias salvo indicação):
${panorama}

PERGUNTA DO GESTOR:
"${q}"

Sua resposta (com números do panorama + ações priorizadas):`;
    try {
      return (await chat(prompt, { temperature: 0.3 })).trim();
    } catch (e) {
      console.error("[DiretorIA] Falha ao responder:", e);
      return "Não consegui analisar agora. Tente novamente em instantes.";
    }
  }

  /**
   * Plano de Ação 30/60/90 da auditoria do RIC. Recebe o relatório montado pelo
   * RevenueAuditService e narra ações priorizadas em 3 horizontes:
   * - 30d (quick wins): liga/ajusta o que já existe no ZappFlow.
   * - 60d (estrutural): processo + cadências + ofertas direcionadas.
   * - 90d (estratégico): mudança de modelo (precificação, mix, segmentação).
   * Retorna texto estruturado — sem inventar número, citando o que o relatório
   * mostrou.
   */
  static async auditPlan(orgId: string): Promise<string> {
    const report = RevenueAuditService.build(orgId, "month");
    const summary = report.sections.map(s => `• ${s.title}: ${s.headline}`).join("\n");
    const prompt = `${this.GUARDRAILS}

RELATÓRIO DE AUDITORIA (Revenue Intelligence — 30 dias):
IQR ${report.headline.iqr}/100. Driver mais fraco: ${report.headline.weakestDriver}.
Potencial em risco: R$ ${report.headline.estimatedLoss.toFixed(2)} (recuperável R$ ${report.headline.recoverable.toFixed(2)}).
Receita já recuperada pelos fluxos do ZappFlow: R$ ${report.headline.recovered.toFixed(2)}.

DESTAQUES POR SEÇÃO:
${summary}

Gere o PLANO DE AÇÃO 30 / 60 / 90 dias EM 3 BLOCOS, cada um com:
- 30 DIAS — Quick wins. Ações que ligam ou afinam o que já existe (cadências, lembrete de PIX, recuperação de carrinho, follow-up de orçamento). MÁX 5 ações.
- 60 DIAS — Estruturais. Mudanças de processo (ofertas direcionadas a segmentos, ajuste de SLA, reativação de inativos). MÁX 4 ações.
- 90 DIAS — Estratégicas. Mexem no modelo (precificação, mix de produto, segmentação fina, integrações). MÁX 3 ações.

Para cada ação, escreva 1 linha começando com um verbo de comando e, quando fizer sentido, cite o número da auditoria que justifica (ex.: "porque IQR de Comercial está em 66, com X orçamentos parados"). NÃO invente números — use só os que aparecem acima.`;
    try {
      return (await chat(prompt, { temperature: 0.3 })).trim();
    } catch (e) {
      console.error("[DiretorIA] Falha no plano 30/60/90:", e);
      return "Não consegui gerar o plano agora. Tente novamente em instantes.";
    }
  }

  /**
   * Coordenador IA (Execution Intelligence) — assessora o COLABORADOR a entregar
   * uma tarefa: passos práticos + um roteiro de abordagem quando houver cliente.
   * Foco e baixo custo: usa só a tarefa + nome/segmento da empresa (sem o
   * panorama financeiro inteiro, que é coisa do Diretor).
   */
  static async taskAssist(orgId: string, task: { title: string; description?: string; contactName?: string; refLabel?: string }): Promise<string> {
    const title = String(task?.title || "").trim();
    if (!title) return "Sem tarefa para orientar.";
    let biz: any = {};
    try { biz = db.prepare("SELECT business_name, vertical FROM organization_settings WHERE organization_id = ?").get(orgId) || {}; } catch { biz = {}; }
    const ctx = [
      biz?.business_name ? `Empresa: ${biz.business_name}.` : "",
      biz?.vertical ? `Segmento: ${biz.vertical}.` : "",
      task.contactName ? `Cliente envolvido: ${task.contactName}.` : "",
      task.refLabel ? `Referência: ${task.refLabel}.` : "",
    ].filter(Boolean).join(" ");
    const prompt = `Você é o COORDENADOR IA — ajuda os colaboradores da empresa a executar tarefas com produtividade. Seja prático, direto e gentil.
${ctx}

TAREFA:
Título: ${title}
${task.description ? `Detalhes: ${task.description}` : ""}

Oriente o colaborador a entregar esta tarefa:
1. Um CHECKLIST objetivo (3 a 6 passos, em ordem).
2. Se a tarefa envolve falar com um cliente, um ROTEIRO curto de mensagem/abordagem (tom acolhedor, pronto para enviar).
3. Um lembrete final de 1 linha (o que NÃO esquecer).
Seja conciso. Não invente dados que você não tem.`;
    try {
      return (await chat(prompt, { temperature: 0.4 })).trim();
    } catch (e) {
      console.error("[CoordenadorIA] Falha ao assessorar tarefa:", e);
      return "Não consegui gerar a orientação agora. Tente novamente em instantes.";
    }
  }

  /** Briefing diário: o que vai bem, o que preocupa e as ações do dia. */
  static async briefing(orgId: string): Promise<string> {
    const panorama = this.buildPanorama(orgId);
    const prompt = `${this.GUARDRAILS}

PANORAMA DO NEGÓCIO (dados reais):
${panorama}

Gere o BRIEFING DE HOJE em 3 blocos curtos, com base SOMENTE no panorama:
1. ✅ O que está indo bem (1-3 pontos com número).
2. ⚠️ O que merece atenção (1-3 pontos com número).
3. 🎯 Ações prioritárias de hoje (até 5, objetivas).
Não invente nada; se faltar dado, indique.`;
    try {
      return (await chat(prompt, { temperature: 0.3 })).trim();
    } catch (e) {
      console.error("[DiretorIA] Falha no briefing:", e);
      return "Não consegui gerar o briefing agora.";
    }
  }
}
