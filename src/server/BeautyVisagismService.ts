/**
 * BeautyVisagismService (ADR-169 F24 / BEAUTY-025) — Visagismo.
 *
 * Recomenda, de forma TÉCNICA:
 *   - subtom de pele (quente/frio/neutro) → famílias de COR que harmonizam;
 *   - formato do rosto (oval/redondo/quadrado/coração/alongado/triangular)
 *     → CORTES que equilibram a proporção — para perfil FEMININO, MASCULINO
 *     ou NEUTRO.
 *
 * Regra fundante (RN-BS-03): **NUNCA julga a aparência da pessoa**. Isto é
 * colorimetria + proporção — a mesma base técnica de uma consultoria de
 * imagem. A narrativa descreve o EFEITO ("tons dourados harmonizam com
 * subtom quente"; "camadas suavizam os ângulos do maxilar"), nunca a pessoa
 * ("ficaria mais bonita/jovem"). Um score de atratividade é EXPRESSAMENTE
 * proibido e não existe aqui.
 *
 * Como o subtom/formato são determinados (nesta ordem, honesto — RN-BS-11):
 *   1. MANUAL — a profissional avalia e informa (ela é treinada pra isso).
 *   2. IA — se `isAIConfigured()`, o Gemini/visão classifica a foto aprovada.
 *      O prompt pede SÓ a classificação técnica; proíbe julgamento.
 *   3. PENDING — sem manual e sem IA, retorna `indeterminado`. NUNCA inventa.
 *
 * A RECOMENDAÇÃO (subtom→cor, rosto→corte) é sempre DETERMINÍSTICA (mapas
 * abaixo), auditável e reprodutível — "determinístico antes de LLM". A IA só
 * classifica; ela nunca decide a recomendação.
 *
 * Guardrails: governança `estetica_appearance_advice` (actor+reason — RN-BS-03),
 * consent `hair_simulation`, disclaimer obrigatório, validador de palavras
 * proibidas, isolamento por org (RN-BS-07), vocab fechado (cores/cortes vêm de
 * COLOR_VOCAB/CUT_VOCAB — RN-BS-11).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { AiGovernanceService } from "./AiGovernanceService.js";
import { BeautyVisualConsultationService } from "./BeautyVisualConsultationService.js";
import { COLOR_VOCAB, CUT_VOCAB } from "./BeautyHairSimulationService.js";
import { safeStorageKey } from "./fileSigning.js";

const PRIVATE_MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "private_media");

export const UNDERTONES = ["quente", "frio", "neutro", "indeterminado"] as const;
export const FACE_SHAPES = ["oval", "redondo", "quadrado", "coracao", "alongado", "triangular", "indeterminado"] as const;
export const VISAGISM_PROFILES = ["feminino", "masculino", "neutro"] as const;
export type Undertone = (typeof UNDERTONES)[number];
export type FaceShape = (typeof FACE_SHAPES)[number];
export type VisagismProfile = (typeof VISAGISM_PROFILES)[number];

export const VISAGISM_DISCLAIMER =
  "Esta é uma orientação técnica de visagismo (harmonia de cores e proporção) — " +
  "nunca um julgamento sobre a pessoa. O resultado real depende do cabelo, da técnica e da " +
  "iluminação. A profissional do estabelecimento fará a avaliação final e conversará com você.";

// Palavras PROIBIDAS na narrativa (RN-BS-03). Se aparecer, o service LANÇA.
const FORBIDDEN_WORDS = [
  "bonito", "bonita", "bonitos", "bonitas", "feio", "feia", "feios", "feias",
  "atraente", "atraentes", "atrativo", "atrativa", "atrativos", "atrativas",
  "lindo", "linda", "lindos", "lindas", "nota", "notas", "score", "rank", "ranking",
  "pontuação", "pontuacao", "nível", "nivel", "melhor", "pior", "melhores", "piores",
  "envelhec", "rejuvenesc", "afin", "emagrec", "embel",
];

// ─── Colorimetria: subtom → famílias de cor (chaves de COLOR_VOCAB) ───
const UNDERTONE_COLORS: Record<Exclude<Undertone, "indeterminado">, { recommended: string[]; avoid: string[] }> = {
  quente: {
    recommended: ["loiro_dourado", "loiro_mel", "loiro_morango", "mel", "caramelo", "castanho_dourado", "castanho_acobreado", "chocolate", "ruivo_acobreado", "acaju"],
    avoid: ["loiro_platinado", "loiro_acinzentado", "prateado", "cinza", "preto_azulado", "castanho_acinzentado"],
  },
  frio: {
    recommended: ["loiro_perola", "loiro_acinzentado", "loiro_platinado", "castanho_acinzentado", "preto_azulado", "borgonha", "ruivo_borgonha", "prateado", "cinza"],
    avoid: ["loiro_dourado", "castanho_dourado", "castanho_acobreado", "caramelo", "mel", "ruivo_acobreado"],
  },
  neutro: {
    recommended: ["castanho", "castanho_claro", "loiro_bege", "mel", "caramelo", "chocolate", "loiro"],
    avoid: [],
  },
};

// ─── Visagismo: formato do rosto → cortes por perfil (chaves de CUT_VOCAB) ───
type CutRec = { feminino: string[]; masculino: string[]; neutro: string[]; rationale: string };
const FACESHAPE_CUTS: Record<Exclude<FaceShape, "indeterminado">, CutRec> = {
  oval: {
    feminino: ["bob", "long_bob", "camadas", "chanel", "longo", "franja_cortina"],
    masculino: ["social", "undercut", "degrade", "topete"],
    neutro: ["camadas", "medio", "social"],
    rationale: "o rosto oval é proporcional — a maioria dos cortes valoriza o equilíbrio natural",
  },
  redondo: {
    feminino: ["longo", "camadas", "corte_v", "franja_lateral", "repicado"],
    masculino: ["topete", "undercut", "moicano"],
    neutro: ["camadas", "longo", "topete"],
    rationale: "cortes com volume no topo e comprimento alongam visualmente o rosto redondo",
  },
  quadrado: {
    feminino: ["camadas", "ondulado", "long_bob", "franja_lateral", "repicado"],
    masculino: ["social", "undercut", "degrade"],
    neutro: ["camadas", "ondulado", "social"],
    rationale: "camadas e texturas suavizam os ângulos do maxilar do rosto quadrado",
  },
  coracao: {
    feminino: ["chanel", "franja_cortina", "franja_lateral", "long_bob"],
    masculino: ["social", "degrade"],
    neutro: ["chanel", "franja_cortina", "social"],
    rationale: "volume na altura do queixo equilibra a proporção entre testa e queixo",
  },
  alongado: {
    feminino: ["bob", "franja_reta", "ondulado", "chanel", "volume"],
    masculino: ["franja", "social"],
    neutro: ["bob", "franja_reta", "volume"],
    rationale: "franja e volume nas laterais reduzem o comprimento percebido do rosto alongado",
  },
  triangular: {
    feminino: ["pixie", "camadas", "volume", "repicado"],
    masculino: ["topete", "undercut"],
    neutro: ["camadas", "volume", "topete"],
    rationale: "volume no topo equilibra a base mais larga do rosto triangular",
  },
};

const onlyValid = (arr: string[], vocab: Set<string>) => arr.filter((k) => vocab.has(k));

export interface VisagismAnalysisRow {
  id: string;
  organizationId: string;
  consultationId: string;
  undertone: Undertone;
  faceShape: FaceShape;
  profile: VisagismProfile;
  source: "manual" | "ai" | "pending";
  recommendedColors: string[];
  recommendedCuts: string[];
  narrative: string;
  disclaimerShown: boolean;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export class BeautyVisagismService {
  static vocabulary() {
    return {
      undertones: UNDERTONES,
      faceShapes: FACE_SHAPES,
      profiles: VISAGISM_PROFILES,
      disclaimer: VISAGISM_DISCLAIMER,
      aiAvailable: isAiConfiguredSafe(),
    };
  }

  /**
   * Analisa (recomenda) para uma consulta. Subtom/formato vêm de:
   *   input manual → IA (se configurada) → indeterminado (nunca inventa).
   * A recomendação (cor/corte) é sempre determinística.
   */
  static async analyze(
    orgId: string,
    consultationId: string,
    opts: {
      actorId?: string | null;
      reason?: string | null;
      profile?: VisagismProfile;
      undertone?: Undertone;   // manual (opcional)
      faceShape?: FaceShape;   // manual (opcional)
    },
  ): Promise<VisagismAnalysisRow> {
    // RN-BS-03: sem actor+reason → lança human_decision_required.
    AiGovernanceService.guardApplied("estetica_appearance_advice", {
      decision: "applied",
      actorId: opts.actorId,
      reason: opts.reason,
    });

    const cons = BeautyVisualConsultationService.getConsultation(orgId, consultationId);
    if (!cons) throw new Error("Consulta não encontrada.");
    if (!cons.contactId) throw new Error("Consulta sem contato.");
    if (!BeautyVisualConsultationService.hasConsent(orgId, cons.contactId, "hair_simulation")) {
      throw new Error("Consent 'hair_simulation' revogado — visagismo não permitido.");
    }

    const profile: VisagismProfile = VISAGISM_PROFILES.includes(opts.profile as any) ? (opts.profile as VisagismProfile) : "feminino";

    // 1) Manual > 2) IA > 3) pending
    let undertone: Undertone = normalizeUndertone(opts.undertone);
    let faceShape: FaceShape = normalizeFaceShape(opts.faceShape);
    let source: "manual" | "ai" | "pending" = "pending";

    if (undertone !== "indeterminado" || faceShape !== "indeterminado") {
      source = "manual";
    } else if (isAiConfiguredSafe()) {
      const cls = await classifyFromPhoto(orgId, consultationId).catch(() => null);
      if (cls) {
        undertone = normalizeUndertone(cls.undertone);
        faceShape = normalizeFaceShape(cls.faceShape);
        if (undertone !== "indeterminado" || faceShape !== "indeterminado") source = "ai";
      }
    }

    // Recomendação DETERMINÍSTICA (só sobre o que foi determinado)
    const recommendedColors = undertone === "indeterminado" ? [] : onlyValid(UNDERTONE_COLORS[undertone].recommended, COLOR_VOCAB);
    const recommendedCuts = faceShape === "indeterminado" ? [] : onlyValid(FACESHAPE_CUTS[faceShape][profile], CUT_VOCAB);

    // F25 — se a ficha capilar registra histórico químico relevante, anexa o
    // caveat TÉCNICO (viabilidade é decisão da profissional — RN-BS-12).
    let chemCaveat = "";
    try {
      const { BeautyClientService } = await import("./BeautyClientService.js");
      const prof = BeautyClientService.getProfile(orgId, cons.contactId);
      if (prof?.chemicalHistory && ["progressiva", "descoloracao", "henna"].includes(prof.chemicalHistory)) {
        chemCaveat = ` Histórico químico registrado (${prof.chemicalHistory.replace(/_/g, " ")}): a viabilidade de nova química ou descoloração deve ser avaliada pela profissional antes de qualquer procedimento.`;
      }
    } catch { /* ficha é opcional */ }

    const narrative = renderNarrative({ undertone, faceShape, profile, recommendedColors, recommendedCuts }) + chemCaveat;
    validateNarrative(narrative);

    const id = randomUUID();
    db.prepare(
      `INSERT INTO beauty_visagism_analyses
         (id, organization_id, consultation_id, undertone, face_shape, profile, source,
          recommended_colors_json, recommended_cuts_json, narrative, disclaimer_shown, actor_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, orgId, consultationId, undertone, faceShape, profile, source,
          JSON.stringify(recommendedColors), JSON.stringify(recommendedCuts), narrative,
          opts.actorId || null, String(opts.reason || "").slice(0, 200));

    try {
      AiGovernanceService.recordDecision(orgId, {
        kind: "estetica_appearance_advice", subjectId: consultationId, decision: "applied",
        actorId: opts.actorId, reason: opts.reason, suggestedBy: source === "ai" ? "ai" : "human",
      });
    } catch { /* telemetria */ }
    try { logAuthEvent(orgId, opts.actorId || null, id, "BEAUTY_VISAGISM_CREATED", { consultationId, source, undertone, faceShape, profile }); } catch { /* noop */ }

    return this.getById(orgId, id)!;
  }

  static getById(orgId: string, id: string): VisagismAnalysisRow | null {
    const r = db.prepare(`SELECT * FROM beauty_visagism_analyses WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    return r ? rowTo(r) : null;
  }

  static listForConsultation(orgId: string, consultationId: string): VisagismAnalysisRow[] {
    const rows = db.prepare(
      `SELECT * FROM beauty_visagism_analyses WHERE organization_id = ? AND consultation_id = ? ORDER BY created_at DESC, rowid DESC`,
    ).all(orgId, consultationId) as any[];
    return rows.map(rowTo);
  }
}

