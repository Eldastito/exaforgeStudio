import db from "./db.js";
import { randomUUID } from "crypto";
import { LossMarginService } from "./LossMarginService.js";

/**
 * ZappFlow Comigo — Motor de Precificação (ADR-111 D3 / ADR-088 D6).
 *
 * O coração do produto do autônomo: revela "quanto custa de verdade cada
 * unidade / cada hora minha" e "quanto cobrar". Unifica os três tipos de item
 * mudando só o denominador:
 *
 *   revenda     -> custo de compra (insumos + indiretos)               ÷ 1
 *   fabricação  -> (insumos + indiretos)                               ÷ rendimento
 *   serviço     -> insumos + indiretos + (tempo × valor da hora)       (por atendimento)
 *
 * Guarda-corpos (ADR-088 D6): trabalha com CHUTE e melhora com o REAL (nunca
 * trava por "não sei quanto gastei de gás"); nunca sugere preço que espante o
 * cliente. O cálculo é aritmético (zero-token) — LLM só na frase-conselho, fora
 * daqui. Isolado por organization_id em toda leitura/escrita.
 */

export type RecipeKind = "revenda" | "fabricacao" | "servico";
export type CostKind = "insumo" | "indireto" | "tempo";

// is_estimate: banco devolve 0/1 (número); entradas puras aceitam boolean também.
export type RecipeCost = { label: string; kind: CostKind; amount: number; is_estimate?: boolean | number };
export type Recipe = {
  kind: RecipeKind;
  yield_qty?: number | null;      // rendimento (fabricação)
  labor_minutes?: number | null;  // tempo do atendimento (serviço)
};

export type CostBreakdown = {
  insumos: number;
  indiretos: number;
  tempo: number;        // custo do tempo (serviço)
  yield: number;        // denominador aplicado
  unitCost: number;     // custo por unidade / atendimento
  hasEstimate: boolean; // ainda há chute na ficha?
};

