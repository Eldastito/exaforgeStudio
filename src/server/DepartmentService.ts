import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * DepartmentService — CONTROLER (PRD-E-007, Fatia 1a).
 *
 * Cadastro de DEPARTAMENTOS (a dimensão organizacional em que o consumo, o custo
 * e os processos serão apropriados). Aditivo e opt-in: nada muda nos fluxos atuais.
 * Determinístico, auditável, isolado por organization_id. Hierarquia via
 * parent_department_id (sem ciclos). Código curto opcional, único por org.
 */

export interface DepartmentInput {
  name: string;
  code?: string | null;
  managerUserId?: string | null;
  parentDepartmentId?: string | null;
  active?: boolean;
}

const clean = (s: any) => (s == null ? null : String(s).trim() || null);

export class DepartmentService {
  static get(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM business_departments WHERE id = ? AND organization_id = ?").get(id, orgId) || null;
  }

  static list(orgId: string, opts: { includeInactive?: boolean } = {}): any[] {
    const where = opts.includeInactive ? "" : " AND active = 1";
    return db.prepare(`SELECT * FROM business_departments WHERE organization_id = ?${where} ORDER BY name`).all(orgId) as any[];
  }

  /** Árvore de departamentos (raízes com filhos aninhados) — para a UI/organograma. */
  static tree(orgId: string, opts: { includeInactive?: boolean } = {}): any[] {
    const all = this.list(orgId, opts);
    const byId = new Map(all.map((d) => [d.id, { ...d, children: [] as any[] }]));
    const roots: any[] = [];
    for (const d of byId.values()) {
      const parent = d.parent_department_id ? byId.get(d.parent_department_id) : null;
      if (parent) parent.children.push(d); else roots.push(d);
    }
    return roots;
  }

  private static assertValid(orgId: string, input: DepartmentInput, selfId?: string): { name: string; code: string | null; managerUserId: string | null; parentId: string | null } {
    const name = clean(input.name);
    if (!name) throw new Error("Departamento exige nome.");
    const code = clean(input.code);
    if (code) {
      const dup = db.prepare("SELECT id FROM business_departments WHERE organization_id = ? AND code = ? AND id <> ?").get(orgId, code, selfId || "") as any;
      if (dup) throw new Error(`Já existe departamento com o código '${code}'.`);
    }
    const managerUserId = clean(input.managerUserId);
    if (managerUserId && !db.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ?").get(managerUserId, orgId)) throw new Error("Gestor (usuário) não encontrado na organização.");
    const parentId = clean(input.parentDepartmentId);
    if (parentId) {
      if (parentId === selfId) throw new Error("Um departamento não pode ser pai de si mesmo.");
      const parent = this.get(orgId, parentId);
      if (!parent) throw new Error("Departamento-pai não encontrado.");
      // Impede ciclos: subindo pela cadeia do pai, não pode reencontrar selfId.
      if (selfId) {
        let cur: any = parent;
        const seen = new Set<string>();
        while (cur && cur.parent_department_id) {
          if (cur.parent_department_id === selfId) throw new Error("Hierarquia inválida: criaria um ciclo.");
          if (seen.has(cur.parent_department_id)) break;
          seen.add(cur.parent_department_id);
          cur = this.get(orgId, cur.parent_department_id);
        }
      }
    }
    return { name, code, managerUserId, parentId };
  }

  static create(orgId: string, input: DepartmentInput, actorId?: string): any {
    const v = this.assertValid(orgId, input);
    const id = randomUUID();
    db.prepare(`INSERT INTO business_departments (id, organization_id, name, code, manager_user_id, parent_department_id, active)
                VALUES (?, ?, ?, ?, ?, ?, 1)`).run(id, orgId, v.name, v.code, v.managerUserId, v.parentId);
    try { logAuthEvent(orgId, actorId || "system", id, "DEPARTMENT_CREATE", { name: v.name, code: v.code }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, input: DepartmentInput, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Departamento não encontrado.");
    const v = this.assertValid(orgId, input, id);
    const active = input.active == null ? existing.active : (input.active ? 1 : 0);
    db.prepare(`UPDATE business_departments SET name = ?, code = ?, manager_user_id = ?, parent_department_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND organization_id = ?`).run(v.name, v.code, v.managerUserId, v.parentId, active, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "DEPARTMENT_UPDATE", { name: v.name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static setActive(orgId: string, id: string, active: boolean, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Departamento não encontrado.");
    db.prepare("UPDATE business_departments SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(active ? 1 : 0, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, active ? "DEPARTMENT_ACTIVATE" : "DEPARTMENT_DEACTIVATE", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }
}

export default DepartmentService;
