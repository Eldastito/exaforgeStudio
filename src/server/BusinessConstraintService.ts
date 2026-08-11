import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * BusinessConstraintService — PRD 3 F4 (§15): BusinessConstraint de 1ª classe.
 *
 * Até aqui as restrições do negócio viviam soltas (`organization_settings.
 * negotiator_max_discount`, bands do `ApprovalPolicyService`, `budget_limit_brl`
 * por campanha). Esta é a casa ÚNICA de uma restrição declarada pelo dono: um
 * LIMITE ou POLÍTICA que as decisões devem respeitar (teto de desconto, limite de
 * orçamento, piso de margem, prazo máximo de pagamento, política textual…).
 *
 * O papel no Context Engine é READ + DERIVE (AC-A02/§90): o resolver LÊ as
 * restrições aplicáveis e as ANEXA ao `ContextPacket` (§15) — este serviço NÃO faz
 * ENFORCEMENT (o gate real segue no RBAC/`ApprovalPolicyService`). Determinístico,
 * auditável, isolado por `organization_id`. Inerte até o dono declarar (0
 * regressão). NUNCA inventa: só existe o que foi declarado (§25).
 *
 * GUARDRAILS (testados):
 *   - RN-BC-1 ISOLAMENTO: `orgId` 1º arg; toda query filtra organization_id.
 *   - RN-BC-2 NÃO INVENTA: sem restrição declarada → `list`/`applicable` vazios.
 *   - RN-BC-3 VALIDAÇÃO DE INVARIANTE: kind/operator do vocabulário fechado; valor
 *     numérico OU textual (uma restrição tem de limitar ALGO).
 *   - RN-BC-4 PROVENIÊNCIA (§24): `source` sempre presente (owner_declared default).
 */

export const CONSTRAINT_KINDS = ["discount_ceiling", "budget_limit", "margin_floor", "payment_term_max", "policy", "custom"] as const;
export const CONSTRAINT_OPERATORS = ["lte", "gte", "eq", "max", "min"] as const;
export const CONSTRAINT_SOURCES = ["owner_declared", "policy", "imported"] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];
export type ConstraintOperator = (typeof CONSTRAINT_OPERATORS)[number];

export interface ConstraintInput {
  kind: string;
  name: string;
  scopeType?: string | null;   // global|product|category|store|supplier|customer|…
  scopeRef?: string | null;    // id da entidade escopada (null = vale pro scopeType todo)
  operator?: string;           // lte|gte|eq|max|min (default lte)
  valueNum?: number | null;
  valueUnit?: string | null;   // percent|BRL|days|…
  valueText?: string | null;   // restrição textual (política)
  source?: string | null;      // proveniência (default owner_declared)
  active?: boolean;
}

const clean = (s: any) => (s == null ? null : String(s).trim() || null);

export class BusinessConstraintService {
  static get(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM business_constraints WHERE id = ? AND organization_id = ?").get(id, orgId) || null;
  }

  /** Lista restrições (isolado por org), com filtros opcionais. Ativas por padrão. */
  static list(orgId: string, opts: { includeInactive?: boolean; kind?: string; scopeType?: string } = {}): any[] {
    let sql = "SELECT * FROM business_constraints WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (!opts.includeInactive) sql += " AND active = 1";
    if (opts.kind) { sql += " AND kind = ?"; params.push(opts.kind); }
    if (opts.scopeType) { sql += " AND scope_type = ?"; params.push(opts.scopeType); }
    sql += " ORDER BY kind, name";
    return db.prepare(sql).all(...params) as any[];
  }

  /**
   * Restrições APLICÁVEIS a um escopo: as globais (sem scope_type, ou scope_type=
   * 'global') SEMPRE valem; as escopadas valem quando (scope_type, scope_ref)
   * casa — ou quando `scope_ref` é null (vale pra todo o scope_type). Determinístico.
   */
  static applicable(orgId: string, target: { scopeType?: string | null; scopeRef?: string | null } = {}): any[] {
    const scopeType = clean(target.scopeType);
    const scopeRef = clean(target.scopeRef);
    const rows = this.list(orgId);
    return rows.filter((c) => {
      const cType = c.scope_type ? String(c.scope_type) : null;
      if (!cType || cType === "global") return true;             // global sempre aplica
      if (!scopeType || cType !== scopeType) return false;        // escopo diferente
      if (c.scope_ref == null) return true;                       // vale pro tipo inteiro
      return scopeRef != null && String(c.scope_ref) === scopeRef; // casa a entidade
    });
  }

