import db from "./db.js";

/**
 * Manifesto do Negócio — a "constituição" da marca (ADR-045, Tier 1 filosófico).
 *
 * Combina 3 tradições:
 * - Golden Circle do Sinek: WHY → HOW → WHAT. O Por Quê ancora tudo.
 * - StorySelling: história fundadora + promessa de transformação como matéria-
 *   prima narrativa para conteúdo, campanhas e primeira mensagem a lead frio.
 * - Tom de voz consistente (3 Cs de Sinek: Clareza, Disciplina, Consistência).
 *
 * O manifesto é injetado no TOPO de todo prompt de IA (atendimento, orquestrador,
 * negociador). Não é opcional — quando presente, orienta 100% da comunicação.
 * Quando ausente, a IA cai no fallback genérico (que ainda funciona, mas sem
 * ancoragem). Existe UM manifesto por organização (chave primária).
 */

export interface BusinessManifesto {
  organizationId: string;
  whyStatement: string;          // 1-2 frases: o Por Quê
  howPrinciples: string[];       // até 5 princípios de operação
  whatSummary: string;           // 1 frase: o Que a marca oferta
  founderStory: string;          // história fundadora (2-6 parágrafos curtos)
  transformationPromise: string; // o que muda na vida do cliente ao consumir
  toneVoice: string;             // registro + palavras-âncora + palavras-veto
  updatedAt?: string;
}

function safeJsonArray(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
    } catch { /* fallback: split por linha */ }
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  }
  return [];
}

export const BusinessManifestoService = {
  /** Lê o manifesto da organização; devolve null se ainda não foi criado. */
  get(organizationId: string): BusinessManifesto | null {
    const row = db.prepare(`SELECT * FROM business_manifesto WHERE organization_id = ?`).get(organizationId) as any;
    if (!row) return null;
    return {
      organizationId,
      whyStatement: row.why_statement || "",
      howPrinciples: safeJsonArray(row.how_principles),
      whatSummary: row.what_summary || "",
      founderStory: row.founder_story || "",
      transformationPromise: row.transformation_promise || "",
      toneVoice: row.tone_voice || "",
      updatedAt: row.updated_at,
    };
  },

  /**
   * Cria ou atualiza (upsert por organization_id). Sanitize: limita tamanhos
   * para não estourar prompt window quando injetado em todo request de IA.
   */
  save(organizationId: string, patch: Partial<Omit<BusinessManifesto, "organizationId">>): BusinessManifesto {
    const cur = this.get(organizationId) || {
      organizationId, whyStatement: "", howPrinciples: [], whatSummary: "",
      founderStory: "", transformationPromise: "", toneVoice: "",
    };
    const next: BusinessManifesto = {
      organizationId,
      whyStatement: (patch.whyStatement ?? cur.whyStatement).trim().slice(0, 400),
      howPrinciples: safeJsonArray(patch.howPrinciples ?? cur.howPrinciples),
      whatSummary: (patch.whatSummary ?? cur.whatSummary).trim().slice(0, 300),
      founderStory: (patch.founderStory ?? cur.founderStory).trim().slice(0, 2000),
      transformationPromise: (patch.transformationPromise ?? cur.transformationPromise).trim().slice(0, 400),
      toneVoice: (patch.toneVoice ?? cur.toneVoice).trim().slice(0, 500),
    };
    db.prepare(`
      INSERT INTO business_manifesto (organization_id, why_statement, how_principles, what_summary, founder_story, transformation_promise, tone_voice, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(organization_id) DO UPDATE SET
        why_statement = excluded.why_statement,
        how_principles = excluded.how_principles,
        what_summary = excluded.what_summary,
        founder_story = excluded.founder_story,
        transformation_promise = excluded.transformation_promise,
        tone_voice = excluded.tone_voice,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      organizationId, next.whyStatement, JSON.stringify(next.howPrinciples),
      next.whatSummary, next.founderStory, next.transformationPromise, next.toneVoice,
    );
    return { ...next, updatedAt: new Date().toISOString() };
  },

  /**
   * "Constituição" injetada no topo do prompt de IA — versão compacta para
   * atendimento/negociação (não inclui a história fundadora completa, que só
   * entra em conteúdo/campanhas). Devolve string vazia se o manifesto está
   * vazio: a IA cai no fallback genérico sem quebrar.
   */
  toPromptHeader(organizationId: string): string {
    const m = this.get(organizationId);
    if (!m) return "";
    const hasContent = m.whyStatement || m.howPrinciples.length || m.transformationPromise || m.toneVoice;
    if (!hasContent) return "";
    const parts: string[] = [`=== MANIFESTO DA MARCA (constituição — todo comportamento e toda mensagem se ancora aqui) ===`];
    if (m.whyStatement) parts.push(`POR QUÊ (Sinek — a razão de existir da marca): ${m.whyStatement}`);
    if (m.transformationPromise) parts.push(`PROMESSA DE TRANSFORMAÇÃO (o que muda na vida do cliente): ${m.transformationPromise}`);
    if (m.whatSummary) parts.push(`O QUE ofertamos: ${m.whatSummary}`);
    if (m.howPrinciples.length) parts.push(`COMO agimos (princípios inegociáveis):\n${m.howPrinciples.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`);
    if (m.toneVoice) parts.push(`TOM DE VOZ (linguagem, registro, palavras-âncora): ${m.toneVoice}`);
    parts.push(`REGRA-MÃE: se uma mensagem sua diluir/contradizer este manifesto, ela está errada por definição — reformule antes de enviar. Consistência (Sinek) é o que gera lealdade.`);
    parts.push(`=========================================================`);
    return parts.join("\n\n");
  },

  /**
   * Bloco expandido (com história fundadora e promessa de transformação
   * completa) — usado no Estúdio de Criação, geração de copy, primeira mensagem
   * a lead frio e conteúdo de campanha (StorySelling).
   */
  toNarrativeContext(organizationId: string): string {
    const m = this.get(organizationId);
    if (!m) return "";
    const parts: string[] = [`=== MATÉRIA-BRUTA NARRATIVA DA MARCA ===`];
    if (m.whyStatement) parts.push(`PROPÓSITO: ${m.whyStatement}`);
    if (m.transformationPromise) parts.push(`TRANSFORMAÇÃO PROMETIDA: ${m.transformationPromise}`);
    if (m.founderStory) parts.push(`HISTÓRIA FUNDADORA (use como matéria-bruta narrativa — pode citar cenas, detalhes sensoriais, momento de virada; NUNCA invente elementos que não estão aqui):\n${m.founderStory}`);
    if (m.toneVoice) parts.push(`TOM E LINGUAGEM: ${m.toneVoice}`);
    parts.push(`==========================================`);
    return parts.join("\n\n");
  },
};
