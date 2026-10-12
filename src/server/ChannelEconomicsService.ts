import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailPosFeeService } from "./RetailPosFeeService.js";
import { RetailCommissionService } from "./RetailCommissionService.js";

/**
 * Economia por canal — FACHADA READ-ONLY (ADR-207 F6): quanto sobra de cada venda na loja física × na loja virtual e
 * qual o MAIOR desconto que ainda respeita o piso do dono ("desconto máximo seguro").
 *
 * É instrumento de DECISÃO, não contabilidade (RN-ECO-05/06): a margem mensal continua sendo a DRE. Não cria preço,
 * cupom, frete nem ação — só calcula e explica. Aplicar o desconto num cupom é fatia futura, governada.
 *
 * Margem de CONTRIBUIÇÃO (não bruta, não "fully loaded"): preço líquido − custo da peça − custos VARIÁVEIS do canal.
 *   Aluguel/folha fixa NÃO entram: para decidir um desconto vale o custo incremental da venda; rateio de fixo é do relatório.
 *   Custos variáveis: % do preço líquido (imposto, taxa de cartão/Pix, comissão) + R$ por venda (embalagem, tarifa fixa).
 *   O desconto reduz o preço líquido E, junto, o que se paga de % — por isso a fórmula é fechada, não "margem − desconto".
 *
 * REGRAS (testadas):
 *  - Custo da peça ausente = qualidade INSUFICIENTE: sem margem, sem desconto seguro (RN-ECO-02/03) — nunca inventa custo.
 *  - Componente de custo do canal não informado pelo dono = 'missing' (≠ 0): qualidade PARCIAL, a margem sai marcada como
 *    teto (upperBound) e o desconto NUNCA é chamado de "seguro" (RN-ECO-08: não dá pra garantir o piso sem saber o custo).
 *  - Sem piso informado pelo dono não há desconto seguro: não inventamos um piso (o "reason" diz o que falta).
 *  - Custos físicos NÃO são duplicados aqui: vêm de retail_store_variable_costs / pos_fee_rules / commission_rules.
 *    Comissão só entra quando é % simples sobre vendas; faixa/cota/fixa/por vendedor = 'não modelada' (parcial).
 *  - Nenhum LLM calcula nada (RN-ECO-01). Dinheiro: as rotas são do dono/admin.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const MAX_PRODUCTS = 1000;

export type Channel = "physical" | "online";
export type Quality = "reliable" | "partial" | "insufficient";

export interface CostComponent { key: string; label: string; percent: number; fixed: number; origin: "configured" | "missing" | "no_rule" | "not_modeled"; note?: string }
export interface CostModel { components: CostComponent[]; variablePercent: number; fixedPerSale: number; missing: string[]; notModeled: string[] }

// ── Cálculo PURO (sem banco) ───────────────────────────────────────────────────────────────────────────────────────
/** Contribuição de uma venda unitária com `discountPct` de desconto. null quando faltar preço/custo. */
export function contributionAt(price: number, unitCost: number | null, model: Pick<CostModel, "variablePercent" | "fixedPerSale">, discountPct = 0) {
  if (!(price > 0) || unitCost == null) return { net: null as number | null, amount: null as number | null, percent: null as number | null };
  const net = price * (1 - discountPct / 100);
  const amount = net - unitCost - (net * model.variablePercent / 100 + model.fixedPerSale);
  return { net: round2(net), amount: round2(amount), percent: net > 0 ? Math.round((amount / net) * 1000) / 10 : null };
}

/**
 * Maior desconto (em %, arredondado PARA BAIXO a 0,1) que mantém a contribuição ≥ piso do preço líquido.
 *   net·(1 − v − piso) ≥ custo + fixo  →  net ≥ (custo+fixo)/(1−v−piso).
 */
export function maxDiscountPct(price: number, unitCost: number, model: Pick<CostModel, "variablePercent" | "fixedPerSale">, floorPct: number):
  { percent: number; state: "ok" | "price_below_floor" | "floor_unreachable" } {
  const k = 1 - model.variablePercent / 100 - floorPct / 100;
  // Tolerância: em ponto flutuante 1 − 0,7 − 0,3 dá 5,5e-17 (não 0) e o piso "inalcançável" passaria como alcançável.
  if (!(k > 1e-9)) return { percent: 0, state: "floor_unreachable" };      // custos % + piso já passam de 100% do preço
  const netMin = (unitCost + model.fixedPerSale) / k;
  if (netMin > price) return { percent: 0, state: "price_below_floor" };    // o preço cheio já não cobre o piso
  return { percent: Math.floor((1 - netMin / price) * 1000) / 10, state: "ok" };
}

