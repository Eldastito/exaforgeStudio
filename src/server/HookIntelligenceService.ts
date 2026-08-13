import { CAMPAIGN_OBJECTIVES } from "./StudioService.js";

/**
 * HookIntelligenceService — Hook Intelligence (PRD 11 / ADR-168 F3).
 *
 * O Estúdio gera legenda inteira, mas não tem o GANCHO — a primeira linha que segura o
 * scroll. F3 preenche essa lacuna: gera OPÇÕES de gancho (padrões distintos: pergunta /
 * curiosidade / afirmação ousada / prova social / dor / identidade), cada uma orientada pelo
 * TÓPICO + OBJETIVO de campanha + BRAND DNA (voz/persona/público — F1).
 *
 * ESTENDE o Estúdio (§37 — sem 2º Estúdio); DETERMINÍSTICO (sem LLM, roda em CI), espelhando
 * o `CreativeVariantService` (que já deriva variantes sem IA). Cada gancho é uma linha pronta
 * pra abrir a legenda.
 *
 * Guardrails:
 *  - RN-CG-09 — GROUNDED: usa só o que existe (tópico + campos de marca preenchidos); não
 *    inventa fato. Sem tópico → erro honesto. Padrão de identidade só sai se há persona/público.
 *  - RN-CG-04 / respeito à marca — ganchos que contêm um termo PROIBIDO do Brand DNA são
 *    filtrados (a marca não fala o que não quer falar).
 *  - convenção nº 1 — isolamento por org (o Brand DNA é lido por `organization_id`).
 */

export interface HookOption { pattern: string; label: string; text: string; rationale: string }
export interface HookSet {
  topic: string; objectiveId: string | null; count: number;
  hooks: HookOption[]; brandGrounded: boolean; caveats: string[];
}

interface HookCtx { topic: string; persona: string | null; audience: string | null; voice: string | null }

function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Padrões de gancho — cada um é uma FORMA distinta de abrir. `build` só usa o que recebe
// (grounded). `needsPersona` marca os que exigem persona/público (não saem sem base).
const PATTERNS: { id: string; label: string; needsPersona?: boolean; build: (c: HookCtx) => string; rationale: string }[] = [
  { id: "pergunta", label: "Pergunta", build: (c) => `Você sabia disso sobre ${c.topic}?`, rationale: "Abre com pergunta que puxa o leitor pra dentro." },
  { id: "curiosidade", label: "Curiosidade", build: (c) => `O segredo sobre ${c.topic} que poucos conhecem.`, rationale: "Lacuna de curiosidade — promete o que vem a seguir." },
  { id: "ousada", label: "Afirmação ousada", build: (c) => `${cap(c.topic)} mudou tudo — e a gente prova.`, rationale: "Declaração forte que interrompe o scroll." },
  { id: "prova_social", label: "Prova social", build: (c) => `Todo mundo está falando sobre ${c.topic}.`, rationale: "Sinal de que outros já aderiram." },
  { id: "dor", label: "Dor / solução", build: (c) => `Cansado de complicação? ${cap(c.topic)} resolve.`, rationale: "Nomeia a dor e aponta a solução." },
  { id: "identidade", label: "Identidade", needsPersona: true, build: (c) => `Pra quem é ${c.audience || c.persona}: ${c.topic} do seu jeito.`, rationale: "Fala direto com a persona/público da marca." },
];

// Ordem de preferência dos padrões por objetivo (o objetivo molda qual gancho vem primeiro).
const OBJECTIVE_ORDER: Record<string, string[]> = {
  vendas: ["ousada", "dor", "prova_social", "pergunta", "curiosidade", "identidade"],
  promocao: ["ousada", "dor", "prova_social", "curiosidade", "pergunta", "identidade"],
  agendamento: ["dor", "pergunta", "identidade", "ousada", "prova_social", "curiosidade"],
  reativacao: ["identidade", "dor", "pergunta", "curiosidade", "ousada", "prova_social"],
  engajamento: ["pergunta", "curiosidade", "prova_social", "identidade", "ousada", "dor"],
  alcance: ["curiosidade", "prova_social", "ousada", "pergunta", "identidade", "dor"],
  educativo: ["curiosidade", "pergunta", "prova_social", "identidade", "ousada", "dor"],
  data: ["identidade", "prova_social", "curiosidade", "pergunta", "ousada", "dor"],
};
const DEFAULT_ORDER = ["pergunta", "curiosidade", "ousada", "prova_social", "dor", "identidade"];

export class HookIntelligenceService {
  static isKnownObjective(objectiveId: string): boolean {
    return CAMPAIGN_OBJECTIVES.some((o) => o.id === objectiveId);
  }

  /**
   * Gera ganchos grounded pro tópico. Lê o Brand DNA (F1) pra voz/persona/público e pros
   * termos PROIBIDOS (filtrados). `count` clampeado a [1..6].
   */
  static async generate(orgId: string, input: { topic: string; objectiveId?: string | null; count?: number }): Promise<HookSet> {
    const topic = String(input?.topic || "").trim();
    if (!topic) throw new Error("Informe o tópico do conteúdo.");
    const objectiveId = input.objectiveId && this.isKnownObjective(String(input.objectiveId)) ? String(input.objectiveId) : null;
    const count = Math.max(1, Math.min(6, Number(input.count) || 3));

    // Brand DNA (F1) — grounded; se ausente, segue sem (0-regressão).
    let persona: string | null = null, audience: string | null = null, voice: string | null = null;
    let forbidden: string[] = [];
    try {
      const { BrandDnaService } = await import("./BrandDnaService.js");
      const dna = await BrandDnaService.get(orgId);
      persona = dna.persona; audience = dna.audience; voice = dna.voice;
      forbidden = (dna.forbidden || []).map((f) => f.toLowerCase());
    } catch { /* sem Brand DNA → ganchos sem marca (honesto) */ }
    const brandGrounded = !!(persona || audience || voice);

    const ctx: HookCtx = { topic, persona, audience, voice };
    const order = objectiveId ? (OBJECTIVE_ORDER[objectiveId] || DEFAULT_ORDER) : DEFAULT_ORDER;

    const caveats: string[] = [];
    const hooks: HookOption[] = [];
    for (const pid of order) {
      const pat = PATTERNS.find((p) => p.id === pid);
      if (!pat) continue;
      if (pat.needsPersona && !persona && !audience) continue; // grounded: sem base, não força
      const text = pat.build(ctx);
      // Respeito à marca (RN-CG-04): descarta gancho que contém termo proibido.
      if (forbidden.some((f) => f && text.toLowerCase().includes(f))) { caveats.push(`gancho "${pat.label}" descartado por termo proibido`); continue; }
      hooks.push({ pattern: pat.id, label: pat.label, text, rationale: pat.rationale });
      if (hooks.length >= count) break;
    }
    if (!brandGrounded) caveats.push("sem Brand DNA — ganchos genéricos (defina persona/voz pra afinar)");
    if (hooks.length < count) caveats.push(`só ${hooks.length} gancho(s) grounded disponíveis`);

    return { topic, objectiveId, count, hooks, brandGrounded, caveats };
  }
}

export default HookIntelligenceService;
