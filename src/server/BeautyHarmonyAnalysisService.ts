/**
 * BeautyHarmonyAnalysisService (ADR-169 F8 / BEAUTY-008) — Análise de
 * Harmonia Visual.
 *
 * Regra fundante (RN-BS-03): **IA NUNCA julga aparência**. Este service
 * gera uma leitura DESCRITIVA — dimensões técnicas de estilo (contraste,
 * equilíbrio, destaque, volume, intensidade) — SEM ranking, SEM nota,
 * SEM adjetivo sobre a pessoa. O que a IA descreve é o EFEITO VISUAL da
 * mudança pretendida, nunca a pessoa em si.
 *
 * Determinístico (0 LLM): usa vocab fechado do Simulador (F6 —
 * COLOR_VOCAB, CUT_VOCAB) + goal/intensity da consulta pra derivar as
 * dimensões via mapa. Reprodutível, testável, sem custo de IA.
 *
 * Guardrails obrigatórios (checados na porta):
 *  - RN-BS-03: `AiGovernanceService.guardApplied("estetica_appearance_
 *    advice", ...)` — sem `actorId + reason` lança `human_decision_required`.
 *    A profissional/dona precisa ASSINAR a análise pra que ela seja gravada.
 *  - RN-BS-04: análise só permitida se `hair_simulation` consent ativo.
 *  - RN-BS-05: NUNCA loga foto/base64/prompt; `dimensions_json` é vocab
 *    fechado, `narrative` é template determinístico.
 *  - RN-BS-07: multi-tenant duro em toda query.
 *  - RN-BS-11: dimensões vindas fora do vocab são rejeitadas.
 *  - Disclaimer OBRIGATÓRIO (`disclaimer_shown=1` — PRD §31).
 *
 * PALAVRAS PROIBIDAS na narrativa (validação hard):
 *   bonito/feio/atraente/atrativo/beleza(além do nome do módulo)/lindo/
 *   feio/nota/score/rank/pontuação/nível/melhor/pior
 * → Se algum aparecer na `narrative` gerada, o service LANÇA (proteção
 *   contra regressão futura).
 */
import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";
import { AiGovernanceService } from "./AiGovernanceService.js";
import { BeautyVisualConsultationService } from "./BeautyVisualConsultationService.js";
import { BeautyHairSimulationService, COLOR_VOCAB, CUT_VOCAB } from "./BeautyHairSimulationService.js";

// Vocab fechado de dimensões (nunca ranking, nunca julgamento).
export const CONTRASTE_VALORES = ["baixo", "medio", "alto"] as const;
export const EQUILIBRIO_VALORES = ["harmônico", "dinâmico", "marcante"] as const;
export const DESTAQUE_VALORES = ["olhar", "rosto", "silhueta", "movimento"] as const;
export const VOLUME_VALORES = ["leve", "medio", "pronunciado"] as const;
export const INTENSIDADE_VALORES = ["discreta", "moderada", "marcante"] as const;

export type ContrasteValor = (typeof CONTRASTE_VALORES)[number];
export type EquilibrioValor = (typeof EQUILIBRIO_VALORES)[number];
export type DestaqueValor = (typeof DESTAQUE_VALORES)[number];
export type VolumeValor = (typeof VOLUME_VALORES)[number];
export type IntensidadeValor = (typeof INTENSIDADE_VALORES)[number];

export interface HarmonyDimensions {
  contraste: ContrasteValor;
  equilibrio: EquilibrioValor;
  destaque: DestaqueValor;
  volume: VolumeValor;
  intensidade: IntensidadeValor;
}

