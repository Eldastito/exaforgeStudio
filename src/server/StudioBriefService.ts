/**
 * StudioBriefService (PRD 10 / ADR-167 F8 — Studio Intelligence Handoff) — transforma
 * uma OPORTUNIDADE (F7, `business_signals`) num BRIEFING orientado pro Estúdio: em vez
 * de tela em branco, o Estúdio abre já sabendo POR QUE está criando (nicho, tópico,
 * ângulo, formato sugerido, procedência). ESTENDE o `StudioService` existente (§42 — SEM
 * 2º Estúdio): produz a ENTRADA (`briefingText`) que alimenta `StudioService.generate`.
 *
 * Read-only/determinístico (SEM LLM, SEM tabela nova): só LÊ o sinal + a marca e deriva o
 * briefing por template. GROUNDING (RN-SI-02): tudo vem da evidência da oportunidade —
 * que já é fundamentada em inteligência fresca; NUNCA inventa. Carrega o `correlationId`
 * do sinal (ADR-158): o fio percepção→oportunidade→conteúdo→publicação→outcome fica
 * contínuo. Procedência explícita (`evidenceMode`, §53/§54) + caveats. Isolamento
 * (convenção #1): `orgId` 1º arg; toda leitura filtra a org.
 */
import db from "./db.js";
import { StudioService, type StudioFormat } from "./StudioService.js";

export interface StudioOpportunity {
  signalId: string;
  correlationId: string | null;
  vertical: string | null;
  topic: string | null;
  channel: string | null;
  evidenceMode: string;
  confidence: number | null;
  validUntil: string | null;
  summary: string | null;
}

export interface StudioBrief extends StudioOpportunity {
  angle: string;
  suggestedFormat: StudioFormat;
  briefingText: string;
  brand: { tone?: string; style?: string; summary?: string } | null;
  provenance: { evidenceMode: string; source: string | null; basis: string; confidence: number | null; validUntil: string | null };
  caveats: string[];
}

export class StudioBriefService {
  private static signalRow(orgId: string, signalId: string): any | undefined {
    return db.prepare(
      `SELECT * FROM business_signals WHERE id = ? AND organization_id = ? AND domain = 'social' AND signal_type = 'content_opportunity'`,
    ).get(signalId, orgId) as any;
  }

  private static parseEvidence(row: any): any {
    try { return JSON.parse(row?.evidence_json || "{}"); } catch { return {}; }
  }
  private static parseCaveats(row: any): string[] {
    try { const p = JSON.parse(row?.premises_json || "{}"); return Array.isArray(p?.caveats) ? p.caveats : []; } catch { return []; }
  }

  /** Oportunidades de conteúdo ABERTAS e não expiradas (candidatas a virar briefing). */
  static listOpportunities(orgId: string): StudioOpportunity[] {
    const rows = db.prepare(
      `SELECT * FROM business_signals
       WHERE organization_id = ? AND domain = 'social' AND signal_type = 'content_opportunity'
         AND status = 'open' AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
       ORDER BY detected_at DESC LIMIT 50`,
    ).all(orgId) as any[];
    return rows.map((r) => this.toOpportunity(r));
  }

  private static toOpportunity(row: any): StudioOpportunity {
    const ev = this.parseEvidence(row);
    return {
      signalId: row.id,
      correlationId: row.correlation_id || null,
      vertical: ev.vertical ?? null,
      topic: ev.topic ?? null,
      channel: ev.channel ?? null,
      evidenceMode: ev.evidenceMode || "model_knowledge",
      confidence: typeof row.confidence === "number" ? row.confidence : null,
      validUntil: row.expires_at || ev.validUntil || null,
      summary: ev.summary ?? null,
    };
  }

  /**
   * Monta o briefing orientado a partir de UMA oportunidade. Retorna null se o sinal não
   * existe (ou não é uma oportunidade de conteúdo desta org). Determinístico, sem LLM.
   */
  static fromOpportunity(orgId: string, signalId: string): StudioBrief | null {
    const row = this.signalRow(orgId, signalId);
    if (!row) return null;
    const opp = this.toOpportunity(row);
    const ev = this.parseEvidence(row);
    const caveats = this.parseCaveats(row);

    // Marca (opcional) — dá tom/estilo ao briefing; sem marca o Estúdio ainda funciona.
    const brandProfile = StudioService.getBrand(orgId);
    const brand = brandProfile ? { tone: brandProfile.tone, style: brandProfile.style, summary: brandProfile.summary } : null;

    // Ângulo e formato DETERMINÍSTICOS (sem inventar métrica). Formato sugerido cresce com
    // o desempenho próprio (F4): se a conta já publica e engaja, sugere vídeo curto (story).
    const ownPosts = Number(ev?.own?.posts || 0);
    const suggestedFormat: StudioFormat = ownPosts > 0 ? "story" : "post";
    const topic = opp.topic || "conteúdo do nicho";
    const angle = `Aproveitar o movimento do nicho${opp.vertical ? ` ${opp.vertical}` : ""} sobre "${topic}" no momento certo.`;

    const brandLine = brand?.tone || brand?.style ? ` Mantenha o tom ${[brand?.tone, brand?.style].filter(Boolean).join(", ")}.` : "";
    const freshLine = opp.validUntil ? ` Oportunidade válida até ${opp.validUntil}.` : "";
    const provLine = opp.evidenceMode === "live" ? " (baseado em fonte de mercado recuperada)" : " (baseado em síntese de mercado do modelo)";
    const briefingText =
      `Crie conteúdo para ${opp.channel || "redes sociais"} sobre "${topic}" no nicho ${opp.vertical || "do negócio"}.` +
      ` ${angle}${provLine}.${brandLine}${freshLine}`.trim();

    return {
      ...opp,
      angle,
      suggestedFormat,
      briefingText,
      brand,
      provenance: {
        evidenceMode: opp.evidenceMode,
        source: ev.source ?? null,
        basis: row.basis || "hypothesis",   // PUBLISHED ≠ RESULTADO (RN-SI-03)
        confidence: opp.confidence,
        validUntil: opp.validUntil,
      },
      caveats,
    };
  }
}

export default StudioBriefService;