export class ChannelEconomicsService {
  // ── Configuração do dono ──────────────────────────────────────────────────────────────────────────────────────────
  static settings(orgId: string) {
    const r = db.prepare("SELECT * FROM channel_economics_settings WHERE organization_id = ?").get(orgId) as any;
    return {
      floorPercent: num(r?.floor_percent), online: {
        taxPercent: num(r?.online_tax_percent), paymentFeePercent: num(r?.online_payment_fee_percent),
        paymentFeeFixed: num(r?.online_payment_fee_fixed), packagingFixed: num(r?.online_packaging_fixed),
      },
      updatedAt: r?.updated_at || null,
    };
  }

  /** Só grava o que veio; `null` limpa (volta a "não informado"). Valor inválido é erro — nunca vira 0 em silêncio. */
  static saveSettings(orgId: string, patch: { floorPercent?: number | null; online?: { taxPercent?: number | null; paymentFeePercent?: number | null; paymentFeeFixed?: number | null; packagingFixed?: number | null } }, actorId?: string) {
    const cols: Record<string, number | null> = {};
    const take = (col: string, v: any, max: number, label: string) => {
      if (v === undefined) return;
      if (v === null) { cols[col] = null; return; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} inválido (0 a ${max}).`);
      cols[col] = n;
    };
    take("floor_percent", patch.floorPercent, 95, "Margem mínima");
    take("online_tax_percent", patch.online?.taxPercent, 60, "Imposto");
    take("online_payment_fee_percent", patch.online?.paymentFeePercent, 30, "Taxa de pagamento");
    take("online_payment_fee_fixed", patch.online?.paymentFeeFixed, 1000, "Tarifa fixa de pagamento");
    take("online_packaging_fixed", patch.online?.packagingFixed, 1000, "Embalagem");
    const keys = Object.keys(cols);
    if (keys.length) {
      db.prepare("INSERT OR IGNORE INTO channel_economics_settings (organization_id) VALUES (?)").run(orgId);
      db.prepare(`UPDATE channel_economics_settings SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
        .run(...keys.map((k) => cols[k]), actorId || null, orgId);
      try { logAuthEvent(orgId, actorId || "system", orgId, "CHANNEL_ECONOMICS_SETTINGS", { fields: keys }); } catch { /* noop */ }
    }
    return this.settings(orgId);
  }

  // ── Fontes de custo ───────────────────────────────────────────────────────────────────────────────────────────────
  /** Custo unitário da peça: linha base com custo médio > 0 = fato; só variações = o MAIOR custo (conservador, estimativa). */
  static unitCost(orgId: string, productId: string): { value: number | null; basis: "fact" | "estimate" | null } {
    const base = db.prepare("SELECT avg_cost FROM inventory_items WHERE organization_id = ? AND product_service_id = ? AND variant_id IS NULL").get(orgId, productId) as any;
    if (Number(base?.avg_cost) > 0) return { value: round2(Number(base.avg_cost)), basis: "fact" };
    const v = db.prepare("SELECT MAX(avg_cost) m FROM inventory_items WHERE organization_id = ? AND product_service_id = ? AND variant_id IS NOT NULL AND COALESCE(avg_cost,0) > 0").get(orgId, productId) as any;
    if (Number(v?.m) > 0) return { value: round2(Number(v.m)), basis: "estimate" };
    return { value: null, basis: null };
  }

