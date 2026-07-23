import db from "./db.js";
import { randomUUID } from "crypto";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * WorkloadService (Epic 7 — People Intelligence, fatia 3, ADR-140).
 *
 * Sobrecarga do colaborador a partir de FATOS: carga de tarefas (abertas +
 * vencidas) e disponibilidade DECLARADA (ausência/reduzida). Cumpre o aceite do
 * PRD §18 — "gestor enxerga sobrecarga baseada em tarefas e disponibilidade,
 * COM EVIDÊNCIA". Determinístico, isolado por organization_id. Não pontua
 * "qualidade humana", não infere nada sensível; a decisão é do gestor. Pode
 * publicar um sinal (domínio `people`) idempotente para entrar no ledger.
 */

const OPEN_THRESHOLD = 6;     // tarefas abertas a partir das quais sinaliza carga
const OVERDUE_THRESHOLD = 3;  // tarefas vencidas que já indicam sobrecarga

export class WorkloadService {
  // ── Disponibilidade declarada ──
  static addAvailability(orgId: string, input: { employeeId: string; kind?: string; startDate: string; endDate?: string | null; note?: string; createdBy?: string }): { ok: boolean; id?: string; error?: string } {
    const kind = ["absence", "reduced", "available"].includes(String(input.kind)) ? input.kind! : "absence";
    if (!input.employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ""))) return { ok: false, error: "Informe colaborador e data inicial (YYYY-MM-DD)." };
    const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND organization_id = ?").get(input.employeeId, orgId) as any;
    if (!emp) return { ok: false, error: "Colaborador não encontrado." };
    const id = randomUUID();
    db.prepare("INSERT INTO employee_availability_events (id, organization_id, employee_id, kind, start_date, end_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, input.employeeId, kind, input.startDate, input.endDate || null, input.note || null, input.createdBy || null);
    return { ok: true, id };
  }

  static listAvailability(orgId: string, employeeId: string): any[] {
    return db.prepare("SELECT * FROM employee_availability_events WHERE organization_id = ? AND employee_id = ? ORDER BY start_date DESC").all(orgId, employeeId) as any[];
  }

  /** Disponibilidade declarada que cobre a data (absence/reduced), ou null. */
  static availabilityOn(orgId: string, employeeId: string, date: string): string | null {
    const r = db.prepare(`SELECT kind FROM employee_availability_events WHERE organization_id = ? AND employee_id = ? AND kind IN ('absence','reduced') AND start_date <= ? AND (end_date IS NULL OR end_date >= ?) ORDER BY CASE kind WHEN 'absence' THEN 0 ELSE 1 END LIMIT 1`)
      .get(orgId, employeeId, date, date) as any;
    return r?.kind || null;
  }

  /**
   * Avalia a carga de cada colaborador ATIVO com usuário vinculado. `asOfDate`
   * (YYYY-MM-DD) define "hoje" para vencidos/disponibilidade (default: hoje).
   */
  static assess(orgId: string, opts: { asOfDate?: string } = {}): any {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOfDate || "")) ? opts.asOfDate! : new Date().toISOString().slice(0, 10);
    const employees = db.prepare("SELECT id, name, user_id, role_id, unit FROM employees WHERE organization_id = ? AND status = 'active' AND user_id IS NOT NULL").all(orgId) as any[];

    const rows = employees.map((e) => {
      const open = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE organization_id = ? AND assigned_to = ? AND status IN ('a_fazer','fazendo')").get(orgId, e.user_id) as any).n;
      const overdue = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE organization_id = ? AND assigned_to = ? AND status IN ('a_fazer','fazendo') AND due_at IS NOT NULL AND date(due_at) < date(?)").get(orgId, e.user_id, asOf) as any).n;
      const sample = (db.prepare("SELECT title FROM tasks WHERE organization_id = ? AND assigned_to = ? AND status IN ('a_fazer','fazendo') ORDER BY (due_at IS NULL), due_at ASC LIMIT 3").all(orgId, e.user_id) as any[]).map((t) => t.title);
      const availability = this.availabilityOn(orgId, e.id, asOf);

      const reasons: string[] = [];
      if (open >= OPEN_THRESHOLD) reasons.push(`${open} tarefas abertas`);
      if (overdue >= OVERDUE_THRESHOLD) reasons.push(`${overdue} vencidas`);
      if (availability === "absence" && open > 0) reasons.push(`${open} tarefas com responsável AUSENTE`);
      if (availability === "reduced" && open >= Math.ceil(OPEN_THRESHOLD / 2)) reasons.push(`${open} tarefas com disponibilidade reduzida`);
      const overloaded = reasons.length > 0;
      const severity = (overdue >= OVERDUE_THRESHOLD || availability === "absence") ? "risk" : "attention";

      return {
        employeeId: e.id, name: e.name, unit: e.unit, userId: e.user_id,
        openTasks: open, overdueTasks: overdue, availability: availability || "available",
        overloaded, severity: overloaded ? severity : null,
        reason: reasons.join("; ") || null,
        evidence: { openTasks: open, overdueTasks: overdue, availability: availability || "available", taskSample: sample },
      };
    });

    return { generatedAt: asOf, employees: rows, overloadedCount: rows.filter((r) => r.overloaded).length };
  }

  /** Publica um sinal `people` por colaborador sobrecarregado (idempotente/dia). */
  static publishOverloadSignals(orgId: string, opts: { asOfDate?: string } = {}): { published: number } {
    const rep = this.assess(orgId, opts);
    let published = 0;
    for (const r of rep.employees) {
      if (!r.overloaded) continue;
      try {
        BusinessSignalService.publish(orgId, {
          domain: "people", signalType: "employee_overload", severity: r.severity, basis: "fact", confidence: 1,
          impactAmount: r.overdueTasks || r.openTasks, impactUnit: "score",
          sourceService: "WorkloadService", sourceEntityType: "employee", sourceEntityId: r.employeeId,
          evidence: { name: r.name, ...r.evidence, reason: r.reason },
          dedupeKey: `people:overload:${r.employeeId}:${rep.generatedAt}`,
        });
        published++;
      } catch (e) { /* sinal é aditivo */ }
    }
    return { published };
  }
}

export default WorkloadService;
