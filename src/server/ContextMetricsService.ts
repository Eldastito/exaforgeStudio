import db from "./db.js";
import type { ContextPacket, ContextProfile } from "./contextModel.js";
import { ContextResolverService } from "./ContextResolverService.js";
import { ContextQualityService } from "./ContextQualityService.js";

/**
 * ContextMetricsService — PRD 3 F11 (§55/§120): OBSERVABILIDADE do Context Engine.
 *
 * "Dá pra saber o tamanho/forma/custo do contexto que o motor produz?" — sem isso,
 * regressões de qualidade (pacote inchado, cobertura caindo, corte silencioso,
 * gasto de IA subindo) passam despercebidas. Esta é a leitura interna de métricas.
 *
 * É COMPOR (AC-A01) e DERIVAR por query (RN-004): NENHUMA tabela nova. As métricas
 * saem de (a) um `ContextPacket` já resolvido (F3) — tamanho, corte, cobertura,
 * confiança, utilização do orçamento, proveniência por tipo (reusa a F8) —, (b) o
 * ledger `business_signals` (momento por domínio/severidade) e (c) o `ai_usage_log`
 * (token economy §55) — os dois já existentes. Sem telemetria externa (§124).
 *
 * GUARDRAILS (testados):
 *   - RN-CM-1 ISOLAMENTO (§66): `orgId` 1º arg; toda query filtra organization_id.
 *   - RN-CM-2 DERIVA, não materializa (RN-004): tudo por query/agregação; 0 tabela.
 *   - RN-CM-3 READ-ONLY (AC-A02): só leitura; não muta nada, não chama modelo.
 *   - RN-CM-4 REUSA (AC-A01): pacote (F3), proveniência (F8), signals+ai_usage_log.
 */

export interface ContextPacketMetrics {
  facts: number;
  entities: number;
  relationships: number;
  goals: number;
  constraints: number;
  skillHints: number;
  sources: number;
  momentTotal: number;
  truncated: boolean;
  coveragePct: number | null;
  confidenceScore: number;
  confidenceBand: string;
  conflicts: number;
  gaps: number;
  // utilização do orçamento (0..1): quão perto do teto cada dimensão chegou.
  budgetUtilization: { facts: number; entities: number; signals: number; goals: number };
  // proveniência agregada (reusa F8): quantas evidências por tipo de fonte…
  evidenceBySourceType: Record<string, number>;
  // …e o atalho pro RAG/memória (APPROVED_DOCUMENT, F7).
  ragEvidence: number;
}

export interface ContextMetricsSnapshot {
  orgId: string;
  generatedAt: string;
  packet: ContextPacketMetrics;
  signals: { open: number; byDomain: Record<string, number>; bySeverity: Record<string, number> };
  aiUsage: { sinceDays: number; totalTokens: number; costBrl: number; byKind: Record<string, { tokens: number; costBrl: number }> };
}

export class ContextMetricsService {
  /**
   * §120 — métricas de um `ContextPacket` já resolvido. PURA (sem DB/IA): tamanho,
   * corte, cobertura/confiança, utilização do orçamento e proveniência por tipo
   * (reusa `ContextQualityService.evidenceSummary`, F8). É o coração da F11.
   */
  static forPacket(packet: ContextPacket): ContextPacketMetrics {
    const b = packet.budget || ({} as any);
    const ratio = (n: number, cap: any) => (Number.isFinite(cap) && cap > 0 ? Math.min(1, n / cap) : 0);
    const ev = ContextQualityService.evidenceSummary(packet.facts || []);
    const q = packet.quality || ({} as any);
    return {
      facts: (packet.facts || []).length,
      entities: (packet.entities || []).length,
      relationships: (packet.relationships || []).length,
      goals: (packet.goals || []).length,
      constraints: (packet.constraints || []).length,
      skillHints: (packet.skillHints || []).length,
      sources: (packet.sources || []).length,
      momentTotal: Number(packet.moment?.total) || 0,
      truncated: !!packet.truncated,
      coveragePct: q.coveragePct ?? null,
      confidenceScore: Number(q.confidence?.score) || 0,
      confidenceBand: String(q.confidence?.band ?? "unreliable"),
      conflicts: Number(q.conflicts) || 0,
      gaps: (q.gaps || []).length,
      budgetUtilization: {
        facts: ratio((packet.facts || []).length, b.maxFacts),
        entities: ratio((packet.entities || []).length, b.maxEntities),
        signals: ratio(Number(packet.moment?.top?.length) || 0, b.maxSignals),
        goals: ratio((packet.goals || []).length, b.maxGoals),
      },
      evidenceBySourceType: ev.bySourceType,
      ragEvidence: ev.bySourceType.APPROVED_DOCUMENT || 0,
    };
  }

  /**
   * §55/§120 — a leitura de observabilidade da org: resolve um pacote REPRESENTATIVO
   * (F3) e agrega, TUDO por query (RN-004): as métricas do pacote + o momento vindo
   * do `business_signals` (por domínio/severidade) + a token economy do
   * `ai_usage_log` (§55) na janela `sinceDays`. Isolado por org, read-only.
   */
  static snapshot(orgId: string, opts: { profile?: ContextProfile; intent?: string; sinceDays?: number } = {}): ContextMetricsSnapshot {
    const packet = ContextResolverService.resolve(orgId, { intent: opts.intent || "observability", profile: opts.profile || "standard" });

    // momento derivado do ledger (RN-004) — nunca contador materializado.
    const rows = db.prepare("SELECT domain, severity, COUNT(*) c FROM business_signals WHERE organization_id = ? AND status = 'open' GROUP BY domain, severity").all(orgId) as any[];
    const byDomain: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let open = 0;
    for (const r of rows) {
      const c = Number(r.c) || 0; open += c;
      byDomain[r.domain] = (byDomain[r.domain] || 0) + c;
      bySeverity[r.severity] = (bySeverity[r.severity] || 0) + c;
    }

    // token economy (§55) — reusa ai_usage_log; janela derivada por query.
    const sinceDays = opts.sinceDays && opts.sinceDays > 0 ? Math.floor(opts.sinceDays) : 30;
    const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString();
    const usage = db.prepare("SELECT kind, SUM(total_tokens) tokens, SUM(cost_brl) cost FROM ai_usage_log WHERE organization_id = ? AND created_at >= ? GROUP BY kind").all(orgId, cutoff) as any[];
    const byKind: Record<string, { tokens: number; costBrl: number }> = {};
    let totalTokens = 0; let costBrl = 0;
    for (const u of usage) {
      const t = Number(u.tokens) || 0; const c = Number(u.cost) || 0;
      totalTokens += t; costBrl += c;
      byKind[u.kind || "unknown"] = { tokens: t, costBrl: c };
    }

    return {
      orgId,
      generatedAt: new Date().toISOString(),
      packet: this.forPacket(packet),
      signals: { open, byDomain, bySeverity },
      aiUsage: { sinceDays, totalTokens, costBrl, byKind },
    };
  }
}

export default ContextMetricsService;