export interface BeautyVisualAnalysisRow {
  id: string;
  organizationId: string;
  consultationId: string;
  simulationId: string | null;
  dimensions: HarmonyDimensions;
  narrative: string;
  disclaimerShown: boolean;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export const HARMONY_DISCLAIMER =
  "Esta é uma leitura visual descritiva — nunca um julgamento sobre a pessoa. " +
  "O resultado real depende do seu cabelo, técnica utilizada, iluminação e outros fatores. " +
  "A profissional do estabelecimento fará a avaliação final e conversará com você sobre a opção mais adequada ao seu caso.";

// Palavras PROIBIDAS na narrativa (validação hard — proteção contra
// regressão futura). Se qualquer uma aparecer na `narrative` gerada, o
// service LANÇA (não silencia). NÃO inclui "beleza" pois é o nome do
// módulo/vertical; inclui só termos julgadores/rankings.
const FORBIDDEN_WORDS = [
  "bonito", "bonita", "bonitos", "bonitas",
  "feio", "feia", "feios", "feias",
  "atraente", "atraentes", "atrativo", "atrativa", "atrativos", "atrativas",
  "lindo", "linda", "lindos", "lindas",
  "nota", "notas", "score", "rank", "ranking", "pontuação", "pontuacao",
  "nível", "nivel", "níveis", "niveis",
  "melhor", "pior", "melhores", "piores",
  "envelhec", "rejuvenesc", "afin", "emagrec", "embel",
];

/**
 * Grupos de cores usados pra derivar contraste (não é ranking — é técnica
 * de estilo: mudar de escuro pra claro TEM alto contraste percebido, é fato).
 */
const COR_ESCURA = new Set(["preto", "preto_azulado", "castanho", "castanho_escuro"]);
const COR_MEDIA = new Set(["castanho_claro", "grisalho", "prateado", "ruivo_acobreado", "morena_iluminada", "ombre_hair"]);
const COR_CLARA = new Set(["loiro", "loiro_claro", "loiro_escuro", "loiro_platinado", "ruivo", "mechas", "balayage"]);

const CORTE_LEVE = new Set(["curto", "raspado", "degrade", "long_bob", "chanel"]);
const CORTE_MEDIO = new Set(["medio", "bob", "franja", "franja_lateral", "camadas", "repicado"]);
const CORTE_PRONUNCIADO = new Set(["longo", "ondulado", "cacheado", "liso"]);

export class BeautyHarmonyAnalysisService {
  /** Vocabulário exportado pra UI. */
  static vocabulary(): {
    contraste: readonly string[];
    equilibrio: readonly string[];
    destaque: readonly string[];
    volume: readonly string[];
    intensidade: readonly string[];
    disclaimer: string;
  } {
    return {
      contraste: CONTRASTE_VALORES,
      equilibrio: EQUILIBRIO_VALORES,
      destaque: DESTAQUE_VALORES,
      volume: VOLUME_VALORES,
      intensidade: INTENSIDADE_VALORES,
      disclaimer: HARMONY_DISCLAIMER,
    };
  }