  private static assertValid(input: ConstraintInput): {
    kind: string; name: string; scopeType: string | null; scopeRef: string | null;
    operator: string; valueNum: number | null; valueUnit: string | null; valueText: string | null; source: string;
  } {
    const kind = clean(input.kind);
    if (!kind || !CONSTRAINT_KINDS.includes(kind as any)) throw new Error(`kind deve ser: ${CONSTRAINT_KINDS.join("|")}`);
    const name = clean(input.name);
    if (!name) throw new Error("Restrição exige nome.");
    const operator = clean(input.operator) || "lte";
    if (!CONSTRAINT_OPERATORS.includes(operator as any)) throw new Error(`operator deve ser: ${CONSTRAINT_OPERATORS.join("|")}`);
    const valueNum = input.valueNum != null && input.valueNum !== undefined ? Number(input.valueNum) : null;
    if (valueNum != null && !Number.isFinite(valueNum)) throw new Error("valueNum deve ser numérico.");
    const valueText = clean(input.valueText);
    // RN-BC-3: uma restrição tem de limitar ALGO — número OU texto.
    if (valueNum == null && !valueText) throw new Error("Restrição exige valueNum ou valueText.");
    const source = clean(input.source) || "owner_declared";
    if (!CONSTRAINT_SOURCES.includes(source as any)) throw new Error(`source deve ser: ${CONSTRAINT_SOURCES.join("|")}`);
    return { kind, name, scopeType: clean(input.scopeType), scopeRef: clean(input.scopeRef), operator, valueNum, valueUnit: clean(input.valueUnit), valueText, source };
  }

  static create(orgId: string, input: ConstraintInput, actorId?: string): any {
    const v = this.assertValid(input);
    const id = randomUUID();
    db.prepare(`INSERT INTO business_constraints (id, organization_id, kind, name, scope_type, scope_ref, operator, value_num, value_unit, value_text, source, active, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, orgId, v.kind, v.name, v.scopeType, v.scopeRef, v.operator, v.valueNum, v.valueUnit, v.valueText, v.source, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", id, "BUSINESS_CONSTRAINT_CREATE", { kind: v.kind, name: v.name, scopeType: v.scopeType }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, input: ConstraintInput, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Restrição não encontrada.");
    const v = this.assertValid(input);
    const active = input.active == null ? existing.active : (input.active ? 1 : 0);
    db.prepare(`UPDATE business_constraints SET kind = ?, name = ?, scope_type = ?, scope_ref = ?, operator = ?, value_num = ?, value_unit = ?, value_text = ?, source = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND organization_id = ?`)
      .run(v.kind, v.name, v.scopeType, v.scopeRef, v.operator, v.valueNum, v.valueUnit, v.valueText, v.source, active, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "BUSINESS_CONSTRAINT_UPDATE", { kind: v.kind, name: v.name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static setActive(orgId: string, id: string, active: boolean, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Restrição não encontrada.");
    db.prepare("UPDATE business_constraints SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(active ? 1 : 0, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, active ? "BUSINESS_CONSTRAINT_ACTIVATE" : "BUSINESS_CONSTRAINT_DEACTIVATE", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static remove(orgId: string, id: string, actorId?: string): { removed: number } {
    const info = db.prepare("DELETE FROM business_constraints WHERE id = ? AND organization_id = ?").run(id, orgId);
    if (info.changes) { try { logAuthEvent(orgId, actorId || "system", id, "BUSINESS_CONSTRAINT_DELETE", {}); } catch { /* noop */ } }
    return { removed: info.changes };
  }
}

export default BusinessConstraintService;
