import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * Ledger de Sinais Empresariais (ADR-136, Epic 2 — C1).
 *
 * Contrato COMUM para qualquer módulo publicar um sinal tipado (fato/estimativa,
 * confiança, impacto, evidência). Deduplicado por (org, dedupe_key) — republicar
 * o mesmo sinal ATUALIZA a linha, não cria outra (idempotência do PRD §7.1).
 * NÃO executa ações; só registra o que foi detectado. Isolado por organization_id.
 */

const SEVERITIES = ["info", "attention", "risk", "critical"];
// PRD 2 F2.1 (§12-13, CA3) — o Radar não pode confundir DADO com INTERPRETAÇÃO.
// `hypothesis` é a explicação ainda não comprovada ("a causa provável é X"),
// distinta de `estimate` (cálculo sobre evidência) e `fact` (comprovado).
const BASES = ["fact", "estimate", "hypothesis"];

export interface SignalInput {
  domain: string;
  signalType: string;
  severity: string;
  basis: string;
  confidence: number;
  impactAmount?: number | null;
  impactUnit?: string | null;
  occurredAt?: string | null;
  sourceService: string;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  evidence: any;
  premises?: any;
  dedupeKey: string;
  // ADR-158 (Espinha Única) — fio de rastreabilidade do ciclo universal. Quando
  // omitido, o sinal ENRAÍZA a própria cadeia (correlation_id = id do sinal) e a
  // decisão/outcome derivados herdam esse id. Republicar (dedupe) NUNCA troca o
  // correlation_id — a identidade da cadeia é estável.
  correlationId?: string | null;
  // ADR-158 F2 — `subjectType`: o "sobre o quê" de 1ª classe (sku|contact|order|
  // opportunity|...). `expiresAt`: TTL opcional (ISO) — sinais que deixam de valer
  // sozinhos. Ambos aditivos; omitidos ficam NULL (comportamento pré-F2).
  subjectType?: string | null;
  // PRD 2 F2.1 — `subjectId`: o id da entidade concreta (sku-123, contactId…),
  // par do subjectType. Aditivo; omitido fica NULL.
  subjectId?: string | null;
  expiresAt?: string | null;
}

