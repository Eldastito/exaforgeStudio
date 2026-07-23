import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * OutcomeMeasurementService (ADR-136, Epic 2 — C2b).
 *
 * Fecha o loop "prometido × entregue": cada ação concluída registra o valor
 * REALIZADO ao lado do ESPERADO, sempre ancorado numa evidência e separando
 * fato de estimativa (ADR-085 D4). É a base do Impact Ledger UNIFICADO — o
 * mesmo contrato para qualquer domínio (caixa, vendas, compras…), em vez de
 * cada módulo medir valor do seu jeito. Determinístico, isolado por
 * organization_id. Não executa nada; só mede o que já aconteceu.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const METHODS = ["self_reported", "manual", "attributed", "derived"] as const;
type Method = (typeof METHODS)[number];

export interface RecordOutcomeInput {
  expectedValue?: number | null;
  realizedValue?: number | null;
  basis?: string;                       // fact | estimate
  measurementMethod?: string;           // self_reported | manual | attributed | derived
  attributionWindowDays?: number | null;
  evidence?: any;
}

export class OutcomeMeasurementService {
  /**
   * Registra um outcome para uma ação existente da própria organização. A ação
   * precisa existir e pertencer ao tenant (isolamento). Idempotência fica a
   * cargo de quem chama (ex.: `complete` só transita uma vez).
   */
  static record(orgId: string, actionId: string, input: RecordOutcomeInput = {}): any {
    const action = db.prepare("SELECT id FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada para medir outcome.");
    const basis = input.basis === "fact" ? "fact" : "estimate";
    const method: Method = (METHODS as readonly string[]).includes(input.measurementMethod as any) ? (input.measurementMethod as Method) : "manual";
    const id = randomUUID();
    db.prepare(`INSERT INTO action_outcomes
      (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method, attribution_window_days, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, actionId,
        input.expectedValue != null ? round2(input.expectedValue) : null,
        input.realizedValue != null ? round2(input.realizedValue) : null,
        basis, method,
        input.attributionWindowDays != null ? Math.trunc(Number(input.attributionWindowDays)) : null,
        input.evidence != null ? JSON.stringify(input.evidence) : null);
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any {
    const o = db.prepare("SELECT * FROM action_outcomes WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!o) return null;
    o.evidence = o.evidence_json ? safeParse(o.evidence_json) : null;
    return o;
  }

  /** Outcomes de uma ação (mais recente primeiro). */
  static forAction(orgId: string, actionId: string): any[] {
    const rows = db.prepare("SELECT * FROM action_outcomes WHERE organization_id = ? AND action_id = ? ORDER BY measured_at DESC").all(orgId, actionId) as any[];
    return rows.map((o) => ({ ...o, evidence: o.evidence_json ? safeParse(o.evidence_json) : null }));
  }

  /**
   * Impact Ledger UNIFICADO: esperado × realizado agregado sobre todas as ações
   * medidas, com fato e estimativa SEPARADOS (nunca somados num número inflado).
   * Junta os metadados da ação (origem, domínio, título) para a UI mostrar
   * "de onde veio, quem aprovou, o que rendeu".
   */
  static ledger(orgId: string, opts: { domain?: string; limit?: number } = {}): any {
    let sql = `SELECT o.*, a.domain, a.action_type, a.title, a.status AS action_status, a.created_by
               FROM action_outcomes o JOIN decision_actions a ON a.id = o.action_id AND a.organization_id = o.organization_id
               WHERE o.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.domain) { sql += " AND a.domain = ?"; params.push(opts.domain); }
    sql += " ORDER BY o.measured_at DESC LIMIT ?";
    params.push(Math.min(Math.max(Number(opts.limit) || 100, 1), 500));
    const items = (db.prepare(sql).all(...params) as any[]).map((o) => ({ ...o, evidence: o.evidence_json ? safeParse(o.evidence_json) : null }));

    const sumExpected = (b: string) => round2(items.filter((i) => i.basis === b).reduce((s, i) => s + (Number(i.expected_value) || 0), 0));
    const sumRealized = (b: string) => round2(items.filter((i) => i.basis === b).reduce((s, i) => s + (Number(i.realized_value) || 0), 0));

    const expected = round2(items.reduce((s, i) => s + (Number(i.expected_value) || 0), 0));
    const realized = round2(items.reduce((s, i) => s + (Number(i.realized_value) || 0), 0));
    return {
      items,
      totals: {
        expected,
        realized,
        gap: round2(realized - expected),
        // Separação inegociável (ADR-085 D4): comprovado ≠ estimado.
        fact: { expected: sumExpected("fact"), realized: sumRealized("fact") },
        estimate: { expected: sumExpected("estimate"), realized: sumRealized("estimate") },
        count: items.length,
      },
    };
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default OutcomeMeasurementService;