  /**
   * Gera análise para uma consulta (opcionalmente sobre uma simulação
   * específica). Pré-condições:
   *  - Consulta existe na org.
   *  - Contato da consulta tem consent `hair_simulation` ativo.
   *  - `actorId` + `reason` obrigatórios (RN-BS-03 via `guardApplied`).
   *  - Se `simulationId` passado, deve pertencer à consulta e à org.
   *
   * Determinístico: dimensões derivam de goal/intensity/params via mapas.
   * Narrative gerada por template + palavras-chave — NUNCA de LLM.
   */
  static analyze(
    orgId: string,
    consultationId: string,
    opts: { simulationId?: string | null; actorId?: string | null; reason?: string | null },
  ): BeautyVisualAnalysisRow {
    // RN-BS-03: sem actor+reason → lança
    AiGovernanceService.guardApplied("estetica_appearance_advice", {
      decision: "applied",
      actorId: opts.actorId,
      reason: opts.reason,
    });

    const cons = BeautyVisualConsultationService.getConsultation(orgId, consultationId);
    if (!cons) throw new Error("Consulta não encontrada.");
    if (!cons.contactId) throw new Error("Consulta sem contato.");
    if (!BeautyVisualConsultationService.hasConsent(orgId, cons.contactId, "hair_simulation")) {
      throw new Error("Consent 'hair_simulation' revogado — análise não permitida.");
    }

    // Coleta parâmetros: da simulação (se passada) ou da consulta (goal/intensity)
    let color: string | null = null;
    let cut: string | null = null;
    if (opts.simulationId) {
      const sim = BeautyHairSimulationService.getSimulation(orgId, opts.simulationId);
      if (!sim) throw new Error("Simulação não encontrada.");
      if (sim.consultationId !== consultationId) throw new Error("Simulação não pertence à consulta.");
      color = sim.parameters?.color || null;
      cut = sim.parameters?.cut || null;
    }
    const goal = String(cons.goal || "").trim().toLowerCase();
    const intensity = String(cons.intensity || "").trim().toLowerCase();

    // Dimensões — determinísticas
    const dimensions: HarmonyDimensions = {
      contraste: deriveContraste(color),
      equilibrio: deriveEquilibrio(color, cut, goal),
      destaque: deriveDestaque(color, cut, goal),
      volume: deriveVolume(cut),
      intensidade: deriveIntensidade(intensity, color, cut),
    };

    const narrative = renderNarrative(dimensions, { color, cut, goal });
    validateNarrative(narrative);

    const id = randomUUID();
    db.prepare(
      `INSERT INTO beauty_visual_analyses
         (id, organization_id, consultation_id, simulation_id, dimensions_json,
          narrative, disclaimer_shown, actor_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, orgId, consultationId, opts.simulationId || null,
          JSON.stringify(dimensions), narrative,
          opts.actorId || null, String(opts.reason || "").slice(0, 200));

    // Registra como decisão IA (auditoria — ADR-130). Como a análise é
    // "aplicada" (será mostrada ao cliente), passa pela guarda de novo
    // (idempotente — guardApplied já rodou no início; recordDecision só
    // grava a linha em ai_decisions pra auditoria).
    try {
      AiGovernanceService.recordDecision(orgId, {
        kind: "estetica_appearance_advice",
        subjectId: consultationId,
        decision: "applied",
        actorId: opts.actorId,
        reason: opts.reason,
        suggestedBy: "ai",
      });
    } catch { /* já validamos acima — este bloco é só telemetria */ }

    try { logAuthEvent(orgId, opts.actorId || null, id, "BEAUTY_ANALYSIS_CREATED", { consultationId, simulationId: opts.simulationId || null }); } catch { /* noop */ }

    return this.getById(orgId, id)!;
  }

  static getById(orgId: string, analysisId: string): BeautyVisualAnalysisRow | null {
    const r = db.prepare(
      `SELECT * FROM beauty_visual_analyses WHERE id = ? AND organization_id = ?`,
    ).get(analysisId, orgId) as any;
    if (!r) return null;
    return rowToAnalysis(r);
  }

  static listForConsultation(orgId: string, consultationId: string): BeautyVisualAnalysisRow[] {
    const rows = db.prepare(
      // rowid DESC como tiebreaker — created_at pode empatar se 2 análises
      // caírem no mesmo segundo (padrão SQLite CURRENT_TIMESTAMP).
      `SELECT * FROM beauty_visual_analyses
        WHERE organization_id = ? AND consultation_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    ).all(orgId, consultationId) as any[];
    return rows.map(rowToAnalysis);
  }

