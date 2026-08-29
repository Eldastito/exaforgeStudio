/**
 * AlterdataLgpdApprovalService — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 6, RF-16).
 *
 * Registra e consulta aprovações LGPD pra dados pessoais capturados pela
 * integração Alterdata (Toulon). Hoje o único propósito coberto é
 * `pdvCustomerImport` (CRM/ClienteMalote), mas a modelagem generaliza pra
 * outros propósitos futuros.
 *
 * Contrato:
 *   record({ orgId, purpose, legalBasis, approvedBy, approvedByEmail?,
 *            retentionDays?, accessProfile?, notes? }) → { id, approvedAt }
 *   hasActiveApproval(orgId, purpose) → boolean
 *   getLatest(orgId, purpose) → row | null
 *   revoke(id, revokedAt?) → boolean
 *
 * Aprovação "ativa" = a mais recente, ainda não revogada.
 */
import { randomUUID } from "crypto";
import db from "./db.js";

export type LgpdLegalBasis =
  | "consentimento"
  | "legitimo_interesse"
  | "execucao_contrato"
  | "obrigacao_legal"
  | "protecao_credito";

export interface LgpdApprovalInput {
  orgId: string;
  purpose: string;
  legalBasis: LgpdLegalBasis | string;
  approvedBy: string;
  approvedByEmail?: string | null;
  retentionDays?: number | null;
  accessProfile?: string | null;
  notes?: string | null;
}

export interface LgpdApprovalRow {
  id: string;
  organization_id: string;
  purpose: string;
  legal_basis: string;
  approved_by: string;
  approved_by_email: string | null;
  approved_at: string;
  retention_days: number | null;
  access_profile: string | null;
  notes: string | null;
  revoked_at: string | null;
}

export class AlterdataLgpdApprovalService {
  /** Registra aprovação. Nova linha sempre (nunca UPDATE) — auditoria. */
  static record(input: LgpdApprovalInput): { id: string; approvedAt: string } {
    if (!input.orgId) throw new Error("LGPD approval: orgId obrigatório.");
    if (!input.purpose) throw new Error("LGPD approval: purpose obrigatório.");
    if (!input.legalBasis) throw new Error("LGPD approval: legalBasis obrigatório.");
    if (!input.approvedBy) throw new Error("LGPD approval: approvedBy obrigatório.");
    const id = randomUUID();
    const approvedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO alterdata_lgpd_approvals
       (id, organization_id, purpose, legal_basis, approved_by, approved_by_email,
        approved_at, retention_days, access_profile, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.orgId, input.purpose, String(input.legalBasis),
      input.approvedBy, input.approvedByEmail ?? null, approvedAt,
      input.retentionDays ?? null, input.accessProfile ?? null, input.notes ?? null,
    );
    return { id, approvedAt };
  }

  /** Última aprovação (por approved_at desc). */
  static getLatest(orgId: string, purpose: string): LgpdApprovalRow | null {
    return db.prepare(
      `SELECT * FROM alterdata_lgpd_approvals
       WHERE organization_id = ? AND purpose = ?
       ORDER BY approved_at DESC LIMIT 1`
    ).get(orgId, purpose) as LgpdApprovalRow | null;
  }

  /** Aprovação está ativa = mais recente não revogada. */
  static hasActiveApproval(orgId: string, purpose: string): boolean {
    const r = this.getLatest(orgId, purpose);
    return !!r && !r.revoked_at;
  }

  /** Lista histórico completo (mais recentes primeiro) — pra auditoria/UI. */
  static listHistory(orgId: string, purpose?: string, limit = 50): LgpdApprovalRow[] {
    if (purpose) {
      return db.prepare(
        `SELECT * FROM alterdata_lgpd_approvals
         WHERE organization_id = ? AND purpose = ?
         ORDER BY approved_at DESC LIMIT ?`
      ).all(orgId, purpose, limit) as LgpdApprovalRow[];
    }
    return db.prepare(
      `SELECT * FROM alterdata_lgpd_approvals
       WHERE organization_id = ?
       ORDER BY approved_at DESC LIMIT ?`
    ).all(orgId, limit) as LgpdApprovalRow[];
  }

  /**
   * Revoga uma aprovação (por id). Não deleta — só marca revoked_at.
   * Uma revogação NÃO desliga automaticamente a flag no connector; a UI/
   * caller decide se pausa o import quando revoked. Retorna true se linha
   * mudou.
   */
  static revoke(id: string, revokedAt: Date | string | null = null): boolean {
    const at = revokedAt ? (typeof revokedAt === "string" ? revokedAt : revokedAt.toISOString()) : new Date().toISOString();
    const r = db.prepare(
      `UPDATE alterdata_lgpd_approvals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
    ).run(at, id);
    return Number(r.changes || 0) > 0;
  }
}
