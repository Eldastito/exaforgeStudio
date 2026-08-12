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
// ADR-162 F13 (D6/§54) — 3º estado de ATRIBUIÇÃO, aditivo. `basis` já é TEXT sem
// CHECK, então aceitar 'influenced' não exige migração. FACT (comprovado) / ESTIMATE
// (projetado) / INFLUENCED (atribuído — a ação contribuiu, mas não é a causa única):
// os três NUNCA são somados entre si (§54) — o ledger os separa em buckets próprios.
const BASES = ["fact", "estimate", "influenced"] as const;

export interface RecordOutcomeInput {
  expectedValue?: number | null;
  realizedValue?: number | null;
  basis?: string;                       // fact | estimate | influenced (§54 — nunca somados)
  measurementMethod?: string;           // self_reported | manual | attributed | derived
  attributionWindowDays?: number | null;
  evidence?: any;
  // ADR-152 F3.1 — categorias explícitas (PRD §11.11). Todos opcionais;
  // NUNCA são somadas entre si num número único (agrupamos por categoria
  // no ledger — a separação é o que garante credibilidade, ADR-085 D4).
  timeSavedMinutes?: number | null;
  costAvoided?: number | null;
  revenueRecovered?: number | null;
  lossPrevented?: number | null;
}

export class OutcomeMeasurementService {
  /**
   * Registra um outcome para uma ação existente da própria organização. A ação
   * precisa existir e pertencer ao tenant (isolamento). Idempotência fica a
   * cargo de quem chama (ex.: `complete` só transita uma vez).
   */
  static record(orgId: string, actionId: string, input: RecordOutcomeInput = {}): any {
    // ADR-158 — o outcome herda o fio da ação (fecha o trace sinal→decisão→outcome).
    const action = db.prepare("SELECT id, correlation_id FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada para medir outcome.");
    const basis = (BASES as readonly string[]).includes(String(input.basis)) ? String(input.basis) : "estimate";
    const method: Method = (METHODS as readonly string[]).includes(input.measurementMethod as any) ? (input.measurementMethod as Method) : "manual";
    const id = randomUUID();
    db.prepare(`INSERT INTO action_outcomes
      (id, organization_id, action_id, expected_value, realized_value, basis, measurement_method, attribution_window_days, evidence_json,
       time_saved_minutes, cost_avoided, revenue_recovered, loss_prevented, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, actionId,
        input.expectedValue != null ? round2(input.expectedValue) : null,
        input.realizedValue != null ? round2(input.realizedValue) : null,
        basis, method,
        input.attributionWindowDays != null ? Math.trunc(Number(input.attributionWindowDays)) : null,
        input.evidence != null ? JSON.stringify(input.evidence) : null,
        input.timeSavedMinutes != null ? Math.trunc(Number(input.timeSavedMinutes)) : null,
        input.costAvoided != null ? round2(input.costAvoided) : null,
        input.revenueRecovered != null ? round2(input.revenueRecovered) : null,
        input.lossPrevented != null ? round2(input.lossPrevented) : null,
        action.correlation_id || null);
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
    // ADR-152 F3.1 — categorias do PRD §11.11. NUNCA somadas entre si (cada
    // uma tem unidade/interpretação diferente); só agregadas dentro da MESMA
    // categoria. Nulls ignorados. Alimentam o painel "Concluído hoje" (F3.2).
    const sumField = (field: string) => round2(items.reduce((s, i) => s + (Number((i as any)[field]) || 0), 0));
    return {
      items,
      totals: {
        expected,
        realized,
        gap: round2(realized - expected),
        // Separação inegociável (ADR-085 D4 / ADR-162 §54): comprovado ≠ estimado ≠
        // atribuído. Os três buckets NUNCA são somados entre si.
        fact: { expected: sumExpected("fact"), realized: sumRealized("fact") },
        estimate: { expected: sumExpected("estimate"), realized: sumRealized("estimate") },
        influenced: { expected: sumExpected("influenced"), realized: sumRealized("influenced") },
        // Categorias explícitas (ADR-152 F3.1) — cada uma na sua unidade.
        categories: {
          timeSavedMinutes: Math.trunc(sumField("time_saved_minutes")),
          costAvoided: sumField("cost_avoided"),
          revenueRecovered: sumField("revenue_recovered"),
          lossPrevented: sumField("loss_prevented"),
        },
        count: items.length,
      },
    };
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default OutcomeMeasurementService;