  static getForSimulation(orgId: string, simulationId: string): BeautyVisualAnalysisRow | null {
    const r = db.prepare(
      `SELECT * FROM beauty_visual_analyses
        WHERE organization_id = ? AND simulation_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(orgId, simulationId) as any;
    if (!r) return null;
    return rowToAnalysis(r);
  }
}

function rowToAnalysis(r: any): BeautyVisualAnalysisRow {
  return {
    id: r.id,
    organizationId: r.organization_id,
    consultationId: r.consultation_id,
    simulationId: r.simulation_id,
    dimensions: JSON.parse(r.dimensions_json),
    narrative: r.narrative,
    disclaimerShown: Number(r.disclaimer_shown) === 1,
    actorUserId: r.actor_user_id,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

// ─────────────────────── DERIVADORES ───────────────────────

function deriveContraste(color: string | null): ContrasteValor {
  if (!color || !COLOR_VOCAB.has(color)) return "baixo";
  if (COR_CLARA.has(color)) return "alto";
  if (COR_MEDIA.has(color)) return "medio";
  if (COR_ESCURA.has(color)) return "baixo";
  return "medio";
}

function deriveEquilibrio(color: string | null, cut: string | null, goal: string): EquilibrioValor {
  const colorHigh = color && COR_CLARA.has(color);
  const cutStrong = cut && CORTE_PRONUNCIADO.has(cut);
  if (colorHigh && cutStrong) return "marcante";
  if (colorHigh || cutStrong) return "dinâmico";
  if (goal.includes("moderado") || goal.includes("discreto")) return "harmônico";
  return "harmônico";
}

function deriveDestaque(color: string | null, cut: string | null, goal: string): DestaqueValor {
  if (goal.includes("mecha") || goal.includes("balaya")) return "movimento";
  if (color && (COR_CLARA.has(color) || COR_MEDIA.has(color))) return "olhar";
  if (cut && CORTE_LEVE.has(cut)) return "rosto";
  return "silhueta";
}

function deriveVolume(cut: string | null): VolumeValor {
  if (!cut || !CUT_VOCAB.has(cut)) return "medio";
  if (CORTE_LEVE.has(cut)) return "leve";
  if (CORTE_MEDIO.has(cut)) return "medio";
  if (CORTE_PRONUNCIADO.has(cut)) return "pronunciado";
  return "medio";
}

function deriveIntensidade(intensity: string, color: string | null, cut: string | null): IntensidadeValor {
  if (intensity === "transformacao") return "marcante";
  if (intensity === "moderado" || intensity === "moderada") return "moderada";
  if (intensity === "discreto" || intensity === "discreta") return "discreta";
  // Sem intensity declarada — infere pelo par (cor+corte)
  const colorHigh = color && COR_CLARA.has(color);
  const cutStrong = cut && CORTE_PRONUNCIADO.has(cut);
  if (colorHigh && cutStrong) return "marcante";
  if (colorHigh || cutStrong) return "moderada";
  return "discreta";
}

// ─────────────────────── NARRATIVA ───────────────────────

/**
 * Template determinístico. Descreve o EFEITO da mudança, nunca a pessoa.
 * Sempre inclui as 5 dimensões + goal descrito (quando existe).
 */
function renderNarrative(d: HarmonyDimensions, ctx: { color: string | null; cut: string | null; goal: string }): string {
  const partes: string[] = [];
  if (ctx.goal) partes.push(`Para o objetivo "${sanitizeText(ctx.goal)}"`);
  else partes.push("Para esta proposta de visual");

  const changeDesc: string[] = [];
  if (ctx.color) changeDesc.push(`cor "${ctx.color.replace(/_/g, " ")}"`);
  if (ctx.cut) changeDesc.push(`corte "${ctx.cut.replace(/_/g, " ")}"`);
  if (changeDesc.length) partes.push(`com ${changeDesc.join(" e ")}`);

  // Nota: usamos VERBOS DE EFEITO ("cria", "acentua", "confere"), nunca
  // ADJETIVOS DA PESSOA. As dimensões descrevem o RESULTADO técnico.
  const lines: string[] = [];
  lines.push(`Contraste ${d.contraste}: a mudança cria uma diferença ${d.contraste === "alto" ? "expressiva" : d.contraste === "medio" ? "moderada" : "sutil"} em relação ao tom atual.`);
  lines.push(`Equilíbrio ${d.equilibrio}: o conjunto propõe um resultado ${d.equilibrio === "marcante" ? "de forte presença" : d.equilibrio === "dinâmico" ? "com movimento" : "equilibrado"}.`);
  lines.push(`Destaque ao ${d.destaque}: a leitura visual guia o olhar para o ${d.destaque}.`);
  lines.push(`Volume ${d.volume}: o corte confere volume ${d.volume === "pronunciado" ? "expressivo" : d.volume === "medio" ? "moderado" : "leve"}.`);
  lines.push(`Intensidade ${d.intensidade}: no todo, é uma transformação ${d.intensidade}.`);

  const header = partes.join(" ") + ":";
  return [header, ...lines, HARMONY_DISCLAIMER].join(" ");
}

/**
 * Sanitização paranoia: se palavra proibida escapou pra `narrative` (bug
 * futuro), LANÇA. Nunca silencia — proteção contra regressão.
 */
function validateNarrative(narrative: string): void {
  const lc = narrative.toLowerCase();
  for (const w of FORBIDDEN_WORDS) {
    // Word-boundary match — evita falsos positivos ("melhor" vs "melhorar",
    // "atractivo/atraente" já cobre); "envelhec" cobre envelhecer.
    const re = new RegExp(`\\b${w}\\w*`, "u");
    if (re.test(lc)) {
      throw new Error(`Narrativa contém termo proibido "${w}" — RN-BS-03 viola.`);
    }
  }
}

/** Remove chars não-alfanuméricos comuns (goal é texto do usuário). */
function sanitizeText(s: string): string {
  return String(s || "").replace(/[^\p{L}\p{N}\s_.-]/gu, "").slice(0, 100);
}