function rowTo(r: any): VisagismAnalysisRow {
  return {
    id: r.id, organizationId: r.organization_id, consultationId: r.consultation_id,
    undertone: r.undertone, faceShape: r.face_shape, profile: r.profile, source: r.source,
    recommendedColors: JSON.parse(r.recommended_colors_json || "[]"),
    recommendedCuts: JSON.parse(r.recommended_cuts_json || "[]"),
    narrative: r.narrative, disclaimerShown: Number(r.disclaimer_shown) === 1,
    actorUserId: r.actor_user_id, reason: r.reason, createdAt: r.created_at,
  };
}

function normalizeUndertone(v?: string | null): Undertone {
  const s = String(v || "").trim().toLowerCase();
  return (UNDERTONES as readonly string[]).includes(s) ? (s as Undertone) : "indeterminado";
}
function normalizeFaceShape(v?: string | null): FaceShape {
  const s = String(v || "").trim().toLowerCase().replace("coração", "coracao");
  return (FACE_SHAPES as readonly string[]).includes(s) ? (s as FaceShape) : "indeterminado";
}

function isAiConfiguredSafe(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return !!(process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
  } catch { return false; }
}

/**
 * Classifica subtom + formato do rosto da foto aprovada via visão (best-effort).
 * O prompt pede SÓ a classificação técnica e PROÍBE qualquer julgamento
 * estético da pessoa (RN-BS-03). Qualquer falha → null (cai pro pending).
 */