  /** Modelo de custos variáveis do canal. Físico: vem do cadastro da LOJA. Online: do que o dono informou aqui. */
  static costModel(orgId: string, channel: Channel, storeId?: string | null): CostModel {
    const comps: CostComponent[] = [];
    if (channel === "online") {
      const o = this.settings(orgId).online;
      const comp = (key: string, label: string, pct: number | null, fixed: number | null): CostComponent =>
        pct == null && fixed == null ? { key, label, percent: 0, fixed: 0, origin: "missing" } : { key, label, percent: pct ?? 0, fixed: fixed ?? 0, origin: "configured" };
      comps.push(comp("tax_sale", "Imposto sobre a venda", o.taxPercent, null));
      comps.push(comp("payment_fee", "Taxa de pagamento (Pix/cartão)", o.paymentFeePercent, o.paymentFeeFixed));
      comps.push(comp("packaging", "Embalagem", null, o.packagingFixed));
      // Frete subsidiado entra na F7; hoje a loja não subsidia frete — não é custo desconhecido, é "ainda não existe".
    } else {
      if (!storeId) throw new Error("Informe a loja física.");
      const rows = db.prepare("SELECT category, percent, fixed_per_sale FROM retail_store_variable_costs WHERE organization_id = ? AND store_id = ?").all(orgId, storeId) as any[];
      const byCat = new Map(rows.map((r) => [r.category as string, r]));
      const row = (key: string, label: string): CostComponent => {
        const r = byCat.get(key);
        return r ? { key, label, percent: Number(r.percent) || 0, fixed: Number(r.fixed_per_sale) || 0, origin: "configured" } : { key, label, percent: 0, fixed: 0, origin: "missing" };
      };
      comps.push(row("tax_sale", "Imposto sobre a venda"));
      // Tarifa de cartão: a regra DETALHADA (crédito/débito) substitui a agregada (nunca soma as duas). Sem saber o mix
      // crédito×débito, usa a MAIOR taxa (conservador) e avisa.
      const pos = RetailPosFeeService.rules(orgId, storeId);
      if (pos.hasDetailed) {
        const rules = [pos.credit, pos.debit].filter(Boolean);
        const worst = rules.reduce((a: any, b: any) => (b.percent + b.fixedPerTransaction > a.percent + a.fixedPerTransaction ? b : a));
        comps.push({ key: "card_fee", label: "Taxa de cartão", percent: worst.percent, fixed: worst.fixedPerTransaction, origin: "configured", note: "Usei a maior taxa entre crédito e débito (o mix de pagamento não é conhecido)." });
      } else comps.push(row("card_fee", "Taxa de cartão"));
      for (const [k, l] of [["pix_fee", "Taxa de Pix"], ["packaging", "Embalagem"], ["other", "Outros variáveis"]] as const) {
        const r = byCat.get(k);
        if (r) comps.push({ key: k, label: l, percent: Number(r.percent) || 0, fixed: Number(r.fixed_per_sale) || 0, origin: "configured" });
      }
      // Comissão: só % simples sobre vendas é modelada.
      const rules = (RetailCommissionService.listRules(orgId) as any[]).filter((r) => r.active && (r.scope === "store" || r.scope === "global") && (!r.store_id || r.store_id === storeId));
      const specific = rules.filter((r) => r.store_id === storeId);
      const eff = specific.length ? specific : rules.filter((r) => !r.store_id);
      const other = (RetailCommissionService.listRules(orgId) as any[]).filter((r) => r.active && (r.scope === "seller" || r.scope === "product"));
      if (!eff.length && !other.length) comps.push({ key: "commission", label: "Comissão", percent: 0, fixed: 0, origin: "no_rule", note: "Nenhuma regra de comissão ativa." });
      else if (other.length || eff.some((r) => r.calculation_type !== "percent_sales")) comps.push({ key: "commission", label: "Comissão", percent: 0, fixed: 0, origin: "not_modeled", note: "Há regra de comissão por faixa/cota/valor fixo/vendedor — não entra neste cálculo." });
      else {
        let pct = 0; for (const r of eff) { try { pct += Number(JSON.parse(r.config_json || "{}").percent) || 0; } catch { /* noop */ } }
        comps.push({ key: "commission", label: "Comissão", percent: pct, fixed: 0, origin: "configured" });
      }
    }
    const used = comps.filter((c) => c.origin === "configured");
    return {
      components: comps,
      variablePercent: round2(used.reduce((a, c) => a + c.percent, 0)),
      fixedPerSale: round2(used.reduce((a, c) => a + c.fixed, 0)),
      missing: comps.filter((c) => c.origin === "missing").map((c) => c.label),
      notModeled: comps.filter((c) => c.origin === "not_modeled").map((c) => c.label),
    };
  }

