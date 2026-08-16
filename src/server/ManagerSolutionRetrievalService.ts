/**
 * Recuperação de soluções validadas do gerente (PRD Moda/TOULON, LEARN-006; ADR-174).
 *
 * A IA/operador PODE recuperar soluções VALIDADAS em contexto semelhante,
 * DECLARANDO: origem HUMANA, onde funcionou e a evidência; e SUGERINDO teste
 * controlado em contexto novo. A IA NÃO pode afirmar eficácia GERAL se a
 * evidência for LOCAL (uma loja) ou INSUFICIENTE (baixa confiança).
 *
 * Determinístico e read-only. Só lê da memória de padrões (retail_store_patterns,
 * pattern_type 'manager_solution', status 'validated' — revogadas viram 'dormant'
 * e SOMEM daqui, LEARN-007). Isolado por organização.
 */
import db from "./db.js";
import { ManagerSolutionService } from "./ManagerSolutionService.js";

const CONFIDENT = 0.6; // abaixo disto, evidência é "insuficiente"

export class ManagerSolutionRetrievalService {
  private static storeName(orgId: string, storeId?: string | null): string {
    if (!storeId) return "rede (todas as lojas)";
    const s = db.prepare(`SELECT name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    return s?.name || "loja";
  }

  /** Soluções validadas relevantes a um PADRÃO (mesmo tipo de problema). */
  static forPattern(orgId: string, patternId: string): any[] {
    const target = db.prepare(`SELECT pattern_type, store_id FROM retail_store_patterns WHERE organization_id = ? AND id = ?`).get(orgId, patternId) as any;
    if (!target) return [];
    return this.retrieve(orgId, { patternType: target.pattern_type, storeId: target.store_id, excludePatternId: patternId });
  }

  /**
   * Recupera soluções validadas para um contexto (tipo de problema + loja).
   * Cada item DECLARA origem/onde/evidência e traz a cautela adequada.
   */
  static retrieve(orgId: string, ctx: { patternType?: string; storeId?: string | null; excludePatternId?: string }): any[] {
    const candidates = db.prepare(
      `SELECT * FROM retail_store_patterns WHERE organization_id = ? AND pattern_type = 'manager_solution' AND status = 'validated' ORDER BY confidence DESC`
    ).all(orgId) as any[];

    const out: any[] = [];
    for (const c of candidates) {
      if (ctx.excludePatternId && c.id === ctx.excludePatternId) continue;
      const proposalId = String(c.pattern_key || "").startsWith("solution:") ? String(c.pattern_key).slice("solution:".length) : null;
      const proposal = proposalId ? ManagerSolutionService.get(orgId, proposalId) : null;
      // Só o que está PROMOVIDO (não revogado/rejeitado) participa da recuperação.
      if (!proposal || proposal.state !== "promoted") continue;

      // Contexto endereçado pela solução = tipo do padrão que a proposta referenciou.
      let addressedType: string | null = null;
      if (proposal.ref_type === "pattern" && proposal.ref_id) {
        const ref = db.prepare(`SELECT pattern_type FROM retail_store_patterns WHERE organization_id = ? AND id = ?`).get(orgId, proposal.ref_id) as any;
        addressedType = ref?.pattern_type || null;
      }
      // Filtro de contexto: quando pediram um tipo, só casa o MESMO tipo de problema.
      if (ctx.patternType && addressedType && addressedType !== ctx.patternType) continue;
      if (ctx.patternType && !addressedType) continue; // sem como aferir semelhança → não arrisca

      const confidence = Number(c.confidence) || 0;
      const solutionStore = c.store_id || null;         // null = rede
      const local = !!solutionStore;                    // evidência de uma loja só
      const insufficient = confidence < CONFIDENT;
      const differentStore = !!(ctx.storeId && solutionStore && ctx.storeId !== solutionStore);
      const generalizable = !local && !insufficient;    // rede + confiante

      let caveat: string;
      if (insufficient) caveat = `Evidência ainda insuficiente (confiança ${Math.round(confidence * 100)}%). Trate como HIPÓTESE e faça um teste controlado antes de confiar.`;
      else if (local) caveat = `Funcionou em ${this.storeName(orgId, solutionStore)}. Evidência LOCAL${differentStore ? " (loja diferente da atual)" : ""} — faça um teste controlado antes de generalizar.`;
      else caveat = `Validada na rede (confiança ${Math.round(confidence * 100)}%). Recomende ACOMPANHAR o resultado ao aplicar.`;

      let evidence: any = {};
      try { evidence = JSON.parse(c.evidence_json || "{}"); } catch { evidence = {}; }

      out.push({
        proposalId, title: proposal.title, proposal: proposal.proposal_text,
        origin: "humana", author_user_id: proposal.author_user_id,
        whereWorked: this.storeName(orgId, solutionStore), scope: solutionStore ? "loja" : "rede",
        addressedType,
        evidence: { baseline: evidence.baseline ?? proposal.baseline ?? null, final: evidence.final ?? proposal.outcome_final ?? null, confidence, period: evidence.period ?? proposal.outcome_period ?? null },
        generalizable, caveat,
        // Nunca afirma eficácia geral: a "claim" é sempre condicionada.
        claim: generalizable ? "solução validada na rede — acompanhe o resultado" : "solução validada em contexto específico — teste antes de generalizar",
      });
    }
    return out;
  }
}