async function classifyFromPhoto(orgId: string, consultationId: string): Promise<{ undertone: string; faceShape: string } | null> {
  const asset = db.prepare(
    `SELECT storage_key FROM beauty_avatar_assets WHERE organization_id = ? AND consultation_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1`,
  ).get(orgId, consultationId) as any;
  if (!asset?.storage_key) return null;
  let buf: Buffer;
  try { buf = fs.readFileSync(path.join(PRIVATE_MEDIA_DIR, safeStorageKey(asset.storage_key))); } catch { return null; }

  const { extractStructuredFromImage } = await import("./llm.js");
  const system =
    "Você é um assistente TÉCNICO de visagismo. Classifique APENAS dois atributos técnicos da foto: " +
    "(1) subtom de pele: 'quente', 'frio' ou 'neutro'; (2) formato do rosto: 'oval', 'redondo', 'quadrado', " +
    "'coracao', 'alongado' ou 'triangular'. É PROIBIDO avaliar, pontuar ou comentar a aparência, a beleza ou a " +
    "atratividade da pessoa — você só classifica os dois atributos técnicos. Se não for possível determinar com " +
    "segurança, use 'indeterminado'. Responda SOMENTE um JSON: {\"undertone\":\"...\",\"faceShape\":\"...\"}.";
  try {
    const raw = await extractStructuredFromImage(buf.toString("base64"), "image/jpeg", system, "Classifique subtom e formato do rosto.", "high");
    const j = JSON.parse(raw || "{}");
    return { undertone: String(j.undertone || ""), faceShape: String(j.faceShape || j.face_shape || "") };
  } catch { return null; }
}

