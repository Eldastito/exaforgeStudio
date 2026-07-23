import { chat } from "./llm.js";
import db from "./db.js";
import { BusinessContextService } from "./BusinessContextService.js";
import { RevenueAuditService } from "./RevenueAuditService.js";
import { BusinessSnapshotV2Service } from "./BusinessSnapshotV2Service.js";

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
   * Sob feature-flag `diretor_snapshot_v2`, ANEXA o panorama financeiro V2
   * (caixa/DRE/previsão/retiradas) — ADR-135, Epic 1. Desligada por padrão:
   * organizações existentes não mudam de comportamento.
   */
  static buildPanorama(orgId: string): string {
    const base = BusinessContextService.build(orgId);
    return base + this.financeBlockV2(orgId);
  }

  private static financeBlockV2(orgId: string): string {
    try {
      const s = db.prepare("SELECT diretor_snapshot_v2 FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      if (!s || !Number(s.diretor_snapshot_v2)) return "";
      const snap = BusinessSnapshotV2Service.build(orgId);
      return `\n\n=== PANORAMA FINANCEIRO V2 (determinístico) ===
Use EXATAMENTE estes números (caixa, contas, DRE, previsão, retiradas). NUNCA invente valores; se um campo faltar ou vier available:false, diga explicitamente que o dado não está disponível.
FINANÇAS: ${JSON.stringify(snap.domains?.finance || {})}
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
