import db from "./db.js";
import { VERTICALS } from "./verticals.js";
import { BrandCoreService } from "./BrandCoreService.js";

/**
 * BrandVerticalProfileService — PRD 07 (roadmap "Evolução de Marca"): comunicação por VERTICAL.
 *
 * A marca INSTITUCIONAL do ZapFlow (Brand Core, PRD 01) FALA a língua de cada nicho sem virar
 * "vários ZapFlows". REGRA DURA (§ "Uma vertical não pode redefinir a essência da marca"): a
 * essência/promessa/mecanismo são SEMPRE herdadas do Brand Core publicado — o overlay de
 * vertical só adapta DOR, LINGUAGEM, EXEMPLO, BENEFÍCIO e feature prioritária. O `resolve()`
 * garante isso: os campos herdados vêm do Brand Core, nunca do overlay (o overlay não os tem).
 *
 * GLOBAL / master-only (escopo plataforma, como o Brand Core institucional) — 1 linha por
 * vertical em `brand_vertical_profiles`. ESTENDE `verticals.ts` (fonte única de verticais) —
 * a `vertical` é validada contra as chaves conhecidas; não inventa vertical. Aditivo/reversível.
 * Nunca inventa: sem overlay → arrays vazios; sem Brand Core publicado → herdado null (honesto).
 */

export interface VerticalBrandOverlay {
  pains: string[];
  desiredOutcomes: string[];
  terminology: string[];
  commonObjections: { objection: string; response: string }[];
  relevantCapabilities: string[];
  proofPoints: string[];
  messagingExamples: string[];
}

const VALID: Set<string> = new Set(VERTICALS.map((v) => v.key));
function labelOf(vertical: string): string { return VERTICALS.find((v) => v.key === vertical)?.label || vertical; }
function arr(v: any): any[] { return Array.isArray(v) ? v : []; }
function strArr(v: any): string[] { return arr(v).map((x) => String(x).trim()).filter(Boolean); }

function emptyOverlay(): VerticalBrandOverlay {
  return { pains: [], desiredOutcomes: [], terminology: [], commonObjections: [], relevantCapabilities: [], proofPoints: [], messagingExamples: [] };
}

function normalize(patch: any, base: VerticalBrandOverlay): VerticalBrandOverlay {
  const p = patch || {};
  return {
    pains: "pains" in p ? strArr(p.pains) : base.pains,
    desiredOutcomes: "desiredOutcomes" in p ? strArr(p.desiredOutcomes) : base.desiredOutcomes,
    terminology: "terminology" in p ? strArr(p.terminology) : base.terminology,
    commonObjections: "commonObjections" in p
      ? arr(p.commonObjections).map((o: any) => ({ objection: String(o?.objection || "").trim(), response: String(o?.response || "").trim() })).filter((o) => o.objection || o.response)
      : base.commonObjections,
    relevantCapabilities: "relevantCapabilities" in p ? strArr(p.relevantCapabilities) : base.relevantCapabilities,
    proofPoints: "proofPoints" in p ? strArr(p.proofPoints) : base.proofPoints,
    messagingExamples: "messagingExamples" in p ? strArr(p.messagingExamples) : base.messagingExamples,
  };
}

// Defaults estratégicos (§ exemplos do PRD 07). Só os nichos citados nascem com rascunho; os
// demais nascem vazios (não inventa). Aplicados pelo `get` quando ainda não há linha.
const DEFAULTS: Partial<Record<string, Partial<VerticalBrandOverlay>>> = {
  moda: {
    pains: ["Não saber em tempo real o que acontece nas lojas sem perguntar."],
    messagingExamples: ["Menos dependência do dono para entender o que está acontecendo nas lojas."],
  },
  petshop: {
    pains: ["Acompanhar a operação enquanto se cuida de outras prioridades (atendimento, banho & tosa)."],
    messagingExamples: ["Sua operação acompanhada mesmo quando você está cuidando de outras prioridades."],
  },
  saude: {
    pains: ["Administração manual roubando tempo do cuidado com o paciente."],
    messagingExamples: ["Menos administração manual. Mais atenção ao paciente."],
  },
  advocacia: {
    pains: ["Informações, clientes e prazos presos na memória da equipe."],
    messagingExamples: ["Informações, clientes e atividades importantes sem depender apenas da memória da equipe."],
  },
};

