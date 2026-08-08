import db from "./db.js";

/**
 * SalesRecoveryCopy — fonte única da copy de Recuperação Comercial (ADR-155 F3.1).
 *
 * Espelha o CollectionCopy (F2.1) pro piloto de recuperação (ADR-152 F4c). Duas
 * variantes A/B, escolhidas por-org (`organization_settings.sales_recovery_copy_
 * variant`, default 'control'):
 *   - `control`    — o prompt de sistema + os templates de fallback ATUAIS,
 *                    byte-idênticos (default de toda org ⇒ zero mudança em prod;
 *                    mantém o test:piloto-sales-recovery verde).
 *   - `calibrated` — copy afinada pela rubrica `docs/grimoire/copy/compose/
 *                    sales-recovery.md`: referência específica ao que ficou
 *                    pendente (prova de compromisso), reciprocidade honesta
 *                    ("posso ajustar"), permissão + saída fácil, e tom que
 *                    SUAVIZA a cada tentativa (recuperação ≠ cobrança).
 *
 * A calibração vale pro fallback determinístico (`template`) E pro prompt do LLM
 * (`systemPrompt`) — quando o OPENAI_API_KEY está setado, o modelo compõe guiado
 * pelo framework da rubrica. A escolha da variante é opt-in; a atribuição/rollout
 * do A/B + medição são a F3.2.
 *
 * NÃO muda canal nem regra de WhatsApp (guardrail RN-155 §2): só o texto. Copy
 * nova passa pela governança ADR-130. Guardrails duros (sem urgência falsa, sem
 * cobrança/ameaça, sem desconto não autorizado) valem nas DUAS variantes.
 */

export type RecoveryVariant = "control" | "calibrated";

export interface RecoveryCopyInput {
  contactName?: string | null;
  stage: string;                 // qualificado | proposta | negociacao | orcamento
  attemptNumber?: 1 | 2 | 3;
}