// Custos que o autônomo esquece (ADR-088 D6) — usados pelo missingCostsHint.
export const FORGOTTEN_COSTS = [
  { key: "gas", label: "Gás" },
  { key: "energia", label: "Energia" },
  { key: "embalagem", label: "Embalagem" },
  { key: "transporte", label: "Transporte / combustível" },
  { key: "taxa_pix", label: "Taxa do Pix / maquininha" },
  { key: "aluguel", label: "Aluguel (ponto / cadeira)" },
] as const;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class ComigoPricingService {
  /**
   * Custo unitário (por unidade na fabricação/revenda, por atendimento no
   * serviço). `hourValue` é o "quanto vale sua hora" (ADR-088 D6 / F2).
   */
  static unitCost(recipe: Recipe, costs: RecipeCost[], hourValue = 0): CostBreakdown {
    const insumos = costs.filter((c) => c.kind === "insumo").reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const indiretos = costs.filter((c) => c.kind === "indireto").reduce((s, c) => s + (Number(c.amount) || 0), 0);
    // Custo do tempo: minutos × valor/minuto. Só entra no serviço.
    const laborFromMinutes = recipe.kind === "servico"
      ? ((Number(recipe.labor_minutes) || 0) / 60) * (Number(hourValue) || 0)
      : 0;
    // Custos explicitamente lançados como 'tempo' (ex.: hora de terceiro) somam.
    const laborExplicit = costs.filter((c) => c.kind === "tempo").reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const tempo = laborFromMinutes + laborExplicit;

    // Denominador: rendimento na fabricação (mín. 1 p/ não dividir por zero — o
    // "trabalha com chute" assume 1 até a pessoa informar). Revenda e serviço = 1.
    const yield_ = recipe.kind === "fabricacao" ? Math.max(1, Number(recipe.yield_qty) || 1) : 1;

    const unitCost = round2((insumos + indiretos + tempo) / yield_);
    // "Ainda é chute?" — um custo conta como real só quando is_estimate é 0/false.
    const hasEstimate = costs.some((c) => !(c.is_estimate === false || c.is_estimate === 0));

    return {
      insumos: round2(insumos),
      indiretos: round2(indiretos),
      tempo: round2(tempo),
      yield: yield_,
      unitCost,
      hasEstimate,
    };
  }

  /**
   * Preço sugerido a partir do custo e da margem-alvo (fração, ex.: 0.4 = 40%).
   * price = custo ÷ (1 − margem). Guarda-corpo: margem é limitada a [0, 0.9] para
   * nunca gerar um preço absurdo que espante o cliente (ADR-088 D6).
   */
  static suggestPrice(unitCost: number, targetMargin = 0.3): { price: number; margin: number; markup: number } {
    const cost = Number(unitCost) || 0;
    const margin = Math.min(0.9, Math.max(0, Number(targetMargin) || 0));
    const price = round2(cost / (1 - margin));
    const markup = cost > 0 ? round2((price - cost) / cost) : 0;
    return { price, margin, markup };
  }

  /**
   * Margem efetiva de um preço praticado vs. o custo (para o termômetro/relatório).
   */
  static marginOf(price: number, unitCost: number): number {
    const p = Number(price) || 0;
    if (p <= 0) return 0;
    return round2((p - (Number(unitCost) || 0)) / p);
  }

  /**
   * Lista os "custos que você esquece" que ainda NÃO aparecem na ficha, para o
   * copiloto sugerir sem humilhar. Casa por palavra-chave no label (case/acento
   * tolerante o suficiente para o uso real).
   */
  static missingCostsHint(costs: RecipeCost[]): { key: string; label: string }[] {
    const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const present = costs.map((c) => norm(c.label));
    const has = (needles: string[]) => present.some((p) => needles.some((n) => p.includes(n)));
    const map: Record<string, string[]> = {
      gas: ["gas"],
      energia: ["energia", "luz", "eletric"],
      embalagem: ["embalagem", "saquinho", "pote", "caixa", "sacola"],
      transporte: ["transporte", "combustivel", "gasolina", "frete", "uber", "moto"],
      taxa_pix: ["pix", "maquininha", "taxa", "cartao"],
      aluguel: ["aluguel", "cadeira", "ponto", "sala"],
    };
    return FORGOTTEN_COSTS.filter((fc) => !has(map[fc.key] || [fc.key])).map((fc) => ({ key: fc.key, label: fc.label }));
  }

  // ── Helpers de banco (isolados por organização) ─────────────────────────────

  private static hourValue(orgId: string): number {
    const o = db.prepare("SELECT comigo_hour_value FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return Number(o?.comigo_hour_value) || 0;
  }

  static getRecipeWithCosts(orgId: string, recipeId: string): { recipe: any; costs: RecipeCost[] } | null {
    const recipe = db.prepare("SELECT * FROM comigo_recipes WHERE organization_id = ? AND id = ?").get(orgId, recipeId) as any;
    if (!recipe) return null;
    const costs = db.prepare("SELECT label, kind, amount, is_estimate FROM comigo_recipe_costs WHERE recipe_id = ?").all(recipeId) as any[];
    return { recipe, costs: costs.map((c) => ({ label: c.label, kind: c.kind, amount: c.amount, is_estimate: c.is_estimate })) };
  }

  /** Custo + sugestão de preço + dica de custos esquecidos, tudo pronto para a UI. */
  static computeForRecipe(orgId: string, recipeId: string, targetMargin = 0.3) {
    const found = this.getRecipeWithCosts(orgId, recipeId);
    if (!found) return null;
    const breakdown = this.unitCost(found.recipe, found.costs, this.hourValue(orgId));
    const suggestion = this.suggestPrice(breakdown.unitCost, targetMargin);
    const missing = this.missingCostsHint(found.costs);
    return { breakdown, suggestion, missing, kind: found.recipe.kind as RecipeKind };
  }

  /**
   * Loop estimativa→realidade (ADR-088 D6, o "IP defensável"): a cada fechamento,
   * o rendimento/merma real entra e o motor recalibra. Registra a calibração,
   * atualiza o rendimento da ficha para o real e devolve o novo custo unitário.
   */
  static applyCalibration(orgId: string, recipeId: string, actualYield: number, wasteQty = 0, note?: string, createdBy?: string) {
    const found = this.getRecipeWithCosts(orgId, recipeId);
    if (!found) return null;
    const expected = Number(found.recipe.yield_qty) || null;
    db.prepare(
      `INSERT INTO comigo_calibrations (id, organization_id, recipe_id, expected_yield, actual_yield, waste_qty, note) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), orgId, recipeId, expected, actualYield, wasteQty, note || null);

    // O rendimento real vira o novo denominador (só faz sentido na fabricação).
    if (found.recipe.kind === "fabricacao" && Number(actualYield) > 0) {
      db.prepare("UPDATE comigo_recipes SET yield_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?")
        .run(Number(actualYield), orgId, recipeId);
    }
    // Recalcula com o rendimento recalibrado.
    const out = this.computeForRecipe(orgId, recipeId);
    // GANCHO de perda (ADR-114 Fatia 2): a merma vira lançamento automático,
    // valorada pelo custo unitário — sem digitação dupla.
    const waste = Number(wasteQty) || 0;
    if (waste > 0 && out?.breakdown?.unitCost > 0) {
      try { LossMarginService.recordLoss(orgId, { driver: "merma", amount: waste * out.breakdown.unitCost, source: "comigo_calibration", note: note || `merma de ${found.recipe.name}`, createdBy }); } catch { /* noop */ }
    }
    return out;
  }
}

export default ComigoPricingService;
