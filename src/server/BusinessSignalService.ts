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
const BASES = ["fact", "estimate"];

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
}

export class BusinessSignalService {
  /**
   * Publica (ou atualiza) um sinal. Idempotente por (org, dedupe_key): se já
   * existe, atualiza severidade/confiança/impacto/evidência e o detected_at,
   * SEM reabrir um sinal já resolvido/dispensado nem duplicar a linha.
   */
  static publish(orgId: string, s: SignalInput): { id: string; deduped: boolean } {
    if (!s?.domain || !s?.signalType || !s?.dedupeKey) throw new Error("Sinal exige domain, signalType e dedupeKey.");
    if (!SEVERITIES.includes(s.severity)) throw new Error("Severidade inválida.");
    if (!BASES.includes(s.basis)) throw new Error("basis deve ser fact|estimate.");
    const confidence = Math.max(0, Math.min(1, Number(s.confidence)));
    const evidence = JSON.stringify(s.evidence ?? {});
    const premises = s.premises != null ? JSON.stringify(s.premises) : null;
    const impact = s.impactAmount != null ? Number(s.impactAmount) : null;

    const existing = db.prepare("SELECT id FROM business_signals WHERE organization_id = ? AND dedupe_key = ?").get(orgId, s.dedupeKey) as any;
    if (existing) {
      db.prepare(`UPDATE business_signals SET domain=?, signal_type=?, severity=?, basis=?, confidence=?, impact_amount=?, impact_unit=?, source_service=?, source_entity_type=?, source_entity_id=?, evidence_json=?, premises_json=?, detected_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(s.domain, s.signalType, s.severity, s.basis, confidence, impact, s.impactUnit || null, s.sourceService, s.sourceEntityType || null, s.sourceEntityId || null, evidence, premises, existing.id);
      return { id: existing.id, deduped: true };
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, impact_amount, impact_unit, occurred_at, source_service, source_entity_type, source_entity_id, evidence_json, premises_json, dedupe_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
      .run(id, orgId, s.domain, s.signalType, s.severity, s.basis, confidence, impact, s.impactUnit || null, s.occurredAt || null, s.sourceService, s.sourceEntityType || null, s.sourceEntityId || null, evidence, premises, s.dedupeKey);
    return { id, deduped: false };
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

export default BusinessSignalService;
