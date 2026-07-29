/**
 * Histórico versionado do prontuário clínico (ADR-080 Fase G) — mesmo padrão
 * do `ProductEditHistoryService` (ADR-033): registra o DIFF de cada alteração
 * campo-a-campo, complementando o `auth_audit_logs` (que registra QUE algo
 * mudou) com o QUE mudou (de/para). Cobre também addendum pós-assinatura, pra
 * auditoria clínica ficar rastreável fim-a-fim (Art.11 LGPD exige trilha).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";

export class ClinicEncounterHistoryService {
  static record(
    orgId: string,
    encounterId: string,
    changedBy: string | null,
    before: Record<string, any>,
    after: Record<string, any>
  ): void {
    try {
      const changed: { field: string; before: any; after: any }[] = [];
      for (const field of Object.keys(after)) {
        const b = before[field] ?? null;
        const a = after[field] ?? null;
        if (String(b) !== String(a)) changed.push({ field, before: b, after: a });
      }
      if (!changed.length) return;
      db.prepare(
        `INSERT INTO clinical_encounter_history (id, organization_id, encounter_id, changed_by, changed_fields_json) VALUES (?, ?, ?, ?, ?)`
      ).run(randomUUID(), orgId, encounterId, changedBy, JSON.stringify(changed));
    } catch (e) { /* best-effort, nunca bloqueia a edição do prontuário */ }
  }

  static list(orgId: string, encounterId: string): { id: string; changedBy: string | null; changedFields: any[]; createdAt: string }[] {
    // rowid desempata quando duas edições cabem no mesmo segundo (CURRENT_TIMESTAMP tem resolução de 1s).
    const rows = db.prepare(
      `SELECT id, changed_by, changed_fields_json, created_at FROM clinical_encounter_history
       WHERE organization_id = ? AND encounter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200`
    ).all(orgId, encounterId) as any[];
    return rows.map((r) => {
      let changedFields: any[] = [];
      try { changedFields = JSON.parse(r.changed_fields_json || "[]"); } catch { /* noop */ }
      return { id: r.id, changedBy: r.changed_by, changedFields, createdAt: r.created_at };
    });
  }
}

export default ClinicEncounterHistoryService;
