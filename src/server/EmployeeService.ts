import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * EmployeeService (Epic 7 — People Intelligence / RH IA, fatia 1, ADR-140).
 *
 * Cadastro FUNCIONAL: função, gestor, unidade, jornada e status — vinculável a
 * `users` quando o colaborador tem acesso ao sistema. SÓ REGISTRO: nenhuma
 * pontuação de "qualidade humana", nenhum dado sensível (saúde/religião/etc.),
 * nenhuma recomendação trabalhista. Determinístico, isolado por organization_id.
 * O primeiro valor de RH é capacidade e desenvolvimento, não folha.
 */

const STATUSES = ["active", "inactive", "leave"] as const;
type Status = (typeof STATUSES)[number];

export interface EmployeeInput {
  name: string; userId?: string | null; roleId?: string | null; managerUserId?: string | null;
  unit?: string | null; workSchedule?: string | null; status?: string; hiredAt?: string | null; notes?: string | null;
}

export class EmployeeService {
  // ── Catálogo de funções ──
  static listRoles(orgId: string): any[] {
    return db.prepare("SELECT * FROM employee_roles WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
  }

  static createRole(orgId: string, name: string, description?: string): { ok: boolean; id?: string; error?: string } {
    const nm = String(name || "").trim();
    if (!nm) return { ok: false, error: "Informe o nome da função." };
    const existing = db.prepare("SELECT id FROM employee_roles WHERE organization_id = ? AND name = ?").get(orgId, nm) as any;
    if (existing) return { ok: true, id: existing.id }; // idempotente por (org, nome)
    const id = randomUUID();
    db.prepare("INSERT INTO employee_roles (id, organization_id, name, description) VALUES (?, ?, ?, ?)").run(id, orgId, nm.slice(0, 120), description || null);
    return { ok: true, id };
  }

  // ── Colaboradores ──
  static create(orgId: string, input: EmployeeInput): { ok: boolean; id?: string; error?: string } {
    if (!String(input?.name || "").trim()) return { ok: false, error: "Informe o nome do colaborador." };
    const status: Status = (STATUSES as readonly string[]).includes(input.status as any) ? (input.status as Status) : "active";
    const id = randomUUID();
    db.prepare(`INSERT INTO employees (id, organization_id, user_id, name, role_id, manager_user_id, unit, work_schedule, status, hired_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, input.userId || null, String(input.name).trim().slice(0, 160), input.roleId || null, input.managerUserId || null,
        input.unit || null, input.workSchedule || null, status, input.hiredAt || null, input.notes || null);
    return { ok: true, id };
  }

  static get(orgId: string, id: string): any | null {
    const e = db.prepare(`SELECT e.*, r.name AS role_name FROM employees e LEFT JOIN employee_roles r ON r.id = e.role_id AND r.organization_id = e.organization_id WHERE e.id = ? AND e.organization_id = ?`).get(id, orgId) as any;
    return e || null;
  }

  static list(orgId: string, opts: { status?: string; managerUserId?: string } = {}): any[] {
    let sql = `SELECT e.*, r.name AS role_name FROM employees e LEFT JOIN employee_roles r ON r.id = e.role_id AND r.organization_id = e.organization_id WHERE e.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND e.status = ?"; params.push(opts.status); }
    if (opts.managerUserId) { sql += " AND e.manager_user_id = ?"; params.push(opts.managerUserId); }
    sql += " ORDER BY e.name LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static update(orgId: string, id: string, patch: Partial<EmployeeInput>): { ok: boolean; error?: string } {
    const cur = this.get(orgId, id);
    if (!cur) return { ok: false, error: "Colaborador não encontrado." };
    const fields: string[] = [];
    const params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (patch.name !== undefined) set("name", String(patch.name).trim().slice(0, 160));
    if (patch.userId !== undefined) set("user_id", patch.userId || null);
    if (patch.roleId !== undefined) set("role_id", patch.roleId || null);
    if (patch.managerUserId !== undefined) set("manager_user_id", patch.managerUserId || null);
    if (patch.unit !== undefined) set("unit", patch.unit || null);
    if (patch.workSchedule !== undefined) set("work_schedule", patch.workSchedule || null);
    if (patch.hiredAt !== undefined) set("hired_at", patch.hiredAt || null);
    if (patch.notes !== undefined) set("notes", patch.notes || null);
    if (patch.status !== undefined) {
      if (!(STATUSES as readonly string[]).includes(patch.status as any)) return { ok: false, error: "Status inválido." };
      set("status", patch.status);
    }
    if (!fields.length) return { ok: true };
    params.push(id, orgId);
    db.prepare(`UPDATE employees SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    return { ok: true };
  }

  static setStatus(orgId: string, id: string, status: string): { ok: boolean; error?: string } {
    return this.update(orgId, id, { status });
  }
}

export default EmployeeService;
