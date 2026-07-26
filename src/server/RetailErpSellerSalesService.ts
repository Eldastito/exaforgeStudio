/**
 * Retail Ops — Vendas por VENDEDOR vindas do ERP (Cenário A).
 *
 * Quando o ERP calcula a comissão por vendedor (endpoint da ModaUp/Alterdata
 * `Venda/ComissaoVendasPorPeriodo`), guardamos por vendedor DUAS coisas:
 *   - `valor` (vendido) → BASE para as NOSSAS regras de comissão, somando com o
 *     manual/foto (Cenário B) e o ZappFlow em RetailCommissionService;
 *   - `comissao_erp` → a comissão JÁ calculada pelo ERP, para exibir e conferir
 *     divergência contra a nossa apuração.
 *
 * FUNDAÇÃO (esta fatia): a tabela, o mapper defensivo, o ingest idempotente e a
 * agregação por vendedor existem e são testados; a fonte já entra no merge de
 * comissão. O SYNC real (chamada do endpoint no AlterdataSyncRunner) só é ligado
 * quando o FORMATO do payload do ERP estiver confirmado — por isso o mapper tenta
 * os nomes de campo mais prováveis e é fácil de ajustar quando o corpo real
 * chegar. Isolado por org.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v: any): string => (v == null ? "" : String(v)).trim();
/** Primeiro candidato não-vazio entre vários nomes de campo possíveis. */
function pick(raw: any, keys: string[]): any {
  for (const k of keys) { const v = raw?.[k]; if (v !== undefined && v !== null && v !== "") return v; }
  return undefined;
}

export type ErpSellerSaleRow = {
  filial: string | null;
  matricula: string | null;
  sellerName: string | null;
  saleDate: string;      // YYYY-MM-DD
  valor: number;
  pecas: number;
  comissaoErp: number;
};

export class RetailErpSellerSalesService {
  /**
   * Mapper DEFENSIVO do payload do ERP para uma linha nossa. Os nomes de campo
   * variam entre instalações da ModaUp (o mesmo padrão do VendaMalote), então
   * tenta os candidatos conhecidos. `defaultDate` cobre o caso do ERP devolver
   * um agregado por período sem data por linha. Devolve null quando não dá para
   * extrair nem matrícula/nome nem valor/comissão (linha inútil).
   */
  static mapErpRow(raw: any, defaultDate: string): ErpSellerSaleRow | null {
    if (!raw || typeof raw !== "object") return null;
    // Alguns contratos EMBRULHAM a linha ({ comissao: {...} } / { vendedor: {...} }).
    // Só desembrulha se for objeto — senão colide com campos escalares de mesmo nome.
    const isObj = (v: any) => v && typeof v === "object" && !Array.isArray(v);
    const r = isObj(raw.comissao) ? raw.comissao : isObj(raw.vendedor) ? raw.vendedor : raw;
    const matricula = str(pick(r, ["matricula", "matriculaVendedor", "codVendedor", "codigoVendedor", "vendedor"])) || null;
    const sellerName = str(pick(r, ["nome", "nomeVendedor", "vendedorNome", "descricao"])) || null;
    const filial = str(pick(r, ["filial", "codigoFilial", "loja"])) || null;
    const saleDate = (str(pick(r, ["data", "dataVenda", "periodo", "dataReferencia"])) || defaultDate).slice(0, 10) || defaultDate;
    const valor = round2(pick(r, ["valorVendido", "valor", "totalVendido", "vendas", "metaVendedorRealizado", "realizado"]));
    const pecas = Number(pick(r, ["pecas", "vendidas", "quantidade", "qtdPecas"]) || 0) || 0;
    const comissaoErp = round2(pick(r, ["comissao", "valorComissao", "comissaoValor", "totalComissao"]));
    // Sem identidade do vendedor OU sem nenhum número → linha inútil.
    if (!matricula && !sellerName) return null;
    if (valor <= 0 && comissaoErp <= 0 && pecas <= 0) return null;
    return { filial, matricula, sellerName, saleDate, valor, pecas, comissaoErp };
  }

