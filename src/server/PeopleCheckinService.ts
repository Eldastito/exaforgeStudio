import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * PeopleCheckinService (Epic 7 — People Intelligence, fatia 4, ADR-140).
 *
 * Check-ins de acompanhamento e reconhecimento/feedback DOCUMENTADO (aceite
 * §18: "reconhecimento e feedback documentado"). Texto HUMANO — nada de
 * pontuar "qualidade humana", nada de recomendação executável: é registro.
 * Determinístico, isolado por organization_id.
 */

const KINDS = ["checkin", "recognition", "feedback"] as const;
type Kind = (typeof KINDS)[number];

export interface CheckinInput {
  employeeId: string; kind?: string; period?: string | null; summary: string;
  strengths?: string | null; nextSteps?: string | null; authorUserId?: string | null;
}

export class PeopleCheckinService {
  static create(orgId: string, input: CheckinInput): { ok: boolean; id?: string; error?: string } {
    if (!String(input?.summary || "").trim()) return { ok: false, error: "Escreva um resumo do check-in/feedback." };
    const emp = db.prepare("SELECT id FROM employees WHERE id = ? AND organization_id = ?").get(input.employeeId, orgId) as any;
    if (!emp) return { ok: false, error: "Colaborador não encontrado." };
    const kind: Kind = (KINDS as readonly string[]).includes(input.kind as any) ? (input.kind as Kind) : "checkin";
    const id = randomUUID();
    db.prepare(`INSERT INTO performance_checkins (id, organization_id, employee_id, author_user_id, kind, period, summary, strengths, next_steps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, input.employeeId, input.authorUserId || null, kind, input.period || null,
        String(input.summary).trim().slice(0, 2000), input.strengths || null, input.nextSteps || null);
    return { ok: true, id };
  }

  static list(orgId: string, employeeId: string, opts: { kind?: string } = {}): any[] {
    let sql = "SELECT * FROM performance_checkins WHERE organization_id = ? AND employee_id = ?";
    const params: any[] = [orgId, employeeId];
    if (opts.kind && (KINDS as readonly string[]).includes(opts.kind)) { sql += " AND kind = ?"; params.push(opts.kind); }
    sql += " ORDER BY created_at DESC LIMIT 200";
    return db.prepare(sql).all(...params) as any[];
  }

  static get(orgId: string, id: string): any | null {
    return db.prepare("SELECT * FROM performance_checkins WHERE id = ? AND organization_id = ?").get(id, orgId) as any || null;
  }

  /** Resumo por colaborador: contagem por tipo + o último de cada. */
  static summaryFor(orgId: string, employeeId: string): any {
    const rows = this.list(orgId, employeeId);
    const byKind = (k: Kind) => rows.filter((r) => r.kind === k);
    const last = (k: Kind) => byKind(k)[0] || null;
    return {
      total: rows.length,
      checkins: byKind("checkin").length,
      recognitions: byKind("recognition").length,
      feedbacks: byKind("feedback").length,
      lastCheckin: last("checkin"),
      lastRecognition: last("recognition"),
    };
  }
}

export default PeopleCheckinService;
