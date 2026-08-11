import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import {
  ContextCandidate,
  ContextCandidateStatus,
  ContextCandidateKind,
  CONTEXT_CANDIDATE_KINDS,
  canTransitionCandidate,
} from "./contextModel.js";
import { BusinessConstraintService } from "./BusinessConstraintService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * ContextCandidateService — PRD 3 F6 (§36/§37): FALA TU CONTEXT CAPTURE. Formaliza
 * o `ContextCandidate` — um candidato de CONTEXTO/REGRA (NÃO de ação): uma mudança
 * PROPOSTA ao contexto (uma restrição/regra ou um fato) capturada do Fala Tu, de um
 * detector ou declarada à mão, que só afeta o contexto depois de CONFIRMADA por um
 * humano — NUNCA em silêncio (§36 — "sem alteração silenciosa de política").
 *
 * É ESTENDER (AC-A01) sobre o padrão que já existe: o inbox do Fala Tu
 * (capturar→pendente→confirmar/descartar) e o `DecisionActionService`
 * (propor→aprovar/rejeitar). A F6 não reimplementa nenhum dos dois — dá casa de 1ª
 * classe pro candidato de CONTEXTO (o que os dois não cobriam: eles capturam AÇÃO,
 * não uma mudança de FATO/REGRA). O net-new é o contrato de estados
 * DETECTED→PENDING→CONFIRMED/REJECTED/EXPIRED.
 *
 * CONFIRMAR é o ÚNICO ponto que muda o contexto: promove o candidato via os
 * serviços que já existem — `BusinessConstraintService.create` (regra, F4) ou
 * `BusinessSignalService.publish` (fato, ADR-136). `detect`/`reject`/`expire`
 * NUNCA promovem (§36). O promovido é EXATAMENTE o `proposed` — não inventa (§25).
 *
 * GUARDRAILS (duros, testados):
 *   - RN-CC-1 ISOLAMENTO (§66): `orgId` 1º arg; toda query filtra organization_id.
 *   - RN-CC-2 SEM ALTERAÇÃO SILENCIOSA (§36): capturar NÃO aplica; só `confirm`
 *     (ato humano) promove. rejeitar/expirar nunca promovem.
 *   - RN-CC-3 NÃO INVENTA (§25): a promoção usa o `proposed` como está; nada é
 *     fabricado. Candidato inválido (proposed insuficiente) é barrado no detect.
 *   - RN-CC-4 INVARIANTE DE ESTADO (§37): as transições respeitam o ciclo
 *     (`canTransitionCandidate`); confirmar/rejeitar um candidato já resolvido falha.
 *   - RN-CC-5 ESTENDE, não duplica (AC-A01): promove pelos serviços existentes.
 */

export interface DetectCandidateInput {
  kind: string;                          // constraint|fact
  title: string;
  summary?: string | null;
  scopeType?: string | null;
  scopeRef?: string | null;
  proposed: Record<string, unknown>;     // payload que viraria a restrição/o sinal
  source?: string | null;                // falatu|signal|detector|manual (default manual)
  sourceRef?: string | null;
  confidence?: number | null;
  expiresAt?: string | null;
  correlationId?: string | null;
  pending?: boolean;                     // já entra PENDING (triado) em vez de DETECTED
  createdBy?: string | null;
}

const SOURCES = ["falatu", "signal", "detector", "manual"];

export class ContextCandidateService {
  /**
   * Captura um candidato. Status inicial `detected` (ou `pending` se `pending`).
   * NÃO altera o contexto (§36) — só registra a proposta. Valida a forma mínima
   * do `proposed` por kind (pra não guardar candidato que nunca poderá confirmar).
   */
  static detect(orgId: string, input: DetectCandidateInput): ContextCandidate {
    const kind = String(input?.kind || "").trim() as ContextCandidateKind;
    if (!CONTEXT_CANDIDATE_KINDS.includes(kind)) throw new Error(`kind deve ser: ${CONTEXT_CANDIDATE_KINDS.join("|")}`);
    const title = String(input?.title || "").trim();
    if (!title) throw new Error("Candidato exige title.");
    const proposed = input?.proposed;
    if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) throw new Error("Candidato exige `proposed` (objeto).");
    this.assertProposable(kind, proposed);

