/**
 * LaborLawAdvisorService — orientação TRABALHISTA (PRD Moda/TOULON; ADR-178).
 *
 * SCAFFOLD HONESTO, gated em CURADORIA JURÍDICA humana. A `LegalAdvisorService`
 * (ADR-115) já orienta o lojista ancorada no CDC (consumo). Falta o lado
 * TRABALHISTA (admissão, jornada/ponto, férias, rescisão/verbas…). Diferente do
 * CDC — cuja base já foi curada — a base trabalhista precisa ser REVISADA por
 * advogado/contador antes de virar produto. Então este service:
 *   - traz a TAXONOMIA dos temas (estrutura), mas NENHUMA regra não-revisada;
 *   - orienta SÓ ancorado em entradas CURADAS (`labor_law_entries`, cada uma com
 *     `reviewed_by` obrigatório) — recuperação DETERMINÍSTICA por termos, igual
 *     ao CDC (GROUNDED, custo zero);
 *   - base VAZIA → responde "aguardando validação jurídica", NUNCA inventa CLT;
 *   - o disclaimer é cravado por código em TODA resposta.
 *
 * A base é GLOBAL (lei federal é a mesma p/ todos) e escrita SÓ pelo admin master
 * (curadoria de plataforma) — espelha a camada compartilhada da ADR-156.
 *
 * Guardrails RN-178:
 *  - RN-178-001 (grounded): só orienta com base curada; sem amparo → honesto.
 *  - RN-178-002 (nunca inventa lei): base vazia/sem match → aguardando curadoria.
 *  - RN-178-003 (revisão obrigatória): `curate` EXIGE `reviewedBy` (o jurista).
 *  - RN-178-004 (curadoria é de plataforma): escrita master-only; tenant read-only.
 *  - RN-178-005 (disclaimer sempre): toda resposta carrega o aviso legal.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const DISCLAIMER =
  "Orientação trabalhista de caráter informativo — não substitui advogado ou contador. Regras trabalhistas (CLT, convenções coletivas) variam por categoria e mudam com frequência; confirme com um profissional antes de decidir.";

// Taxonomia dos temas trabalhistas (estrutura; o conteúdo vem da curadoria).
export const LABOR_TOPICS: { key: string; label: string }[] = [
  { key: "admissao", label: "Admissão e contrato" },
  { key: "jornada", label: "Jornada e controle de ponto" },
  { key: "ferias", label: "Férias" },
  { key: "decimo_terceiro", label: "13º salário" },
  { key: "aviso_previo", label: "Aviso prévio" },
  { key: "rescisao", label: "Rescisão e verbas rescisórias" },
  { key: "fgts", label: "FGTS" },
  { key: "afastamento", label: "Afastamentos e licenças" },
  { key: "estagio_aprendiz", label: "Estágio e jovem aprendiz" },
  { key: "seguranca", label: "Segurança e saúde no trabalho" },
];
const TOPIC_KEYS = new Set(LABOR_TOPICS.map((t) => t.key));

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
function safeParse(s: any): any { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }

export class LaborLawAdvisorService {
  private static entries(): any[] {
    return db.prepare(`SELECT * FROM labor_law_entries WHERE status = 'published'`).all() as any[];
  }

  /** Estado da base: quantas entradas curadas, se ainda aguarda curadoria. */
  static status(): any {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM labor_law_entries WHERE status = 'published'`).get() as any).n;
    const byTopic = db.prepare(`SELECT topic, COUNT(*) AS n FROM labor_law_entries WHERE status = 'published' GROUP BY topic`).all() as any[];
    const cov: Record<string, number> = {};
    for (const r of byTopic) cov[r.topic] = Number(r.n);
    return {
      curated: count > 0,
      awaitingCuration: count === 0,
      entriesCount: count,
      topics: LABOR_TOPICS.map((t) => ({ ...t, entries: cov[t.key] || 0 })),
      disclaimer: DISCLAIMER,
      note: count === 0
        ? "Base trabalhista aguardando validação jurídica — nenhuma regra publicada sem revisão de advogado/contador."
        : null,
    };
  }

  /**
   * Orienta sobre um tema/pergunta trabalhista — GROUNDED na base curada.
   * Recuperação determinística por termos (igual ao CDC). Sem base/sem match →
   * NÃO inventa: devolve "aguardando validação jurídica".
   */
  static advise(question: string, opts: { orgId?: string; actorId?: string } = {}): any {
    const q = norm(question);
    const entries = this.entries();
    let best: any = null, bestScore = 0;
    if (q) {
      for (const e of entries) {
        const terms: string[] = safeParse(e.terms_json) || [];
        let score = 0;
        for (const t of terms) { const tn = norm(t); if (tn && q.includes(tn)) score += tn.length >= 6 ? 2 : 1; }
        if (norm(e.title) && q.includes(norm(e.title))) score += 2;
        if (score > bestScore) { bestScore = score; best = e; }
      }
    }
    try { if (opts.orgId) logAuthEvent(opts.orgId, opts.actorId || "system", "labor", "LABOR_LAW_ADVISE", { grounded: !!best, awaitingCuration: entries.length === 0 }); } catch { /* noop */ }

    if (!best) {
      return {
        grounded: false,
        awaitingCuration: entries.length === 0,
        orientacao: entries.length === 0
          ? "A orientação trabalhista ainda está em validação jurídica. Não publicamos regra trabalhista sem revisão de um advogado/contador. Para este tema, consulte seu contador ou um advogado trabalhista."
          : "Não encontrei uma orientação curada para esse tema. Consulte seu contador ou um advogado trabalhista.",
        citations: [], topic: null, reviewedBy: null,
        disclaimer: DISCLAIMER,
      };
    }
    return {
      grounded: true,
      awaitingCuration: false,
      orientacao: best.guidance,
      citations: safeParse(best.citations_json) || [],
      topic: best.topic,
      reviewedBy: best.reviewed_by,
      source: best.source || null,
      disclaimer: DISCLAIMER,
    };
  }

  /** Lista as entradas curadas (para o painel master de curadoria). */
  static list(): any[] {
    const rows = db.prepare(`SELECT * FROM labor_law_entries WHERE status = 'published' ORDER BY topic, created_at DESC`).all() as any[];
    return rows.map((r) => ({
      id: r.id, topic: r.topic, title: r.title, guidance: r.guidance,
      citations: safeParse(r.citations_json) || [], terms: safeParse(r.terms_json) || [],
      source: r.source || null, reviewedBy: r.reviewed_by, createdAt: r.created_at,
    }));
  }

  /** Arquiva uma entrada (master-only) — some da recuperação; nunca DELETE. */
  static archive(id: string, actorId?: string): { archived: boolean } {
    const r = db.prepare(`UPDATE labor_law_entries SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'published'`).run(String(id || ""));
    if (r.changes) { try { logAuthEvent("_platform", actorId || "system", "labor", "LABOR_LAW_ARCHIVED", { id }); } catch { /* noop */ } }
    return { archived: !!r.changes };
  }

  /**
   * Publica uma entrada CURADA (master-only). EXIGE `reviewedBy` (RN-178-003) —
   * quem revisou juridicamente. Sem isso, nada entra na base.
   */
  static curate(entry: { topic: string; title: string; guidance: string; reviewedBy: string; citations?: any[]; terms?: string[]; source?: string }, actorId?: string): any {
    const topic = String(entry?.topic || "");
    if (!TOPIC_KEYS.has(topic)) throw new Error(`topic inválido (${[...TOPIC_KEYS].join("|")}).`);
    const title = String(entry?.title || "").trim();
    const guidance = String(entry?.guidance || "").trim();
    const reviewedBy = String(entry?.reviewedBy || "").trim();
    if (!title || !guidance) throw new Error("title e guidance são obrigatórios.");
    if (!reviewedBy) throw new Error("reviewedBy é obrigatório — nenhuma regra entra sem revisão jurídica (RN-178-003).");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO labor_law_entries (id, topic, title, guidance, citations_json, terms_json, source, reviewed_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, topic, title.slice(0, 300), guidance.slice(0, 8000),
      entry.citations ? JSON.stringify(entry.citations) : null,
      entry.terms ? JSON.stringify(entry.terms) : null,
      entry.source ? String(entry.source).slice(0, 300) : null, reviewedBy.slice(0, 200), actorId || null);
    try { logAuthEvent("_platform", actorId || "system", "labor", "LABOR_LAW_CURATED", { id, topic, reviewedBy }); } catch { /* noop */ }
    return { id, topic, title, reviewedBy };
  }
}

export default LaborLawAdvisorService;
