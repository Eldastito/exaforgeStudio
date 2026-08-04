import { chat } from "./llm.js";

// Injeção pra testes (padrão do CollectionIntentClassifier F4b.2 — ESM
// modules são frozen, então setter isolado).
let _chat: typeof chat = chat;
export function __setGeneratorChatForTests(fn: typeof chat | null): void { _chat = fn || chat; }

/**
 * Gera mensagem de reengajamento comercial (ADR-152 F4c).
 *
 * Chamado pelo `SalesRecoveryProposeHandler` do playbook `sales_recovery_
 * v1`. Recebe o contexto do deal parado (nome do contato, stage, dias
 * parados) e devolve UMA mensagem cordial, curta, sem pressão, que
 * pergunta se dá pra continuar a conversa.
 *
 * Design:
 *   - Usa `chat` do llm.ts (mesma primitiva do CollectionIntentClassifier).
 *   - Sem OPENAI_API_KEY OU erro → FALLBACK pra template estático
 *     determinístico (source='template'). NÃO trava a proposta — o
 *     dono ainda pode editar antes de aprovar.
 *   - Prompt força tom que respeita LGPD: nunca fala em "cobrança",
 *     nunca ameaça, nunca cria urgência artificial. Foca em "posso
 *     ajudar em algo?" (§14 do PRD, tom Business Manifesto).
 *   - Temperatura 0.6 (um pouco mais quente que classifier) pra ter
 *     variação — 2 tickets do mesmo stage não devem virar msg idêntica.
 *
 * Guardas F4c-GEN:
 *   G-4c-G-1: NUNCA lança — sempre devolve {text, source}.
 *   G-4c-G-2: Nome do contato sanitizado (evita prompt injection via
 *             nome tipo "Ignore instructions...").
 *   G-4c-G-3: Sample size cap no output (200 chars) — WhatsApp curto,
 *             cliente lê no 1º olhar.
 *   G-4c-G-4: Fallback estático inclui nome (se disponível) e stage.
 */

export type MessageSource = "llm" | "template";
export interface GeneratedMessage { text: string; source: MessageSource; }

export interface GenerateInput {
  contactName?: string | null;
  stage: string;         // qualificado | proposta | negociacao | orcamento
  daysStalled: number;
}

const SYSTEM_PROMPT = `Você escreve UMA mensagem curta em PT-BR pra RETOMAR uma conversa comercial parada.

Contexto: você é do time comercial de uma empresa. Um cliente ficou algum tempo sem responder no funil. Precisa reabrir a conversa de um jeito CORDIAL e SEM PRESSÃO — LGPD/CDC exigem que a comunicação seja informativa, nunca coercitiva.

Devolva EXCLUSIVAMENTE um JSON:
  {"text": "<mensagem>"}

Regras rígidas:
- Máximo 200 caracteres na mensagem.
- Use o nome da pessoa quando disponível.
- Faça UMA pergunta aberta ("posso te ajudar em algo?", "faz sentido a gente conversar de novo?", "quer retomar de onde paramos?").
- NUNCA cobre, NUNCA ameace, NUNCA crie urgência falsa ("última chance", "oferta expira hoje").
- NUNCA prometa desconto/vantagem que o time não autorizou.
- Formal-cordial, tom brasileiro, pode ter 1 emoji sutil (🙂/👋) opcional.
- Se stage='proposta' ou 'orcamento', menciona brevemente a proposta pendente; se 'negociacao', foca em "onde paramos".
- NUNCA devolva markdown, prefixos ou texto fora do JSON.`;

function sanitizeName(name: string | null | undefined): string {
  if (!name) return "";
  // Remove qualquer coisa que pareça instrução de prompt (defesa vs injection).
  return String(name).replace(/[\r\n"`{}]/g, " ").trim().slice(0, 40);
}

function template(input: GenerateInput): string {
  const nome = sanitizeName(input.contactName);
  const oi = nome ? `Oi, ${nome}!` : "Oi!";
  if (input.stage === "proposta" || input.stage === "orcamento") {
    return `${oi} 🙂 Faz uns dias que a gente não conversa por aqui — a proposta que enviei ainda faz sentido pra você? Se precisar ajustar algo, é só me falar.`;
  }
  if (input.stage === "negociacao") {
    return `${oi} 🙂 Quer retomar de onde a gente parou? Se ficou alguma dúvida ou tiver algo pra ajustar, me chama aqui.`;
  }
  return `${oi} 🙂 Só passando pra saber se posso te ajudar em algo por aqui. Se preferir conversar depois, é só me avisar.`;
}

export async function generate(input: GenerateInput): Promise<GeneratedMessage> {
  const fallback = { text: template(input), source: "template" as const };
  if (!process.env.OPENAI_API_KEY) return fallback;

  // Payload sanitizado (G-4c-G-2): nome NUNCA vai como parte de
  // instrução; passa como campo separado que o LLM entende como "user
  // data" (context, não prompt).
  const nome = sanitizeName(input.contactName);
  const stage = String(input.stage || "").slice(0, 40);
  const days = Math.max(0, Math.min(Math.trunc(input.daysStalled || 0), 365));
  const userText = `Contexto do cliente:\n- nome: ${nome || "(desconhecido)"}\n- stage no funil: ${stage}\n- dias sem resposta: ${days}\n\nEscreva a mensagem seguindo TODAS as regras.`;

  let raw = "";
  try { raw = await _chat(userText, { system: SYSTEM_PROMPT, json: true, temperature: 0.6 }); }
  catch { return fallback; }

  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* deixa null */ }
  if (!parsed || typeof parsed !== "object") return fallback;

  const text = String(parsed.text || "").trim().slice(0, 200);
  if (!text) return fallback;
  return { text, source: "llm" };
}

export const SalesRecoveryMessageGenerator = { generate };
export default SalesRecoveryMessageGenerator;
