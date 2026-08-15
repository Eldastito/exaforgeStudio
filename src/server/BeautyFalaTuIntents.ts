/**
 * BeautyFalaTuIntents (ADR-169 F15 / BEAUTY-016) — classificador
 * DETERMINÍSTICO de intenções beauty pra entradas do Fala Tu.
 *
 * ONDE ENTRA: como HELPER opt-in — o `FalaTuService` continua produzindo
 * `FalaTuIntent` genérico (TASK|EVENT|LIST|NOTE|UNKNOWN); esta camada
 * adicional detecta, POR CIMA, uma intenção BEAUTY quando a org é da
 * vertical `beleza` E o texto casa com padrões conhecidos do salão. Assim
 * evitamos regredir o extrator global (que serve TODAS as verticais) e
 * ainda entregamos o valor esperado da fatia: rotinas beauty-specific
 * disparadas pela conversa natural.
 *
 * POR QUE DETERMINÍSTICO (§32 do PRD + convenção do repo):
 *  - Roda em CI sem chave de IA (0 LLM, 0 rede)
 *  - Auditável: cada regra é um regex que o dono pode ler
 *  - Rápido e barato — vai no caminho quente do Fala Tu
 *  - Extrator LLM continua fazendo o pesado pra domínios sem padrão fixo
 *
 * INTENTS RECONHECIDAS (mínimo viável — a lista cresce por evidência de uso):
 *  - `BEAUTY_SIMULATE`: pedido de simulação visual do salão
 *      ex.: "quero simular mechas na Ana", "vamos ver como fica um bob nela",
 *           "faz uma simulação de coloração pra Ana amanhã"
 *  - `BEAUTY_BOOK`: pedido de agendamento com viés beauty (não substitui
 *      EVENT genérico do FalaTu; ADICIONA rotulagem do domínio)
 *      ex.: "marca a Ana pra fazer escova sábado 10h",
 *           "agenda coloração pra Bia semana que vem"
 *  - `BEAUTY_AVAILABILITY`: pergunta sobre gap/disponibilidade
 *      ex.: "tem horário livre pra Maria amanhã?",
 *           "onde ela consegue encaixar hoje?"
 *
 * ENTIDADES EXTRAÍDAS (best-effort, nunca inventa):
 *  - `contactName`: primeiro nome mencionado depois de gatilhos ("na", "pra",
 *     "com") — nunca busca no CRM aqui (routing é do Fala Tu principal);
 *     se não achou nome no texto, retorna null (RN-BS-11).
 *  - `serviceHint`: se o texto contém uma keyword da vocab de cor/corte do
 *     `LookServiceRecommendationService` (F9), retorna a keyword bruta
 *     (ex.: "mechas", "coloração", "escova", "chapinha"). O matching REAL
 *     de serviço fica com F9 no runtime; aqui é só uma dica.
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-11 (nunca infere): sem match limpo, `intent=null` (não força).
 *  - RN-BS-07 (isolamento): classificador não le DB — puro sobre string.
 *    O caller decide se ativa por org (checando `vertical=beleza`).
 *  - RN-BS-04: não extrai foto/base64/prompt — só rótulos de texto.
 *
 * POSTURA: OPT-IN. O `FalaTuService` NÃO É modificado por esta fatia
 * (0-regressão dura pras 8 verticais existentes que usam Fala Tu). Esta
 * camada é um HELPER que o caller (rota beauty, Autopilot fatia F11-B,
 * ou uma futura integração no fluxo `FalaTuHomeService`) invoca quando
 * quer o rotulamento adicional.
 */
import { KEYWORDS_COLOR, KEYWORDS_CUT } from "./LookServiceRecommendationService.js";

export const BEAUTY_INTENTS = ["BEAUTY_SIMULATE", "BEAUTY_BOOK", "BEAUTY_AVAILABILITY"] as const;
export type BeautyIntent = (typeof BEAUTY_INTENTS)[number];

export interface BeautyIntentClassification {
  intent: BeautyIntent | null;
  contactName: string | null;
  serviceHint: string | null;
}

