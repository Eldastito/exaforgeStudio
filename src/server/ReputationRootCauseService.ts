/**
 * ReputationRootCauseService (ADR-162 / PRD 5 §42-§46, F12) — ROOT CAUSE & LEARNING:
 * agrupa as reclamações por CATEGORIA (F4) numa janela, mede a TENDÊNCIA contra um
 * BASELINE e memoriza os padrões recorrentes — reusando o `PatternMemoryService`
 * genérico (o domínio traz só o detector; a memória/recorrência/validação/publicação
 * de sinais é do serviço genérico — sem motor novo, D1/§5).
 *
 * GUARDRAILS DUROS (RN-CRR-8 / §43-§44), no coração desta fatia:
 *   - BASELINE ANTES DE CAUSA (§43): uma categoria só é "sobre-representada" comparada a
 *     um BASELINE — a fatia da MESMA categoria na janela ANTERIOR — e o volume de
 *     reclamações é ancorado no VOLUME de negócio (reclamações por 100 pedidos). Sem
 *     baseline não se conclui causa: correlação NÃO é causalidade. O padrão é EVIDÊNCIA
 *     PARA INVESTIGAR, nunca uma afirmação de culpa.
 *   - NUNCA RANKING PUNITIVO DE FUNCIONÁRIO (§44): a dimensão é CATEGORIA de reclamação,
 *     jamais pessoa. Este serviço não agrupa por atendente/vendedor.
 *
 * Determinístico (roda em CI: hypothesizer no-op → descrição por regra). Isolado por org.
 */
import db from "./db.js";
import { PatternMemoryService, PatternCandidate } from "./PatternMemoryService.js";

const MIN_EVIDENCE = 3;                 // categoria precisa de ≥3 reclamações pra virar padrão.
const OVER_REP_DELTA = 0.10;            // +10 p.p. de fatia sobre o baseline = sobre-representada.
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
const PATTERN_TYPE = "reputation_category_spike";

export interface CategoryTrend {
  category: string;
  currentCount: number;
  currentShare: number;      // fatia da categoria nas reclamações da janela atual
  baselineShare: number;     // fatia da MESMA categoria na janela anterior (§43)
  delta: number;             // currentShare − baselineShare (p.p.)
  overRepresented: boolean;
  confidence: number;
}

export interface RootCauseAnalysis {
  windowDays: number;
  generatedAt: string;
  totals: {
    currentComplaints: number; priorComplaints: number;
    currentOrders: number; priorOrders: number;
    complaintsPer100OrdersCurrent: number | null;
    complaintsPer100OrdersPrior: number | null;
    volumeBaselineAvailable: boolean;
    volumeTrend: "rising" | "stable" | "falling" | "unknown";
  };
  categories: CategoryTrend[];
  note: string;
}

export class ReputationRootCauseService {
  private static countByCategory(orgId: string, fromIso: string, toIso: string): { total: number; byCat: Map<string, number> } {
    const byCat = new Map<string, number>();
    let total = 0;
    for (const r of db.prepare(
      `SELECT evidence_json FROM business_signals
        WHERE organization_id = ? AND domain = 'reputation' AND signal_type = 'public_complaint'
          AND datetime(detected_at) >= datetime(?) AND datetime(detected_at) < datetime(?)`
    ).all(orgId, fromIso, toIso) as any[]) {
      let cat = "unclassified";
      try { cat = String(JSON.parse(r.evidence_json || "{}")?.classification?.category || "unclassified"); } catch { /* ignore */ }
      byCat.set(cat, (byCat.get(cat) || 0) + 1);
      total++;
    }
    return { total, byCat };
  }

  private static countOrders(orgId: string, fromIso: string, toIso: string): number {
    return (db.prepare(
      `SELECT COUNT(*) n FROM orders WHERE organization_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)`
    ).get(orgId, fromIso, toIso) as any).n;
  }