// ─────────────────────── NARRATIVA (descritiva, RN-BS-03) ───────────────────────
function label(k: string): string { return k.replace(/_/g, " "); }

function renderNarrative(ctx: {
  undertone: Undertone; faceShape: FaceShape; profile: VisagismProfile;
  recommendedColors: string[]; recommendedCuts: string[];
}): string {
  const parts: string[] = [];

  if (ctx.undertone === "indeterminado") {
    parts.push("Subtom de pele não determinado — a profissional pode avaliar pessoalmente à luz natural.");
  } else {
    const c = UNDERTONE_COLORS[ctx.undertone];
    const rec = ctx.recommendedColors.map(label).join(", ");
    const avoid = onlyValid(c.avoid, COLOR_VOCAB).map(label).join(", ");
    parts.push(`Subtom ${ctx.undertone}: harmoniza com tons como ${rec}` + (avoid ? `; tons ${avoid} tendem a contrastar menos favoravelmente com a pele.` : "."));
  }

  if (ctx.faceShape === "indeterminado") {
    parts.push("Formato do rosto não determinado — a profissional pode avaliar as proporções pessoalmente.");
  } else {
    const cut = FACESHAPE_CUTS[ctx.faceShape];
    const rec = ctx.recommendedCuts.map(label).join(", ");
    parts.push(`Rosto ${ctx.faceShape} (${ctx.profile}): ${cut.rationale}; cortes como ${rec} valorizam a proporção.`);
  }

  parts.push(VISAGISM_DISCLAIMER);
  return parts.join(" ");
}

function validateNarrative(narrative: string): void {
  const lc = narrative.toLowerCase();
  for (const w of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${w}\\w*`, "u");
    if (re.test(lc)) throw new Error(`Narrativa de visagismo contém termo proibido "${w}" — RN-BS-03 viola.`);
  }
}