// Ordem importa: SIMULATE tem prioridade sobre BOOK (se falar "quero
// simular e depois marcar", classifica como SIMULATE — a marcação vira
// F10 downstream).
const RE_SIMULATE = /\b(simula(r|ç[aã]o)?|(quer(o|ia)|posso)\s+(ver|testar|experimentar|prov[ao]r)|como\s+(fica(ria)?|ficaria)|imagin(ar|a)\s+como\s+fic)/i;
const RE_BOOK = /\b(marc(a|ar|ando)|agend(a|ar|ando)|encaix(a|ar|e|ando)|reserv(a|ar|ando)|book(ar|ando)?)\b/i;
const RE_AVAILABILITY = /\b(hor[aá]rio\s+livre|dispon[ií]bil?(idade|es|s)?|tem\s+(hor[aá]rio|vaga)|vaga(s)?\s+(livre|pra|com|hoje|amanh[aã]|semana)|quando\s+(ela|ele|voc[eê])?\s*(t[eé]m|tem)\s+livre)/i;

// Gatilhos comuns de pessoa em PT-BR de salão. Match do NOME logo depois.
// Inclui "a" solto (definite article, muito comum: "marca a Ana", "chama a
// Bia") + preposições/contrações. Aceita nome próprio simples (1 palavra,
// capitalizado) — não tenta juntar sobrenome (o CRM resolve downstream).
const RE_CONTACT = /\b(?:pra|para|com|na|no|à|ao|de|a)\s+([A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ][a-záàâãéêíóôõúüç]{1,20})\b/;

/**
 * Classifica uma entrada de texto BEAUTY. Determinístico, síncrono, sem
 * side-effect. Uso típico: o caller checa se `vertical=beleza` e chama
 * `classifyBeautyIntent(text)`; se `intent != null`, roteia pra fluxo
 * específico (ex.: propor `beauty_review_invite` action, abrir Beauty
 * AI, etc.).
 */
export function classifyBeautyIntent(text: string): BeautyIntentClassification {
  const t = String(text || "").trim();
  const empty: BeautyIntentClassification = { intent: null, contactName: null, serviceHint: null };
  if (!t) return empty;

  const serviceHint = findServiceHint(t);
  const contactName = findContactName(t);

  // Prioridade: SIMULATE > BOOK > AVAILABILITY
  if (RE_SIMULATE.test(t)) return { intent: "BEAUTY_SIMULATE", contactName, serviceHint };
  if (RE_AVAILABILITY.test(t)) return { intent: "BEAUTY_AVAILABILITY", contactName, serviceHint };
  if (RE_BOOK.test(t) && (serviceHint || /(salã|salao|beleza|cabelo|corte|escova|coloraç|mecha)/i.test(t))) {
    // BOOK exige um "cheiro beauty" (serviceHint OU palavra do domínio) pra
    // não canibalizar o EVENT genérico do FalaTu (RN-BS-11: se não tem sinal
    // beauty, deixa o extrator geral cuidar).
    return { intent: "BEAUTY_BOOK", contactName, serviceHint };
  }

  return empty;
}

function findServiceHint(text: string): string | null {
  const low = String(text || "").toLowerCase();
  for (const kw of KEYWORDS_COLOR) if (low.includes(kw)) return kw;
  for (const kw of KEYWORDS_CUT) if (low.includes(kw)) return kw;
  return null;
}

function findContactName(text: string): string | null {
  const m = String(text || "").match(RE_CONTACT);
  if (!m || !m[1]) return null;
  // Filtra palavras comuns capitalizadas por acidente ou início-de-frase que
  // não são nome (whitelist simples via keywords de serviço/lista).
  const w = m[1];
  const lw = w.toLowerCase();
  const isServiceWord = KEYWORDS_COLOR.includes(lw) || KEYWORDS_CUT.includes(lw);
  if (isServiceWord) return null;
  // Palavras temporais frequentes ("Amanhã", "Hoje", "Segunda"...) — se o
  // "nome" for essas, ignora. NORMALIZA acentos primeiro (NFD + strip
  // diacríticos) pra evitar armadilhas de encoding (ã composto vs
  // decomposto): "Amanhã" pode chegar em qualquer forma dependendo do
  // canal; comparar sem acento é determinístico.
  const nfdBare = lw.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Inclui "amanh" (sem vogal final) — quando o RE_CONTACT captura só a
  // parte base do nome (ex.: "Amanhã" quebrada em "Amanh" por char-class
  // que não pega diacrítico combinante), o filtro ainda barra.
  if (/^(hoje|amanh|amanha|ontem|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana|manh|manha|tarde|noite)$/.test(nfdBare)) return null;
  return w;
}
