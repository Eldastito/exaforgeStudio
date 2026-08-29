/**
 * RetailPdvSaleLinesService — drill-down "vendas do dia" (linhas INDIVIDUAIS do PDV).
 *
 * As abas "Mais vendidos" e "Por vendedor" mostram TOTAIS do período (cada linha
 * é uma SOMA), então não cabe uma data por linha. Este service abre o detalhe: as
 * linhas de venda cruas de `retail_pdv_sale_items`, CADA UMA com a sua DATA, loja,
 * boleta, vendedor, peças e valor — filtrável por produto (código do ERP), por
 * vendedor (CAI_USUARIO/matrícula) e por loja.
 *
 * Determinístico; isolado por organization_id. Só leitura.
 */
import db from "./db.js";

export type SaleLineFilter = {
  produto?: string;        // código de produto do ERP (retail_pdv_sale_items.produto)
  vendedor?: string;       // código/matrícula do vendedor por linha
  store?: string;          // código da filial (retail_stores.code)
  start: string;           // YYYY-MM-DD
  end: string;             // YYYY-MM-DD
  limit?: number;
};

export class RetailPdvSaleLinesService {
  static lines(orgId: string, f: SaleLineFilter): { start: string; end: string; lines: any[]; total: number; cap: number } {
    const start = String(f.start || "").slice(0, 10);
    const end = String(f.end || "").slice(0, 10);
    const cap = Math.max(1, Math.min(1000, Math.trunc(Number(f.limit) || 500)));
    if (!start || !end) return { start, end, lines: [], total: 0, cap };

    const where: string[] = ["i.organization_id = ?", "i.sale_date BETWEEN ? AND ?"];
    const args: any[] = [orgId, start, end];
    const produto = String(f.produto || "").trim();
    if (produto) { where.push("i.produto = ?"); args.push(produto); }
    const vendedor = String(f.vendedor || "").trim();
    if (vendedor) { where.push("COALESCE(NULLIF(i.vendedor,''),'') = ?"); args.push(vendedor); }
    const store = String(f.store || "").trim();
    if (store) { where.push("i.filial = ?"); args.push(store); }

    const total = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM retail_pdv_sale_items i WHERE ${where.join(" AND ")}`
    ).get(...args) as any)?.n || 0);

    const rows = db.prepare(
      `SELECT i.sale_date, i.filial, i.boleta, i.produto, i.quantidade, i.valor, i.vendedor,
              COALESCE(st.name, 'Filial ' || i.filial) AS loja,
              COALESCE(rs.name, NULLIF(i.vendedor, '')) AS vendedor_nome
         FROM retail_pdv_sale_items i
         LEFT JOIN retail_stores st ON st.organization_id = i.organization_id AND st.code = i.filial
         LEFT JOIN retail_sellers rs ON rs.organization_id = i.organization_id AND rs.matricula = i.vendedor
        WHERE ${where.join(" AND ")}
        ORDER BY i.sale_date DESC, i.boleta DESC, i.item_seq
        LIMIT ?`
    ).all(...args, cap) as any[];

    return {
      start, end, total, cap,
      lines: rows.map((r) => ({
        date: r.sale_date,
        filial: r.filial,
        loja: r.loja,
        boleta: r.boleta,
        produto: r.produto,
        vendedor: r.vendedor || null,
        vendedorNome: r.vendedor_nome || null,
        pecas: Math.round(Number(r.quantidade || 0)),
        valor: Math.round(Number(r.valor || 0) * 100) / 100,
      })),
    };
  }
}

export default RetailPdvSaleLinesService;