/** Sanitiza o nome (defesa vs prompt injection). Compartilhado com o gerador. */
export function sanitizeName(name: string | null | undefined): string {
  if (!name) return "";
  return String(name).replace(/[\r\n"`{}]/g, " ").trim().slice(0, 40);
}

// ───────────────────────── control (legado byte-idêntico) ─────────────────────
const CONTROL_SYSTEM_BASE = `Você escreve UMA mensagem curta em PT-BR pra RETOMAR uma conversa comercial parada.

Contexto: você é do time comercial de uma empresa. Um cliente ficou algum tempo sem responder no funil. Precisa reabrir a conversa de um jeito CORDIAL e SEM PRESSÃO — LGPD/CDC exigem que a comunicação seja informativa, nunca coercitiva.

{ATTEMPT_HINT}

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

const CONTROL_ATTEMPT_HINTS: Record<1 | 2 | 3, string> = {
  1: "Esta é a PRIMEIRA tentativa de retomar. Tom leve e curioso — provavelmente o cliente só esqueceu de responder.",
  2: "Esta é a SEGUNDA tentativa (a primeira não teve resposta). Tom AINDA mais leve, quase se desculpando por insistir. Pode reconhecer que a pessoa está ocupada. Pergunta aberta simples.",
  3: "Esta é a TERCEIRA (e ÚLTIMA) tentativa antes de deixar em stand-by. Tom cordial mas com fechamento respeitoso — algo como 'vou deixar em stand-by e se um dia quiser retomar, é só me chamar'. NÃO pareça ressentido nem ameaçador.",
};

function controlTemplate(input: RecoveryCopyInput): string {
  const nome = sanitizeName(input.contactName);
  const oi = nome ? `Oi, ${nome}!` : "Oi!";
  const attempt = (input.attemptNumber ?? 1) as 1 | 2 | 3;
  if (attempt === 3) {
    return `${oi} 🙂 Vou deixar essa conversa em stand-by por aqui — se um dia quiser retomar, é só me chamar. Obrigado! 🙏`;
  }
  if (attempt === 2) {
    return `${oi} 🙂 Sei que a rotina corre — só passando pra ver se ainda faz sentido a gente conversar. Sem pressão nenhuma.`;
  }
  if (input.stage === "proposta" || input.stage === "orcamento") {
    return `${oi} 🙂 Faz uns dias que a gente não conversa por aqui — a proposta que enviei ainda faz sentido pra você? Se precisar ajustar algo, é só me falar.`;
  }
  if (input.stage === "negociacao") {
    return `${oi} 🙂 Quer retomar de onde a gente parou? Se ficou alguma dúvida ou tiver algo pra ajustar, me chama aqui.`;
  }
  return `${oi} 🙂 Só passando pra saber se posso te ajudar em algo por aqui. Se preferir conversar depois, é só me avisar.`;
}

// ─────────────────────── calibrated (rubrica sales-recovery) ──────────────────
// Reforça prova de compromisso (referência ao que ficou pendente), reciprocidade
// honesta e permissão explícita; endurece o "nunca fazer" (urgência/cobrança).
const CALIBRATED_SYSTEM_BASE = `Você escreve UMA mensagem curta em PT-BR pra REABRIR uma conversa comercial que esfriou. Recuperação comercial NÃO é cobrança: o objetivo é preservar a relação e reabrir o diálogo, nunca arrancar um pagamento.

Contexto: você é do time comercial. Um cliente demonstrou interesse (tem proposta/orçamento/negociação em aberto) e parou de responder. LGPD/CDC exigem comunicação informativa, nunca coercitiva.

{ATTEMPT_HINT}

Devolva EXCLUSIVAMENTE um JSON:
  {"text": "<mensagem>"}

Framework (rubrica sales-recovery):
- UMA pergunta aberta só (CTA único): "faz sentido retomar?", "quer que eu revise algo?".
- Referência ESPECÍFICA ao que ficou pendente (prova de compromisso): "a proposta que te enviei", "onde a gente parou" — mostra que há um fio concreto, não disparo genérico.
- Reciprocidade honesta: ofereça ajustar/revisar o que JÁ existe ("posso ajustar o que fizer sentido"), sem inventar vantagem nova.
- Permissão + saída fácil: deixe claro que responder é opcional e que dá pra retomar depois ("sem pressão", "se preferir, falamos mais pra frente").

Regras rígidas:
- Máximo 200 caracteres. Use o nome da pessoa quando disponível. No máximo 1 emoji sutil (🙂/👋/🙏).
- NUNCA crie urgência falsa ("última chance", "expira hoje", "só até amanhã").
- NUNCA cobre, ameace, fale em "pendência/dívida" nem soe ressentido ("você sumiu").
- NUNCA prometa desconto/vantagem que o time não autorizou.
- O tom SUAVIZA a cada tentativa — a 2ª/3ª é MAIS leve que a 1ª, nunca mais insistente.
- Se stage='proposta'/'orcamento', cite a proposta pendente e ofereça revisá-la; se 'negociacao', foque em "onde paramos".
- NUNCA devolva markdown, prefixos ou texto fora do JSON.`;

const CALIBRATED_ATTEMPT_HINTS: Record<1 | 2 | 3, string> = {
  1: "PRIMEIRA tentativa. Retome com uma referência concreta ao que ficou pendente e ofereça ajustar/revisar. Curioso e cordial — provavelmente só esqueceu de responder.",
  2: "SEGUNDA tentativa (a 1ª não teve resposta). AINDA mais leve: reconheça que a rotina corre, reforce que é sem pressão e que responder é opcional. Uma pergunta aberta simples.",
  3: "TERCEIRA (e ÚLTIMA) tentativa antes do stand-by. Fechamento respeitoso que mantém a porta aberta ('deixo em stand-by; quando quiser retomar, é só me chamar'). Sem ressentimento, sem ameaça.",
};

function calibratedTemplate(input: RecoveryCopyInput): string {
  const nome = sanitizeName(input.contactName);
  const oi = nome ? `Oi, ${nome}!` : "Oi!";
  const attempt = (input.attemptNumber ?? 1) as 1 | 2 | 3;
  if (attempt === 3) {
    return `${oi} 🙂 Vou deixar essa conversa em stand-by por aqui — quando quiser retomar, é só me chamar. Obrigado pela conversa! 🙏`;
  }
  if (attempt === 2) {
    return `${oi} 🙂 Sei que a rotina corre — sem pressão nenhuma. Só passando pra ver se ainda faz sentido a gente retomar quando você puder.`;
  }
  if (input.stage === "proposta" || input.stage === "orcamento") {
    return `${oi} 🙂 Fiquei de retomar sobre a proposta que te enviei — ela segue de pé e posso ajustar o que fizer sentido. Quer que eu revise algum ponto?`;
  }
  if (input.stage === "negociacao") {
    return `${oi} 🙂 Quer retomar de onde a gente parou? Se ficou alguma dúvida ou algo pra ajustar, é só me dizer — sem pressa.`;
  }
  return `${oi} 🙂 Só passando pra ver se posso ajudar em algo por aqui. Se preferir falar mais pra frente, é só me avisar.`;
}

export class SalesRecoveryCopy {
  /** Variante da org (A/B). Qualquer valor != 'calibrated' cai em 'control'. */
  static variantFor(orgId?: string | null): RecoveryVariant {
    if (!orgId) return "control";
    const row = db.prepare(`SELECT sales_recovery_copy_variant AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return row?.v === "calibrated" ? "calibrated" : "control";
  }

  /** Prompt de sistema do LLM pra variante+tentativa (control byte-idêntico ao legado). */
  static systemPrompt(variant: RecoveryVariant, attempt: 1 | 2 | 3): string {
    const base = variant === "calibrated" ? CALIBRATED_SYSTEM_BASE : CONTROL_SYSTEM_BASE;
    const hints = variant === "calibrated" ? CALIBRATED_ATTEMPT_HINTS : CONTROL_ATTEMPT_HINTS;
    return base.replace("{ATTEMPT_HINT}", hints[attempt] ?? hints[1]);
  }

  /** Fallback determinístico pra variante (control byte-idêntico ao legado). */
  static template(variant: RecoveryVariant, input: RecoveryCopyInput): string {
    return variant === "calibrated" ? calibratedTemplate(input) : controlTemplate(input);
  }
}

export default SalesRecoveryCopy;