export class BrandVerticalProfileService {
  static isValidVertical(vertical: string): boolean { return VALID.has(String(vertical)); }

  /** Overlay de uma vertical (aplica o rascunho default se ainda não há linha). Nunca inventa
   *  além dos defaults documentados; verticais não citadas nascem vazias. */
  static get(vertical: string): { vertical: string; label: string; overlay: VerticalBrandOverlay; configured: boolean } {
    if (!this.isValidVertical(vertical)) throw new Error(`Vertical desconhecida: ${vertical}`);
    const row = db.prepare("SELECT profile_json FROM brand_vertical_profiles WHERE vertical = ?").get(vertical) as any;
    if (row?.profile_json) {
      let o: any = {}; try { o = JSON.parse(row.profile_json); } catch { o = {}; }
      return { vertical, label: labelOf(vertical), overlay: normalize(o, emptyOverlay()), configured: true };
    }
    const seed = DEFAULTS[vertical];
    return { vertical, label: labelOf(vertical), overlay: seed ? normalize(seed, emptyOverlay()) : emptyOverlay(), configured: false };
  }

  /** Lista todas as verticais conhecidas com seu estado (configurada ou não). */
  static list(): { vertical: string; label: string; configured: boolean }[] {
    const configured = new Set((db.prepare("SELECT vertical FROM brand_vertical_profiles").all() as any[]).map((r) => r.vertical));
    return VERTICALS.map((v) => ({ vertical: v.key, label: v.label, configured: configured.has(v.key) }));
  }

  /** Salva/atualiza o overlay (merge parcial). Master-only na rota. NÃO aceita campos de
   *  essência (o overlay não os tem) — a herança é garantida no `resolve`. */
  static set(vertical: string, patch: any, actor?: string): { vertical: string; label: string; overlay: VerticalBrandOverlay; configured: boolean } {
    if (!this.isValidVertical(vertical)) throw new Error(`Vertical desconhecida: ${vertical}`);
    const current = this.get(vertical).overlay;
    const merged = normalize(patch, current);
    db.prepare(`INSERT INTO brand_vertical_profiles (vertical, profile_json, updated_by, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(vertical) DO UPDATE SET profile_json = excluded.profile_json, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`).run(vertical, JSON.stringify(merged), actor || null);
    return this.get(vertical);
  }

  /**
   * Resolver (§ "getBrandMessaging por contexto de vertical"): COMBINA a marca herdada do
   * Brand Core (essência/promessa/mecanismo — INTOCÁVEL) com o overlay da vertical. É o que os
   * consumidores por-vertical pedem. `inherited` sempre vem do Brand Core publicado (nunca do
   * overlay); sem Brand Core publicado → inherited null (honesto).
   */
  static resolve(vertical: string): {
    vertical: string; label: string;
    inherited: { essence: string | null; promise: string | null; mechanism: any } | null;
    overlay: VerticalBrandOverlay; brandConfigured: boolean; verticalConfigured: boolean;
  } {
    if (!this.isValidVertical(vertical)) throw new Error(`Vertical desconhecida: ${vertical}`);
    const ctx = BrandCoreService.getBrandCoreContext();
    const inherited = ctx.configured && ctx.brand
      ? { essence: ctx.brand.essence, promise: ctx.brand.promise, mechanism: ctx.brand.mechanism }
      : null;
    const v = this.get(vertical);
    return { vertical, label: v.label, inherited, overlay: v.overlay, brandConfigured: !!inherited, verticalConfigured: v.configured };
  }
}

export default BrandVerticalProfileService;
