import { chat, isAIConfigured } from "./llm.js";

// Narrativa em prosa do diagnóstico do Radar (Fase 4, ADR-016). Regra
// não-negociável do PRD do módulo (§3): nenhuma IA generativa decide
// score/maturidade/prioridade — isso já foi TODO calculado de forma
// determinística por RadarScoringEngine.ts antes de chegar aqui. Esta função
// só pede para a IA REDIGIR um resumo em português a partir dos números já
// prontos, nunca para recalculá-los ou inventar dados que não estejam no
// JSON enviado. Se a IA não estiver configurada (sem OPENAI_API_KEY) ou a
// chamada falhar, devolve null — o relatório em PDF continua funcionando
// normalmente sem a seção de narrativa, nunca quebra por causa disso.

const PILLAR_LABEL: Record<string, string> = {
  estrategia: "Estratégia e liderança",
  receita: "Receita e atendimento",
  processos: "Processos operacionais",
  dados: "Dados e integração",
  pessoas: "Pessoas e capacitação",
  governanca: "Governança e segurança",
  metricas: "Métricas e ROI",
};

const SYSTEM_PROMPT = `Você é um redator técnico que resume diagnósticos de maturidade em IA para donos de negócio não-técnicos.
Regras rígidas:
1. Use SOMENTE os dados fornecidos no JSON abaixo. NUNCA invente número, score, pilar ou recomendação que não esteja lá.
2. NUNCA sugira um score diferente do informado, nem "corrija" ou reinterprete os números — eles já foram calculados de forma determinística e não podem mudar.
3. Escreva em português do Brasil, tom direto e profissional, sem jargão técnico de IA.
4. Estruture em 3 parágrafos curtos: (1) onde a empresa está hoje (score geral e nível de maturidade), (2) o maior gap/oportunidade (cite o pilar mais fraco pelo nome), (3) o próximo passo recomendado (cite a recomendação de maior prioridade, se houver).
5. Máximo de 220 palavras. Sem títulos, sem marcadores — só os 3 parágrafos.`;

export async function generateNarrative(payload: {
  companyName: string | null;
  overallScore: number | null;
  maturityLevel: string | null;
  confidenceScore: number | null;
  pillarScores: { pillar: string; score: number | null }[];
  topRecommendation: { use_case_name: string; priority_band: string } | null;
}): Promise<string | null> {
  if (!isAIConfigured()) return null;

  const data = {
    empresa: payload.companyName || "a empresa",
    scoreGeral: payload.overallScore,
    nivelMaturidade: payload.maturityLevel,
    confianca: payload.confidenceScore,
    pilares: payload.pillarScores.map((p) => ({ nome: PILLAR_LABEL[p.pillar] || p.pillar, score: p.score })),
    recomendacaoPrincipal: payload.topRecommendation
      ? { titulo: payload.topRecommendation.use_case_name, prioridade: payload.topRecommendation.priority_band }
      : null,
  };

  try {
    const text = await chat(JSON.stringify(data), { system: SYSTEM_PROMPT, temperature: 0.3 });
    return text.trim() || null;
  } catch (e) {
    console.error("[RadarNarrative] Falha ao gerar narrativa (relatório segue sem essa seção):", e);
    return null;
  }
}
