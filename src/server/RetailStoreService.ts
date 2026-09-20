/**
 * Retail Ops — Cadastro de lojas (ADR-083, Fase A).
 *
 * Dimensão de loja física, inexistente até aqui (estoque/pedidos do core são só
 * por organização). Camada ADITIVA: nada aqui toca orders/inventory (D1). Cada
 * loja carrega o `whatsapp_identifier` que, nas fases seguintes, casa o
 * fechamento recebido pelo WhatsApp ao remetente/loja. Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { RetailAnalyticsCache } from "./RetailAnalyticsCache.js";
import { logAuthEvent } from "./auditLog.js";

export type StoreInput = {
  name: string;
  code?: string | null;
  whatsappIdentifier?: string | null;
  managerUserId?: string | null;
  managerContactId?: string | null;
  active?: boolean;
  address?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** null/'pdv' = comissão por vendedor vem do PDV normalmente (default). 'manual'
   * = o PDV dessa loja NÃO individualiza vendedor de verdade (CAI_USUARIO
   * compartilhado/anômalo) — a fonte de verdade passa a ser o lançamento
   * manual/foto (retail_seller_sales) feito no fechamento de caixa. */
  sellerSource?: "pdv" | "manual" | null;
  /** Margem bruta média da loja em % (0..100) — premissa gerencial usada para
   * estimar o LUCRO e o PONTO DE EQUILÍBRIO por loja (faturamento − custo da
   * mercadoria). null = não informada; nesse caso o resultado não é calculado. */
  grossMarginPercent?: number | null;
  /** Dias-da-semana em que a loja NÃO abre (0=domingo..6=sábado, strftime %w).
   * Nesses dias: sem cota (a distribuição mensal pula), fechamento bloqueado e
   * sem cobrança de pendência. A escala lançada no dia sempre vence (abre um
   * domingo excepcional). null/[] = abre todos os dias. */
  closedWeekdays?: number[] | null;
};

