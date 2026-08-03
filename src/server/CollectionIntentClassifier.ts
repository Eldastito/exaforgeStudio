import { chat } from "./llm.js";

// Chat injetável (ADR-152 F4b.2): módulos ESM são imutáveis, então em vez
// de reassignar `llm.chat` no teste (que quebra), guardamos um ponteiro
// interno + um setter test-only. Produção usa o `chat` importado default;
// testes trocam via `__setClassifierChatForTests` sem tocar em nenhum
// arquivo compartilhado.
let _chat: typeof chat = chat;
export function __setClassifierChatForTests(fn: typeof chat | null): void {
  _chat = fn || chat;
}

/**
 * Classificador de intenção pra respostas de cobrança (ADR-152 F4b.2).
 *
 * Recebe o texto da resposta do cliente e devolve UMA das 10 intenções
 * do PRD §13.4 + `unknown` como fallback. NUNCA age no lado do negócio —
 * é uma função pura de classificação. Quem consome (CollectionReplyService)
 * é que publica sinal / envia reply / escala.
 *
 * Design:
 *   - Usa `chat(prompt, {json:true})` do `llm.ts` (mesma primitiva do
 *     AIOrchestratorService); JSON mode do OpenAI + whitelist estrita do
 *     enum retornado (padrão do `classifyInventoryPhoto` em `llm.ts:489`).
 *   - Fallback pra `unknown` em 3 casos: (a) OPENAI_API_KEY ausente, (b)
 *     erro no chat, (c) LLM devolve valor fora da whitelist. Isso garante
 *     que uma resposta que não classificamos NUNCA trava o pipeline nem
 *     é interpretada errado.
 *   - Temperatura 0 (determinístico) + max output curto (o modelo devolve
 *     `{"intent":"...","reason":"..."}` só).
 *
 * Guardas F4b.2 aplicáveis aqui:
 *   G-4b.2-1: classifier NUNCA age (só devolve label + rationale).
 *   G-4b.2-3: sem OpenAI configurado → `unknown` (não trava fluxo).
 */

export const INTENT_LABELS = [
  "promise",         // "Vou pagar amanhã."
  "resend_pix",      // "Manda o PIX."
  "claims_paid",     // "Já paguei."
  "dispute",         // "Não reconheço."
  "installment",     // "Posso parcelar?"
  "partial",         // "Posso pagar metade?"
  "escalate_human",  // "Fale com o financeiro."
  "churn",           // "Não quero mais o serviço."
  "hardship",        // "Estou sem condições."
  "callback_later",  // "Me chama depois."
  "unknown",         // fallback — NUNCA vem do LLM confiavelmente; usado
                     // quando enum falha, LLM indisponível ou resposta ambígua.
] as const;

export type IntentLabel = (typeof INTENT_LABELS)[number];

export interface ClassificationResult {
  intent: IntentLabel;
  confidence: number;   // 0..1 — quando LLM não dá, cai pra 0
  rationale: string;    // uma linha curta pra auditoria
}

const WHITELIST: Set<string> = new Set(INTENT_LABELS as unknown as string[]);

const SYSTEM_PROMPT = `Você é um classificador de intenções de RESPOSTAS DE COBRANÇA em PT-BR.

Receberá UMA mensagem enviada pelo devedor (cliente) reagindo a um lembrete de cobrança que a empresa acabou de mandar (PIX, valor, vencimento).

Devolva EXCLUSIVAMENTE um JSON com este shape:
  {"intent": "<one_of_enum>", "reason": "<uma frase curta>"}

O enum tem exatamente estes valores (use um deles literalmente, sem inventar):
  - "promise"         → cliente promete pagar em data futura. Ex.: "Vou pagar amanhã.", "Pago sexta.", "Semana que vem eu acerto."
  - "resend_pix"      → cliente pede o PIX/link/QR de novo (não recebeu, apagou, quer confirmar). Ex.: "Manda o PIX.", "Não chegou o QR.", "Me envia o código Pix."
  - "claims_paid"     → cliente afirma que JÁ pagou. Ex.: "Já paguei.", "Paguei ontem.", "Enviei o comprovante."
  - "dispute"         → cliente contesta a dívida. Ex.: "Não reconheço.", "Esse valor tá errado.", "Não fui eu."
  - "installment"     → cliente pede parcelamento. Ex.: "Posso parcelar?", "Dá pra dividir em X vezes?"
  - "partial"         → cliente pede pagar valor parcial. Ex.: "Posso pagar metade?", "Consigo só R$ X hoje."
  - "escalate_human"  → cliente quer falar com humano/financeiro. Ex.: "Fale com o financeiro.", "Passa pra alguém.", "Quero falar com uma pessoa."
  - "churn"           → cliente quer cancelar o serviço/produto. Ex.: "Não quero mais o serviço.", "Cancela pra mim.", "Não uso mais."
  - "hardship"        → cliente relata dificuldade financeira sem propor solução concreta. Ex.: "Estou sem condições.", "Tô desempregado.", "Não tenho como agora."
  - "callback_later"  → cliente pede pra ser contatado depois. Ex.: "Me chama depois.", "Semana que vem falamos.", "Volta a falar comigo mês que vem."

Regras rígidas:
- Escolha SEMPRE a intenção QUE MELHOR DESCREVE a mensagem. Se estiver genuinamente ambígua ou o texto não parece resposta de cobrança (spam, saudação vazia, gíria isolada, emoji só, etc), devolva "intent" fora do enum ou string vazia — o consumidor tratará como desconhecido.
- Se a mensagem contém MAIS DE UMA intenção, priorize nesta ordem: claims_paid > dispute > escalate_human > promise > installment > partial > hardship > resend_pix > callback_later > churn.
- "reason" deve ser UMA frase curta (≤ 15 palavras) em PT-BR justificando.
- NÃO devolva markdown, prefixos, código. APENAS o JSON.`;

/**
 * Classifica a intenção do texto. Nunca lança; devolve `unknown` em erro.
 * `sample` fica limitado a 500 chars pra proteger contra prompt-injection
 * por payload gigante (política default do orchestrator ADR-050).
 */
export async function classify(text: string): Promise<ClassificationResult> {
  const sample = String(text || "").trim().slice(0, 500);
  if (!sample) return { intent: "unknown", confidence: 0, rationale: "mensagem vazia" };
  if (!process.env.OPENAI_API_KEY) {
    return { intent: "unknown", confidence: 0, rationale: "LLM indisponível (OPENAI_API_KEY ausente)" };
  }

  let raw = "";
  try {
    raw = await _chat(sample, { system: SYSTEM_PROMPT, json: true, temperature: 0 });
  } catch (e: any) {
    return { intent: "unknown", confidence: 0, rationale: `LLM erro: ${e?.message || e}` };
  }

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

  // Whitelist passou — confiança default 0.9 (o modelo com temp=0 e prompt
  // enum-forçado é bastante estável; se quiséssemos calibrar mais fino,
  // pediríamos "confidence" no JSON — mas isso adiciona superfície ao
  // prompt sem ganho pra MVP).
  return { intent: rawIntent as IntentLabel, confidence: 0.9, rationale: rationale || "classificado pelo LLM" };
}

export const CollectionIntentClassifier = { classify, INTENT_LABELS };
export default CollectionIntentClassifier;