export class BusinessSignalService {
  /**
   * Publica (ou atualiza) um sinal. Idempotente por (org, dedupe_key): se já
   * existe, atualiza severidade/confiança/impacto/evidência e o detected_at,
   * SEM reabrir um sinal já resolvido/dispensado nem duplicar a linha.
   */
  static publish(orgId: string, s: SignalInput): { id: string; deduped: boolean; correlationId: string } {
    if (!s?.domain || !s?.signalType || !s?.dedupeKey) throw new Error("Sinal exige domain, signalType e dedupeKey.");
    if (!SEVERITIES.includes(s.severity)) throw new Error("Severidade inválida.");
    if (!BASES.includes(s.basis)) throw new Error("basis deve ser fact|estimate|hypothesis.");
    const confidence = Math.max(0, Math.min(1, Number(s.confidence)));
    const evidence = JSON.stringify(s.evidence ?? {});
    const premises = s.premises != null ? JSON.stringify(s.premises) : null;
    const impact = s.impactAmount != null ? Number(s.impactAmount) : null;

    const expiresAt = s.expiresAt || null;
    const existing = db.prepare("SELECT id, correlation_id FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(orgId, s.dedupeKey) as any;
    if (existing) {
      // Dedupe: NUNCA reescreve correlation_id — a cadeia mantém sua identidade.
      // subject_type/expires_at são atualizados (re-detecção renova o TTL).
      db.prepare(`UPDATE business_signals SET domain=?, signal_type=?, severity=?, basis=?, confidence=?, impact_amount=?, impact_unit=?, source_service=?, source_entity_type=?, source_entity_id=?, evidence_json=?, premises_json=?, subject_type=?, subject_id=?, expires_at=?, detected_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(s.domain, s.signalType, s.severity, s.basis, confidence, impact, s.impactUnit || null, s.sourceService, s.sourceEntityType || null, s.sourceEntityId || null, evidence, premises, s.subjectType || null, s.subjectId || null, expiresAt, existing.id);
      return { id: existing.id, deduped: true, correlationId: existing.correlation_id || existing.id };
    }
    const id = randomUUID();
    // Sinal sem correlationId informado enraíza a própria cadeia (= seu id).
    const correlationId = s.correlationId || id;
    db.prepare(`INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, impact_amount, impact_unit, occurred_at, source_service, source_entity_type, source_entity_id, evidence_json, premises_json, dedupe_key, status, correlation_id, subject_type, subject_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
      .run(id, orgId, s.domain, s.signalType, s.severity, s.basis, confidence, impact, s.impactUnit || null, s.occurredAt || null, s.sourceService, s.sourceEntityType || null, s.sourceEntityId || null, evidence, premises, s.dedupeKey, correlationId, s.subjectType || null, s.subjectId || null, expiresAt);
    return { id, deduped: false, correlationId };
  }

  /** Lista sinais (isolado por org), com filtros opcionais de status/domínio. */
  static list(orgId: string, opts: { status?: string; domain?: string } = {}): any[] {
    let sql = "SELECT * FROM business_signals WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.domain) { sql += " AND domain = ?"; params.push(opts.domain); }
    sql += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'risk' THEN 1 WHEN 'attention' THEN 2 ELSE 3 END, detected_at DESC LIMIT 200";
    return (db.prepare(sql).all(...params) as any[]).map((r) => ({
      ...r,
      evidence: safeParse(r.evidence_json),
      premises: r.premises_json ? safeParse(r.premises_json) : null,
    }));
  }

  /**
   * ADR-160 F1 (Onda A) — LEITURA TRANSVERSAL DE ATENÇÃO. Uma superfície ÚNICA
   * "o que precisa de atenção agora" que funde, ranqueado por severidade:
   *   - `business_signals` ABERTOS e NÃO EXPIRADOS (todos os domínios — a ADR-158
   *     F2 já consolidou os detectores aqui; respeita o `expires_at`/TTL da F2);
   *   - `decision_risks` (DI-2) ainda vivos (predicted|materialized, não resolved).
   * DERIVADO por query (RN-004): zero tabela nova (RN-158-4). Isolado por org.
   * Normaliza a severidade das 2 fontes numa escala única (critical>risk>
   * attention>info) e devolve totais por severidade/domínio + itens ordenados.
   */
  static attention(orgId: string, opts: { limit?: number } = {}): {
    generatedAt: string;
    total: number;
    bySeverity: Record<string, number>;
    byDomain: Record<string, number>;
    items: Array<{ source: string; id: string; domain: string; type: string; severity: string; summary: string; basis: string | null; impactAmount: number | null; impactUnit: string | null; detectedAt: string | null; correlationId: string | null; subjectType: string | null; subjectId: string | null; status: string }>;
  } {
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 200;
    // Escala única: aceita o vocabulário dos sinais (info/attention/risk/critical)
    // E o de risco (low/medium/high) — mapeados pra a mesma normalizada.
    const RANK: Record<string, number> = { critical: 0, high: 0, risk: 1, medium: 1, attention: 2, low: 2, info: 3 };
    const NORM: Record<string, string> = { critical: "critical", high: "critical", risk: "risk", medium: "risk", attention: "attention", low: "attention", info: "info" };
    const norm = (s: any) => NORM[String(s || "").toLowerCase()] || "attention";
    const rank = (s: any) => RANK[String(s || "").toLowerCase()] ?? 2;

    const items: any[] = [];
    // Fonte 1 — sinais abertos e não expirados (respeita o TTL da F2).
    for (const r of db.prepare(
      `SELECT * FROM business_signals WHERE organization_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).all(orgId) as any[]) {
      items.push({
        source: "signal", id: r.id, domain: r.domain, type: r.signal_type, severity: norm(r.severity),
        summary: shortSummary(r.signal_type, r.evidence_json), basis: r.basis ?? null, impactAmount: r.impact_amount ?? null, impactUnit: r.impact_unit ?? null,
        detectedAt: r.detected_at ?? null, correlationId: r.correlation_id ?? null, subjectType: r.subject_type ?? null, subjectId: r.subject_id ?? null, status: r.status,
        _rank: rank(r.severity), _at: r.detected_at || "",
      });
    }
    // Fonte 2 — riscos previstos ainda vivos. `materialized` sobe um nível.
    for (const r of db.prepare(
      `SELECT * FROM decision_risks WHERE organization_id = ? AND status IN ('predicted','materialized') AND resolved_at IS NULL`
    ).all(orgId) as any[]) {
      const bumped = r.status === "materialized" && norm(r.severity) === "risk" ? "critical" : (r.status === "materialized" && norm(r.severity) === "attention" ? "risk" : norm(r.severity));
      items.push({
        source: "risk", id: r.id, domain: "decision", type: `risk:${r.source || "premortem"}`, severity: bumped,
        summary: String(r.description || "").slice(0, 200), basis: "estimate", impactAmount: r.impact_amount ?? null, impactUnit: r.impact_unit ?? null,
        detectedAt: r.predicted_at ?? null, correlationId: null, subjectType: r.decision_id ? "decision" : null, subjectId: r.decision_id ?? null, status: r.status,
        _rank: rank(bumped), _at: r.predicted_at || "",
      });
    }

    items.sort((a, b) => a._rank - b._rank || String(b._at).localeCompare(String(a._at)));
    const bySeverity: Record<string, number> = { critical: 0, risk: 0, attention: 0, info: 0 };
    const byDomain: Record<string, number> = {};
    for (const it of items) { bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1; byDomain[it.domain] = (byDomain[it.domain] || 0) + 1; }
    const trimmed = items.slice(0, limit).map(({ _rank, _at, ...rest }) => rest);
    return { generatedAt: new Date().toISOString(), total: items.length, bySeverity, byDomain, items: trimmed };
  }

  private static setStatus(orgId: string, id: string, status: string): { ok: boolean } {
    const r = db.prepare("UPDATE business_signals SET status = ? WHERE id = ? AND organization_id = ?").run(status, id, orgId);
    return { ok: r.changes > 0 };
  }
  static acknowledge(orgId: string, id: string) { return this.setStatus(orgId, id, "acknowledged"); }
  static dismiss(orgId: string, id: string) { return this.setStatus(orgId, id, "dismissed"); }
  static resolve(orgId: string, id: string) { return this.setStatus(orgId, id, "resolved"); }

  /**
   * Resolve um sinal AINDA ABERTO pela sua dedupe_key (ex.: o padrão que o gerou
   * deixou de valer). No-op se não existe ou já foi fechado. Isolado por org.
   */
  static resolveByDedupe(orgId: string, dedupeKey: string): { ok: boolean } {
    const r = db.prepare("UPDATE business_signals SET status = 'resolved' WHERE organization_id = ? AND dedupe_key = ? AND status = 'open'").run(orgId, dedupeKey);
    return { ok: r.changes > 0 };
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

/** Resumo curto e legível de um sinal pra a leitura de atenção (F1 Onda A). */
function shortSummary(signalType: string, evidenceJson: string | null): string {
  const ev = evidenceJson ? safeParse(evidenceJson) : {};
  const cand = ev?.summary || ev?.title || ev?.label || ev?.contactName || ev?.nota;
  const base = typeof cand === "string" && cand.trim() ? cand.trim() : String(signalType || "").replace(/_/g, " ");
  return base.slice(0, 200);
}

export default BusinessSignalService;