const STORE_COLS = `id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active, address, city, latitude, longitude, seller_source, gross_margin_percent, closed_weekdays, created_at, updated_at`;
const numOrNull = (v: any): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sellerSourceOrNull = (v: any): string | null => (v === "manual" ? "manual" : null);
// Margem em %: aceita 0..100; fora disso (ou vazio) vira null (não informada).
const marginOrNull = (v: any): number | null => {
  const n = numOrNull(v);
  if (n === null) return null;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
};
// Dias fechados: só inteiros 0..6, únicos e ordenados; vazio vira null. Todos
// os 7 dias fechados é cadastro sem sentido (loja que nunca abre) — rejeita.
const closedWeekdaysOrNull = (v: any): string | null => {
  if (v === null || v === undefined) return null;
  const arr = Array.isArray(v) ? v : [];
  const days = [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  if (!days.length) return null;
  if (days.length >= 7) throw new Error("A loja não pode estar fechada todos os dias da semana — desmarque pelo menos um dia.");
  return JSON.stringify(days);
};

export class RetailStoreService {
  static list(orgId: string): any[] {
    return db.prepare(
      `SELECT ${STORE_COLS} FROM retail_stores WHERE organization_id = ? ORDER BY active DESC, name ASC`
    ).all(orgId) as any[];
  }

  static get(orgId: string, id: string): any | null {
    return (db.prepare(
      `SELECT ${STORE_COLS} FROM retail_stores WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any) || null;
  }

  /** Resolve a loja pelo identificador de WhatsApp do remetente (fases B–D). */
  static findByWhatsapp(orgId: string, identifier: string): any | null {
    if (!identifier) return null;
    return (db.prepare(
      `SELECT * FROM retail_stores WHERE organization_id = ? AND whatsapp_identifier = ? AND active = 1 LIMIT 1`
    ).get(orgId, identifier) as any) || null;
  }

  /** Código de filial é a CHAVE do casamento com o ERP (estoque, caixa) — duas
   *  lojas ativas com o mesmo código fazem os dados caírem numa delas ao acaso. */
  private static assertCodeFree(orgId: string, code: string | null | undefined, exceptId?: string): void {
    const c = code ? String(code).trim() : "";
    if (!c) return;
    const dup = db.prepare(
      `SELECT name FROM retail_stores WHERE organization_id = ? AND active = 1 AND code = ? ${exceptId ? "AND id <> ?" : ""} LIMIT 1`
    ).get(...(exceptId ? [orgId, c, exceptId] : [orgId, c])) as any;
    if (dup) throw new Error(`Já existe a loja ativa "${dup.name}" com o código ${c}. Edite a loja existente em vez de criar outra (o código da filial precisa ser único — é por ele que o estoque e o caixa do ERP são casados).`);
  }

  static create(orgId: string, input: StoreInput, actorId?: string): any {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("Nome da loja é obrigatório");
    this.assertCodeFree(orgId, input.code);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_stores (id, organization_id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active, address, city, latitude, longitude, seller_source, gross_margin_percent, closed_weekdays)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, name,
      input.code ? String(input.code).trim() : null,
      input.whatsappIdentifier ? String(input.whatsappIdentifier).trim() : null,
      input.managerUserId || null,
      input.managerContactId || null,
      input.active === false ? 0 : 1,
      input.address ? String(input.address).trim() : null,
      input.city ? String(input.city).trim() : null,
      numOrNull(input.latitude),
      numOrNull(input.longitude),
      sellerSourceOrNull(input.sellerSource),
      marginOrNull(input.grossMarginPercent),
      closedWeekdaysOrNull(input.closedWeekdays)
    );
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_CREATED", { name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /**
   * Colunas com escopo por loja em TODO o schema, descobertas no runtime:
   * qualquer tabela com organization_id + (store_id | origin_store_id |
   * dest_store_id). É a lista única usada pelo merge de duplicata e pelo
   * resgate de órfãos — tabela nova entra sozinha, sem depender de lembrar
   * de atualizar uma lista na mão (foi assim que escala/malote ficaram órfãos).
   */
  static storeScopedColumns(): Array<{ table: string; column: string }> {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as any[];
    const out: Array<{ table: string; column: string }> = [];
    for (const t of tables) {
      const name = String(t.name || "");
      if (!name || name === "retail_stores") continue;
      let cols: any[] = [];
      try { cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as any[]; } catch { continue; }
      const colNames = new Set(cols.map((c) => String(c.name)));
      if (!colNames.has("organization_id")) continue;
      for (const column of ["store_id", "origin_store_id", "dest_store_id"]) {
        if (colNames.has(column)) out.push({ table: name, column });
      }
    }
    return out;
  }

  /**
   * EXCLUI uma loja duplicada com segurança: se existir OUTRA loja com o mesmo
   * código, todo o histórico é UNIFICADO nela antes de apagar — excluir sem
   * unificar perderia o que já foi gravado. Cobre fechamentos (com itens por
   * forma de pagamento e details_json), estoque, cotas, tarefas, alertas,
   * pedidos E TAMBÉM escala + template de folga + lotação de vendedores +
   * malote (depósitos, ajustes de dia, semanas fechadas) + boletas + vendas
   * por vendedor — antes essas ficavam órfãs no store_id apagado, então a
   * escala "sumia do fechamento" e o malote da loja unificada zerava.
   * Sem outra loja de mesmo código, só permite excluir se a loja não tiver
   * fechamentos nem estoque (senão: desativar).
   */
  static remove(orgId: string, id: string, actorId?: string): { deleted: boolean; mergedInto: string | null; mergedIntoName?: string } {
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Loja não encontrada.");
    const code = cur.code ? String(cur.code).trim() : "";
    const target = code
      ? (db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id <> ? AND code = ? ORDER BY active DESC, created_at ASC LIMIT 1`).get(orgId, id, code) as any)
      : null;

    if (!target) {
      const hasClosings = db.prepare(`SELECT 1 FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? LIMIT 1`).get(orgId, id);
      const hasStock = db.prepare(`SELECT 1 FROM retail_store_inventory WHERE organization_id = ? AND store_id = ? LIMIT 1`).get(orgId, id);
      if (hasClosings || hasStock) throw new Error("Esta loja tem fechamentos/estoque e não existe outra loja com o mesmo código para unificar — desative em vez de excluir.");
      db.prepare(`DELETE FROM retail_stores WHERE organization_id = ? AND id = ?`).run(orgId, id);
      try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_DELETED", { name: cur.name }); } catch { /* noop */ }
      return { deleted: true, mergedInto: null };
    }

    const tx = db.transaction(() => {
      // Fechamentos: move os dias que o alvo não tem; nos conflitos, completa
      // campos vazios do alvo com os da duplicata e descarta a linha duplicada.
      const conflicts = db.prepare(
        `SELECT s.id AS src_id, t.id AS tgt_id, s.informed_total AS s_inf, s.system_total AS s_sys, s.details_json AS s_det,
                t.informed_total AS t_inf, t.system_total AS t_sys, t.details_json AS t_det
           FROM retail_daily_closings s JOIN retail_daily_closings t
             ON t.organization_id = s.organization_id AND t.store_id = ? AND t.closing_date = s.closing_date
          WHERE s.organization_id = ? AND s.store_id = ?`
      ).all(target.id, orgId, id) as any[];
      for (const c of conflicts) {
        if (Number(c.t_inf || 0) === 0 && Number(c.s_inf || 0) > 0) db.prepare(`UPDATE retail_daily_closings SET informed_total = ?, status = 'received' WHERE id = ?`).run(c.s_inf, c.tgt_id);
        if (Number(c.t_sys || 0) === 0 && Number(c.s_sys || 0) > 0) db.prepare(`UPDATE retail_daily_closings SET system_total = ? WHERE id = ?`).run(c.s_sys, c.tgt_id);
        // A folha completa (despesas/ranking/malote) segue a mesma regra de
        // completar o vazio — sem ela o malote perdia as despesas do dia.
        if (!c.t_det && c.s_det) db.prepare(`UPDATE retail_daily_closings SET details_json = ? WHERE id = ?`).run(c.s_det, c.tgt_id);
        // Itens por forma de pagamento: alvo sem itens HERDA os da duplicata
        // (apagar aqui sumia com o 'dinheiro' do dia no malote); alvo com itens
        // mantém os dele e os da duplicata são descartados.
        const tgtHasItems = db.prepare(`SELECT 1 FROM retail_daily_closing_items WHERE closing_id = ? LIMIT 1`).get(c.tgt_id);
        if (!tgtHasItems) db.prepare(`UPDATE retail_daily_closing_items SET closing_id = ? WHERE closing_id = ?`).run(c.tgt_id, c.src_id);
        else db.prepare(`DELETE FROM retail_daily_closing_items WHERE closing_id = ?`).run(c.src_id);
        db.prepare(`DELETE FROM retail_daily_closings WHERE id = ?`).run(c.src_id);
      }
      db.prepare(`UPDATE retail_daily_closings SET store_id = ? WHERE organization_id = ? AND store_id = ?`).run(target.id, orgId, id);

      // Vendas por vendedor vindas do FECHAMENTO: nos dias em que o alvo já tem
      // as suas (source 'closing'), as da duplicata são descartadas — re-apontar
      // dobraria a base de comissão do dia. O resto re-aponta no loop abaixo.
      try {
        db.prepare(
          `DELETE FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? AND source = 'closing'
             AND sale_date IN (SELECT sale_date FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? AND source = 'closing')`
        ).run(orgId, id, orgId, target.id);
      } catch { /* noop */ }
      // TODA tabela com escopo por loja (descoberta no runtime — escala, folgas,
      // lotação, cotas de vendedor, malote, boletas, custos, PDV, piso etc.):
      // move o que não conflita nos UNIQUEs, descarta o resto (o alvo, que
      // continuou operando, tende a estar mais fresco). A lista dinâmica é o
      // que garante que tabela nova NUNCA mais fica órfã no merge.
      for (const { table, column } of RetailStoreService.storeScopedColumns()) {
        try {
          db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE organization_id = ? AND ${column} = ?`).run(target.id, orgId, id);
          db.prepare(`DELETE FROM ${table} WHERE organization_id = ? AND ${column} = ?`).run(orgId, id);
        } catch { /* tabela pode não existir em bases antigas */ }
      }
      db.prepare(`DELETE FROM retail_stores WHERE organization_id = ? AND id = ?`).run(orgId, id);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_MERGED_DELETED", { name: cur.name, into: target.id, intoName: target.name }); } catch { /* noop */ }
    return { deleted: true, mergedInto: target.id, mergedIntoName: target.name };
  }

  /**
   * RESGATE dos órfãos de merges feitos ANTES da correção do remove(): varre os
   * eventos RETAIL_STORE_MERGED_DELETED do audit (a loja apagada está em
   * target_user_id; a sobrevivente em metadata.into) e re-aponta pra
   * sobrevivente tudo que ficou apontando pro store_id apagado — escala,
   * template de folga, lotação, cotas de vendedor, malote (depósitos/ajustes/
   * semanas fechadas), boletas, vendas, custos, PDV etc. (storeScopedColumns).
   *
   * NUNCA apaga nada: linha que conflita com o que a sobrevivente já tem
   * (UNIQUE) fica onde está e sai no relatório como `leftover`; venda de
   * vendedor source='closing' de dia que a sobrevivente também tem fica no
   * lugar (mover dobraria a base de comissão). Dry-run por padrão (`apply`
   * falso conta e não grava). Idempotente: rodar de novo encontra 0 órfãos.
   */
  static rescueMergeOrphans(opts: { apply?: boolean; organizationId?: string | null } = {}): { apply: boolean; merges: any[] } {
    const apply = !!opts.apply;
    const events = db.prepare(
      `SELECT organization_id, target_user_id AS old_store_id, metadata_json, created_at FROM auth_audit_logs
        WHERE event_type = 'RETAIL_STORE_MERGED_DELETED' ${opts.organizationId ? "AND organization_id = ?" : ""}
        ORDER BY created_at`
    ).all(...(opts.organizationId ? [opts.organizationId] : [])) as any[];
    const cols = this.storeScopedColumns();
    const merges: any[] = [];
    for (const e of events) {
      let meta: any = {};
      try { meta = JSON.parse(e.metadata_json || "{}"); } catch { meta = {}; }
      const orgId = String(e.organization_id || "");
      const oldId = String(e.old_store_id || "");
      const newId = String(meta?.into || "");
      const entry: any = { orgId, oldId, oldName: meta?.name || null, newId, newName: meta?.intoName || null, mergedAt: e.created_at, status: "ok", tables: [], totalOrphans: 0, moved: 0, leftover: 0 };
      merges.push(entry);
      if (!orgId || !oldId || !newId) { entry.status = "skip: evento sem loja de destino"; continue; }
      const targetStore = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, newId) as any;
      if (!targetStore) { entry.status = "skip: loja sobrevivente não existe mais"; continue; }
      if (db.prepare(`SELECT 1 FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, oldId)) { entry.status = "skip: a loja 'apagada' ainda existe no cadastro"; continue; }
      entry.newName = targetStore.name || entry.newName;

      // Dias em que MOVER a venda 'closing' da órfã dobraria a da sobrevivente.
      let sellerSalesConflictDates: string[] = [];
      try {
        sellerSalesConflictDates = (db.prepare(
          `SELECT DISTINCT s.sale_date AS d FROM retail_seller_sales s
            WHERE s.organization_id = ? AND s.store_id = ? AND s.source = 'closing'
              AND EXISTS (SELECT 1 FROM retail_seller_sales t WHERE t.organization_id = s.organization_id AND t.store_id = ? AND t.source = 'closing' AND t.sale_date = s.sale_date)`
        ).all(orgId, oldId, newId) as any[]).map((r) => String(r.d));
      } catch { sellerSalesConflictDates = []; }

      const work = () => {
        for (const { table, column } of cols) {
          try {
            const orphans = Number((db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE organization_id = ? AND ${column} = ?`).get(orgId, oldId) as any)?.n || 0);
            if (!orphans) continue;
            let moved: number | null = null, leftover: number | null = null;
            if (apply) {
              if (table === "retail_seller_sales" && sellerSalesConflictDates.length) {
                const ph = sellerSalesConflictDates.map(() => "?").join(",");
                moved = db.prepare(
                  `UPDATE OR IGNORE retail_seller_sales SET store_id = ? WHERE organization_id = ? AND store_id = ?
                     AND NOT (source = 'closing' AND sale_date IN (${ph}))`
                ).run(newId, orgId, oldId, ...sellerSalesConflictDates).changes;
              } else {
                moved = db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE organization_id = ? AND ${column} = ?`).run(newId, orgId, oldId).changes;
              }
              leftover = orphans - moved; // conflito de UNIQUE / venda que dobraria — fica no lugar
            }
            entry.tables.push({ table, column, orphans, moved, leftover });
            entry.totalOrphans += orphans;
            if (apply) { entry.moved += moved || 0; entry.leftover += leftover || 0; }
          } catch { /* tabela pode não existir em bases antigas */ }
        }
      };
      if (apply) db.transaction(work)(); else work();
      if (apply && entry.moved > 0) {
        try { logAuthEvent(orgId, "system", oldId, "RETAIL_STORE_MERGE_RESCUED", { into: newId, moved: entry.moved, leftover: entry.leftover }); } catch { /* noop */ }
      }
    }
    return { apply, merges };
  }

  static update(orgId: string, id: string, patch: Partial<StoreInput>, actorId?: string): any | null {
    const cur = this.get(orgId, id);
    if (!cur) return null;
    const fields: string[] = [];
    const vals: any[] = [];
    const map: Record<string, any> = {
      name: patch.name !== undefined ? String(patch.name).trim() : undefined,
      code: patch.code !== undefined ? (patch.code ? String(patch.code).trim() : null) : undefined,
      whatsapp_identifier: patch.whatsappIdentifier !== undefined ? (patch.whatsappIdentifier ? String(patch.whatsappIdentifier).trim() : null) : undefined,
      manager_user_id: patch.managerUserId !== undefined ? (patch.managerUserId || null) : undefined,
      manager_contact_id: patch.managerContactId !== undefined ? (patch.managerContactId || null) : undefined,
      active: patch.active !== undefined ? (patch.active ? 1 : 0) : undefined,
      address: patch.address !== undefined ? (patch.address ? String(patch.address).trim() : null) : undefined,
      city: patch.city !== undefined ? (patch.city ? String(patch.city).trim() : null) : undefined,
      latitude: patch.latitude !== undefined ? numOrNull(patch.latitude) : undefined,
      longitude: patch.longitude !== undefined ? numOrNull(patch.longitude) : undefined,
      seller_source: patch.sellerSource !== undefined ? sellerSourceOrNull(patch.sellerSource) : undefined,
      gross_margin_percent: patch.grossMarginPercent !== undefined ? marginOrNull(patch.grossMarginPercent) : undefined,
      closed_weekdays: patch.closedWeekdays !== undefined ? closedWeekdaysOrNull(patch.closedWeekdays) : undefined,
    };
    // Guarda de código único entre lojas ATIVAS: cobre troca de código e
    // REATIVAÇÃO de loja cujo código já está em uso por outra ativa.
    const nextCode = map.code !== undefined ? map.code : cur.code;
    const willBeActive = map.active !== undefined ? map.active === 1 : cur.active === 1;
    if (willBeActive) this.assertCodeFree(orgId, nextCode, id);
    for (const [col, v] of Object.entries(map)) {
      if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v); }
    }
    if (!fields.length) return cur;
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    db.prepare(`UPDATE retail_stores SET ${fields.join(", ")} WHERE organization_id = ? AND id = ?`).run(...vals, orgId, id);
    // PERF-005: margem/código/ativação da loja mexem nos números da rede.
    RetailAnalyticsCache.invalidate(orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_UPDATED", { fields: Object.keys(map).filter((k) => map[k] !== undefined) }); } catch { /* noop */ }
    return this.get(orgId, id);
  }
}
