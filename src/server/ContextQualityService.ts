import {
  ContextFact,
  ContextQuality,
  ContextQualityReport,
  ContextCoverageItem,
  ContextConflict,
  ContextRequest,
  ConfidenceBand,
  EvidenceReference,
  RagHitLike,
  confidenceBand,
  clampConfidence,
  freshnessOf,
  detectConflict,
  evidenceFromRagHit,
} from "./contextModel.js";
import { BusinessHealthService } from "./BusinessHealthService.js";

/**
 * ContextQualityService — PRD 3 F8 (§75/§34): a QUALIDADE DO CONTEXTO como leitura
 * de 1ª classe. "Quanta confiança dá pra ter NESTE contexto" — cobertura +
 * confiança + frescor + conflitos + lacunas — consolidada num só lugar.
 *
 * É COMPOR (AC-A01): a matemática do resumo (`assessFromFacts`) foi EXTRAÍDA do
 * `ContextResolverService.computeQuality` (F3) pra cá — o resolver agora DELEGA
 * (fonte única, zero duplicação; o `packet.quality` segue idêntico → 0 regressão).
 * Sobre isso a F8 acrescenta o relatório RICO (`assess`): cobertura POR-FONTE
 * (§34 — o que está disponível × ausente), os conflitos DETALHADOS (§31, não só a
 * contagem) e a proveniência AGREGADA por tipo de fonte (§24) — reusando a
 * evidência estruturada do RAG (F7, `evidenceFromRagHit`).
 *
 * GUARDRAILS (testados):
 *   - RN-CQ-1 ISOLAMENTO (§66): `orgId` 1º arg; herda o filtro dos serviços lidos.
 *   - RN-CQ-2 NÃO INVENTA (§25): sem dado → cobertura null / lacuna, nunca valor
 *     fabricado; frescor ausente é `unknown`, não "fresco".
 *   - RN-CQ-3 NÃO OCULTA CONFLITO (§31): conflito entre fontes é REPORTADO
 *     (detalhado), nunca resolvido em silêncio.
 *   - RN-CQ-4 READ + DERIVE (AC-A02/§90): só leitura/derivação; nada de escrita.
 *   - RN-CQ-5 ESTENDE, não duplica (AC-A01): o resolver delega aqui.
 */
export class ContextQualityService {
  /**
   * §75 — o RESUMO de qualidade a partir dos fatos do pacote (cobertura +
   * confiança + frescor + conflitos + lacunas). EXTRAÍDO do resolver (F3) —
   * comportamento idêntico. `now` injetável pra frescor determinístico em teste.
   */
  static assessFromFacts(orgId: string, facts: ContextFact[], now = Date.now()): ContextQuality {
    let coveragePct: number | null = null;
    const gaps: string[] = [];
    try {
      const dq = BusinessHealthService.dataQuality(orgId);
      if (dq) {
        coveragePct = Number(dq.pct);
        for (const it of dq.items || []) if (!it.ok) gaps.push(String(it.label));
      }
    } catch { /* sem dataQuality: cobertura desconhecida (null), não zero falso */ }

    // Confiança: média dos fatos; sem fato → cobertura (se houver) como proxy.
    const avg = facts.length
      ? facts.reduce((s, f) => s + clampConfidence(f.confidence), 0) / facts.length
      : (coveragePct != null ? coveragePct / 100 : 0);
    const score = clampConfidence(avg);
    const band: ConfidenceBand = confidenceBand(score);

    // Frescor: conta os fatos por status derivado (reusa freshnessOf da F1).
    const freshness = { fresh: 0, stale: 0, unknown: 0 };
    for (const f of facts) {
      const fr = freshnessOf({ observedAt: f.observedAt, validUntil: f.validUntil }, now);
      freshness[fr.status] += 1;
    }

    // Conflitos (§31): fatos com mesmo subject|predicate mas OBJETO divergente.
    let conflicts = 0;
    for (const [, g] of groupBySubjectPredicate(facts)) {
      if (g.length < 2) continue;
      const c = detectConflict("object", g.map((f) => ({ source: f.source, value: f.object, confidence: f.confidence, observedAt: f.observedAt })));
      if (c) conflicts += 1;
    }

    return { coveragePct, confidence: { score, band }, freshness, conflicts, gaps };
  }

