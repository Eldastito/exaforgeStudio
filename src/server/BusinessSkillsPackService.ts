/**
 * BusinessSkillsPackService — Track C do PRD-PEL-01, fatia F1.
 *
 * Fachada aditiva sobre os services de pricing por vertical já existentes
 * (`pricing.ts`, `RetailPricingService`, `ComigoPricingService`). Não muda
 * nenhuma assinatura — só delega baseado em vertical.
 *
 * F1 escopo:
 *   - suggestPrice(orgId, cost, vertical) via adapter map
 *   - getOrgConfig / updateOrgConfig da tabela business_skills_pack_org_config
 *
 * F2, F3, F4 adicionam createQuoteFromTemplate, enrichProspectsWithCompetitor,
 * bundle comercial. Este PR é backend puro; UI fica para F5.
 *
 * Regras (RN-BSP-01..12 do PRD-BSP-01):
 *   - Fachada aditiva (RN-BSP-02) — services por vertical intactos
 *   - Multi-tenant isolation (RN-BSP-03) — orgId em toda operação
 *   - PT-BR em mensagens (RN-BSP-11)
 *   - Sem gate de plano nesta fatia (RN-BSP-08 vira ativo em F4)
 */
import db from "./db.js";
import { suggestSalePrice } from "./pricing.js";
import { ComigoPricingService } from "./ComigoPricingService.js";

export const SUPPORTED_VERTICALS = [
  "retail", "loja_virtual", "comigo", "falatu", "beauty", "advocacia", "clinic",
] as const;
export type Vertical = typeof SUPPORTED_VERTICALS[number] | "default";

export const DIMENSIONS = ["pricing", "rfp", "local_marketing"] as const;
export type Dimension = typeof DIMENSIONS[number];

export interface PricingSuggestion {
  suggested_price: number;
  floor_price: number | null;
  ceiling_price: number | null;
  method: string;                  // 'markup_psycho' | 'comigo_margin' | 'default_markup40' | ...
  reasoning: string;
  adapter: string;                 // 'pricing.ts' | 'ComigoPricingService' | 'default'
  markup_percent_used?: number;
  target_margin_used?: number;
}

export interface PricingPrefs {
  markup_percent?: number;         // padrão pra loja_virtual/retail (default 40)
  target_margin?: number;          // padrão pra comigo/falatu (default 0.3)
  floor_multiplier?: number;       // se definido: floor = cost * floor_multiplier
  ceiling_multiplier?: number;     // se definido: ceiling = cost * ceiling_multiplier
}

export interface OrgBspConfig {
  organization_id: string;
  pricing_prefs: PricingPrefs | null;
  quote_template: any | null;      // F2
  outreach_pack: any | null;       // F3
  enabled_dimensions: Dimension[]; // F4 vai enforçar
  created_at: string;
  updated_at: string;
}

export class BusinessSkillsPackError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg); this.code = code; this.name = "BusinessSkillsPackError";
  }
}

