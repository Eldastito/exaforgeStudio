/**
 * SignalCorrelationService — PRD 2 Fase 3 / F3.1 (§16-20, CA4): correlação de
 * sinais. O maior incremento do Radar: vários sinais DIFERENTES podem descrever
 * a MESMA situação (não confundir com dedupe, que é o MESMO evento repetido, §19).
 *
 * Exemplo (§16): "acabou camisa M" (humano) + "cliente pediu M e não tinha"
 * (humano) + estoque SKU M = 0 (ERP) + queda de venda do SKU (PDV) → UM problema
 * com QUATRO evidências.
 *
 * Escopo desta fatia (F3.1) — a primitiva DETERMINÍSTICA e SEGURA (§18: começar
 * só pela confiança ALTA; falso agrupamento é pior que duplicidade):
 *   - agrupa sinais ABERTOS que compartilham EXATAMENTE o mesmo sujeito
 *     `(subject_type, subject_id)` — o par de 1ª classe que a F2.1 introduziu —
 *     dentro de uma janela temporal (§17);
 *   - confiança HIGH (mesmo sujeito concreto), inclusive cruzando domínios
 *     (estoque+venda+humano sobre o MESMO SKU = a mesma ruptura);
 *   - é DERIVADO por query sobre `business_signals` — NÃO cria fonte de verdade
 *     nova (§20/CA1); o cluster REFERENCIA os sinais, nunca destrói a evidência
 *     individual (CA4);
 *   - impacto REPRESENTATIVO = o maior |amount| dentro da mesma unidade (nunca
 *     soma entre unidades/categorias, RN ADR-085; §37 não inventa dinheiro).
 *
 * Confiança MÉDIA ("possivelmente relacionado") e BAIXA (separado) — §18 — ficam
 * pra F3.3. Aqui só a ALTA (auto-correlacionar).
 */
import db from "./db.js";

const SEV_RANK: Record<string, number> = { critical: 0, risk: 1, attention: 2, info: 3 };
const sevMax = (a: string, b: string) => ((SEV_RANK[a] ?? 3) <= (SEV_RANK[b] ?? 3) ? a : b);

export interface SignalCluster {
  key: string;
  subjectType: string;
  subjectId: string;
  confidence: "high";
  evidenceCount: number;
  domains: string[];
  signalTypes: string[];
  maxSeverity: string;
  representativeImpact: { amount: number | null; unit: string | null };
  correlationIds: string[];
  signalIds: string[];
  firstDetectedAt: string | null;
  lastDetectedAt: string | null;
}

// F3.3 — elo de confiança MÉDIA ("possivelmente relacionado", §18): o MESMO tipo
// de sinal em SUJEITOS DISTINTOS na janela (um padrão — ex.: stockout em 3 SKUs).
// NÃO colapsa automaticamente; é uma dica pra investigação.
export interface SignalRelated {
  key: string;
  confidence: "medium";
  domain: string;
  signalType: string;
  subjectType: string | null;
  subjectIds: string[];
  evidenceCount: number;             // sujeitos DISTINTOS
  maxSeverity: string;
  representativeImpact: { amount: number | null; unit: string | null };
  signalIds: string[];
  firstDetectedAt: string | null;
  lastDetectedAt: string | null;
}

function repImpact(sigs: any[]): { amount: number | null; unit: string | null } {
  let rep: { amount: number | null; unit: string | null } = { amount: null, unit: null };
  for (const s of sigs) {
    if (s.impact_amount == null) continue;
    if (rep.amount == null || Math.abs(Number(s.impact_amount)) > Math.abs(rep.amount)) rep = { amount: Number(s.impact_amount), unit: s.impact_unit ?? null };
  }
  return rep;
}