  /**
   * §34 — cobertura POR-FONTE: cada item do `dataQuality` vira uma linha de
   * disponibilidade (available:true/false). Ausência é ausência (§25) — não vira
   * "disponível". Best-effort → [] se `dataQuality` indisponível.
   */
  static coverageByItem(orgId: string): { pct: number | null; items: ContextCoverageItem[] } {
    try {
      const dq = BusinessHealthService.dataQuality(orgId);
      if (!dq) return { pct: null, items: [] };
      return {
        pct: Number(dq.pct),
        items: (dq.items || []).map((it: any) => ({ key: String(it.key), label: String(it.label), available: !!it.ok })),
      };
    } catch { return { pct: null, items: [] }; }
  }

  /**
   * §31 — os conflitos DETALHADOS (não só a contagem): pra cada grupo
   * subject|predicate com objeto divergente, devolve o `ContextConflict` com os
   * valores/fontes em disputa. NÃO resolve (RN-CQ-3) — expõe.
   */
  static conflictsDetailed(facts: ContextFact[]): ContextConflict[] {
    const out: ContextConflict[] = [];
    for (const [key, g] of groupBySubjectPredicate(facts)) {
      if (g.length < 2) continue;
      const c = detectConflict(key, g.map((f) => ({ source: f.source, value: f.object, confidence: f.confidence, observedAt: f.observedAt })));
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * §24 — proveniência AGREGADA: conta as `EvidenceReference` dos fatos por tipo
   * de fonte (INTERNAL_DB, APPROVED_DOCUMENT do RAG/F7, …). Quando `ragHits` é
   * informado, FUNDE a evidência estruturada do RAG (F7, `evidenceFromRagHit`) —
   * é onde a proveniência de RAG/memória entra no cálculo de qualidade.
   */
  static evidenceSummary(facts: ContextFact[], ragHits?: RagHitLike[]): { total: number; bySourceType: Record<string, number> } {
    const bySourceType: Record<string, number> = {};
    let total = 0;
    const count = (ev: EvidenceReference) => { const t = String(ev.sourceType); bySourceType[t] = (bySourceType[t] || 0) + 1; total += 1; };
    for (const f of facts) for (const ev of f.evidence || []) count(ev);
    for (const h of ragHits || []) count(evidenceFromRagHit(h));
    return { total, bySourceType };
  }

  /**
   * O RELATÓRIO RICO (§75 + §34 + §31 + §24). Resolve o pacote (F3, via fachada
   * dinâmica pra quebrar o ciclo) e consolida: o resumo (packet.quality) +
   * cobertura por-fonte + conflitos detalhados + proveniência agregada (fundindo
   * o RAG de `opts.ragHits`, F7). READ+DERIVE. Isolado por org.
   */
  static async assess(orgId: string, request: ContextRequest, opts: { ragHits?: RagHitLike[] } = {}): Promise<ContextQualityReport> {
    // Import dinâmico quebra o ciclo Resolver↔QualityService (convenção nº 11).
    const { ContextResolverService } = await import("./ContextResolverService.js");
    const packet = ContextResolverService.resolve(orgId, request);
    return this.reportFromFacts(orgId, packet.facts, opts.ragHits);
  }

  /**
   * Monta o relatório rico a partir de fatos já resolvidos (permite a callers que
   * já têm o pacote evitar re-resolver). O `quality` slim reusa `assessFromFacts`.
   */
  static reportFromFacts(orgId: string, facts: ContextFact[], ragHits?: RagHitLike[], now = Date.now()): ContextQualityReport {
    const quality = this.assessFromFacts(orgId, facts, now);
    return {
      tenantId: orgId,
      quality,
      coverage: this.coverageByItem(orgId),
      conflicts: this.conflictsDetailed(facts),
      evidence: this.evidenceSummary(facts, ragHits),
      generatedAt: new Date(now).toISOString(),
      schemaVersion: 1,
    };
  }
}

// Agrupa fatos por `subject|predicate` (a chave de um conflito §31).
function groupBySubjectPredicate(facts: ContextFact[]): Map<string, ContextFact[]> {
  const groups = new Map<string, ContextFact[]>();
  for (const f of facts) {
    const k = `${f.subject}|${f.predicate}`;
    (groups.get(k) || groups.set(k, []).get(k)!).push(f);
  }
  return groups;
}

export default ContextQualityService;
