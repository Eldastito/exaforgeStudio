import { chat } from "./llm.js";

// Injeção pra testes (ESM modules são frozen — setter isolado por módulo).
let _chat: typeof chat = chat;
export function __setSalesReplyChatForTests(fn: typeof chat | null): void { _chat = fn || chat; }

/**
 * Classificador de intent pra RESPOSTAS de recuperação comercial
 * (ADR-152 F4c.2). Padrão idêntico ao `CollectionIntentClassifier` do
 * F4b.2: JSON mode + whitelist estrita + fallback `unknown` (3 casos:
 * OPENAI_API_KEY ausente, chat throw, LLM devolve valor fora do enum).
 *
 * 7 intents (§14 do PRD):
 *   - `interested`      → demonstra interesse ativo ("sim vamos", "manda info")
 *   - `meeting_request` → pede reunião/agenda ("marcamos?", "podemos falar hoje?")
 *   - `not_now`         → adia ("agora não", "próximo mês", "só depois das férias")
 *   - `objection`       → objeção específica (preço, timing, autoridade)
 *   - `remove_me`       → opt-out LGPD ("para de me mandar msg", "sair da lista")
 *   - `already_bought`  → resolveu de outro jeito ("já comprei", "já resolvi")
 *   - `unknown`         → fallback
 *
 * Guardas F4c.2-C:
 *   G-4c.2-C-1: nunca lança — devolve `unknown` em erro.
 *   G-4c.2-C-2: whitelist estrita — nenhum intent inventado.
 *   G-4c.2-C-3: `remove_me` PRIORIZADO acima de outros — dúvida
 *               semântica com "pare" resolve pra opt-out (LGPD é
 *               interpretação mais protetiva pro cliente).
 */

export const SALES_REPLY_INTENT_LABELS = [
  "interested",
  "meeting_request",
  "not_now",
  "objection",
  "remove_me",
  "already_bought",
  "unknown",
] as const;

export type SalesReplyIntent = (typeof SALES_REPLY_INTENT_LABELS)[number];

export interface SalesReplyClassificationResult {
  intent: SalesReplyIntent;
  confidence: number;
  rationale: string;
}

const WHITELIST: Set<string> = new Set(SALES_REPLY_INTENT_LABELS as unknown as string[]);

const SYSTEM_PROMPT = `Você é um classificador de RESPOSTAS a um contato de RECUPERAÇÃO COMERCIAL em PT-BR.

Contexto: a empresa enviou UMA mensagem tentando retomar uma conversa comercial (proposta, orçamento, negociação) que estava parada. O cliente respondeu — sua tarefa é classificar a INTENÇÃO da resposta.

Devolva EXCLUSIVAMENTE um JSON:
  {"intent": "<one_of_enum>", "reason": "<uma frase curta>"}

Enum (use um deles literalmente):
  - "interested"      → cliente demonstra INTERESSE ATIVO em continuar. Ex.: "Sim, vamos!", "Manda os detalhes", "Ainda tenho interesse".
  - "meeting_request" → cliente PEDE UMA REUNIÃO / call / conversa marcada. Ex.: "Podemos conversar amanhã?", "Marca uma reunião", "Me liga às 14h".
  - "not_now"         → cliente ADIA / diz que não é hora. Ex.: "Agora não é hora", "Semana que vem", "Só depois do fim do ano".
  - "objection"       → cliente traz uma OBJEÇÃO específica (preço, timing, prioridade, autoridade). Ex.: "Está caro demais", "Não tenho verba", "Preciso falar com meu sócio", "Não é prioridade agora".
  - "remove_me"       → cliente pede pra NÃO RECEBER MAIS mensagens (opt-out LGPD). Ex.: "Para de me mandar msg", "Sair da lista", "Não me contate mais", "Cancela isso aí".
  - "already_bought"  → cliente resolveu de outro jeito. Ex.: "Já comprei em outro lugar", "Já fechei com concorrente", "Já resolvi".

Regras rígidas:
- Escolha SEMPRE a intenção que MELHOR descreve. Se ambígua ou não parece resposta de recuperação, devolva "intent" fora do enum.
- Se a mensagem contém "para", "cancela", "não me manda mais" — SEMPRE priorize "remove_me" (LGPD, interpretação protetiva).
- Ordem de prioridade quando há múltiplas intenções: remove_me > already_bought > meeting_request > interested > objection > not_now.
- "reason" ≤ 15 palavras em PT-BR.
- NÃO devolva markdown, prefixos ou texto fora do JSON.`;

export async function classify(text: string): Promise<SalesReplyClassificationResult> {
  const sample = String(text || "").trim().slice(0, 500);
  if (!sample) return { intent: "unknown", confidence: 0, rationale: "mensagem vazia" };
  if (!process.env.OPENAI_API_KEY) {
    return { intent: "unknown", confidence: 0, rationale: "LLM indisponível (OPENAI_API_KEY ausente)" };
  }

  let raw = "";
  try { raw = await _chat(sample, { system: SYSTEM_PROMPT, json: true, temperature: 0 }); }
  catch (e: any) { return { intent: "unknown", confidence: 0, rationale: `LLM erro: ${e?.message || e}` }; }

  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* deixa null */ }
  if (!parsed || typeof parsed !== "object") {
    return { intent: "unknown", confidence: 0, rationale: "resposta LLM não é JSON válido" };
  }

  const rawIntent = String(parsed.intent || "").trim();
  const rationale = String(parsed.reason || "").trim().slice(0, 200);
  if (!WHITELIST.has(rawIntent) || rawIntent === "unknown") {
    return { intent: "unknown", confidence: 0, rationale: rationale || "intent fora do enum" };
  }

  return { intent: rawIntent as SalesReplyIntent, confidence: 0.9, rationale: rationale || "classificado pelo LLM" };
}

export const SalesRecoveryReplyClassifier = { classify, SALES_REPLY_INTENT_LABELS };
export default SalesRecoveryReplyClassifier;