    const source = SOURCES.includes(String(input.source || "")) ? String(input.source) : "manual";
    const status: ContextCandidateStatus = input.pending ? "PENDING" : "DETECTED";
    const id = randomUUID();
    db.prepare(`INSERT INTO context_candidates
      (id, organization_id, kind, status, title, summary, scope_type, scope_ref, proposed_json, source, source_ref, confidence, expires_at, correlation_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, kind, status.toLowerCase(), title, clean(input.summary), clean(input.scopeType), clean(input.scopeRef),
        JSON.stringify(proposed), source, clean(input.sourceRef), input.confidence != null ? Number(input.confidence) : null,
        clean(input.expiresAt), clean(input.correlationId), clean(input.createdBy));
    try { logAuthEvent(orgId, input.createdBy || "system", id, "CONTEXT_CANDIDATE_DETECT", { kind, source, status: status.toLowerCase() }); } catch { /* noop */ }
    return this.get(orgId, id)!;
  }

  static get(orgId: string, id: string): ContextCandidate | null {
    const r = db.prepare("SELECT * FROM context_candidates WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    return r ? rowToCandidate(r) : null;
  }

  static list(orgId: string, opts: { status?: string; kind?: string } = {}): ContextCandidate[] {
    let sql = "SELECT * FROM context_candidates WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND status = ?"; params.push(String(opts.status).toLowerCase()); }
    if (opts.kind) { sql += " AND kind = ?"; params.push(opts.kind); }
    sql += " ORDER BY datetime(detected_at) DESC LIMIT 200";
    return (db.prepare(sql).all(...params) as any[]).map(rowToCandidate);
  }

  /** Triagem: DETECTED → PENDING (fila de confirmação). Não promove. */
  static submit(orgId: string, id: string, actorId?: string): ContextCandidate {
    return this.transition(orgId, id, "PENDING", actorId, null, false);
  }

  /**
   * CONFIRMA (ato humano) — o ÚNICO ponto que muda o contexto (§36). Promove o
   * candidato pelo serviço da 1ª classe correspondente e registra o que virou
   * (promoted_kind/promoted_ref_id). Falha se o candidato já foi resolvido
   * (invariante de estado, RN-CC-4). Isolado por org.
   */
  static confirm(orgId: string, id: string, actorId: string | undefined, opts: { reason?: string } = {}): { candidate: ContextCandidate; promoted: { kind: string; refId: string } } {
    const row = db.prepare("SELECT * FROM context_candidates WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!row) throw new Error("Candidato não encontrado.");
    const from = String(row.status).toUpperCase() as ContextCandidateStatus;
    if (!canTransitionCandidate(from, "CONFIRMED")) throw new Error(`Candidato não pode ser confirmado (${row.status}).`);

    const proposed = safeParse(row.proposed_json) || {};
    // Promoção: usa o `proposed` COMO ESTÁ (não inventa, RN-CC-3). O escopo do
    // candidato preenche o do payload quando este não trouxe (conveniência).
    let promotedKind: string; let promotedRefId: string;
    if (row.kind === "constraint") {
      const created = BusinessConstraintService.create(orgId, {
        kind: proposed.kind, name: proposed.name ?? row.title, operator: proposed.operator,
        valueNum: proposed.valueNum ?? proposed.value_num ?? null, valueUnit: proposed.valueUnit ?? proposed.value_unit ?? null,
        valueText: proposed.valueText ?? proposed.value_text ?? null, source: proposed.source ?? "owner_declared",
        scopeType: proposed.scopeType ?? proposed.scope_type ?? row.scope_type ?? null,
        scopeRef: proposed.scopeRef ?? proposed.scope_ref ?? row.scope_ref ?? null,
      }, actorId);
      promotedKind = "constraint"; promotedRefId = String(created.id);
    } else if (row.kind === "fact") {
      const res = BusinessSignalService.publish(orgId, {
        domain: proposed.domain, signalType: proposed.signalType ?? proposed.signal_type,
        severity: proposed.severity ?? "info", basis: proposed.basis ?? "fact",
        confidence: proposed.confidence != null ? Number(proposed.confidence) : (row.confidence != null ? Number(row.confidence) : 0.9),
        impactAmount: proposed.impactAmount ?? proposed.impact_amount ?? null, impactUnit: proposed.impactUnit ?? proposed.impact_unit ?? null,
        subjectType: proposed.subjectType ?? proposed.subject_type ?? row.scope_type ?? null,
        subjectId: proposed.subjectId ?? proposed.subject_id ?? row.scope_ref ?? null,
        sourceService: proposed.sourceService ?? "ContextCandidateService", evidence: proposed.evidence ?? {},
        dedupeKey: proposed.dedupeKey ?? proposed.dedupe_key ?? `ctxcand:${id}`,
        correlationId: row.correlation_id ?? null,
      });
      promotedKind = "signal"; promotedRefId = String(res.id);
    } else {
      throw new Error(`kind não promovível: ${row.kind}`);
    }

    db.prepare(`UPDATE context_candidates SET status = 'confirmed', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_reason = ?, promoted_kind = ?, promoted_ref_id = ? WHERE id = ? AND organization_id = ?`)
      .run(actorId || null, clean(opts.reason), promotedKind, promotedRefId, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "CONTEXT_CANDIDATE_CONFIRM", { kind: row.kind, promotedKind, promotedRefId }); } catch { /* noop */ }
    return { candidate: this.get(orgId, id)!, promoted: { kind: promotedKind, refId: promotedRefId } };
  }

  /** REJEITA — descarta sem promover (§36). Terminal. */
  static reject(orgId: string, id: string, actorId?: string, opts: { reason?: string } = {}): ContextCandidate {
    return this.transition(orgId, id, "REJECTED", actorId, opts.reason ?? null, false);
  }

  /**
   * Sweep: marca EXPIRED os candidatos DETECTED/PENDING cujo `expires_at` passou.
   * Nunca promove (§36). Idempotente; isolado por org. `now` injetável pra teste.
   */
  static expireStale(orgId: string, now = Date.now()): { expired: number } {
    const r = db.prepare(
      `UPDATE context_candidates SET status = 'expired', resolved_at = CURRENT_TIMESTAMP
        WHERE organization_id = ? AND status IN ('detected','pending')
          AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime(?)`
    ).run(orgId, new Date(now).toISOString());
    return { expired: r.changes };
  }

  // ── internos ──────────────────────────────────────────────────────────────────

  /** Transição de estado simples (sem promoção). Guarda o invariante (§37). */
  private static transition(orgId: string, id: string, to: ContextCandidateStatus, actorId: string | undefined, reason: string | null, _promote: boolean): ContextCandidate {
    const row = db.prepare("SELECT status FROM context_candidates WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!row) throw new Error("Candidato não encontrado.");
    const from = String(row.status).toUpperCase() as ContextCandidateStatus;
    if (!canTransitionCandidate(from, to)) throw new Error(`Transição inválida: ${row.status} → ${to.toLowerCase()}.`);
    const terminal = to === "REJECTED";
    db.prepare(`UPDATE context_candidates SET status = ?, resolved_at = ${terminal ? "CURRENT_TIMESTAMP" : "resolved_at"}, resolved_by = ?, resolution_reason = ? WHERE id = ? AND organization_id = ?`)
      .run(to.toLowerCase(), actorId || null, reason, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, `CONTEXT_CANDIDATE_${to}`, { from: from.toLowerCase() }); } catch { /* noop */ }
    return this.get(orgId, id)!;
  }

  /**
   * Forma MÍNIMA pra o candidato poder ser confirmado (senão guardaríamos algo que
   * nunca promove). Validação profunda fica no serviço de destino no confirm.
   */
  private static assertProposable(kind: ContextCandidateKind, p: Record<string, any>): void {
    if (kind === "constraint") {
      if (!clean(p.kind)) throw new Error("proposed.kind é obrigatório p/ candidato de restrição.");
      if (p.valueNum == null && p.value_num == null && !clean(p.valueText) && !clean(p.value_text)) throw new Error("proposed exige valueNum ou valueText.");
    } else if (kind === "fact") {
      if (!clean(p.domain)) throw new Error("proposed.domain é obrigatório p/ candidato de fato.");
      if (!clean(p.signalType) && !clean(p.signal_type)) throw new Error("proposed.signalType é obrigatório p/ candidato de fato.");
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
const clean = (s: any) => (s == null ? null : String(s).trim() || null);
function safeParse(s: string | null | undefined): any { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } }

function rowToCandidate(r: any): ContextCandidate {
  return {
    id: String(r.id), tenantId: String(r.organization_id), kind: r.kind, status: String(r.status).toUpperCase() as ContextCandidateStatus,
    title: r.title, summary: r.summary ?? null, scopeType: r.scope_type ?? null, scopeRef: r.scope_ref ?? null,
    proposed: safeParse(r.proposed_json) || {}, source: r.source ?? "manual", sourceRef: r.source_ref ?? null,
    confidence: r.confidence != null ? Number(r.confidence) : null, detectedAt: r.detected_at ?? null, expiresAt: r.expires_at ?? null,
    resolvedAt: r.resolved_at ?? null, resolvedBy: r.resolved_by ?? null, resolutionReason: r.resolution_reason ?? null,
    promotedKind: r.promoted_kind ?? null, promotedRefId: r.promoted_ref_id ?? null, correlationId: r.correlation_id ?? null,
  };
}

export default ContextCandidateService;
