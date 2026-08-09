import db from "./db.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";
import { ComigoImpactService } from "./ComigoImpactService.js";
import { RetailImpactService } from "./RetailImpactService.js";

/**
 * UnifiedImpactLedgerService (ADR-158 F3 — Espinha Única / consolidação da
 * ponta de IMPACTO).
 *
 * Responde à pergunta do PRD §40 / Estado Final §33 — "quanto o ZapFlow
 * produziu?" — num ÚNICO lugar, reunindo as ilhas de impacto que hoje moram
 * em serviços separados (action_outcomes, Comigo, Retail, RIC).
 *
 * DESENHO (por que DERIVADO, não uma 2ª tabela):
 *  - Convenção nº 2 do repo proíbe rebuild de tabela; `action_outcomes.action_id`
 *    é NOT NULL, então não dá pra escrever impacto de domínio (não atado a uma
 *    decisão) lá sem reconstruir a tabela.
 *  - RN-004 manda DERIVAR por query em vez de duplicar armazenamento.
 *  → Logo a unificação é feita na LEITURA: cada fonte é um "provider" que
 *    devolve contribuições normalizadas; o ledger agrega por CATEGORIA. Zero
 *    escrita nova, zero migração, zero risco de divergência (nada é copiado).
 *
 * INVARIANTE INEGOCIÁVEL (ADR-085 D4 / PRD §32): categorias NUNCA são somadas
 * entre si — cada uma tem unidade e interpretação distintas (R$ recuperado ≠
 * horas economizadas). Só se agrega DENTRO da mesma categoria (mesma unidade).
 *
 * F3.1 liga a 1ª fonte (`action_ledger` = outcomes atados a decisões). As
 * fatias seguintes (F3.2 Comigo, F3.3 Retail, F3.4 RIC) apenas ADICIONAM
 * providers — sem tocar no núcleo. Isolado por org (cada provider filtra orgId).
 */

export interface ImpactContribution {
  source: string;        // action_ledger | comigo | retail | ric | ...
  category: string;      // revenueRecovered | costAvoided | lossPrevented | timeSaved | ...
  unit: string;          // BRL | minutes | ...
  value: number;
  basis: string;         // fact | estimate | mixed
  evidence?: any;
}

export interface UnifiedImpactLedger {
  generatedAt: string;
  sources: string[];
  categories: Record<string, { unit: string; total: number; lines: Array<{ source: string; value: number; basis: string; evidence: any }> }>;
  disclaimer: string;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class UnifiedImpactLedgerService {
  /**
   * Providers de fonte. Cada um recebe orgId e devolve contribuições
   * normalizadas (ou [] se a org não usa aquela fonte). Adicionar uma fonte =
   * registrar um provider aqui — o núcleo (`assemble`) não muda.
   */
  private static providers: Array<(orgId: string) => ImpactContribution[]> = [
    UnifiedImpactLedgerService.actionLedgerProvider,
    UnifiedImpactLedgerService.comigoProvider,
    UnifiedImpactLedgerService.retailProvider,
    // F3.4: ricProvider
  ];

  /** Fonte 1 — outcomes atados a decisões (action_outcomes, ADR-136/152). */
  static actionLedgerProvider(orgId: string): ImpactContribution[] {
    const c = OutcomeMeasurementService.ledger(orgId, { limit: 500 }).totals.categories;
    const out: ImpactContribution[] = [];
    const add = (category: string, unit: string, value: number) => {
      if (value) out.push({ source: "action_ledger", category, unit, value, basis: "mixed" });
    };
    add("revenueRecovered", "BRL", c.revenueRecovered);
    add("costAvoided", "BRL", c.costAvoided);
    add("lossPrevented", "BRL", c.lossPrevented);
    add("timeSaved", "minutes", c.timeSavedMinutes);
    return out;
  }

  /**
   * Fonte 2 (F3.2) — Comigo: lucro COMPROVADO desde o baseline (fato; dinheiro
   * que já entrou/foi ganho). Categoria própria `provenValue` (≠ receita
   * recuperada — nunca somadas). Só contribui se a org já usa Comigo (baseline
   * capturado): guarda contra rodar/capturar baseline num ledger read-only.
   */
  static comigoProvider(orgId: string): ImpactContribution[] {
    const row = db.prepare("SELECT comigo_impact_baseline_at FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    if (!row?.comigo_impact_baseline_at) return [];
    const s = ComigoImpactService.summary(orgId);
    if (!s || !s.provenBRL) return [];
    return [{
      source: "comigo",
      category: "provenValue",
      unit: "BRL",
      value: s.provenBRL,
      basis: "fact",
      evidence: { sinceDays: s.sinceDays, ordersCount: s.ordersCount, baselineAt: s.baselineAt },
    }];
  }

  /**
   * Fonte 3 (F3.3) — Retail: valor COMPROVADO do mês (R$ efetivamente apurados
   * via divergências de comissão + conciliação de fechamento). Mesma categoria
   * `provenValue` (basis=fact) que o Comigo — as duas fontes SOMAM dentro da
   * categoria (mesma unidade/semântica: dinheiro comprovado). Só contribui se a
   * org é tenant de varejo (tem loja). O RetailImpact JÁ separa comprovado de
   * atividade/estimativa (ADR-085 D4) — aqui entra só o comprovado (fato).
   */
  static retailProvider(orgId: string): ImpactContribution[] {
    const hasRetail = db.prepare("SELECT 1 FROM retail_stores WHERE organization_id = ? LIMIT 1").get(orgId);
    if (!hasRetail) return [];
    const month = new Date().toISOString().slice(0, 7);
    const m = RetailImpactService.monthly(orgId, month);
    const proven = Number(m?.proven?.totalProvenBRL) || 0;
    if (!proven) return [];
    return [{
      source: "retail",
      category: "provenValue",
      unit: "BRL",
      value: proven,
      basis: "fact",
      evidence: { month, commissionDivergences: m.proven.commissionDivergences, systemReconciliation: m.proven.systemReconciliation },
    }];
  }

  /** Monta o ledger unificado da org (derivado, read-only). */
  static build(orgId: string): UnifiedImpactLedger {
    const contributions: ImpactContribution[] = [];
    for (const provider of this.providers) {
      try { contributions.push(...provider(orgId)); }
      catch (e) { /* uma fonte quebrada não derruba o ledger inteiro (best-effort) */ }
    }
    return this.assemble(contributions);
  }

  private static assemble(contributions: ImpactContribution[]): UnifiedImpactLedger {
    const categories: UnifiedImpactLedger["categories"] = {};
    for (const c of contributions) {
      if (!categories[c.category]) categories[c.category] = { unit: c.unit, total: 0, lines: [] };
      const cat = categories[c.category];
      // Soma só DENTRO da categoria (mesma unidade). NUNCA entre categorias.
      cat.total = c.unit === "minutes" ? Math.trunc(cat.total + c.value) : round2(cat.total + c.value);
      cat.lines.push({ source: c.source, value: c.value, basis: c.basis, evidence: c.evidence ?? null });
    }
    return {
      generatedAt: new Date().toISOString(),
      sources: [...new Set(contributions.map((c) => c.source))],
      categories,
      disclaimer: "Categorias nunca somadas entre si — cada uma tem unidade e interpretação distintas (ADR-085 D4 / PRD §32).",
    };
  }
}

export default UnifiedImpactLedgerService;
