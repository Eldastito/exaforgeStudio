import { chat } from "./llm.js";
import { BusinessContextService } from "./BusinessContextService.js";

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

  /** Responde uma pergunta do gestor usando o panorama real do negócio. */
  static async ask(orgId: string, question: string): Promise<string> {
    const q = String(question || "").trim();
    if (!q) return "Faça uma pergunta sobre o seu negócio (ex.: \"por que minhas vendas caíram?\").";
    const panorama = BusinessContextService.build(orgId);
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

  /** Briefing diário: o que vai bem, o que preocupa e as ações do dia. */
  static async briefing(orgId: string): Promise<string> {
    const panorama = BusinessContextService.build(orgId);
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
