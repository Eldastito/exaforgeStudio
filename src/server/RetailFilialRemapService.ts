/**
 * RetailFilialRemapService — troca de código de filial no HISTÓRICO (loja que mudou de código: 1006 → 1084).
 *
 * PDV, itens, parcelas de cartão e vendas por vendedor do ERP casam a loja pelo número da filial. Quando a loja muda de
 * código, o histórico fica sob o código antigo e some dos números da loja. Aqui o código antigo é REETIQUETADO para o atual.
 *
 * Garantias (decisão do dono: "aplicar só depois de ver os números"):
 *  - `plan` é só leitura e devolve, por tabela, o que MOVE e o que FICA.
 *  - `apply` exige o código antigo SEM loja ativa (nunca mexe em filial viva), o destino ATIVO, a digitação de
 *    `${from}>${to}` e os mesmos números do plano (se o histórico mudou desde a prévia, recusa).
 *  - Linha que JÁ existe sob o destino (mesma chave natural) NUNCA é sobrescrita nem apagada: fica no lugar e sai no relatório.
 *    Item/parcela de uma venda que ficou também fica (a venda não pode ser dividida entre dois códigos).
 *  - Uma transação só; o id de cada linha movida é registrado → `undo` devolve exatamente essas linhas.
 *  - Tudo por organization_id.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

type Spec = { table: string; label: string; keys: string[]; parent: boolean };
const SPECS: Spec[] = [
  { table: "retail_pdv_sales", label: "pdvSales", keys: ["boleta", "sale_date"], parent: false },
  { table: "retail_pdv_sale_items", label: "saleItems", keys: ["boleta", "sale_date", "item_seq"], parent: true },
  { table: "retail_pdv_card_installments", label: "cardInstallments", keys: ["numero", "parcela", "seq"], parent: true },
  { table: "retail_erp_seller_sales", label: "erpSellerSales", keys: ["matricula", "sale_date"], parent: false },
];

const collisionSql = (sp: Spec) =>
  `EXISTS (SELECT 1 FROM ${sp.table} b WHERE b.organization_id = a.organization_id AND b.filial = @into AND ${sp.keys.map((k) => `b.${k} = a.${k}`).join(" AND ")})`;
// item/parcela cuja VENDA tem par sob o destino: fica junto da venda
const parentSql = (sp: Spec) => !sp.parent ? "0" :
  `EXISTS (SELECT 1 FROM retail_pdv_sales pa JOIN retail_pdv_sales pb ON pb.organization_id = pa.organization_id AND pb.filial = @into AND pb.boleta = pa.boleta AND pb.sale_date = pa.sale_date
            WHERE pa.organization_id = a.organization_id AND pa.filial = @from AND pa.boleta = a.boleta AND pa.sale_date = a.sale_date)`;
const movableSql = (sp: Spec) => `a.organization_id = @org AND a.filial = @from AND NOT ${collisionSql(sp)} AND NOT ${parentSql(sp)}`;

export type TableCounts = { total: number; move: number; stay: number };

export class RetailFilialRemapService {
  private static check(orgId: string, from: string, into: string) {
    const f = String(from ?? "").trim(), t = String(into ?? "").trim();
    if (!f || !t) throw new Error("Informe o código antigo e o código atual.");
    if (f === t) throw new Error("O código antigo e o atual são iguais.");
    const stores = db.prepare(`SELECT id, name, code, active FROM retail_stores WHERE organization_id = ? AND code IS NOT NULL`).all(orgId) as any[];
    if (stores.some((s) => s.active === 1 && String(s.code).trim() === f)) throw new Error(`O código ${f} pertence a uma loja ATIVA — não é código antigo. Nada foi feito.`);
    const target = stores.find((s) => s.active === 1 && String(s.code).trim() === t);
    if (!target) throw new Error(`Não há loja ativa com o código ${t}.`);
    return { from: f, into: t, targetName: target.name as string };
  }

  /** Só leitura: o que moveria e o que ficaria (colisão), por tabela. */
  static plan(orgId: string, from: string, into: string) {
    const c = this.check(orgId, from, into);
    const p = { org: orgId, from: c.from, into: c.into };
    const tables: Record<string, TableCounts> = {};
    for (const sp of SPECS) {
      const total = (db.prepare(`SELECT COUNT(*) n FROM ${sp.table} a WHERE a.organization_id = @org AND a.filial = @from`).get(p) as any).n;
      const move = (db.prepare(`SELECT COUNT(*) n FROM ${sp.table} a WHERE ${movableSql(sp)}`).get(p) as any).n;
      tables[sp.label] = { total, move, stay: total - move };
    }
    // vendas que ficam: idênticas (mesmo valor e vendedor) ou DIFERENTES (valor/vendedor divergem — conferir à mão)
    const stayIdentical = (db.prepare(
      `SELECT COUNT(*) n FROM retail_pdv_sales a WHERE a.organization_id = @org AND a.filial = @from AND EXISTS (
         SELECT 1 FROM retail_pdv_sales b WHERE b.organization_id = a.organization_id AND b.filial = @into AND b.boleta = a.boleta AND b.sale_date = a.sale_date
           AND ROUND(COALESCE(b.valor,0),2) = ROUND(COALESCE(a.valor,0),2) AND COALESCE(b.vendedor_codigo,'') = COALESCE(a.vendedor_codigo,''))`).get(p) as any).n;
    const salesStayByCollision = (db.prepare(`SELECT COUNT(*) n FROM retail_pdv_sales a WHERE a.organization_id = @org AND a.filial = @from AND ${collisionSql(SPECS[0])}`).get(p) as any).n;
    const range = db.prepare(`SELECT MIN(sale_date) a, MAX(sale_date) b, ROUND(COALESCE(SUM(CASE WHEN COALESCE(status,'N') <> 'C' THEN valor ELSE 0 END),0),2) total FROM retail_pdv_sales a WHERE ${movableSql(SPECS[0])}`).get(p) as any;
    return {
      readOnly: true, from: c.from, into: c.into, targetName: c.targetName, tables,
      salesCollisions: { identical: stayIdentical, different: salesStayByCollision - stayIdentical },
      moving: { firstDate: range.a || null, lastDate: range.b || null, pdvTotal: Number(range.total || 0) },
      willMoveRows: Object.values(tables).reduce((a, t) => a + t.move, 0),
      confirmWith: `${c.from}>${c.into}`,
    };
  }

  static apply(orgId: string, input: { from: string; into: string; confirm: string; expectedMove: Record<string, number> }, actorId?: string | null) {
    const pl = this.plan(orgId, input.from, input.into);
    if (String(input.confirm ?? "").trim() !== pl.confirmWith) throw new Error(`confirm_mismatch: digite ${pl.confirmWith} para confirmar.`);
    for (const sp of SPECS) {
      if (Number(input.expectedMove?.[sp.label]) !== pl.tables[sp.label].move) throw new Error("plan_changed: o histórico mudou desde a prévia — confira de novo.");
    }
    if (pl.willMoveRows === 0) throw new Error("nothing_to_move: não há linha para mover.");
    const id = randomUUID();
    const p = { org: orgId, from: pl.from, into: pl.into };
    const run = db.transaction(() => {
      db.prepare(`INSERT INTO retail_filial_remaps (id, organization_id, from_filial, into_filial, counts_json, actor_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, orgId, pl.from, pl.into, JSON.stringify({ moved: Object.fromEntries(Object.entries(pl.tables).map(([k, v]) => [k, v.move])), stayed: Object.fromEntries(Object.entries(pl.tables).map(([k, v]) => [k, v.stay])) }), actorId || null);
      for (const sp of SPECS) {
        db.prepare(`INSERT INTO retail_filial_remap_rows (remap_id, table_name, row_id) SELECT @rid, @tbl, a.id FROM ${sp.table} a WHERE ${movableSql(sp)}`).run({ ...p, rid: id, tbl: sp.table });
        const logged = (db.prepare(`SELECT COUNT(*) n FROM retail_filial_remap_rows WHERE remap_id = ? AND table_name = ?`).get(id, sp.table) as any).n;
        if (logged !== pl.tables[sp.label].move) throw new Error("plan_changed: o histórico mudou durante a troca — nada foi alterado.");
        const r = db.prepare(`UPDATE ${sp.table} SET filial = @into WHERE organization_id = @org AND filial = @from AND id IN (SELECT row_id FROM retail_filial_remap_rows WHERE remap_id = @rid AND table_name = @tbl)`).run({ ...p, rid: id, tbl: sp.table });
        if (r.changes !== logged) throw new Error("apply_mismatch: contagem divergente — nada foi alterado.");
      }
    });
    run();
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_FILIAL_REMAPPED", { from: pl.from, into: pl.into, moved: pl.willMoveRows }); } catch { /* noop */ }
    return { remapId: id, from: pl.from, into: pl.into, moved: Object.fromEntries(Object.entries(pl.tables).map(([k, v]) => [k, v.move])), stayed: Object.fromEntries(Object.entries(pl.tables).map(([k, v]) => [k, v.stay])) };
  }

  /** Devolve exatamente as linhas movidas por esta troca. Linha que já tem par sob o código antigo fica e é contada. */
  static undo(orgId: string, remapId: string, actorId?: string | null) {
    const rm = db.prepare(`SELECT * FROM retail_filial_remaps WHERE organization_id = ? AND id = ?`).get(orgId, remapId) as any;
    if (!rm) throw new Error("Troca não encontrada.");
    if (rm.undone_at) throw new Error("already_undone: esta troca já foi desfeita.");
    const back: Record<string, number> = {}, left: Record<string, number> = {};
    db.transaction(() => {
      for (const sp of SPECS) {
        const inLog = (db.prepare(`SELECT COUNT(*) n FROM retail_filial_remap_rows WHERE remap_id = ? AND table_name = ?`).get(remapId, sp.table) as any).n;
        const coll = `EXISTS (SELECT 1 FROM ${sp.table} b WHERE b.organization_id = ${sp.table}.organization_id AND b.filial = @from AND ${sp.keys.map((k) => `b.${k} = ${sp.table}.${k}`).join(" AND ")})`;
        const r = db.prepare(`UPDATE ${sp.table} SET filial = @from WHERE organization_id = @org AND filial = @into AND NOT ${coll} AND id IN (SELECT row_id FROM retail_filial_remap_rows WHERE remap_id = @rid AND table_name = @tbl)`)
          .run({ org: orgId, from: rm.from_filial, into: rm.into_filial, rid: remapId, tbl: sp.table });
        back[sp.label] = r.changes; left[sp.label] = inLog - r.changes;
      }
      db.prepare(`UPDATE retail_filial_remaps SET undone_at = CURRENT_TIMESTAMP, undone_by = ? WHERE id = ?`).run(actorId || null, remapId);
    })();
    try { logAuthEvent(orgId, actorId || "system", remapId, "RETAIL_FILIAL_REMAP_UNDONE", { from: rm.from_filial, into: rm.into_filial, back }); } catch { /* noop */ }
    return { remapId, from: rm.from_filial, into: rm.into_filial, returned: back, notReturned: left };
  }

  static history(orgId: string) {
    return (db.prepare(`SELECT id, from_filial, into_filial, counts_json, created_at, undone_at FROM retail_filial_remaps WHERE organization_id = ? ORDER BY created_at DESC LIMIT 20`).all(orgId) as any[])
      .map((r) => ({ id: r.id, from: r.from_filial, into: r.into_filial, counts: JSON.parse(r.counts_json || "{}"), createdAt: r.created_at, undoneAt: r.undone_at || null }));
  }
}
