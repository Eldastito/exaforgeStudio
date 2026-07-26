/**
 * Retail Ops — Vendas por VENDEDOR (Cenário B).
 *
 * Quando o PDV/ERP NÃO traz o vendedor por venda (só o operador de caixa), a
 * loja anota as vendas de cada vendedor no papel e o gestor lança aqui — de duas
 * formas, que gravam na MESMA tabela (`retail_seller_sales`):
 *   1) MANUAL: digita nome + valor (R$) + peças por vendedor num modal;
 *   2) FOTO+IA: envia a foto da folha, a IA lê e pré-preenche o modal, e o
 *      gestor CONFERE antes de salvar (a IA nunca salva sozinha).
 *
 * Essa base alimenta a comissão por vendedor (RetailCommissionService), somando
 * com as vendas do ZappFlow. Isolado por org.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

export type SellerSaleEntry = {
  sellerName: string;
  matricula?: string | null;
  valor?: number;
  pecas?: number;
};

/** Chave para consolidar um vendedor: matrícula (se houver) ou nome normalizado. */
export function sellerKeyOf(matricula: string | null | undefined, name: string | null | undefined): string {
  const m = String(matricula || "").trim();
  if (m) return `mat:${m}`;
  return `nom:${String(name || "").trim().toLowerCase()}`;
}

export class RetailSellerSalesService {
  /** Lista os lançamentos de um período (opcional por loja). */
  static list(orgId: string, start: string, end: string, storeId?: string | null): any[] {
    const rows = storeId
      ? db.prepare(
          `SELECT ss.*, st.name AS store_name FROM retail_seller_sales ss
             LEFT JOIN retail_stores st ON st.id = ss.store_id
            WHERE ss.organization_id = ? AND ss.store_id = ? AND ss.sale_date BETWEEN ? AND ?
            ORDER BY ss.sale_date DESC, ss.seller_name`
        ).all(orgId, storeId, start, end)
      : db.prepare(
          `SELECT ss.*, st.name AS store_name FROM retail_seller_sales ss
             LEFT JOIN retail_stores st ON st.id = ss.store_id
            WHERE ss.organization_id = ? AND ss.sale_date BETWEEN ? AND ?
            ORDER BY ss.sale_date DESC, ss.seller_name`
        ).all(orgId, start, end);
    return rows as any[];
  }

  /**
   * Lança em lote (uma folha = várias linhas de vendedor). Ignora linhas sem
   * nome ou sem valor/peças. `saleDate` é a data da folha. Retorna os criados.
   */
  static bulkCreate(
    orgId: string,
    input: { storeId?: string | null; saleDate: string; entries: SellerSaleEntry[]; source?: "manual" | "photo"; imageUrl?: string | null },
    actorId?: string
  ): any[] {
    const saleDate = String(input.saleDate || "").slice(0, 10);
    if (!saleDate) throw new Error("saleDate é obrigatório (YYYY-MM-DD).");
    const storeId = input.storeId ? String(input.storeId) : null;
    const source = input.source === "photo" ? "photo" : "manual";
    const rows = Array.isArray(input.entries) ? input.entries : [];
    const created: string[] = [];
    const insert = db.prepare(
      `INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, source, image_url, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction((entries: SellerSaleEntry[]) => {
      for (const e of entries) {
        const name = String(e.sellerName || "").trim();
        const valor = round2(e.valor);
        const pecas = Number(e.pecas || 0) || 0;
        if (!name || (valor <= 0 && pecas <= 0)) continue;
        const id = randomUUID();
        insert.run(id, orgId, storeId, saleDate, name, e.matricula ? String(e.matricula).trim() : null, valor, pecas, source, input.imageUrl || null, actorId || null);
        created.push(id);
      }
    });
    tx(rows);
    try { logAuthEvent(orgId, actorId || "system", saleDate, "RETAIL_SELLER_SALES_CREATED", { count: created.length, source, storeId }); } catch { /* noop */ }
    if (!created.length) return [];
    const placeholders = created.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM retail_seller_sales WHERE id IN (${placeholders})`).all(...created) as any[];
  }

