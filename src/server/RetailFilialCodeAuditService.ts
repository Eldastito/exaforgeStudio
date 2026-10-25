/**
 * RetailFilialCodeAuditService — PRÉVIA SOMENTE LEITURA de vendas guardadas sob códigos de filial
 * que não são mais de nenhuma loja ATIVA (loja que mudou de código: ex. 1005 → 1006 → 1084).
 *
 * Por quê: PDV, itens, parcelas de cartão e vendas por vendedor do ERP casam a loja pelo número da filial
 * (`retail_stores.code`). Quem mudou de código deixa histórico "órfão" — a venda existe, o painel da loja não vê.
 *
 * Esta fatia NÃO grava nada e NÃO decide o destino: só mostra, por código órfão, o que existe em cada tabela
 * (linhas, período, valor) e, dado um código destino (`into`), quais linhas JÁ existem sob ele (colisão) e se os
 * períodos se sobrepõem. Reetiquetar é uma etapa posterior, decidida pelo dono depois de ver este relatório.
 *
 *  - Cancelada (status 'C') conta como linha, mas não entra no valor.
 *  - Sobreposição de períodos NÃO prova que são lojas diferentes (a troca pode ter sido gradual); só avisa.
 *  - Tudo por organization_id (convenção nº 1).
 */
import db from "./db.js";

const dayNum = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);

type Range = { rows: number; firstDate: string | null; lastDate: string | null };

