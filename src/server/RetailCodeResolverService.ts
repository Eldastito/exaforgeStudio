/**
 * RetailCodeResolverService — resolve o código LIDO na loja (EAN, SKU, referência,
 * código ERP ou alias) para produto/variante do catálogo (PRD Fase 1, F1.2).
 *
 * Ordem de busca (a 1ª que casar vence; mais de 1 destino no mesmo nível →
 * `ambiguous`, NUNCA escolhe às cegas):
 *   1. variante por external_ref (ADR-105: EAN da variante da grade)
 *   2. variante por sku
 *   3. produto por ean
 *   4. produto por external_ref (código ERP)
 *   5. alias vinculado por humano (`product_code_aliases`)
 *   6. produto por PREFIXO (EAN13 do caixa × external_ref de 12 — ADR-105), só se não-ambíguo
 *
 * Normalização: o código pode vir do leitor (só dígitos) ou de etiqueta
 * alfanumérica (SKU/referência). Tenta o código como veio (trim), só os dígitos,
 * sem zeros à esquerda e completado a 13 dígitos (UPC-A/GTIN-14 × EAN-13).
 *
 * Não escreve nada aqui (exceto `linkAlias`, gesto humano explícito). Isolado por
 * organization_id (convenção nº 1).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type CodeMatchedBy = "variant_ean" | "variant_sku" | "product_ean" | "product_ref" | "alias" | "prefix";
export type ResolvedCode = {
  status: "found" | "ambiguous" | "unresolved";
  code: string;
  matchedBy: CodeMatchedBy | null;
  product: { id: string; name: string; price: number; reference: string | null } | null;
  variant: { id: string; name: string; size: string | null; color: string | null } | null;
  candidates: Array<{ productId: string; productName: string; variantId: string | null; variantName: string | null }>;
};

const MIN_LEN = 4;

export class RetailCodeResolverService {
  /** Código como o operador vê/grava: trim, sem espaços internos. Alfanumérico é preservado. */
  static normalize(raw: unknown): string {
    const s = String(raw ?? "").trim().replace(/\s+/g, "");
    if (/^[\d\-.]+$/.test(s)) return s.replace(/\D/g, ""); // só dígitos (leitor/digitado)
    return s.toUpperCase();
  }

  /** Variações a tentar (sem duplicar). Zeros à esquerda só valem pra código numérico. */
  static variants(code: string): string[] {
    const out = new Set<string>([code]);
    if (/^\d+$/.test(code)) {
      const stripped = code.replace(/^0+/, "");
      if (stripped.length >= 6) out.add(stripped);
      if (code.length < 13) out.add(code.padStart(13, "0"));
      if (code.length === 14 && code.startsWith("0")) out.add(code.slice(1));
    }
    return [...out];
  }

  static isValid(code: string): boolean {
    return code.length >= (/^\d+$/.test(code) ? 6 : MIN_LEN);
  }

  static resolve(orgId: string, raw: unknown): ResolvedCode {
    const code = this.normalize(raw);
    const base: ResolvedCode = { status: "unresolved", code, matchedBy: null, product: null, variant: null, candidates: [] };
    if (!this.isValid(code)) return base;
    const vs = this.variants(code);
    const ph = vs.map(() => "?").join(",");

    const variantLevel = (col: "external_ref" | "sku", by: CodeMatchedBy): ResolvedCode | null => {
      const rows = db.prepare(
        `SELECT v.id, v.product_service_id, v.name, v.size, v.color, v.price AS vprice, p.name AS pname, p.price AS pprice, p.external_ref AS pref
           FROM product_variants v JOIN products_services p ON p.id = v.product_service_id AND p.organization_id = v.organization_id
          WHERE v.organization_id = ? AND v.${col} IN (${ph}) AND v.active = 1 LIMIT 5`
      ).all(orgId, ...vs) as any[];
      return this.pick(base, rows.map((r) => ({ kind: "variant", r })), by);
    };
    const productLevel = (col: "ean" | "external_ref", by: CodeMatchedBy): ResolvedCode | null => {
      const rows = db.prepare(
        `SELECT id, name, price, external_ref FROM products_services WHERE organization_id = ? AND ${col} IN (${ph}) LIMIT 5`
      ).all(orgId, ...vs) as any[];
      return this.pick(base, rows.map((r) => ({ kind: "product", r })), by);
    };

    const hit =
      variantLevel("external_ref", "variant_ean") ||
      variantLevel("sku", "variant_sku") ||
      productLevel("ean", "product_ean") ||
      productLevel("external_ref", "product_ref") ||
      this.aliasLevel(orgId, base, vs, ph);
    if (hit) return hit;

    // Prefixo (heurística): só numérico e só quando não-ambíguo.
    if (/^\d+$/.test(code)) {
      const pref = db.prepare(
        `SELECT id, name, price, external_ref FROM products_services WHERE organization_id = ? AND external_ref IS NOT NULL AND length(external_ref) >= 4 AND ? LIKE external_ref || '%' ORDER BY length(external_ref) DESC LIMIT 2`
      ).all(orgId, code) as any[];
      if (pref.length === 1) return this.pick(base, [{ kind: "product", r: pref[0] }], "prefix");
    }
    return base;
  }

  private static aliasLevel(orgId: string, base: ResolvedCode, vs: string[], ph: string): ResolvedCode | null {
    const a = db.prepare(`SELECT product_service_id, variant_id FROM product_code_aliases WHERE organization_id = ? AND code IN (${ph}) LIMIT 1`).get(orgId, ...vs) as any;
    if (!a) return null;
    const p = db.prepare(`SELECT id, name, price, external_ref FROM products_services WHERE organization_id = ? AND id = ?`).get(orgId, a.product_service_id) as any;
    if (!p) return null;
    if (a.variant_id) {
      const v = db.prepare(`SELECT id, product_service_id, name, size, color, price AS vprice FROM product_variants WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, a.variant_id) as any;
      if (v) return this.pick(base, [{ kind: "variant", r: { ...v, pname: p.name, pprice: p.price, pref: p.external_ref } }], "alias");
    }
    return this.pick(base, [{ kind: "product", r: p }], "alias");
  }

  /** 0 → null (segue o próximo nível); 1 → found; >1 destinos distintos → ambiguous. */
  private static pick(base: ResolvedCode, rows: Array<{ kind: "variant" | "product"; r: any }>, by: CodeMatchedBy): ResolvedCode | null {
    if (!rows.length) return null;
    const dests = new Map<string, any>();
    for (const x of rows) dests.set(x.kind === "variant" ? `v:${x.r.id}` : `p:${x.r.id}`, x);
    const list = [...dests.values()];
    if (list.length > 1) {
      return {
        ...base, status: "ambiguous", matchedBy: by,
        candidates: list.slice(0, 5).map((x) => x.kind === "variant"
          ? { productId: x.r.product_service_id, productName: x.r.pname, variantId: x.r.id, variantName: x.r.name }
          : { productId: x.r.id, productName: x.r.name, variantId: null, variantName: null }),
      };
    }
    const x = list[0];
    if (x.kind === "variant") {
      const r = x.r;
      return {
        ...base, status: "found", matchedBy: by,
        product: { id: r.product_service_id, name: r.pname, price: Number(r.vprice ?? r.pprice ?? 0), reference: r.pref || null },
        variant: { id: r.id, name: r.name, size: r.size || null, color: r.color || null },
      };
    }
    return { ...base, status: "found", matchedBy: by, product: { id: x.r.id, name: x.r.name, price: Number(x.r.price || 0), reference: x.r.external_ref || null }, variant: null };
  }

  /** Busca simples no catálogo (nome/ref/ean/sku) pro "Pesquisar catálogo". Máx. 10. */
  static search(orgId: string, q: unknown): Array<{ productId: string; name: string; reference: string | null; variants: Array<{ id: string; name: string; size: string | null; color: string | null }> }> {
    const term = String(q ?? "").trim().slice(0, 60);
    if (term.length < 2) return [];
    const like = `%${term.replace(/[%_]/g, "")}%`;
    const prods = db.prepare(
      `SELECT DISTINCT p.id, p.name, p.external_ref FROM products_services p
         LEFT JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_service_id = p.id AND v.active = 1
        WHERE p.organization_id = ? AND (p.name LIKE ? OR p.external_ref LIKE ? OR p.ean LIKE ? OR v.sku LIKE ? OR v.external_ref LIKE ?)
        ORDER BY p.name LIMIT 10`
    ).all(orgId, like, like, like, like, like) as any[];
    return prods.map((p) => ({
      productId: p.id, name: p.name, reference: p.external_ref || null,
      variants: (db.prepare(`SELECT id, name, size, color FROM product_variants WHERE organization_id = ? AND product_service_id = ? AND active = 1 ORDER BY name LIMIT 30`).all(orgId, p.id) as any[])
        .map((v) => ({ id: v.id, name: v.name, size: v.size || null, color: v.color || null })),
    }));
  }

  /** Gesto HUMANO: vincula o código a um produto/variante do catálogo da org. */
  static linkAlias(orgId: string, rawCode: unknown, target: { productId: string; variantId?: string | null }, actorId: string | null): { code: string; productId: string; variantId: string | null } {
    const code = this.normalize(rawCode);
    if (!this.isValid(code)) throw new Error("Código inválido.");
    const p = db.prepare(`SELECT id FROM products_services WHERE organization_id = ? AND id = ?`).get(orgId, String(target.productId || "")) as any;
    if (!p) throw new Error("Produto não encontrado.");
    let variantId: string | null = null;
    if (target.variantId) {
      const v = db.prepare(`SELECT id FROM product_variants WHERE organization_id = ? AND id = ? AND product_service_id = ?`).get(orgId, String(target.variantId), p.id) as any;
      if (!v) throw new Error("Variante não pertence ao produto.");
      variantId = v.id;
    }
    // Vincular não pode esconder um código que JÁ resolve por outra via.
    const existing = this.resolve(orgId, code);
    if (existing.status === "found" && existing.matchedBy !== "alias" && existing.matchedBy !== "prefix") throw new Error("code_already_resolves");
    db.prepare(
      `INSERT INTO product_code_aliases (id, organization_id, code, product_service_id, variant_id, source, created_by)
       VALUES (?, ?, ?, ?, ?, 'floor_link', ?)
       ON CONFLICT (organization_id, code) DO UPDATE SET product_service_id = excluded.product_service_id, variant_id = excluded.variant_id, created_by = excluded.created_by`
    ).run(randomUUID(), orgId, code, p.id, variantId, actorId);
    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_CODE_ALIAS_LINKED", { code, productId: p.id, variantId }); } catch { /* noop */ }
    return { code, productId: p.id, variantId };
  }
}

export default RetailCodeResolverService;