  /** Análise PURA: clusters por categoria + tendência vs baseline + volume-baseline (§43). */
  static analyze(orgId: string, opts: { windowDays?: number; now?: number } = {}): RootCauseAnalysis {
    const windowDays = Math.max(1, opts.windowDays ?? 30);
    const now = opts.now || Date.now();
    const ms = windowDays * 86400e3;
    const curFrom = new Date(now - ms).toISOString();
    const priFrom = new Date(now - 2 * ms).toISOString();
    const nowIso = new Date(now).toISOString();

    const cur = this.countByCategory(orgId, curFrom, nowIso);
    const pri = this.countByCategory(orgId, priFrom, curFrom);
    const curOrders = this.countOrders(orgId, curFrom, nowIso);
    const priOrders = this.countOrders(orgId, priFrom, curFrom);

    const cats = new Set<string>([...cur.byCat.keys(), ...pri.byCat.keys()]);
    const categories: CategoryTrend[] = [];
    for (const cat of cats) {
      const c = cur.byCat.get(cat) || 0;
      const p = pri.byCat.get(cat) || 0;
      const currentShare = cur.total > 0 ? round2(c / cur.total) : 0;
      const baselineShare = pri.total > 0 ? round2(p / pri.total) : 0;
      const delta = round2(currentShare - baselineShare);
      // Sobre-representada: fatia subiu ≥ OVER_REP_DELTA sobre o baseline E tem massa
      // mínima. Sem baseline (janela anterior vazia), exige a massa mínima só (novo pico).
      const overRepresented = c >= MIN_EVIDENCE && (pri.total === 0 ? true : delta >= OVER_REP_DELTA);
      const confidence = overRepresented ? clamp01(0.5 + Math.max(0, delta)) : 0;
      categories.push({ category: cat, currentCount: c, currentShare, baselineShare, delta, overRepresented, confidence });
    }
    categories.sort((a, b) => Number(b.overRepresented) - Number(a.overRepresented) || b.currentCount - a.currentCount);

    const rateCur = curOrders > 0 ? round2((cur.total / curOrders) * 100) : null;
    const ratePri = priOrders > 0 ? round2((pri.total / priOrders) * 100) : null;
    const volumeTrend: "rising" | "stable" | "falling" | "unknown" =
      rateCur == null || ratePri == null ? "unknown" : rateCur > ratePri * 1.15 ? "rising" : rateCur < ratePri * 0.85 ? "falling" : "stable";

    return {
      windowDays, generatedAt: nowIso,
      totals: {
        currentComplaints: cur.total, priorComplaints: pri.total,
        currentOrders: curOrders, priorOrders: priOrders,
        complaintsPer100OrdersCurrent: rateCur, complaintsPer100OrdersPrior: ratePri,
        volumeBaselineAvailable: rateCur != null && ratePri != null,
        volumeTrend,
      },
      categories,
      note: "Padrão é EVIDÊNCIA para investigar, não causa comprovada (correlação ≠ causalidade, RN-CRR-8/§43). Dimensão = categoria de reclamação; NUNCA ranking punitivo de funcionário (§44).",
    };
  }

  /** Candidatos de padrão (categorias sobre-representadas) para o PatternMemoryService. */
  private static candidates(analysis: RootCauseAnalysis): PatternCandidate[] {
    return analysis.categories.filter((c) => c.overRepresented).map((c) => ({
      scopeId: c.category, scopeName: c.category,
      patternType: PATTERN_TYPE, patternKey: c.category,
      evidenceCount: c.currentCount, confidence: c.confidence,
      impactAmount: c.currentCount, impactUnit: "complaints",
      evidence: {
        category: c.category, currentCount: c.currentCount, currentShare: c.currentShare,
        baselineShare: c.baselineShare, delta: c.delta, windowDays: analysis.windowDays,
        volumeBaseline: { per100OrdersCurrent: analysis.totals.complaintsPer100OrdersCurrent, per100OrdersPrior: analysis.totals.complaintsPer100OrdersPrior, trend: analysis.totals.volumeTrend },
      },
      fallbackDescription: `Categoria '${c.category}' sobre-representada nas reclamações (${Math.round(c.currentShare * 100)}% vs baseline ${Math.round(c.baselineShare * 100)}%) — investigar. Correlação, não causa comprovada (RN-CRR-8).`,
    }));
  }

  /**
   * Passe de aprendizado: analisa e memoriza os padrões via PatternMemoryService (domínio
   * 'reputation'). Opt-in pela flag de memória genérica (`pattern_memory`). Hypothesizer
   * no-op → descrição por regra (determinístico, roda em CI). Padrão validado vira sinal.
   */
  static async learn(orgId: string, opts: { windowDays?: number; now?: number; asOf?: string } = {}): Promise<{ skipped?: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { skipped: true, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const analysis = this.analyze(orgId, opts);
    const candidates = this.candidates(analysis);
    return PatternMemoryService.learn(orgId, "reputation", candidates, {
      asOf: opts.asOf, handledTypes: [PATTERN_TYPE], sourceService: "ReputationRootCauseService",
      hypothesizer: async () => ({}), // determinístico: sem LLM em CI; usa fallbackDescription
    });
  }
}

export default ReputationRootCauseService;
