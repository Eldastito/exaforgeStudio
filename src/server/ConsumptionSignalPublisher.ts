import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ConsumptionLedgerService } from "./ConsumptionLedgerService.js";

/**
 * ConsumptionSignalPublisher — CONTROLER (PRD-E-007, Fatia 2b, §20.1).
 *
 * Liga o consumo ao KERNEL: a partir do ledger de consumo (fatos) + saldos por
 * local, deriva sinais DETERMINÍSTICOS que fluem para o Pareto, o Diretor, o
 * briefing e a tela de Insights — como qualquer outro publicador.
 *
 * Sinais (domínio "consumption"), só para itens com controle de consumo:
 *   - consumo_cobertura_baixa: saldo cobre poucos dias no ritmo atual;
 *   - consumo_acima_padrao: consumo recente muito acima da própria média;
 *   - consumo_estoque_parado: tem saldo mas sem NENHUMA saída na janela (capital parado).
 *
 * Determinístico, idempotente (dedupe por sinal), auto-resolve quando a condição
 * some, isolado por organização. Nunca edita saldo.
 */

const DOMAIN = "consumption";
const SOURCE = "ConsumptionSignalPublisher";
const COVERAGE_WINDOW = 30;   // janela p/ a média diária da cobertura
const PROTECTION_DAYS = 10;   // cobertura abaixo disso → sinal
const RECENT_DAYS = 7;        // janela "recente" p/ o pico de consumo
const BASELINE_DAYS = 30;     // janela de base (antes da recente)
const ABOVE_FACTOR = 1.5;     // recente > base × isso → acima do padrão
const DEAD_STOCK_DAYS = 90;   // sem saída nesse período + saldo > 0 → parado
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function today(): string { return new Date().toISOString().slice(0, 10); }
function daysBefore(dateISO: string, days: number): string { const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); }

export class ConsumptionSignalPublisher {
  /** Saldo total do produto somando todas as localizações. */
  private static totalBalance(orgId: string, productId: string): number {
    const r = db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_location_balances WHERE organization_id = ? AND product_service_id = ?").get(orgId, productId) as any;
    return round2(Number(r?.q) || 0);
  }

  static run(orgId: string, opts: { asOf?: string } = {}): { published: number; resolved: number } {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : today();
    const products = db.prepare(
      "SELECT id, name, default_uom FROM products_services WHERE organization_id = ? AND consumption_control_enabled = 1"
    ).all(orgId) as any[];

    const current = new Set<string>();
    let published = 0;
    const pub = (s: any, dedupeKey: string) => {
      current.add(dedupeKey);
      try { BusinessSignalService.publish(orgId, { domain: DOMAIN, basis: "fact", sourceService: SOURCE, sourceEntityType: "product", ...s, dedupeKey }); published++; } catch { /* noop */ }
    };

    for (const p of products) {
      const balance = this.totalBalance(orgId, p.id);
      const unit = p.default_uom || "un";

      // 1) Cobertura baixa — só quando há ritmo de consumo confiável.
      const { average } = ConsumptionLedgerService.dailyAverage(orgId, p.id, { windowDays: COVERAGE_WINDOW, to: asOf });
      if (average > 0 && balance >= 0) {
        const coverage = round2(balance / average);
        if (coverage < PROTECTION_DAYS) {
          const severity = coverage < 3 ? "critical" : coverage < 7 ? "risk" : "attention";
          pub({
            signalType: "consumo_cobertura_baixa", severity, confidence: 1, sourceEntityId: p.id,
            impactAmount: balance, impactUnit: unit,
            evidence: { product: p.name, coverageDays: coverage, balance, dailyAverage: average },
          }, `consumo:cobertura:${p.id}`);
        }
      }

      // 2) Consumo acima do padrão — recente vs base.
      const recentNet = ConsumptionLedgerService.netConsumption(orgId, p.id, { from: daysBefore(asOf, RECENT_DAYS), to: asOf });
      const baseTo = daysBefore(asOf, RECENT_DAYS + 1);
      const baseNet = ConsumptionLedgerService.netConsumption(orgId, p.id, { from: daysBefore(baseTo, BASELINE_DAYS - 1), to: baseTo });
      const recentRate = recentNet / RECENT_DAYS;
      const baseRate = baseNet / BASELINE_DAYS;
      if (recentNet > 0 && baseRate > 0 && recentRate > baseRate * ABOVE_FACTOR) {
        pub({
          signalType: "consumo_acima_padrao", severity: "attention", confidence: 1, sourceEntityId: p.id,
          impactAmount: round2(recentNet), impactUnit: unit,
          evidence: { product: p.name, recentRate: round2(recentRate), baselineRate: round2(baseRate), recentNet: round2(recentNet) },
        }, `consumo:acima:${p.id}`);
      }

      // 3) Estoque parado — tem saldo mas nenhuma saída na janela.
      if (balance > 0 && ConsumptionLedgerService.grossOut(orgId, p.id, { from: daysBefore(asOf, DEAD_STOCK_DAYS), to: asOf }) === 0) {
        pub({
          signalType: "consumo_estoque_parado", severity: "attention", confidence: 1, sourceEntityId: p.id,
          impactAmount: balance, impactUnit: unit,
          evidence: { product: p.name, balance, daysWithoutConsumption: DEAD_STOCK_DAYS },
        }, `consumo:parado:${p.id}`);
      }
    }

    // Auto-resolve: sinais deste publicador que não valem mais.
    let resolved = 0;
    const open = db.prepare(`SELECT dedupe_key FROM business_signals WHERE organization_id = ? AND source_service = ? AND status = 'open'`).all(orgId, SOURCE) as any[];
    for (const s of open) if (!current.has(s.dedupe_key)) { if (BusinessSignalService.resolveByDedupe(orgId, s.dedupe_key).ok) resolved++; }

    return { published, resolved };
  }
}

export default ConsumptionSignalPublisher;
