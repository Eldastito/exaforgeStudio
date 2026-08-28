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
import { QuoteService } from "./QuoteService.js";

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

// F2 — RFP: templates de orçamento
export interface QuoteTemplate {
  header?: string;                  // texto no topo (aceita {{placeholders}})
  greeting?: string;                // linha de saudação
  footer?: string;                  // rodapé
  conditions?: string[];            // bullets de condições
  signature?: string;               // assinatura
}

// Template default quando a org não configurou o próprio.
export const DEFAULT_QUOTE_TEMPLATE: QuoteTemplate = {
  header: "*Orçamento — {{org_name}}*",
  greeting: "Olá{{contact_line}}!",
  footer: "Válido até {{valid_until}}. Aguardo seu retorno.",
  conditions: ["Prazo de entrega: 5 dias úteis", "Pagamento: PIX ou boleto"],
  signature: "Equipe {{org_name}}",
};

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

// F4 — Gate de plano (RN-BSP-08).
// Feature flag global de soft launch: durante bake-in, o gate é bypassado pra
// qualquer org testar. Env var `BSP_SOFT_LAUNCH`:
//   - undefined/"1"/"true" → soft launch ON (default; gate desligado)
//   - "0"/"false"          → soft launch OFF (gate ligado; enabled_dimensions vale)
const readSoftLaunch = (): boolean => {
  const v = (process.env.BSP_SOFT_LAUNCH ?? "1").toString().toLowerCase();
  return v !== "0" && v !== "false";
};

export interface BspAccessCheck {
  allowed: boolean;
  code?: "soft_launch_disabled" | "dimension_disabled" | "missing_org";
  reason?: string;
  soft_launch: boolean;
}

export class BusinessSkillsPackService {

  // ═══════════════ Gate de plano (F4) ═══════════════

  /**
   * Estado atual do soft launch. Lido a cada chamada — testes conseguem
   * mexer no env var sem restart.
   */
  static isSoftLaunch(): boolean {
    return readSoftLaunch();
  }

  /**
   * Verifica se a org pode usar o BSP (opcionalmente uma dimensão específica).
   * Regras:
   *  - Soft launch ON → sempre allowed (bake-in).
   *  - Soft launch OFF + orgId vazio → missing_org.
   *  - Soft launch OFF + config null → default (todas as 3 dimensões ligadas),
   *    pra novo cliente não ficar trancado na primeira request.
   *  - Soft launch OFF + dimension informada → allowed se `enabled_dimensions`
   *    inclui a dimensão.
   *  - Soft launch OFF + dimension nula → allowed se `enabled_dimensions` não
   *    está vazio (pelo menos uma dimensão ligada).
   */
  static checkAccess(orgId: string, dimension?: Dimension): BspAccessCheck {
    const softLaunch = this.isSoftLaunch();
    if (softLaunch) return { allowed: true, soft_launch: true };

    if (!orgId) {
      return { allowed: false, code: "missing_org", reason: "orgId é obrigatório", soft_launch: false };
    }

    const config = this.getOrgConfig(orgId);
    const enabled = config?.enabled_dimensions
      ?? ([...DIMENSIONS] as Dimension[]);

    if (dimension && !enabled.includes(dimension)) {
      return {
        allowed: false,
        code: "dimension_disabled",
        reason: `Dimensão "${dimension}" desligada para a organização`,
        soft_launch: false,
      };
    }

    if (!dimension && enabled.length === 0) {
      return {
        allowed: false,
        code: "dimension_disabled",
        reason: "Nenhuma dimensão do BSP está habilitada para a organização",
        soft_launch: false,
      };
    }

    return { allowed: true, soft_launch: false };
  }

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

  // ═══════════════ RFP (F2) — templates de orçamento ═══════════════

  /**
   * Retorna o template de orçamento da org, ou DEFAULT_QUOTE_TEMPLATE
   * se não configurado. Sempre retorna algo — nunca null.
   */
  static getQuoteTemplate(orgId: string): QuoteTemplate {
    if (!orgId) return { ...DEFAULT_QUOTE_TEMPLATE };
    const config = this.getOrgConfig(orgId);
    const template = config?.quote_template as QuoteTemplate | null;
    if (!template) return { ...DEFAULT_QUOTE_TEMPLATE };
    // Merge com default pra garantir todos os campos
    return { ...DEFAULT_QUOTE_TEMPLATE, ...template };
  }

