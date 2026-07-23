import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * PeopleDevelopmentService (Epic 7 — People Intelligence, fatia 2, ADR-140).
 *
 * Competências e trilhas de treinamento — "orientação e treinamento APLICÁVEL
 * À FUNÇÃO" (aceite §18). O foco é capacidade/desenvolvimento, não folha nem
 * julgamento de "qualidade humana": só o mapa declarado de skills e as trilhas
 * que a função exige. `developmentPlan` cruza o exigido pela função × o que o
 * colaborador tem e devolve a LACUNA + as trilhas recomendadas — de forma
 * determinística. Isolado por organization_id.
 */

const LEVELS = ["none", "basic", "intermediate", "advanced"] as const;
type Level = (typeof LEVELS)[number];
const RANK: Record<Level, number> = { none: 0, basic: 1, intermediate: 2, advanced: 3 };
const MIN_OK: Level = "basic"; // abaixo disto conta como lacuna

export class PeopleDevelopmentService {
  // ── Catálogo de competências ──
  static createSkill(orgId: string, name: string, category?: string): { ok: boolean; id?: string; error?: string } {
    const nm = String(name || "").trim();
    if (!nm) return { ok: false, error: "Informe o nome da competência." };
    const existing = db.prepare("SELECT id FROM skills WHERE organization_id = ? AND name = ?").get(orgId, nm) as any;
    if (existing) return { ok: true, id: existing.id };
    const id = randomUUID();
    db.prepare("INSERT INTO skills (id, organization_id, name, category) VALUES (?, ?, ?, ?)").run(id, orgId, nm.slice(0, 120), category || null);
    return { ok: true, id };
  }
  static listSkills(orgId: string): any[] {
    return db.prepare("SELECT * FROM skills WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
  }

  // ── Competências do colaborador (upsert por nível) ──
  static setEmployeeSkill(orgId: string, employeeId: string, skillId: string, level: string): { ok: boolean; error?: string } {
    if (!(LEVELS as readonly string[]).includes(level)) return { ok: false, error: "Nível inválido." };
    const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND organization_id = ?").get(employeeId, orgId) as any;
    const sk = db.prepare("SELECT id FROM skills WHERE id = ? AND organization_id = ?").get(skillId, orgId) as any;
    if (!emp || !sk) return { ok: false, error: "Colaborador ou competência não encontrados." };
    const existing = db.prepare("SELECT id FROM employee_skills WHERE organization_id = ? AND employee_id = ? AND skill_id = ?").get(orgId, employeeId, skillId) as any;
    if (existing) db.prepare("UPDATE employee_skills SET level = ?, assessed_at = CURRENT_TIMESTAMP WHERE id = ?").run(level, existing.id);
    else db.prepare("INSERT INTO employee_skills (id, organization_id, employee_id, skill_id, level) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), orgId, employeeId, skillId, level);
    return { ok: true };
  }
  static listEmployeeSkills(orgId: string, employeeId: string): any[] {
    return db.prepare(`SELECT es.*, s.name AS skill_name, s.category FROM employee_skills es JOIN skills s ON s.id = es.skill_id AND s.organization_id = es.organization_id WHERE es.organization_id = ? AND es.employee_id = ? ORDER BY s.name`).all(orgId, employeeId) as any[];
  }

  // ── Trilhas de treinamento ──
  static createPath(orgId: string, input: { name: string; description?: string; roleId?: string | null; requiredSkillIds?: string[] }): { ok: boolean; id?: string; error?: string } {
    const nm = String(input?.name || "").trim();
    if (!nm) return { ok: false, error: "Informe o nome da trilha." };
    const id = randomUUID();
    db.prepare("INSERT INTO training_paths (id, organization_id, name, description, role_id, required_skills_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, orgId, nm.slice(0, 160), input.description || null, input.roleId || null, input.requiredSkillIds && input.requiredSkillIds.length ? JSON.stringify(input.requiredSkillIds) : null);
    return { ok: true, id };
  }
  static listPaths(orgId: string): any[] {
    return (db.prepare("SELECT * FROM training_paths WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[])
      .map((p) => ({ ...p, requiredSkillIds: p.required_skills_json ? safeArr(p.required_skills_json) : [] }));
  }

  // ── Atribuições ──
  static assign(orgId: string, employeeId: string, pathId: string): { ok: boolean; id?: string; deduped?: boolean; error?: string } {
    const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND organization_id = ?").get(employeeId, orgId) as any;
    const path = db.prepare("SELECT id FROM training_paths WHERE id = ? AND organization_id = ?").get(pathId, orgId) as any;
    if (!emp || !path) return { ok: false, error: "Colaborador ou trilha não encontrados." };
    const existing = db.prepare("SELECT id FROM training_assignments WHERE organization_id = ? AND employee_id = ? AND path_id = ?").get(orgId, employeeId, pathId) as any;
    if (existing) return { ok: true, id: existing.id, deduped: true };
    const id = randomUUID();
    db.prepare("INSERT INTO training_assignments (id, organization_id, employee_id, path_id, status) VALUES (?, ?, ?, ?, 'assigned')").run(id, orgId, employeeId, pathId);
    return { ok: true, id, deduped: false };
  }
  static setAssignmentStatus(orgId: string, id: string, status: string): { ok: boolean; error?: string } {
    if (!["assigned", "in_progress", "completed"].includes(status)) return { ok: false, error: "Status inválido." };
    const completedAt = status === "completed" ? new Date().toISOString() : null;
    const r = db.prepare("UPDATE training_assignments SET status = ?, completed_at = ? WHERE id = ? AND organization_id = ?").run(status, completedAt, id, orgId);
    return r.changes ? { ok: true } : { ok: false, error: "Atribuição não encontrada." };
  }
  static listAssignments(orgId: string, employeeId: string): any[] {
    return db.prepare(`SELECT a.*, p.name AS path_name FROM training_assignments a JOIN training_paths p ON p.id = a.path_id AND p.organization_id = a.organization_id WHERE a.organization_id = ? AND a.employee_id = ? ORDER BY a.assigned_at DESC`).all(orgId, employeeId) as any[];
  }

  /** Trilhas aplicáveis à FUNÇÃO do colaborador (ou gerais). */
  static applicablePaths(orgId: string, employeeId: string): any[] {
    const emp = db.prepare("SELECT role_id FROM employees WHERE id = ? AND organization_id = ?").get(employeeId, orgId) as any;
    if (!emp) return [];
    return this.listPaths(orgId).filter((p) => !p.role_id || p.role_id === emp.role_id);
  }

  /**
   * Plano de desenvolvimento: cruza as competências EXIGIDAS pelas trilhas da
   * função × o que o colaborador tem, devolvendo a LACUNA e as trilhas
   * recomendadas (as que cobrem alguma competência em falta). Determinístico.
   */
  static developmentPlan(orgId: string, employeeId: string): any {
    const emp = db.prepare("SELECT id, name, role_id FROM employees WHERE id = ? AND organization_id = ?").get(employeeId, orgId) as any;
    if (!emp) return null;
    const applicable = this.applicablePaths(orgId, employeeId);
    const have = new Map<string, Level>();
    for (const es of this.listEmployeeSkills(orgId, employeeId)) have.set(es.skill_id, es.level as Level);

    const requiredIds = Array.from(new Set(applicable.flatMap((p) => p.requiredSkillIds as string[])));
    const skillName = (id: string) => (db.prepare("SELECT name FROM skills WHERE id = ? AND organization_id = ?").get(id, orgId) as any)?.name || id;
    const gaps = requiredIds
      .filter((sid) => RANK[(have.get(sid) || "none") as Level] < RANK[MIN_OK])
      .map((sid) => ({ skillId: sid, skillName: skillName(sid), currentLevel: have.get(sid) || "none" }));

    const gapSet = new Set(gaps.map((g) => g.skillId));
    const recommendedPaths = applicable
      .filter((p) => (p.requiredSkillIds as string[]).some((sid) => gapSet.has(sid)))
      .map((p) => ({ id: p.id, name: p.name, covers: (p.requiredSkillIds as string[]).filter((sid) => gapSet.has(sid)) }));

    return { employeeId: emp.id, name: emp.name, applicablePaths: applicable.map((p) => ({ id: p.id, name: p.name })), gaps, recommendedPaths, assignments: this.listAssignments(orgId, employeeId) };
  }
}

function safeArr(s: string): any[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

export default PeopleDevelopmentService;
