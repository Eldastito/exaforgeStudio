import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * ConsumptionLedgerService — CONTROLER (PRD-E-007, Fatia 2, §14).
 *
 * O ledger de CONSUMO é a verdade: cada retirada (out) e devolução (in) vira um
 * evento. O consumo LÍQUIDO, a média diária/mensal e a cobertura são DERIVADOS
 * daqui — nunca do saldo. Determinístico, isolado por organization_id.
 *
 * consumo_líquido = Σ(out) − Σ(in)  na janela.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface ConsumptionEventInput {
  productId: string;
  locationId?: string | null;
  costCenterId?: string | null;
  departmentId?: string | null;
  direction?: "out" | "in";
  quantity: number;
  uom?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  actorUserId?: string | null;
  occurredAt?: string; // YYYY-MM-DD (default: hoje)
}

function today(): string { return new Date().toISOString().slice(0, 10); }
function daysBefore(dateISO: string, days: number): string { const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); }

export class ConsumptionLedgerService {
  /** Registra um evento de consumo (fato). Quantidade sempre positiva. */
  static record(orgId: string, input: ConsumptionEventInput): any {
    const qty = round2(input.quantity);
    if (!(qty > 0)) throw new Error("Quantidade do evento de consumo deve ser positiva.");
    const direction = input.direction === "in" ? "in" : "out";
    const occurredAt = /^\d{4}-\d{2}-\d{2}$/.test(input.occurredAt || "") ? input.occurredAt! : today();
    const id = randomUUID();
    db.prepare(`INSERT INTO consumption_events
      (id, organization_id, product_service_id, location_id, cost_center_id, department_id, direction, quantity, uom, source_type, source_id, actor_user_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, orgId, input.productId, input.locationId || null, input.costCenterId || null, input.departmentId || null,
      direction, qty, input.uom || null, input.sourceType || "manual", input.sourceId || null, input.actorUserId || null, occurredAt);
    return db.prepare("SELECT * FROM consumption_events WHERE id = ?").get(id);
  }

  /** Consumo líquido (out − in) na janela, com filtros opcionais. */
  static netConsumption(orgId: string, productId: string, opts: { from?: string; to?: string; costCenterId?: string; departmentId?: string } = {}): number {
    const to = opts.to || today();
    const from = opts.from || daysBefore(to, 30);
    let sql = `SELECT COALESCE(SUM(CASE WHEN direction='out' THEN quantity ELSE -quantity END), 0) AS net
                 FROM consumption_events
                WHERE organization_id = ? AND product_service_id = ? AND occurred_at BETWEEN ? AND ?`;
    const params: any[] = [orgId, productId, from, to];
    if (opts.costCenterId) { sql += " AND cost_center_id = ?"; params.push(opts.costCenterId); }
    if (opts.departmentId) { sql += " AND department_id = ?"; params.push(opts.departmentId); }
    return round2(Number((db.prepare(sql).get(...params) as any)?.net) || 0);
  }

  /** Média diária = consumo líquido da janela ÷ dias da janela. */
  static dailyAverage(orgId: string, productId: string, opts: { windowDays?: number; to?: string } = {}): { average: number; net: number; windowDays: number } {
    const windowDays = Math.max(1, Number(opts.windowDays) || 30);
    const to = opts.to || today();
    const from = daysBefore(to, windowDays);
    const net = this.netConsumption(orgId, productId, { from, to });
    return { average: round2(net / windowDays), net, windowDays };
  }

  /**
   * Cobertura em dias = saldo utilizável ÷ média diária confiável. Sem histórico
   * suficiente (média ≤ 0), devolve null — não inventa cobertura (§14.5).
   */
  static coverageDays(orgId: string, productId: string, balance: number, opts: { windowDays?: number } = {}): number | null {
    const { average } = this.dailyAverage(orgId, productId, opts);
    if (!(average > 0)) return null;
    return round2(Number(balance) / average);
  }

  /** Consumo líquido agregado por centro de custo na janela. */
  static byCostCenter(orgId: string, opts: { from?: string; to?: string } = {}): any[] {
    const to = opts.to || today();
    const from = opts.from || daysBefore(to, 30);
    return db.prepare(
      `SELECT cost_center_id,
              COALESCE(SUM(CASE WHEN direction='out' THEN quantity ELSE -quantity END), 0) AS net
         FROM consumption_events
        WHERE organization_id = ? AND occurred_at BETWEEN ? AND ? AND cost_center_id IS NOT NULL
        GROUP BY cost_center_id
        ORDER BY net DESC`
    ).all(orgId, from, to) as any[];
  }
}

export default ConsumptionLedgerService;