export class RetailFilialCodeAuditService {
  static report(orgId: string, opts: { into?: string | null } = {}) {
    const into = opts.into ? String(opts.into).trim() : "";
    const stores = db.prepare(`SELECT id, name, code, active FROM retail_stores WHERE organization_id = ? AND code IS NOT NULL AND TRIM(code) <> ''`).all(orgId) as any[];
    const activeCodes = new Set(stores.filter((s) => s.active === 1).map((s) => String(s.code).trim()));
    const target = into ? stores.find((s) => s.active === 1 && String(s.code).trim() === into) || null : null;

    const filiais = new Set<string>();
    for (const t of ["retail_pdv_sales", "retail_pdv_sale_items", "retail_pdv_card_installments", "retail_erp_seller_sales"]) {
      for (const r of db.prepare(`SELECT DISTINCT filial FROM ${t} WHERE organization_id = ? AND filial IS NOT NULL AND TRIM(filial) <> ''`).all(orgId) as any[]) filiais.add(String(r.filial).trim());
    }
    const orphans = [...filiais].filter((f) => !activeCodes.has(f)).sort();

    const rangeOf = (table: string, filial: string): Range => {
      const r = db.prepare(`SELECT COUNT(*) AS n, MIN(sale_date) AS a, MAX(sale_date) AS b FROM ${table} WHERE organization_id = ? AND filial = ?`).get(orgId, filial) as any;
      return { rows: Number(r.n), firstDate: r.a || null, lastDate: r.b || null };
    };
    const targetRange = target ? rangeOf("retail_pdv_sales", into) : null;

    // linhas do órfão que JÁ existem sob o destino (mesma chave natural) → reetiquetar colidiria
    const collide = (sql: string, filial: string): number => (db.prepare(sql).get(orgId, filial, orgId, into) as any).n;
    const rows = orphans.map((f) => {
      const pdv = rangeOf("retail_pdv_sales", f);
      const money = db.prepare(`SELECT ROUND(COALESCE(SUM(CASE WHEN COALESCE(status,'N') <> 'C' THEN valor ELSE 0 END),0),2) AS total, COUNT(DISTINCT NULLIF(vendedor_codigo,'')) AS sellers FROM retail_pdv_sales WHERE organization_id = ? AND filial = ?`).get(orgId, f) as any;
      const items = rangeOf("retail_pdv_sale_items", f);
      const inst = rangeOf("retail_pdv_card_installments", f);
      const erp = rangeOf("retail_erp_seller_sales", f);
      const rec = stores.find((s) => String(s.code).trim() === f) || null;
      let collisions: null | { pdvSales: number; saleItems: number; cardInstallments: number; erpSellerSales: number; total: number } = null;
      if (target) {
        const c = {
          pdvSales: collide(`SELECT COUNT(*) n FROM retail_pdv_sales a WHERE a.organization_id = ? AND a.filial = ? AND EXISTS (SELECT 1 FROM retail_pdv_sales b WHERE b.organization_id = ? AND b.filial = ? AND b.boleta = a.boleta AND b.sale_date = a.sale_date)`, f),
          saleItems: collide(`SELECT COUNT(*) n FROM retail_pdv_sale_items a WHERE a.organization_id = ? AND a.filial = ? AND EXISTS (SELECT 1 FROM retail_pdv_sale_items b WHERE b.organization_id = ? AND b.filial = ? AND b.boleta = a.boleta AND b.sale_date = a.sale_date AND b.item_seq = a.item_seq)`, f),
          cardInstallments: collide(`SELECT COUNT(*) n FROM retail_pdv_card_installments a WHERE a.organization_id = ? AND a.filial = ? AND EXISTS (SELECT 1 FROM retail_pdv_card_installments b WHERE b.organization_id = ? AND b.filial = ? AND b.numero = a.numero AND b.parcela = a.parcela AND b.seq = a.seq)`, f),
          erpSellerSales: collide(`SELECT COUNT(*) n FROM retail_erp_seller_sales a WHERE a.organization_id = ? AND a.filial = ? AND EXISTS (SELECT 1 FROM retail_erp_seller_sales b WHERE b.organization_id = ? AND b.filial = ? AND b.matricula = a.matricula AND b.sale_date = a.sale_date)`, f),
          total: 0,
        };
        c.total = c.pdvSales + c.saleItems + c.cardInstallments + c.erpSellerSales;
        collisions = c;
      }
      const overlaps = !!(targetRange && pdv.firstDate && pdv.lastDate && targetRange.firstDate && targetRange.lastDate
        && pdv.firstDate <= targetRange.lastDate && targetRange.firstDate <= pdv.lastDate);
      return {
        filial: f,
        storeRecord: rec ? { id: rec.id, name: rec.name, active: rec.active === 1 } : null,
        pdvSales: { ...pdv, total: Number(money.total || 0), sellers: Number(money.sellers || 0) },
        saleItems: items, cardInstallments: inst, erpSellerSales: erp,
        collisions,
        overlapsTarget: target ? overlaps : null,
        gapDaysToTarget: target && pdv.lastDate && targetRange?.firstDate ? dayNum(targetRange.firstDate) - dayNum(pdv.lastDate) : null,
        cleanToRemap: collisions ? collisions.total === 0 : null,
      };
    });

    return {
      readOnly: true,
      into: into || null,
      target: target ? { id: target.id, name: target.name, code: into, pdvSales: targetRange } : null,
      intoNotFound: !!into && !target,
      activeStores: stores.filter((s) => s.active === 1).map((s) => ({ name: s.name, code: String(s.code).trim() })),
      orphans: rows,
      summary: {
        orphanCodes: rows.length,
        pdvSales: rows.reduce((a, r) => a + r.pdvSales.rows, 0),
        pdvTotal: Math.round(rows.reduce((a, r) => a + r.pdvSales.total, 0) * 100) / 100,
        withCollisions: rows.filter((r) => r.collisions && r.collisions.total > 0).length,
      },
      notes: [
        "Nada foi alterado. Esta é só a prévia: reetiquetar o histórico é uma etapa separada, depois da sua decisão.",
        "Período sobreposto ao do destino não prova que são lojas diferentes; confira com o histórico de trocas de código da loja.",
        ...(into && !target ? [`Não há loja ATIVA com o código ${into}; escolha um destino da lista de lojas ativas.`] : []),
        ...(!into ? ["Informe o código destino (ex.: 1084) para ver colisões e sobreposição."] : []),
      ],
    };
  }
}