  static remove(orgId: string, id: string, actorId?: string): boolean {
    const r = db.prepare(`DELETE FROM retail_seller_sales WHERE organization_id = ? AND id = ?`).run(orgId, id);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_SELLER_SALES_DELETED", {}); } catch { /* noop */ } }
    return r.changes > 0;
  }

  /**
   * Agregado por VENDEDOR no período — base da comissão. Consolida por matrícula
   * (se houver) ou por nome. `sellerUserId` vem do mapeamento retail_sellers.
   */
  static bySeller(orgId: string, start: string, end: string): Array<{ sellerKey: string; sellerUserId: string | null; sellerName: string; matricula: string | null; sales: number; pecas: number; orders: number; source: string }> {
    const rows = db.prepare(
      `SELECT ss.seller_name, ss.matricula, rs.name AS mapped_name, rs.user_id AS user_id,
              SUM(ss.valor) AS sales, SUM(ss.pecas) AS pecas, COUNT(*) AS orders
         FROM retail_seller_sales ss
         LEFT JOIN retail_sellers rs ON rs.organization_id = ss.organization_id AND rs.matricula = ss.matricula
        WHERE ss.organization_id = ? AND ss.sale_date BETWEEN ? AND ?
        GROUP BY COALESCE(NULLIF(ss.matricula, ''), LOWER(TRIM(ss.seller_name)))
        ORDER BY sales DESC`
    ).all(orgId, start, end) as any[];
    return rows.map((r) => ({
      sellerKey: sellerKeyOf(r.matricula, r.mapped_name || r.seller_name),
      sellerUserId: r.user_id || null,
      sellerName: r.mapped_name || r.seller_name,
      matricula: r.matricula || null,
      sales: round2(r.sales),
      pecas: Number(r.pecas || 0),
      orders: Number(r.orders || 0),
      source: "manual",
    }));
  }

  /**
   * Lê a folha por FOTO com a IA e devolve as linhas para o gestor CONFERIR — NÃO
   * salva nada. Extrator injetável (teste offline). O salvamento é o bulkCreate,
   * chamado só depois da confirmação humana.
   */
  static async extractFromImage(base64: string, mimetype: string): Promise<{ entries: SellerSaleEntry[]; confidence: number; needsReview: boolean }> {
    const extractor = _sellerSalesExtractor || (async (b: string, m: string) => (await import("./llm.js")).extractSellerSalesFromImage(b, m));
    let parsed: any = {};
    try { parsed = JSON.parse((await extractor(base64, mimetype)) || "{}"); } catch { parsed = {}; }
    const list = Array.isArray(parsed?.vendedores) ? parsed.vendedores : [];
    const entries: SellerSaleEntry[] = list
      .map((v: any) => ({ sellerName: String(v?.nome || "").trim(), valor: Number(v?.valor || 0) || 0, pecas: Number(v?.pecas || 0) || 0 }))
      .filter((e: SellerSaleEntry) => e.sellerName && ((e.valor || 0) > 0 || (e.pecas || 0) > 0));
    const confidence = Number(parsed?.confidence ?? 0);
    const minConf = Number(process.env.RETAIL_SELLER_SALES_MIN_CONFIDENCE || 80);
    return { entries, confidence, needsReview: !(confidence >= minConf && entries.length > 0) };
  }
}

/** Extrator injetável (teste offline, sem provedor de visão). */
type SellerSalesExtractor = (base64: string, mimetype: string) => Promise<string>;
let _sellerSalesExtractor: SellerSalesExtractor | null = null;
export function __setSellerSalesExtractorForTests(fn: SellerSalesExtractor | null): void { _sellerSalesExtractor = fn; }