  // ── Produto × canal ───────────────────────────────────────────────────────────────────────────────────────────────
  private static product(orgId: string, productId: string) {
    return db.prepare("SELECT id, name, price FROM products_services WHERE id = ? AND organization_id = ? AND active = 1 AND type = 'product'").get(productId, orgId) as any;
  }

  /** Resolve a loja física de referência: a pedida; ou a única da empresa; várias e nenhuma pedida → pede para escolher. */
  static physicalStore(orgId: string, storeId?: string | null): { storeId: string | null; stores: Array<{ id: string; name: string }>; storeName?: string } {
    const stores = db.prepare("SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
    if (storeId) { const s = stores.find((x) => x.id === storeId); return { storeId: s ? s.id : null, stores, storeName: s?.name }; }
    return stores.length === 1 ? { storeId: stores[0].id, stores, storeName: stores[0].name } : { storeId: null, stores };
  }

  static productEconomics(orgId: string, productId: string, channel: Channel, storeId?: string | null) {
    const p = this.product(orgId, productId);
    if (!p) return null;
    const price = round2(Number(p.price) || 0);
    const cost = this.unitCost(orgId, productId);
    let model: CostModel | null = null, storeInfo: any = null;
    if (channel === "physical") {
      storeInfo = this.physicalStore(orgId, storeId);
      if (storeInfo.storeId) model = this.costModel(orgId, "physical", storeInfo.storeId);
    } else model = this.costModel(orgId, "online");

    const missing: string[] = [];
    if (cost.value == null) missing.push("custo da peça");
    if (!(price > 0)) missing.push("preço de venda");
    if (!model) missing.push("loja física");
    else missing.push(...model.missing);
    const quality: Quality = cost.value == null || !(price > 0) || !model ? "insufficient" : (missing.length || model.notModeled.length ? "partial" : "reliable");
    const floorPercent = this.settings(orgId).floorPercent;
    const c = model && quality !== "insufficient" ? contributionAt(price, cost.value, model, 0) : { net: null, amount: null, percent: null };
    return {
      productId: p.id, name: p.name, channel, storeId: storeInfo?.storeId ?? null, storeName: storeInfo?.storeName ?? null,
      stores: channel === "physical" ? storeInfo.stores : undefined,
      price, unitCost: cost, floorPercent,
      components: model?.components ?? [], variablePercent: model?.variablePercent ?? null, fixedPerSale: model?.fixedPerSale ?? null,
      contribution: { amount: c.amount, percent: c.percent, upperBound: quality === "partial" && c.amount != null },
      quality, missing: Array.from(new Set(missing)), notModeled: model?.notModeled ?? [],
      note: "Margem de CONTRIBUIÇÃO (preço − custo da peça − custos variáveis do canal). Aluguel e folha fixa não entram — para decidir um desconto vale o custo da própria venda.",
    };
  }

  /** Físico × online lado a lado + a diferença (o "espaço comercial"). Diferença só com os dois lados conhecidos. */
  static compare(orgId: string, productId: string, storeId?: string | null) {
    const physical = this.productEconomics(orgId, productId, "physical", storeId);
    const online = this.productEconomics(orgId, productId, "online");
    if (!physical || !online) return null;
    const both = physical.contribution.amount != null && online.contribution.amount != null;
    return {
      physical, online,
      difference: both ? { amount: round2(online.contribution.amount! - physical.contribution.amount!), percentPoints: Math.round((online.contribution.percent! - physical.contribution.percent!) * 10) / 10, upperBound: physical.contribution.upperBound || online.contribution.upperBound } : null,
    };
  }

  /**
   * Desconto MÁXIMO SEGURO de um produto num canal. `status`:
   *  - safe: dado confiável + piso informado → o número respeita o piso (RN-ECO-08).
   *  - upper_bound: falta custo do canal → é só um TETO; NÃO é "seguro".
   *  - unavailable: sem custo da peça / sem piso / piso inalcançável — `reason` diz o quê.
   */
  static safeDiscount(orgId: string, productId: string, channel: Channel, storeId?: string | null) {
    const e = this.productEconomics(orgId, productId, channel, storeId);
    if (!e) return null;
    const base = { productId, name: e.name, channel, storeId: e.storeId, price: e.price, quality: e.quality, missing: e.missing, floorPercent: e.floorPercent };
    if (e.quality === "insufficient") return { ...base, status: "unavailable" as const, maxPercent: null, reason: e.missing.length ? `Falta: ${e.missing.join(", ")}.` : "Dados insuficientes.", scenarios: [] };
    if (e.floorPercent == null) return { ...base, status: "unavailable" as const, maxPercent: null, reason: "Defina a margem mínima que você aceita para calcular o desconto seguro.", scenarios: [] };
    const model = { variablePercent: e.variablePercent!, fixedPerSale: e.fixedPerSale! };
    const m = maxDiscountPct(e.price, e.unitCost.value!, model, e.floorPercent);
    const scenarios = [0, 5, 10, 15, 20, 25, 30].map((d) => {
      const c = contributionAt(e.price, e.unitCost.value, model, d);
      return { discountPercent: d, net: c.net, contribution: c.amount, contributionPercent: c.percent, aboveFloor: c.percent != null && c.percent >= e.floorPercent! };
    });
    const reason = m.state === "floor_unreachable" ? "Os custos e a margem mínima somam mais de 100% do preço: nenhum preço cobre o piso."
      : m.state === "price_below_floor" ? "Mesmo sem desconto, este preço já fica abaixo da sua margem mínima." : null;
    return { ...base, status: e.quality === "reliable" ? ("safe" as const) : ("upper_bound" as const), maxPercent: m.percent, state: m.state, reason, scenarios,
      caveat: e.quality === "partial" ? `Falta informar: ${[...e.missing, ...e.notModeled].join(", ")}. O número é um TETO, não uma garantia.` : null };
  }

  /**
   * Contribuição de um PEDIDO online inteiro (preços e desconto REAIS do checkout). Custos fixos por venda (embalagem, tarifa)
   * contam UMA vez por pedido — não por peça. Só `reliable` quando TODA peça tem custo conhecido e o custo do canal está completo;
   * item sem produto vinculado (peso/volume) ou sem custo → `insufficient` (não dá pra provar nada sobre a margem do pedido).
   */
  static orderContribution(orgId: string, items: Array<{ productId: string | null; qty: number; unitPrice: number }>, discountAmount = 0) {
    const model = this.costModel(orgId, "online");
    const gross = items.reduce((a, i) => a + i.unitPrice * i.qty, 0);
    const net = gross - Math.max(0, discountAmount);
    const missing: string[] = [];
    let cost = 0;
    for (const it of items) {
      const c = it.productId ? this.unitCost(orgId, it.productId) : { value: null as number | null };
      if (c.value == null) { if (!missing.includes("custo da peça")) missing.push("custo da peça"); continue; }
      cost += c.value * it.qty;
    }
    missing.push(...model.missing);
    const quality: Quality = !items.length || !(net > 0) || missing.includes("custo da peça") ? "insufficient" : (missing.length || model.notModeled.length ? "partial" : "reliable");
    if (quality === "insufficient") return { quality, net: round2(net), contribution: null as number | null, percent: null as number | null, missing };
    const contribution = net - cost - net * model.variablePercent / 100 - model.fixedPerSale;
    return { quality, net: round2(net), contribution: round2(contribution), percent: Math.round((contribution / net) * 1000) / 10, missing };
  }

  /**
   * "Posso dar 20% no catálogo?" — classifica cada produto ativo para um desconto PERCENTUAL (ou valor fixo, convertido em % pelo preço
   * de cada produto) no canal online (cupons são da loja virtual). Read-only: não cria cupom.
   */
  static couponCheck(orgId: string, input: { type: "percent" | "fixed"; value: number }, opts: { productIds?: string[] } = {}) {
    const value = Number(input.value);
    if (!(value > 0) || (input.type === "percent" ? value >= 100 : false)) throw new Error("Informe um desconto válido.");
    const rows = (opts.productIds?.length
      ? db.prepare(`SELECT id FROM products_services WHERE organization_id = ? AND active = 1 AND type = 'product' AND id IN (${opts.productIds.map(() => "?").join(",")}) LIMIT ${MAX_PRODUCTS}`).all(orgId, ...opts.productIds)
      : db.prepare(`SELECT id FROM products_services WHERE organization_id = ? AND active = 1 AND type = 'product' AND COALESCE(storefront_visible,1) = 1 ORDER BY name LIMIT ${MAX_PRODUCTS}`).all(orgId)) as any[];
    const buckets: Record<"supports" | "partial" | "below" | "unconfirmed" | "unknown", any[]> = { supports: [], partial: [], below: [], unconfirmed: [], unknown: [] };
    const floorSet = this.settings(orgId).floorPercent != null;
    for (const r of rows) {
      const s = this.safeDiscount(orgId, r.id, "online");
      if (!s) continue;
      const asked = input.type === "percent" ? value : (s.price > 0 ? Math.round((value / s.price) * 1000) / 10 : 100);
      const item = { productId: s.productId, name: s.name, askedPercent: asked, maxPercent: s.maxPercent };
      if (s.status === "unavailable") buckets.unknown.push({ ...item, reason: s.reason });
      else if (s.status === "upper_bound") buckets.unconfirmed.push(item);
      else if (s.maxPercent! >= asked) buckets.supports.push(item);
      else if (s.maxPercent! > 0) buckets.partial.push(item);
      else buckets.below.push(item);
    }
    const cap = (a: any[]) => a.slice(0, 20);
    return {
      type: input.type, value, evaluated: rows.length, floorSet,
      counts: { supports: buckets.supports.length, supportsLess: buckets.partial.length, belowFloor: buckets.below.length, unconfirmed: buckets.unconfirmed.length, unknown: buckets.unknown.length },
      examples: { supports: cap(buckets.supports), supportsLess: cap(buckets.partial.sort((a, b) => b.maxPercent - a.maxPercent)), belowFloor: cap(buckets.below), unconfirmed: cap(buckets.unconfirmed), unknown: cap(buckets.unknown) },
      note: floorSet ? "Só os de 'suportam' estão dentro da sua margem mínima COM dados confiáveis. 'Teto' e 'sem dados' não são garantia." : "Defina a margem mínima para o cálculo ter o que respeitar.",
    };
  }

  /** Qualidade do dado: o quanto dá pra confiar nas contas acima. Limiares (90%/30%) são heurística, não calibrada. */
  static dataQuality(orgId: string, storeId?: string | null) {
    const ps = db.prepare("SELECT id FROM products_services WHERE organization_id = ? AND active = 1 AND type = 'product'").all(orgId) as any[];
    let withCost = 0;
    for (const p of ps) if (this.unitCost(orgId, p.id).value != null) withCost++;
    const coveragePct = ps.length ? Math.round((withCost / ps.length) * 1000) / 10 : null;
    const online = this.costModel(orgId, "online");
    const st = this.physicalStore(orgId, storeId);
    const physical = st.storeId ? this.costModel(orgId, "physical", st.storeId) : null;
    const settings = this.settings(orgId);
    const gaps: string[] = [];
    if (coveragePct == null) gaps.push("nenhum produto ativo cadastrado");
    else if (withCost < ps.length) gaps.push(`${ps.length - withCost} de ${ps.length} produtos sem custo`);
    if (online.missing.length) gaps.push(`custo do canal online sem informar: ${online.missing.join(", ")}`);
    if (settings.floorPercent == null) gaps.push("margem mínima não definida");
    if (!st.storeId) gaps.push(st.stores.length ? "escolha a loja física de referência" : "nenhuma loja física cadastrada");
    else if (physical!.missing.length) gaps.push(`custo da loja física sem informar: ${physical!.missing.join(", ")}`);
    const status: Quality = coveragePct == null || coveragePct < 30 ? "insufficient" : (coveragePct >= 90 && !online.missing.length && settings.floorPercent != null ? "reliable" : "partial");
    return {
      status, products: ps.length, withCost, coveragePct, floorSet: settings.floorPercent != null,
      online: { missing: online.missing }, physical: physical ? { storeId: st.storeId, storeName: st.storeName, missing: physical.missing, notModeled: physical.notModeled } : { storeId: null, stores: st.stores },
      gaps, note: "🟢 confiável · 🟡 parcial · 🔴 insuficiente. Limiares de cobertura (90% / 30%) são uma heurística, ainda não calibrada com dados reais.",
    };
  }
}

export default ChannelEconomicsService;