export class SignalCorrelationService {
  /**
   * Clusters de confiança ALTA: sinais abertos do MESMO sujeito, na janela.
   * `minEvidence` (≥2) evita chamar 1 sinal solto de "situação".
   */
  static clusters(orgId: string, opts: { windowHours?: number; minEvidence?: number; minRelated?: number; now?: number } = {}): { generatedAt: string; total: number; clusters: SignalCluster[]; relatedTotal: number; related: SignalRelated[] } {
    const now = opts.now || Date.now();
    const windowMs = Math.max(1, opts.windowHours ?? 72) * 3600e3;
    const minEvidence = Math.max(2, opts.minEvidence ?? 2);
    const minRelated = Math.max(2, opts.minRelated ?? 3); // padrão precisa de ≥3 sujeitos (§25)

    const rows = db.prepare(
      `SELECT id, domain, signal_type, severity, impact_amount, impact_unit, correlation_id, subject_type, subject_id, detected_at
         FROM business_signals
        WHERE organization_id = ? AND status = 'open'
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
          AND subject_type IS NOT NULL AND subject_id IS NOT NULL AND subject_id != ''
        ORDER BY detected_at ASC`
    ).all(orgId) as any[];

    // Agrupa por sujeito concreto.
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.subject_type}:${r.subject_id}`;
      (groups.get(key) || groups.set(key, []).get(key)!).push(r);
    }

    const clusters: SignalCluster[] = [];
    for (const [key, sigs] of groups) {
      // Janela temporal (§17): só os sinais dentro de `windowHours` do MAIS RECENTE
      // do grupo — um sinal aberto muito antigo não "cola" numa rajada nova.
      const times = sigs.map((s) => Date.parse(s.detected_at || "") || 0);
      const latest = Math.max(...times, 0);
      const inWindow = sigs.filter((s) => latest - (Date.parse(s.detected_at || "") || 0) <= windowMs);
      if (inWindow.length < minEvidence) continue;

      // Impacto representativo: maior |amount| na unidade dominante (nunca soma).
      const rep = repImpact(inWindow);

      const domains = [...new Set(inWindow.map((s) => s.domain))];
      const signalTypes = [...new Set(inWindow.map((s) => s.signal_type))];
      const maxSeverity = inWindow.map((s) => String(s.severity)).reduce((a, b) => sevMax(a, b), "info");
      const dets = inWindow.map((s) => s.detected_at).filter(Boolean).sort();

      clusters.push({
        key, subjectType: inWindow[0].subject_type, subjectId: inWindow[0].subject_id, confidence: "high",
        evidenceCount: inWindow.length, domains, signalTypes, maxSeverity, representativeImpact: rep,
        correlationIds: [...new Set(inWindow.map((s) => s.correlation_id).filter(Boolean))],
        signalIds: inWindow.map((s) => s.id),
        firstDetectedAt: dets[0] || null, lastDetectedAt: dets[dets.length - 1] || null,
      });
    }

    // Ordena por severidade e depois por nº de evidências (situação mais "corroborada").
    clusters.sort((a, b) => (SEV_RANK[a.maxSeverity] ?? 3) - (SEV_RANK[b.maxSeverity] ?? 3) || b.evidenceCount - a.evidenceCount);

    // F3.3 — confiança MÉDIA: o MESMO (domain, signal_type) em SUJEITOS DISTINTOS
    // na janela = "possivelmente relacionado" (um padrão). Elo fraco, NÃO colapsa
    // (§18: só a alta agrupa automático). Exposto pra a UI investigar.
    const fam = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.domain}:${r.signal_type}`;
      (fam.get(key) || fam.set(key, []).get(key)!).push(r);
    }
    const related: SignalRelated[] = [];
    for (const [key, sigs] of fam) {
      const latest = Math.max(...sigs.map((s) => Date.parse(s.detected_at || "") || 0), 0);
      const inWindow = sigs.filter((s) => latest - (Date.parse(s.detected_at || "") || 0) <= windowMs);
      const subjectIds = [...new Set(inWindow.map((s) => s.subject_id))];
      if (subjectIds.length < minRelated) continue; // pattern precisa de ≥minRelated sujeitos DISTINTOS
      const dets = inWindow.map((s) => s.detected_at).filter(Boolean).sort();
      related.push({
        key, confidence: "medium", domain: inWindow[0].domain, signalType: inWindow[0].signal_type,
        subjectType: inWindow[0].subject_type ?? null, subjectIds,
        evidenceCount: subjectIds.length,
        maxSeverity: inWindow.map((s) => String(s.severity)).reduce((a, b) => sevMax(a, b), "info"),
        representativeImpact: repImpact(inWindow), signalIds: inWindow.map((s) => s.id),
        firstDetectedAt: dets[0] || null, lastDetectedAt: dets[dets.length - 1] || null,
      });
    }
    related.sort((a, b) => (SEV_RANK[a.maxSeverity] ?? 3) - (SEV_RANK[b.maxSeverity] ?? 3) || b.evidenceCount - a.evidenceCount);

    return { generatedAt: new Date(now).toISOString(), total: clusters.length, clusters, relatedTotal: related.length, related };
  }
}
