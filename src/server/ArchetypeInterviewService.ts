/**
 * ADR-206 F5.6 — ONBOARDING CONVERSACIONAL por arquétipo (ESTENDE `BusinessArchetypeService`/`AdaptiveOnboardingService` — sem motor novo, RN-F5-12).
 *
 * O dono responde em linguagem natural ("repomos as mesmas peças o ano todo" / "compramos por coleção e liquidamos no fim") e o
 * sistema devolve uma SUGESTÃO de arquétipo para ele CONFIRMAR. Nada é aplicado aqui: aplicar é `BusinessArchetypeService.select`,
 * ato de PESSOA (RN-UX-3 — o onboarding sugere, nunca auto-aplica política).
 *
 * Como lê a resposta (DETERMINÍSTICO, sem LLM — roda em CI e não tem superfície de prompt-injection): procura expressões-pista de
 * cada arquétipo do catálogo (sem acento, sem caixa). Pista NEGADA ("não repomos", "nunca em coleção") não conta — vira aviso e
 * pergunta de confirmação, porque negação muda o sentido e regra simples não resolve isso com segurança.
 *
 * Veredito honesto:
 *  - `suggested` (confiança alta só com ≥2 pistas distintas e nenhuma do outro lado; média com 1 pista ou vantagem clara; baixa com negação);
 *  - `ambiguous` (pistas dos dois lados sem vantagem clara → pergunta qual predomina);
 *  - `no_signal` (nada reconhecido → devolve a pergunta guiada com as opções, não chuta);
 *  - `already_set` (a empresa já escolheu; mudar é pelo PUT do arquétipo) · `not_applicable` (vertical sem arquétipo).
 *  Sempre `applied:false` e `confirmationRequired:true`.
 *
 * Prévia do efeito: antes de confirmar, mostra o que a escolha MUDARIA em cada política — e quando a empresa já definiu a política
 * sozinha, diz que a escolha não muda nada nela (a empresa vence o arquétipo, RN-F5-1).
 *
 * Texto do dono é DADO NÃO CONFIÁVEL: limite de tamanho, nunca executado nem repassado a modelo; só um trecho curto entra na
 * auditoria da confirmação. Cada arquétipo do catálogo PRECISA ter pistas aqui (o teste falha se entrar um sem pista).
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ARCHETYPES, POLICIES, BusinessArchetypeService } from "./BusinessArchetypeService.js";

export const INTERVIEW_MAX_CHARS = 1000;

/** Pistas por arquétipo (normalizadas: minúsculas, sem acento). Cada pista é uma expressão de 1+ palavras. */
export const CUES: Record<string, string[]> = {
  moda_colecao: ["colecao", "colecoes", "fim de colecao", "compra em lote", "compramos em lote", "lote", "temporada", "liquidacao", "outlet", "ciclo da colecao", "pecas de colecao", "troca de colecao"],
  moda_reposicao_continua: ["reposicao", "repomos", "repor", "repoe", "recompra", "recomprar", "recompramos", "mesmas pecas", "sempre em estoque", "linha permanente", "basicos", "basico", "pronta entrega", "reposicao continua", "estoque permanente"],
};

const NEGATORS = new Set(["nao", "nunca", "jamais", "sem", "nem"]);

const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function hasCue(tokens: string[], cue: string): { found: boolean; negated: boolean } {
  const ct = cue.split(" ");
  let found = false, negated = false;
  for (let i = 0; i + ct.length <= tokens.length; i++) {
    if (ct.every((w, j) => tokens[i + j] === w)) {
      found = true;
      const before = tokens.slice(Math.max(0, i - 2), i);
      if (before.some((t) => NEGATORS.has(t))) negated = true;
      else return { found: true, negated: false }; // ocorrência afirmativa vale
    }
  }
  return { found, negated };
}

