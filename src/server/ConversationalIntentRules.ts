/**
 * ConversationalIntentRules — regras PURAS (sem DB, sem IA) de intenção conversacional (PRD Fase 2 / ADR-203, F2.1).
 *
 * Existem porque o FalaTu (`FalaTuAskService.classify`) e o roteador do Diretor IA (`ExecutiveQueryRouterService.detect`) precisam
 * concordar sobre o que é uma PERGUNTA DE DECISÃO e um PEDIDO DE CAMPANHA — antes cada um decidia sozinho e o probe da F2.0 mostrou
 * dois erros: "Estou pensando em comprar R$180 mil… o fornecedor quer 30% de entrada… Analisa" virava LANÇAMENTO DE DESPESA (a palavra
 * "fornecedor" casa o cue de despesa) e "Crie uma campanha para quem não compra há 90 dias" virava ANÁLISE DE DECISÃO (o "90" casava como
 * dinheiro). Uma definição por regra (PRD §40): quem mudar muda nos dois.
 *
 * Guardrails: determinístico antes de LLM; dinheiro só com MARCA explícita (R$, reais, mil/milhão/k, milhar com ponto) — número solto
 * ("90 dias", "30%") NUNCA é dinheiro; registro explícito ("lança a despesa…", "paguei…") continua sendo registro.
 */
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Valor monetário com marca explícita. "90 dias" e "30%" não contam. */
export function hasMoneyMarker(text: string): boolean {
  const t = norm(text);
  return /r\$/.test(t) || /\breais\b/.test(t) || /\d\s*(milhao|milhoes|mil\b|mi\b|k\b)/.test(t) || /\d{1,3}(\.\d{3})+/.test(t);
}

const RECORD_VERB_START = /^\s*(grava|gravar|anota|anotar|registra|registrar|guarda|guardar|salva|salvar|cadastra|cadastrar|lanca|lancar|paguei|gastei)\b/;
const CAMPAIGN_RE = /\b(cri[ae]r?|monte|montar|faz|fazer|gere|gerar|prepare|preparar|lance|lancar|dispare|disparar)\b.{0,40}\bcampanha\b|\bcampanha\s+(para|pra|de)\b/;

/** "Crie uma campanha para quem não compra há 90 dias" — pedido de CAMPANHA (nunca decisão financeira nem despesa). */
export function isCampaignRequest(text: string): boolean {
  return CAMPAIGN_RE.test(norm(text));
}

/** Dias de inatividade citados ("há 90 dias", "90 dias sem comprar"); null = não disse. */
export function inactiveDaysFrom(text: string): number | null {
  const m = norm(text).match(/(\d{1,4})\s*dias/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pergunta de DECISÃO de compra/investimento ("estou pensando em comprar R$ 180 mil… 30% de entrada… analisa").
 * Exige: valor com marca + verbo de compra/investimento + (condições do negócio OU cue de decisão) e NÃO ser registro explícito
 * nem pedido de campanha. "Posso comprar R$ 180 mil?" puro continua com o simulador (sem condições/cue de análise).
 */
export function isDecisionInquiry(text: string): boolean {
  const t = norm(text);
  if (RECORD_VERB_START.test(t) || isCampaignRequest(t)) return false;
  if (!hasMoneyMarker(t) || !/(compr|invest)/.test(t)) return false;
  const conditions = /(entrada|parcel|prazo|\d+\s*(dias|meses)|\d+\s*%|a prazo)/.test(t);
  const cue = /(pensando em|considerando|avaliando|planejo|pretendo|estou vendo|queria comprar|analis[ae]|avalia\b|vale a pena)/.test(t);
  return conditions || cue;
}
