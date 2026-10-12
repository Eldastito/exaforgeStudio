import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ChannelEconomicsService } from "./ChannelEconomicsService.js";

/**
 * Política de FRETE da Loja Virtual — regras DEFINIDAS PELO DONO (ADR-207 F7). Sem transportadora: a cotação por Correios/
 * Melhor Envio é fatia futura (depende de contrato). Aqui o dono diz quanto cobra; o ZapFlow só aplica e protege a margem.
 *
 *  - Retirada na loja nunca paga frete (F3). Só o pedido de ENTREGA passa por aqui.
 *  - Preço do frete: faixa de CEP que casa → senão valor fixo → senão "a combinar" (como era antes). Nunca bloqueia a venda:
 *    sem como calcular, o pedido segue exatamente como hoje, sem frete.
 *  - Frete GRÁTIS só com TRÊS provas juntas (RN-ECO-07, PRD §19 — "grátis acima de X" sozinho é regra proibida):
 *      1) pedido (já com desconto) ≥ valor mínimo do dono;
 *      2) o frete que a empresa absorveria ≤ teto de subsídio do dono (se definido);
 *      3) a contribuição do pedido, DEPOIS de absorver o frete, ainda respeita a margem mínima do dono (F6).
 *    Se o ZapFlow não consegue PROVAR a 3ª (custo ausente, custo do canal incompleto, sem margem mínima) → o cliente paga o
 *    frete normal. Nunca chuta que a margem aguenta.
 *  - O que a empresa absorve fica gravado no pedido (`shipping_absorbed`), para o custo não sumir.
 *  - Em branco ≠ zero: `shipping_amount` NULL = não calculado; 0 = grátis.
 *  - O motivo de não dar grátis é interno (dono): a resposta pública NÃO mostra margem nem custo.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_RANGES = 50;
const MAX_AMOUNT = 1000;

export interface ShippingRange { cepFrom: string; cepTo: string; amount: number; label?: string }
export type FreeReason = "applied" | "no_threshold" | "below_threshold" | "above_max_absorb" | "floor_not_set" | "economics_unconfirmed" | "would_break_floor" | "not_calculated";

export function normalizeCep(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length === 8 ? d : null;
}
const money = (v: any, label: string, max = MAX_AMOUNT): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} inválido (0 a ${max}).`);
  return round2(n);
};

export class ShippingPolicyService {
  static settings(orgId: string) {
    const r = db.prepare("SELECT * FROM shipping_policy WHERE organization_id = ?").get(orgId) as any;
    let ranges: ShippingRange[] = [];
    try { ranges = JSON.parse(r?.ranges_json || "[]"); } catch { ranges = []; }
    return {
      enabled: !!Number(r?.enabled), fixedAmount: r?.fixed_amount == null ? null : Number(r.fixed_amount), ranges,
      freeAbove: r?.free_above == null ? null : Number(r.free_above), maxAbsorb: r?.max_absorb == null ? null : Number(r.max_absorb),
      updatedAt: r?.updated_at || null,
    };
  }

  /** Só grava o que veio; `null` limpa. Faixas de CEP: 8 dígitos, de ≤ até, sem sobreposição. Valor inválido é erro. */
  static save(orgId: string, patch: { enabled?: boolean; fixedAmount?: number | null; ranges?: ShippingRange[]; freeAbove?: number | null; maxAbsorb?: number | null }, actorId?: string) {
    const cur = this.settings(orgId);
    const next = { ...cur };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.fixedAmount !== undefined) next.fixedAmount = money(patch.fixedAmount, "Frete fixo");
    if (patch.freeAbove !== undefined) next.freeAbove = money(patch.freeAbove, "Valor para frete grátis", 1_000_000);
    if (patch.maxAbsorb !== undefined) next.maxAbsorb = money(patch.maxAbsorb, "Teto de subsídio");
    if (patch.ranges !== undefined) {
      if (!Array.isArray(patch.ranges) || patch.ranges.length > MAX_RANGES) throw new Error(`Informe até ${MAX_RANGES} faixas de CEP.`);
      const rs = patch.ranges.map((r) => {
        const from = normalizeCep(r?.cepFrom), to = normalizeCep(r?.cepTo);
        if (!from || !to) throw new Error("CEP da faixa inválido (8 dígitos).");
        if (from > to) throw new Error("Na faixa de CEP, o início não pode ser maior que o fim.");
        const amount = money(r.amount, "Valor da faixa");
        if (amount == null) throw new Error("Informe o valor de cada faixa.");
        return { cepFrom: from, cepTo: to, amount, label: typeof r.label === "string" ? r.label.trim().slice(0, 40) || undefined : undefined } as ShippingRange;
      }).sort((a, b) => a.cepFrom.localeCompare(b.cepFrom));
      for (let i = 1; i < rs.length; i++) if (rs[i].cepFrom <= rs[i - 1].cepTo) throw new Error("As faixas de CEP não podem se sobrepor.");
      next.ranges = rs;
    }
    db.prepare(
      `INSERT INTO shipping_policy (organization_id, enabled, fixed_amount, ranges_json, free_above, max_absorb, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id) DO UPDATE SET enabled = excluded.enabled, fixed_amount = excluded.fixed_amount, ranges_json = excluded.ranges_json,
         free_above = excluded.free_above, max_absorb = excluded.max_absorb, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(orgId, next.enabled ? 1 : 0, next.fixedAmount, JSON.stringify(next.ranges), next.freeAbove, next.maxAbsorb, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", orgId, "SHIPPING_POLICY_SET", { enabled: next.enabled, ranges: next.ranges.length }); } catch { /* noop */ }
    return this.settings(orgId);
  }

  /** Preço de tabela do frete para o CEP (faixa → fixo). null = não dá pra calcular. */
  static basePrice(orgId: string, cep: unknown): { amount: number; label: string | null; source: "range" | "fixed" } | null {
    const s = this.settings(orgId);
    const c = normalizeCep(cep);
    if (c) {
      const hit = s.ranges.find((r) => c >= r.cepFrom && c <= r.cepTo);
      if (hit) return { amount: hit.amount, label: hit.label || null, source: "range" };
    }
    return s.fixedAmount != null ? { amount: s.fixedAmount, label: null, source: "fixed" } : null;
  }

  /**
   * Frete de um pedido de ENTREGA. `items` com preço real do checkout; `discount` = desconto do cupom. Nunca lança.
   * `reason` é interno (dono); o chamador público não deve expô-lo.
   */
  static quote(orgId: string, input: { items: Array<{ productId: string | null; qty: number; unitPrice: number }>; subtotal: number; discount: number; cep?: unknown }) {
    const s = this.settings(orgId);
    if (!s.enabled) return { enabled: false as const, mode: "off" as const, amount: null, absorbed: 0, free: false, label: null, reason: null as FreeReason | null, needsCep: false };
    const base = this.basePrice(orgId, input.cep);
    const needsCep = !normalizeCep(input.cep) && s.ranges.length > 0;
    if (!base) return { enabled: true as const, mode: "to_arrange" as const, amount: null, absorbed: 0, free: false, label: null, reason: "not_calculated" as FreeReason, needsCep };

    const net = round2(input.subtotal - Math.max(0, input.discount));
    let reason: FreeReason = "no_threshold";
    let free = false;
    if (s.freeAbove != null) {
      if (net < s.freeAbove) reason = "below_threshold";
      else if (s.maxAbsorb != null && base.amount > s.maxAbsorb) reason = "above_max_absorb";
      else {
        const floor = ChannelEconomicsService.settings(orgId).floorPercent;
        const oc = ChannelEconomicsService.orderContribution(orgId, input.items, Math.max(0, input.discount));
        if (floor == null) reason = "floor_not_set";
        else if (oc.quality !== "reliable" || oc.contribution == null) reason = "economics_unconfirmed";
        else if ((oc.contribution - base.amount) / oc.net * 100 < floor) reason = "would_break_floor";
        else { free = true; reason = "applied"; }
      }
    }
    return { enabled: true as const, mode: "calculated" as const, amount: free ? 0 : base.amount, absorbed: free ? base.amount : 0, free, label: base.label, reason, needsCep };
  }
}

export default ShippingPolicyService;