export class ArchetypeInterviewService {
  /** Lê a resposta do dono e devolve a SUGESTÃO (nunca aplica). */
  static interpret(orgId: string, text: unknown): any {
    const raw = typeof text === "string" ? text : "";
    const base = { applied: false as const, confirmationRequired: true as const, method: "deterministic_cues" as const };
    if (!raw.trim()) return { ...base, status: "no_signal", error: "Conte como sua operação trata o estoque.", followUp: BusinessArchetypeService.question(orgId) };
    if (raw.length > INTERVIEW_MAX_CHARS) return { ...base, status: "invalid", error: `Resposta longa demais (máx. ${INTERVIEW_MAX_CHARS} caracteres).` };

    const applicable = BusinessArchetypeService.applicable(orgId);
    if (!applicable.length) return { ...base, status: "not_applicable", note: "A vertical da sua empresa ainda não tem modelos de operação no catálogo." };
    const current = BusinessArchetypeService.current(orgId);
    if (current) return { ...base, status: "already_set", current: { key: current.key, label: current.label }, note: "A empresa já escolheu o modelo de operação; para mudar, use a escolha do modelo." };

    const tokens = norm(raw).split(" ").filter(Boolean);
    const scored = applicable.map((a) => {
      const hits: string[] = []; let negated = false;
      for (const cue of CUES[a.key] || []) { const r = hasCue(tokens, cue); if (r.found && !r.negated) hits.push(cue); else if (r.found && r.negated) negated = true; }
      return { a, hits, negated };
    }).sort((x, y) => y.hits.length - x.hits.length);
    const anyNegation = scored.some((s) => s.negated);
    const top = scored[0], second = scored[1];
    const question = BusinessArchetypeService.question(orgId);

    if (!top || top.hits.length === 0) {
      return { ...base, status: "no_signal", negationDetected: anyNegation, note: anyNegation ? "Entendi uma negação e não consegui concluir o modelo." : "Não reconheci o modelo de operação na resposta.", followUp: question };
    }
    const secondHits = second ? second.hits.length : 0;
    const alternatives = scored.slice(1).map((s) => ({ key: s.a.key, label: s.a.label, matched: s.hits }));
    if (secondHits > 0 && top.hits.length - secondHits < 2) {
      return { ...base, status: "ambiguous", negationDetected: anyNegation, candidates: scored.filter((s) => s.hits.length > 0).map((s) => ({ key: s.a.key, label: s.a.label, matched: s.hits })), followUp: { text: "Você falou de coisas dos dois modelos. Qual predomina na sua operação?", options: question?.options || [] } };
    }
    let confidence: "alta" | "média" | "baixa" = secondHits === 0 && top.hits.length >= 2 ? "alta" : "média";
    if (anyNegation) confidence = "baixa";
    return {
      ...base, status: "suggested", confidence, negationDetected: anyNegation,
      suggestion: { key: top.a.key, label: top.a.label, description: top.a.description, matched: top.hits },
      alternatives,
      preview: this.preview(orgId, top.a.key),
      confirmText: `Entendi que sua operação é "${top.a.label}". Está correto?`,
    };
  }

  /** O que escolher este arquétipo MUDARIA em cada política (a escolha da própria empresa vence — então pode não mudar nada). */
  static preview(orgId: string, archetypeKey: string): Array<{ policy: string; label: string; before: string; after: string; changes: boolean; reason: string }> {
    const arch = ARCHETYPES.find((a) => a.key === archetypeKey);
    if (!arch) return [];
    return POLICIES.map((p) => {
      const cur = BusinessArchetypeService.resolve(orgId, p.key)!;
      const org = p.readOrg(orgId);
      const proposed = arch.policies[p.key];
      if (org && p.values.includes(org)) return { policy: p.key, label: p.label, before: cur.value, after: cur.value, changes: false, reason: "A empresa já definiu esta política; o modelo não a altera." };
      if (!proposed) return { policy: p.key, label: p.label, before: cur.value, after: cur.value, changes: false, reason: "O modelo não define esta política." };
      return { policy: p.key, label: p.label, before: cur.value, after: proposed, changes: proposed !== cur.value, reason: proposed !== cur.value ? "Passa a valer o padrão do modelo." : "Já é o valor em vigor." };
    });
  }

  /** O dono CONFIRMA (ato de pessoa). Aplica via `select` e audita a resposta + o que o sistema tinha sugerido. */
  static confirm(orgId: string, archetypeKey: string, actor: string | null | undefined, ctx: { answerText?: string } = {}): { ok: boolean; error?: string; archetype?: string | null; suggestedKey?: string | null; matchedSuggestion?: boolean } {
    const answer = typeof ctx.answerText === "string" ? ctx.answerText.slice(0, INTERVIEW_MAX_CHARS) : "";
    const interp = answer.trim() ? this.interpret(orgId, answer) : null;
    const suggestedKey: string | null = interp?.suggestion?.key ?? null;
    const out = BusinessArchetypeService.select(orgId, archetypeKey, actor);
    if (!out.ok) return out;
    try {
      logAuthEvent(orgId, String(actor), orgId, "BUSINESS_ARCHETYPE_INTERVIEW_CONFIRMED", { archetype: archetypeKey, suggestedKey, matchedSuggestion: suggestedKey === archetypeKey, status: interp?.status ?? null, answerExcerpt: answer.replace(/\s+/g, " ").slice(0, 300) });
    } catch { /* auditoria best-effort */ }
    return { ok: true, archetype: out.archetype, suggestedKey, matchedSuggestion: suggestedKey === archetypeKey };
  }

  /** Taxa em que a sugestão coincidiu com o que a pessoa confirmou — para saber se as pistas funcionam. Null sem amostra. */
  static suggestionAccuracy(orgId: string): { n: number; matched: number; rate: number | null } {
    const rows = db.prepare("SELECT metadata_json m FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'BUSINESS_ARCHETYPE_INTERVIEW_CONFIRMED'").all(orgId) as any[];
    let n = 0, matched = 0;
    for (const r of rows) { try { const m = JSON.parse(r.m || "{}"); if (m.suggestedKey) { n++; if (m.matchedSuggestion) matched++; } } catch { /* linha torta */ } }
    return { n, matched, rate: n ? matched / n : null };
  }
}

export default ArchetypeInterviewService;
