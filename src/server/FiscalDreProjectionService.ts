/**
 * FiscalDreProjectionService — ADR-181 F7: projeção de CBS/IBS na DRE gerencial.
 *
 * Reflete o peso dos novos tributos NO CONTEXTO da DRE (ADR-128), mas de forma READ-ONLY: NÃO
 * altera o `sobra` do `ManagerialDreService`. Isso resolve a "dupla contagem" ESTRUTURALMENTE —
 * como a projeção é um bloco à parte (nunca somado no resultado), ela jamais duplica o
 * `tax_sale` (o % de Simples que o lojista já lança como custo variável).
 *
 * O tratamento depende do regime (herdado do motor F3):
 *  - Simples/MEI (das_embedded): CBS/IBS JÁ estão no DAS → `informative_embedded` (não é
 *    despesa a somar; se a org usa `tax_sale`, é o MESMO ônus — avisa, não duplica).
 *  - regime regular (separate): `operating_expense` (recolhido por fora — poderia entrar como
 *    linha de tributo quando as alíquotas oficiais forem curadas).
 *
 * Guardrails RN-FISCAL: nunca inventa (alíquota não curada → amount null via motor); honesto
 * quando falta regime (projeção indisponível); determinístico; isolado por org; SEM dupla
 * contagem (read-only, fora do bottom line).
 */
import { ManagerialDreService } from "./ManagerialDreService.js";
import { ConsumptionTaxService } from "./ConsumptionTaxService.js";
import db from "./db.js";

const DISCLAIMER =
  "Projeção informativa dos tributos da Reforma sobre a receita líquida do período — não altera o resultado da DRE gerencial nem substitui a apuração fiscal oficial.";

export interface FiscalDreProjection {
  period: string;
  available: boolean;
  reason?: string;                       // 'profile_incomplete' quando indisponível
  baseReceitaLiquida: number;            // base da projeção (R$)
  regime: string | null;
  collectionMode: "das_embedded" | "separate" | null;
  treatment: "informative_embedded" | "operating_expense" | null;
  taxes: { cbs: { rate: number | null; amount: number | null }; ibs: { rate: number | null; amount: number | null } };
  totalTax: number | null;
  partial: boolean;
  doubleCount: { usesTaxSaleCost: boolean; note: string | null };
  note: string;
  disclaimer: string;
}

export class FiscalDreProjectionService {
  /** Projeta CBS/IBS sobre a receita líquida do período. Read-only; não toca a DRE. */
  static project(orgId: string, period = new Date().toISOString().slice(0, 7)): FiscalDreProjection {
    const dre = ManagerialDreService.monthly(orgId, period);
    const base = Number((dre.linhas as any)?.receitaLiquida) || 0;
    // Data representativa do fato gerador: meio do mês (a fase vem daí, RN-FISCAL-3).
    const date = `${period}-15`;
    const usesTaxSaleCost = this.usesTaxSale(orgId);

    const ct = ConsumptionTaxService.compute(orgId, { baseValue: base, date });
    if (ct.status === "profile_incomplete") {
      return {
        period, available: false, reason: "profile_incomplete", baseReceitaLiquida: base,
        regime: null, collectionMode: null, treatment: null,
        taxes: { cbs: { rate: null, amount: null }, ibs: { rate: null, amount: null } },
        totalTax: null, partial: true,
        doubleCount: { usesTaxSaleCost, note: null },
        note: "Declare o regime tributário para projetar CBS/IBS na DRE.", disclaimer: DISCLAIMER,
      };
    }

    const treatment = ct.collectionMode === "das_embedded" ? "informative_embedded" : "operating_expense";
    const dcNote = ct.collectionMode === "das_embedded"
      ? (usesTaxSaleCost
          ? "Você já lança o imposto do Simples como custo variável (tax_sale) — CBS/IBS representam o MESMO ônus (dentro do DAS). NÃO some os dois: esta projeção é informativa e não entra no resultado."
          : "CBS/IBS são recolhidos dentro do DAS — projeção informativa, não é despesa a somar no resultado.")
      : "Regime regular: CBS/IBS recolhidos por fora — quando as alíquotas oficiais forem curadas, entram como linha de tributo (esta projeção não altera o resultado atual).";

    return {
      period, available: true, baseReceitaLiquida: base, regime: ct.regime, collectionMode: ct.collectionMode,
      treatment,
      taxes: { cbs: { rate: ct.taxes.cbs.rate, amount: ct.taxes.cbs.amount }, ibs: { rate: ct.taxes.ibs.rate, amount: ct.taxes.ibs.amount } },
      totalTax: ct.totalTax, partial: ct.partial,
      doubleCount: { usesTaxSaleCost, note: dcNote },
      note: ct.note, disclaimer: DISCLAIMER,
    };
  }

  /** A org lança imposto de venda como custo variável (tax_sale)? Sinal do risco de dupla contagem. */
  private static usesTaxSale(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT COUNT(*) n FROM retail_store_variable_costs WHERE organization_id = ? AND category = 'tax_sale' AND percent > 0`).get(orgId) as any;
      return Number(r?.n || 0) > 0;
    } catch { return false; }
  }
}

export default FiscalDreProjectionService;
