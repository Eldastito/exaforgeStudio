import db from "./db.js";
import { PatternMemoryService, PatternCandidate, Hypothesizer } from "./PatternMemoryService.js";

/**
 * InventoryPatternMemory — o domínio de ESTOQUE aprende sobre o motor genérico
 * (PatternMemoryService). Detector determinístico sobre stock_movements:
 *   - produto_ruptura_recorrente: produto que ROMPE (saldo cruza para ≤ 0) com
 *     frequência na janela — ponto de pedido mal calibrado ou giro subestimado.
 *
 * O saldo é reconstruído REPLAYANDO as movimentações em ordem cronológica
 * (entrada/transferência somam; saída subtrai; ajuste define o absoluto). Conta
 * uma "ruptura" só na BORDA (transição de >0 para ≤0), não a cada saída em falta.
 * Validado, vira sinal 'inventory' que flui para o Pareto/briefing/Diretor/Insights.
 */

const MIN_EVIDENCE = 3;
const DOMAIN = "inventory";
const HANDLED_TYPES = ["produto_ruptura_recorrente"];
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

function daysBefore(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export class InventoryPatternMemory {
  /** Produto com ruptura recorrente: reconstrói o saldo e conta bordas para ≤ 0 na janela. */
  static detectRecurringStockout(orgId: string, from: string, asOf: string): PatternCandidate[] {
    // Todo o histórico ATÉ asOf (para ter o saldo de abertura correto), só produtos
    // com controle de estoque. Conta a ruptura apenas se a borda cai DENTRO da janela.
    const rows = db.prepare(
      `SELECT sm.product_service_id AS pid, sm.type AS type, sm.quantity AS qty, date(sm.created_at) AS d
         FROM stock_movements sm
         JOIN products_services ps ON ps.id = sm.product_service_id AND ps.organization_id = sm.organization_id
        WHERE sm.organization_id = ? AND date(sm.created_at) <= ? AND ps.stock_control_enabled = 1
        ORDER BY sm.product_service_id, sm.created_at, sm.id`
    ).all(orgId, asOf) as any[];

    const events = new Map<string, number>(); // pid → nº de rupturas na janela
    let curPid: string | null = null;
    let bal = 0;
    for (const m of rows) {
      if (m.pid !== curPid) { curPid = m.pid; bal = 0; }
      const prev = bal;
      const qty = Number(m.qty) || 0;
      if (m.type === "entrada" || m.type === "transferencia") bal += qty;
      else if (m.type === "saida") bal -= qty;
      else if (m.type === "ajuste") bal = qty;
      // Borda de ruptura: estava com saldo, ficou sem — e dentro da janela.
      if (prev > 0 && bal <= 0 && m.d >= from) events.set(m.pid, (events.get(m.pid) || 0) + 1);
    }

    const out: PatternCandidate[] = [];
    for (const [pid, count] of events) {
      if (count < MIN_EVIDENCE) continue;
      const name = (db.prepare("SELECT name FROM products_services WHERE id = ? AND organization_id = ?").get(pid, orgId) as any)?.name || "produto";
      out.push({
        scopeId: String(pid), scopeName: name,
        patternType: "produto_ruptura_recorrente", patternKey: "ruptura",
        evidenceCount: count, confidence: clamp01(count / 5),
        impactAmount: count, impactUnit: "stockouts",
        evidence: { product: name, stockouts: count, from, to: asOf },
        fallbackDescription: `Produto ${name} rompe recorrente: ${count} rupturas de estoque na janela — revisar ponto de pedido/estoque mínimo e o giro real.`,
      });
    }
    return out;
  }

  /** Um passe de aprendizado do domínio de estoque (opt-in via PatternMemoryService). */
  static async learnPass(orgId: string, opts: { asOf?: string; windowWeeks?: number; hypothesizer?: Hypothesizer | null } = {}): Promise<{ enabled: boolean; detected: number; validated: number; decayed: number; published: number; resolved: number }> {
    if (!PatternMemoryService.isEnabled(orgId)) return { enabled: false, detected: 0, validated: 0, decayed: 0, published: 0, resolved: 0 };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : new Date().toISOString().slice(0, 10);
    const from = daysBefore(asOf, (opts.windowWeeks || 12) * 7);
    const candidates = this.detectRecurringStockout(orgId, from, asOf);
    const res = await PatternMemoryService.learn(orgId, DOMAIN, candidates, {
      asOf, handledTypes: HANDLED_TYPES, sourceService: "InventoryPatternMemory", hypothesizer: opts.hypothesizer,
    });
    return { enabled: true, ...res };
  }
}

export default InventoryPatternMemory;
