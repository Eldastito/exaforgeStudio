import { FinancialLedgerService } from "./FinancialLedgerService.js";

/**
 * SurvivalBudgetService — Orçamento de Sobrevivência (Financial Recovery OS,
 * PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.5 / PR-7). Read-only, determinístico, sem tabela nova
 * (deriva das contas a pagar — `payables`).
 *
 * Classifica cada despesa em 4 níveis:
 *   A — indispensável (a empresa PARA sem ela)
 *   B — essencial ajustável (deve ser negociada/reduzida quando possível)
 *   C — adiável (pode ser postergada)
 *   D — potencialmente cortável (pode ser eliminada sem comprometer o essencial)
 *
 * REGRA (F3.5): a IA SUGERE, o humano CONFIRMA. NENHUMA despesa é cancelada aqui — este
 * service é 100% leitura/sugestão; a ação (cortar/postergar/renegociar) é comando governado
 * em fatia posterior (DecisionAction→ApprovalPolicy→CommandExecutor). Sem sinal → `unknown`
 * (não força classificação — RN-FR-1, não inventa).
 *
 * Heurística determinística por palavra-chave (categoria/descrição/fornecedor, PT-BR,
 * insensível a acento) + recorrência como sinal fraco. Dinheiro role-gated (§73).
 */

export type BudgetTier = "A" | "B" | "C" | "D" | "unknown";

const TIER_LABEL: Record<BudgetTier, string> = {
  A: "Indispensável", B: "Essencial ajustável", C: "Adiável", D: "Potencialmente cortável", unknown: "Não classificado",
};

// Palavras-chave por nível (a mais específica vence: D > C > B > A na checagem abaixo é
// tratada por ordem explícita). Curada para SMB BR; ampliável sem quebrar (unknown é o default).
const KEYWORDS: { tier: BudgetTier; terms: string[] }[] = [
  { tier: "A", terms: ["folha", "salario", "salarios", "funcionario", "funcionarios", "inss", "fgts", "energia", "luz", "agua", "internet", "telefonia", "telefone"] },
  { tier: "B", terms: ["aluguel", "locacao", "imposto", "tributo", "das", "simples", "icms", "iss", "fornecedor", "materia prima", "materia-prima", "insumo", "insumos", "frete", "contador", "contabilidade"] },
  { tier: "C", terms: ["software", "assinatura", "saas", "manutencao", "marketing", "anuncio", "anuncios", "publicidade", "treinamento", "consultoria"] },
  { tier: "D", terms: ["brinde", "brindes", "evento", "confraternizacao", "viagem", "premium", "extra", "cortesia", "presente"] },
];

function norm(s: any): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
const money = (v: number | null, includeMoney: boolean) => (includeMoney ? v : null);

export interface BudgetItem {
  id: string; description: string; category: string | null; supplier: string | null;
  amount: number | null; recurrence: string; tier: BudgetTier; tierLabel: string;
  basis: "keyword" | "unknown"; rationale: string; suggested: true;
}

export class SurvivalBudgetService {
  /**
   * Sugere a classificação A/B/C/D de cada conta a pagar aberta. NUNCA cancela nada.
   * `includeMoney:false` redige os valores (mantém tier/contagem/label).
   */
  static suggest(orgId: string, opts: { includeMoney?: boolean } = {}): {
    generatedAt: string; items: BudgetItem[];
    summary: { tier: BudgetTier; tierLabel: string; count: number; total: number | null }[];
    caveats: string[]; redacted?: boolean;
  } {
    const includeMoney = opts.includeMoney !== false;
    const payables = FinancialLedgerService.listPayables(orgId, "open") as any[];
    const items: BudgetItem[] = payables.map((p) => this.classify(p, includeMoney));

    const byTier = new Map<BudgetTier, { count: number; total: number }>();
    for (const p of payables) {
      const t = this.tierOf(p).tier;
      const acc = byTier.get(t) || { count: 0, total: 0 };
      acc.count++; acc.total += Number(p.amount) || 0;
      byTier.set(t, acc);
    }
    const order: BudgetTier[] = ["A", "B", "C", "D", "unknown"];
    const summary = order.filter((t) => byTier.has(t)).map((t) => ({
      tier: t, tierLabel: TIER_LABEL[t], count: byTier.get(t)!.count, total: money(byTier.get(t)!.total, includeMoney),
    }));

    return {
      generatedAt: new Date().toISOString(), items, summary,
      caveats: ["Sugestão automática — a IA sugere, o humano confirma. Nenhuma despesa é cancelada aqui (F3.5)."],
      ...(includeMoney ? {} : { redacted: true }),
    };
  }

  private static tierOf(p: any): { tier: BudgetTier; basis: "keyword" | "unknown" } {
    const hay = `${norm(p.category)} ${norm(p.description)} ${norm(p.supplier_name)}`;
    // Ordem D→C→B→A: um termo mais "cortável" prevalece sobre um genérico essencial.
    for (const group of [...KEYWORDS].reverse()) {
      if (group.terms.some((t) => hay.includes(t))) return { tier: group.tier, basis: "keyword" };
    }
    return { tier: "unknown", basis: "unknown" };
  }

  private static classify(p: any, includeMoney: boolean): BudgetItem {
    const { tier, basis } = this.tierOf(p);
    const rationale = basis === "keyword"
      ? `Classificada como ${TIER_LABEL[tier]} por palavra-chave na categoria/descrição.`
      : "Sem palavra-chave reconhecida — classifique manualmente (não inventamos o nível).";
    return {
      id: p.id, description: p.description, category: p.category || null, supplier: p.supplier_name || null,
      amount: money(Number(p.amount) || 0, includeMoney), recurrence: p.recurrence || "none",
      tier, tierLabel: TIER_LABEL[tier], basis, rationale, suggested: true,
    };
  }
}

export default SurvivalBudgetService;
