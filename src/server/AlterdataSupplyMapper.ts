/**
 * Conector Alterdata/ModaUp — MAPPER SUPPLY (ADR-105, Fase 1b): catálogo.
 *
 * Traduz as entidades do módulo Supply da ModaUp em produto+variantes do
 * ZappFlow, com UPSERT idempotente por referência externa (`external_ref`):
 *   - `Referencia` (referenciaId, descricao, preco, custo, colecao, grupo)
 *      → products_services (external_ref = referenciaId).
 *   - `CodigoDeBarras` (codigo=referência, cor, tamanho, ean)
 *      → product_variants (external_ref = ean|codigo:cor:tamanho), cor/tamanho,
 *        EAN em `sku`; marca o produto com has_variants.
 *
 * É um MAPPER PURO de dados (sem HTTP): recebe os itens já baixados pelo
 * AlterdataSyncService.onItems e devolve quantos itens tratou. Idempotente por
 * chave natural — reprocessar o mesmo delta não duplica. Estoque (Saldo) e preço
 * por filial (TabelaPreco) entram na Fase 1c.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { uniqueProductSlug } from "./productSlug.js";
import { sanitizeGtin } from "./eanUtil.js";
import { logAuthEvent } from "./auditLog.js";

export class AlterdataSupplyMapper {
  /** Upsert de produtos a partir de `Referencia` (chave: external_ref = referenciaId). */
  static upsertReferencias(orgId: string, items: any[]): number {
    let n = 0;
    for (const r of Array.isArray(items) ? items : []) {
      const ref = str(r?.referenciaId ?? r?.referencia ?? r?.codigo);
      if (!ref) continue;
      const name = str(r?.descricao) || `Referência ${ref}`;
      const price = numOrNull(r?.preco);
      const minPrice = numOrNull(r?.precoMin);
      const category = str(r?.grupo) || null;
      const meta = JSON.stringify({
        alterdata: { referenciaId: ref, colecao: str(r?.colecao) || null, tipo: str(r?.tipo) || null, linha: str(r?.linha) || null, custo: numOrNull(r?.custo) },
      });

      const existing = db.prepare(`SELECT id FROM products_services WHERE organization_id = ? AND external_ref = ? LIMIT 1`).get(orgId, ref) as any;
      if (existing?.id) {
        db.prepare(
          `UPDATE products_services SET name = ?, price = COALESCE(?, price), min_price = COALESCE(?, min_price),
             category = COALESCE(?, category), metadata_json = ?
           WHERE organization_id = ? AND id = ?`
        ).run(name, price, minPrice, category, meta, orgId, existing.id);
      } else {
        const id = uuidv4();
        db.prepare(
          `INSERT INTO products_services (id, organization_id, type, name, price, min_price, currency, active,
             stock_control_enabled, category, slug, storefront_visible, external_ref, metadata_json)
           VALUES (?, ?, 'product', ?, ?, ?, 'BRL', 1, 1, ?, ?, 1, ?, ?)`
        ).run(id, orgId, name, price, minPrice, category, uniqueProductSlug(orgId, name), ref, meta);
        try { logAuthEvent(orgId, "system", id, "PRODUCT_CREATED", { source: "alterdata_supply", referenciaId: ref }); } catch { /* noop */ }
      }
      n++;
    }
    return n;
  }

  /**
   * Upsert de variantes a partir de `CodigoDeBarras`. `codigo` liga à Referência
   * (external_ref do produto); cor×tamanho é a grade; `ean` o código de barras.
   * Barras cujo produto ainda não foi importado são puladas (o cursor de
   * Referencia avança primeiro; no próximo ciclo elas casam).
   */
  static upsertCodigosDeBarras(orgId: string, items: any[]): number {
    let n = 0;
    for (const c of Array.isArray(items) ? items : []) {
      const codigo = str(c?.codigo ?? c?.referencia);
      if (!codigo) continue;
      const product = db.prepare(`SELECT id, ean FROM products_services WHERE organization_id = ? AND external_ref = ? LIMIT 1`).get(orgId, codigo) as any;
      if (!product?.id) continue; // produto ainda não importado — pula (idempotente no próximo ciclo)

      const cor = str(c?.cor);
      const tamanho = str(c?.tamanho);
      const ean = sanitizeGtin(c?.ean);
      const extRef = ean || `${codigo}:${cor}:${tamanho}`;
      const vName = [tamanho, cor].filter(Boolean).join(" / ") || (ean ? `EAN ${ean}` : `Variante ${extRef}`);
      const inactive = int(c?.inativo) === 1 || int(c?.descontinuado) === 1;

      const existing = db.prepare(`SELECT id FROM product_variants WHERE organization_id = ? AND product_service_id = ? AND external_ref = ? LIMIT 1`).get(orgId, product.id, extRef) as any;
      if (existing?.id) {
        db.prepare(`UPDATE product_variants SET name = ?, size = ?, color = ?, sku = COALESCE(?, sku), active = ? WHERE organization_id = ? AND id = ?`)
          .run(vName, tamanho || null, cor || null, ean, inactive ? 0 : 1, orgId, existing.id);
      } else {
        db.prepare(
          `INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, size, color, variant_type, active, external_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'grade', ?, ?)`
        ).run(uuidv4(), orgId, product.id, vName, ean, tamanho || null, cor || null, inactive ? 0 : 1, extRef);
      }
      // Marca o produto como tendo grade e, se ainda sem EAN de capa, adota o 1º.
      db.prepare(`UPDATE products_services SET has_variants = 1, stock_control_enabled = 1, ean = COALESCE(ean, ?) WHERE organization_id = ? AND id = ?`)
        .run(ean, orgId, product.id);
      n++;
    }
    return n;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function str(v: any): string { return v == null ? "" : String(v).trim(); }
function int(v: any): number { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : 0; }
function numOrNull(v: any): number | null { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