  /**
   * Ingesta (upsert idempotente) as linhas do ERP. Chamado pelo SYNC quando ele
   * for ligado; nesta fatia é exercitado só pelos testes. Resolve a loja pela
   * filial (retail_stores.code) quando possível. Retorna quantas linhas gravou.
   */
  static ingest(orgId: string, rows: ErpSellerSaleRow[], actorId?: string): number {
    const upsert = db.prepare(
      `INSERT INTO retail_erp_seller_sales (id, organization_id, store_id, filial, sale_date, matricula, seller_name, valor, pecas, comissao_erp, external_ref, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id, filial, matricula, sale_date) DO UPDATE SET
         store_id = excluded.store_id, seller_name = excluded.seller_name, valor = excluded.valor,
         pecas = excluded.pecas, comissao_erp = excluded.comissao_erp, external_ref = excluded.external_ref,
         synced_at = CURRENT_TIMESTAMP`
    );
    const storeByFilial = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND code = ? AND active = 1`);
    let n = 0;
    const insertOne = (row: ErpSellerSaleRow) => {
      if (!row) return;
      const date = str(row.saleDate).slice(0, 10);
      if (!date) return;
      if (!row.matricula && !row.sellerName) return;
      const storeId = row.filial ? (storeByFilial.get(orgId, row.filial) as any)?.id || null : null;
      // filial/matricula gravam '' (não NULL) quando ausentes: numa coluna do
      // UNIQUE, NULL nunca casa no ON CONFLICT — viraria linha duplicada a cada
      // reingestão. Com '' o upsert é idempotente. bySeller usa NULLIF p/ agrupar.
      const filial = row.filial || "";
      const matricula = row.matricula || (row.sellerName ? `nome:${str(row.sellerName).toLowerCase()}` : "");
      const ref = `${filial}:${matricula}:${date}`;
      upsert.run(randomUUID(), orgId, storeId, filial, date, matricula, row.sellerName || null, round2(row.valor), Number(row.pecas || 0) || 0, round2(row.comissaoErp), ref);
      n++;
    };
    const run = db.transaction((list: ErpSellerSaleRow[]) => { for (const row of list) insertOne(row); });
    run(Array.isArray(rows) ? rows : []);
    if (n > 0) { try { logAuthEvent(orgId, actorId || "system", "erp", "RETAIL_ERP_SELLER_SALES_INGESTED", { count: n }); } catch { /* noop */ } }
    return n;
  }

  /**
   * Agregado por VENDEDOR no período — base (valor) + comissão do ERP. Consolida
   * por matrícula; `sellerUserId`/nome vêm do mapeamento retail_sellers quando há.
   */
  static bySeller(orgId: string, start: string, end: string): Array<{ sellerUserId: string | null; sellerName: string; matricula: string | null; sales: number; pecas: number; orders: number; erpCommission: number; source: string }> {
    const rows = db.prepare(
      `SELECT es.matricula, es.seller_name, rs.name AS mapped_name, rs.user_id AS user_id,
              SUM(es.valor) AS sales, SUM(es.pecas) AS pecas, SUM(es.comissao_erp) AS comissao, COUNT(*) AS orders
         FROM retail_erp_seller_sales es
         LEFT JOIN retail_sellers rs ON rs.organization_id = es.organization_id AND rs.matricula = es.matricula
        WHERE es.organization_id = ? AND es.sale_date BETWEEN ? AND ?
        GROUP BY COALESCE(NULLIF(es.matricula, ''), LOWER(TRIM(es.seller_name)))
        ORDER BY sales DESC`
    ).all(orgId, start, end) as any[];
    return rows.map((r) => {
      // matricula sintética ("nome:...") é só chave interna p/ vendedor sem
      // matrícula no ERP — não expõe como matrícula real.
      const realMatricula = r.matricula && !String(r.matricula).startsWith("nome:") ? r.matricula : null;
      return {
      sellerUserId: r.user_id || null,
      sellerName: r.mapped_name || r.seller_name || (realMatricula ? `Matrícula ${realMatricula}` : "vendedor"),
      matricula: realMatricula,
      sales: round2(r.sales),
      pecas: Number(r.pecas || 0),
      orders: Number(r.orders || 0),
      erpCommission: round2(r.comissao),
      source: "erp",
      };
    });
  }
}