interface OrgConfigRow {
  organization_id: string;
  quote_template_json: string | null;
  outreach_pack_json: string | null;
  pricing_prefs_json: string | null;
  enabled_dimensions_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConfig(r: OrgConfigRow): OrgBspConfig {
  const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  return {
    organization_id: r.organization_id,
    pricing_prefs: parse(r.pricing_prefs_json, null),
    quote_template: parse(r.quote_template_json, null),
    outreach_pack: parse(r.outreach_pack_json, null),
    enabled_dimensions: parse(r.enabled_dimensions_json, ["pricing", "rfp", "local_marketing"] as Dimension[]),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const DEFAULT_MARKUP = 40;
const DEFAULT_TARGET_MARGIN = 0.3;

export class BusinessSkillsPackService {

  // ═══════════════ Config CRUD ═══════════════

  /** Retorna a config da org. Null se não existe ainda. */
  static getOrgConfig(orgId: string): OrgBspConfig | null {
    if (!orgId) return null;
    const row = db.prepare(
      "SELECT * FROM business_skills_pack_org_config WHERE organization_id = ?"
    ).get(orgId) as OrgConfigRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  /**
   * Upsert de patch parcial. Cria a linha se não existe.
   * Retorna a config atualizada.
   */
  static updateOrgConfig(orgId: string, patch: {
    pricing_prefs?: PricingPrefs | null;
    quote_template?: any | null;
    outreach_pack?: any | null;
    enabled_dimensions?: Dimension[];
  }): OrgBspConfig {
    if (!orgId) throw new BusinessSkillsPackError("missing_org", "orgId é obrigatório");

    const current = this.getOrgConfig(orgId);
    if (!current) {
      db.prepare(
        "INSERT INTO business_skills_pack_org_config (organization_id) VALUES (?)"
      ).run(orgId);
    }

    const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
    const params: any[] = [];
    if (Object.prototype.hasOwnProperty.call(patch, "pricing_prefs")) {
      sets.push("pricing_prefs_json = ?");
      params.push(patch.pricing_prefs == null ? null : JSON.stringify(patch.pricing_prefs));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "quote_template")) {
      sets.push("quote_template_json = ?");
      params.push(patch.quote_template == null ? null : JSON.stringify(patch.quote_template));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "outreach_pack")) {
      sets.push("outreach_pack_json = ?");
      params.push(patch.outreach_pack == null ? null : JSON.stringify(patch.outreach_pack));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "enabled_dimensions")) {
      const dims = Array.isArray(patch.enabled_dimensions)
        ? patch.enabled_dimensions.filter(d => (DIMENSIONS as readonly string[]).includes(d))
        : [];
      sets.push("enabled_dimensions_json = ?");
      params.push(JSON.stringify(dims));
    }

    params.push(orgId);
    db.prepare(
      `UPDATE business_skills_pack_org_config SET ${sets.join(", ")}
        WHERE organization_id = ?`
    ).run(...params);

    return this.getOrgConfig(orgId)!;
  }

  // ═══════════════ suggestPrice (F1) ═══════════════

  /**
   * Sugere preço de venda de um item baseado no custo + vertical.
   * Não busca custo do inventory — o caller passa `cost` explicitamente
   * (mantém o service determinístico e sem dependência transversal).
   *
   * Adapter map por vertical (ADR-195 D1):
   *   retail, loja_virtual → pricing.ts.suggestSalePrice (markup + psycho round)
   *   comigo, falatu       → ComigoPricingService.suggestPrice (target margin)
   *   default (fallback)   → markup 40% + psycho round
   *
   * Overrides do `pricing_prefs_json` da org têm prioridade sobre defaults.
   */
  static suggestPrice(input: {
    orgId: string;
    cost: number;
    vertical?: string;
    markup_percent?: number;         // override explícito acima do config
    target_margin?: number;          // override explícito acima do config
  }): PricingSuggestion {
    if (!input.orgId) {
      throw new BusinessSkillsPackError("missing_org", "orgId é obrigatório");
    }
    if (typeof input.cost !== "number" || !isFinite(input.cost)) {
      throw new BusinessSkillsPackError("invalid_cost", "cost deve ser um número finito");
    }
    if (input.cost < 0) {
      throw new BusinessSkillsPackError("invalid_cost", "cost não pode ser negativo");
    }

    const vertical = (input.vertical || "default").toLowerCase();
    const config = this.getOrgConfig(input.orgId);
    const prefs: PricingPrefs = config?.pricing_prefs || {};

    // Resolução dos parâmetros (input > prefs > default)
    const markup = input.markup_percent ?? prefs.markup_percent ?? DEFAULT_MARKUP;
    const targetMargin = input.target_margin ?? prefs.target_margin ?? DEFAULT_TARGET_MARGIN;

    // Adapter map
    let suggestion: PricingSuggestion;
    switch (vertical) {
      case "retail":
      case "loja_virtual":
      case "beauty":
      case "clinic": {
        const price = suggestSalePrice(input.cost, markup);
        suggestion = {
          suggested_price: price,
          floor_price: null,
          ceiling_price: null,
          method: "markup_psycho",
          reasoning: `Markup ${markup}% + arredondamento psicológico`,
          adapter: "pricing.ts",
          markup_percent_used: markup,
        };
        break;
      }
      case "comigo":
      case "falatu":
      case "advocacia": {
        const result = ComigoPricingService.suggestPrice(input.cost, targetMargin);
        suggestion = {
          suggested_price: result.price,
          floor_price: null,
          ceiling_price: null,
          method: "comigo_margin",
          reasoning: `Margem alvo ${(targetMargin * 100).toFixed(0)}%`,
          adapter: "ComigoPricingService",
          target_margin_used: targetMargin,
        };
        break;
      }
      default: {
        const price = suggestSalePrice(input.cost, DEFAULT_MARKUP);
        suggestion = {
          suggested_price: price,
          floor_price: null,
          ceiling_price: null,
          method: "default_markup40",
          reasoning: `Vertical "${vertical}" sem adapter específico — markup padrão 40%`,
          adapter: "default",
          markup_percent_used: DEFAULT_MARKUP,
        };
      }
    }

    // Aplica floor/ceiling se configurados
    if (prefs.floor_multiplier && input.cost > 0) {
      suggestion.floor_price = Math.round(input.cost * prefs.floor_multiplier * 100) / 100;
    }
    if (prefs.ceiling_multiplier && input.cost > 0) {
      suggestion.ceiling_price = Math.round(input.cost * prefs.ceiling_multiplier * 100) / 100;
    }

    return suggestion;
  }
}