  /**
   * Renderiza texto com placeholders `{{var}}` substituídos por context[var].
   * Placeholders desconhecidos viram string vazia. Escape mínimo: apenas
   * remove backticks e HTML tags do INPUT (não do template — template é
   * confiável, controlado pela org). Isso é intencional: templates são
   * texto plano (WhatsApp/PDF), não HTML.
   */
  static renderTemplateString(template: string, context: Record<string, string>): string {
    if (!template) return "";
    // Escape simples do valor do context: remove HTML tags e backticks
    // (WhatsApp usa markdown simples; deixamos passar * _ ~).
    const sanitize = (v: any): string => {
      if (v == null) return "";
      return String(v).replace(/<[^>]*>/g, "").replace(/`/g, "'");
    };
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return context[key] !== undefined ? sanitize(context[key]) : "";
    });
  }

  /**
   * Compõe um orçamento completo a partir do template configurado.
   * Delega pra `QuoteService.buildAndSave` (que persiste em `quotes`) e
   * concatena o texto do template ao redor.
   *
   * Contexto disponível nos placeholders:
   *   {{org_name}}, {{contact_name}}, {{contact_line}}, {{valid_until}},
   *   {{total}}, {{item_count}}
   */
  static createQuoteFromTemplate(input: {
    orgId: string;
    items: any[];
    contactId?: string;
    ticketId?: string;
    createdBy?: string;
    contactName?: string;
    orgName?: string;
    templateOverrides?: Partial<QuoteTemplate>;
  }): {
    quote_id: string;
    rendered_text: string;
    total: number;
    item_count: number;
  } {
    if (!input.orgId) throw new BusinessSkillsPackError("missing_org", "orgId é obrigatório");
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BusinessSkillsPackError("missing_items", "items é obrigatório");
    }

    const base = this.getQuoteTemplate(input.orgId);
    const template: QuoteTemplate = { ...base, ...(input.templateOverrides || {}) };

    // Persiste o quote via QuoteService (reuso — RN-BSP-02).
    const built = QuoteService.buildAndSave(input.orgId, input.items, {
      contactId: input.contactId,
      ticketId: input.ticketId,
      createdBy: input.createdBy,
    });
    if (!built) {
      throw new BusinessSkillsPackError("quote_failed", "Falha ao construir orçamento (itens inválidos ou catálogo vazio)");
    }

    // Contexto pros placeholders
    const validityHours = QuoteService.validityHours(input.orgId);
    const validUntil = new Date(Date.now() + validityHours * 3600 * 1000)
      .toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    const context: Record<string, string> = {
      org_name: input.orgName || "sua marca",
      contact_name: input.contactName || "",
      contact_line: input.contactName ? ` ${input.contactName}` : "",
      valid_until: validUntil,
      total: `R$ ${built.total.toFixed(2).replace(".", ",")}`,
      item_count: String(built.itemCount),
    };

    // Compõe texto final: header, greeting, quote_text (do QuoteService),
    // condições, footer, signature. Cada parte só entra se estiver
    // preenchida.
    const parts: string[] = [];
    if (template.header) parts.push(this.renderTemplateString(template.header, context));
    if (template.greeting) parts.push(this.renderTemplateString(template.greeting, context));
    parts.push(built.text);
    if (template.conditions && template.conditions.length > 0) {
      parts.push("*Condições:*\n" + template.conditions.map(c =>
        `• ${this.renderTemplateString(c, context)}`).join("\n"));
    }
    if (template.footer) parts.push(this.renderTemplateString(template.footer, context));
    if (template.signature) parts.push(this.renderTemplateString(template.signature, context));

    return {
      quote_id: built.id,
      rendered_text: parts.filter(Boolean).join("\n\n"),
      total: built.total,
      item_count: built.itemCount,
    };
  }

  // ═══════════════ Local Marketing (F3) — contact ↔ competitor ═══════════════

  /**
   * Cruza `contacts.identifier` × `competitor_accounts.handle` da mesma org e
   * persiste os matches em `bsp_contact_competitor_match`. Sinal-chave pra
   * Local Marketing: um contato do CRM cujo handle é um concorrente que a
   * org monitora vale outreach diferenciado.
   *
   * Case-insensitive. Multi-plataforma (não filtra por provider do canal —
   * um contato WhatsApp cujo `identifier` casa com um handle Instagram
   * monitorado ainda é sinal válido; o platform do competitor fica no
   * match pra o caller decidir).
   *
   * Idempotente: reroda o batch reinsere os mesmos matches sem duplicar
   * (INSERT OR IGNORE + PRIMARY KEY composta).
   */
  static enrichContactsWithCompetitor(orgId: string): {
    matched: number;
    contacts_checked: number;
    competitors_active: number;
  } {
    if (!orgId) throw new BusinessSkillsPackError("missing_org", "orgId é obrigatório");

    const contactsChecked = (db.prepare(
      "SELECT COUNT(*) c FROM contacts WHERE organization_id = ?"
    ).get(orgId) as any).c as number;

    const competitorsActive = (db.prepare(
      "SELECT COUNT(*) c FROM competitor_accounts WHERE organization_id = ? AND active = 1"
    ).get(orgId) as any).c as number;

    // Insert-or-ignore acumula matches idempotentemente. `matched_at` fica
    // do primeiro match; se quiser refresh, delete antes.
    const result = db.prepare(`
      INSERT OR IGNORE INTO bsp_contact_competitor_match (organization_id, contact_id, competitor_id)
      SELECT c.organization_id, c.id, ca.id
      FROM contacts c
      JOIN competitor_accounts ca
        ON ca.organization_id = c.organization_id
       AND ca.active = 1
       AND lower(c.identifier) = lower(ca.handle)
      WHERE c.organization_id = ?
    `).run(orgId);

    // matched total (não só o delta desta chamada) — o caller quer saber o
    // estado atual, não o "quantos foram novos".
    const matched = (db.prepare(
      "SELECT COUNT(*) c FROM bsp_contact_competitor_match WHERE organization_id = ?"
    ).get(orgId) as any).c as number;

    // silenciar warning de result não usado
    void result;

    return { matched, contacts_checked: contactsChecked, competitors_active: competitorsActive };
  }

  /**
   * Lista os matches contact↔competitor já persistidos, com detalhes de
   * cada lado. Usado pela UI de Local Marketing (F5) pra mostrar
   * "esses X contatos são concorrentes que você monitora".
   */
  static listContactCompetitorMatches(orgId: string, opts: { limit?: number } = {}): Array<{
    contact_id: string;
    contact_name: string | null;
    contact_identifier: string;
    competitor_id: string;
    competitor_handle: string;
    competitor_platform: string;
    competitor_display_name: string | null;
    matched_at: string;
  }> {
    if (!orgId) return [];
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    return db.prepare(`
      SELECT
        c.id AS contact_id,
        c.name AS contact_name,
        c.identifier AS contact_identifier,
        ca.id AS competitor_id,
        ca.handle AS competitor_handle,
        ca.platform AS competitor_platform,
        ca.display_name AS competitor_display_name,
        m.matched_at AS matched_at
      FROM bsp_contact_competitor_match m
      JOIN contacts c ON c.id = m.contact_id
      JOIN competitor_accounts ca ON ca.id = m.competitor_id
      WHERE m.organization_id = ?
      ORDER BY m.matched_at DESC
      LIMIT ?
    `).all(orgId, limit) as any[];
  }

  /** Lookup rápido: esse contact é um concorrente monitorado? */
  static isContactWatchedCompetitor(orgId: string, contactId: string): boolean {
    if (!orgId || !contactId) return false;
    const row = db.prepare(
      "SELECT 1 FROM bsp_contact_competitor_match WHERE organization_id = ? AND contact_id = ? LIMIT 1"
    ).get(orgId, contactId);
    return !!row;
  }

  /**
   * Métricas por vendedor (RN-BSP-05). Agrupa `quotes.created_by` na
   * janela `days` (default 30). Retorna [{agent, sent, accepted, declined,
   * conversion_rate}].
   */
  static salesMetricsByAgent(orgId: string, opts: { days?: number } = {}): Array<{
    agent: string;
    sent: number;
    accepted: number;
    declined: number;
    conversion_rate: number;
  }> {
    if (!orgId) return [];
    const days = Math.max(1, opts.days || 30);
    const rows = db.prepare(`
      SELECT
        COALESCE(created_by, 'unknown') AS agent,
        SUM(CASE WHEN status IN ('sent','viewed','accepted','declined','expired') THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined
      FROM quotes
      WHERE organization_id = ?
        AND sent_at >= datetime('now', '-' || ? || ' days')
      GROUP BY COALESCE(created_by, 'unknown')
      ORDER BY sent DESC, agent
    `).all(orgId, days) as Array<{ agent: string; sent: number; accepted: number; declined: number }>;
    return rows.map(r => ({
      agent: r.agent,
      sent: r.sent,
      accepted: r.accepted,
      declined: r.declined,
      conversion_rate: r.sent > 0 ? r.accepted / r.sent : 0,
    }));
  }
}
