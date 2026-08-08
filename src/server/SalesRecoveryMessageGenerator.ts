import { chat } from "./llm.js";
import { SalesRecoveryCopy, sanitizeName } from "./SalesRecoveryCopy.js";

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
  // ADR-155 F3.1 — orgId escolhe a variante de copy (control|calibrated) via
  // SalesRecoveryCopy. Sem orgId cai em 'control' (byte-idêntico ao legado) ⇒
  // nenhum caller antigo muda de comportamento.
  orgId?: string | null;
  contactName?: string | null;
  stage: string;         // qualificado | proposta | negociacao | orcamento
  daysStalled: number;
  // ADR-152 F4c.3 — tentativa 1 (default), 2 (follow-up suave) ou 3
  // (última tentativa, tom "vou deixar em stand-by"). Nunca chega
  // além de 3 (G-4c.3-3). Tom fica MAIS SUAVE a cada tentativa —
  // recuperação comercial ≠ cobrança; queremos preservar a relação.
  attemptNumber?: 1 | 2 | 3;
}

export async function generate(input: GenerateInput): Promise<GeneratedMessage> {
  // ADR-155 F3.1 — a copy (prompt do LLM + fallback determinístico) vem do
  // SalesRecoveryCopy, que escolhe control|calibrated por org. Guardas G-4c-G-*
  // preservadas (nunca lança, nome sanitizado, cap de 200 chars).
  const variant = SalesRecoveryCopy.variantFor(input.orgId);
  const attempt = (input.attemptNumber ?? 1) as 1 | 2 | 3;
  const fallback = { text: SalesRecoveryCopy.template(variant, input), source: "template" as const };
  if (!process.env.OPENAI_API_KEY) return fallback;

  // Payload sanitizado (G-4c-G-2): nome NUNCA vai como parte de
  // instrução; passa como campo separado que o LLM entende como "user
  // data" (context, não prompt).
  const nome = sanitizeName(input.contactName);
  const stage = String(input.stage || "").slice(0, 40);
  const days = Math.max(0, Math.min(Math.trunc(input.daysStalled || 0), 365));
  const baseSystem = SalesRecoveryCopy.systemPrompt(variant, attempt);
  // ADR-155 — fecha o loop de aprendizado: injeta o bloco do grimoire (rubrica
  // `sales-recovery` + as lições do pós-mortem F3.2 + contexto de marca) no
  // prompt VIVO da geração. Gated por brand_voice (promptForOrg devolve "" se a
  // flag está off ⇒ zero mudança pra quem não optou). Import dinâmico pra
  // quebrar ciclo (convenção nº 11); best-effort — erro nunca derruba a geração.
  let grimoire = "";
  if (input.orgId) {
    try {
      const { GrimoireService } = await import("./GrimoireService.js");
      grimoire = await GrimoireService.promptForOrg(input.orgId, "recuperacao", ["compose"]);
    } catch { /* noop — segue com o prompt base */ }
  }
  const system = grimoire ? `${baseSystem}\n\n${grimoire}` : baseSystem;
  const userText = `Contexto do cliente:\n- nome: ${nome || "(desconhecido)"}\n- stage no funil: ${stage}\n- dias sem resposta: ${days}\n- tentativa: ${attempt} de 3\n\nEscreva a mensagem seguindo TODAS as regras.`;

  let raw = "";
  try { raw = await _chat(userText, { system, json: true, temperature: 0.6 }); }
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
