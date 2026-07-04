import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Histórico versionado de edições de produto pós-criação (ADR-033) —
 * complementa a auditoria de eventos (auth_audit_logs, que registra QUE algo
 * mudou) com o DIFF de cada alteração manual (o QUE mudou, de/para). Só grava
 * quando algo de fato mudou — comparar sempre before/after evita registrar
 * uma "edição" vazia quando o usuário reenvia os mesmos valores.
 */
export class ProductEditHistoryService {
  static record(orgId: string, productId: string, changedBy: string | null, before: Record<string, any>, after: Record<string, any>): void {
    try {
      const changed: { field: string; before: any; after: any }[] = [];
      for (const field of Object.keys(after)) {
        const b = before[field] ?? null;
        const a = after[field] ?? null;
        if (String(b) !== String(a)) changed.push({ field, before: b, after: a });
      }
      if (!changed.length) return;
      db.prepare(
        `INSERT INTO product_edit_history (id, organization_id, product_id, changed_by, changed_fields_json) VALUES (?, ?, ?, ?, ?)`
      ).run(uuidv4(), orgId, productId, changedBy, JSON.stringify(changed));
    } catch (e) { /* histórico é best-effort, nunca bloqueia a edição */ }
  }

  static list(orgId: string, productId: string): { id: string; changedBy: string | null; changedFields: any[]; createdAt: string }[] {
    // rowid como desempate: CURRENT_TIMESTAMP tem resolução de segundo, então
    // duas edições no mesmo segundo empatariam em created_at sem ele.
    const rows = db.prepare(
      `SELECT id, changed_by, changed_fields_json, created_at FROM product_edit_history
       WHERE organization_id = ? AND product_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`
    ).all(orgId, productId) as any[];
    return rows.map((r) => {
      let changedFields: any[] = [];
      try { changedFields = JSON.parse(r.changed_fields_json || "[]"); } catch { /* noop */ }
      return { id: r.id, changedBy: r.changed_by, changedFields, createdAt: r.created_at };
    });
  }
}
