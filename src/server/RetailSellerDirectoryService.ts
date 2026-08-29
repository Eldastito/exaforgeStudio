/**
 * RetailSellerDirectoryService — diretório de vendedores + lotação por loja
 * (PDR Estabilização TOULON, Fatia 2 / SELL-001..008).
 *
 * `retail_sellers` é a IDENTIDADE canônica (matrícula ERP), global por org — sem
 * store_id de propósito (um vendedor pode cobrir outra loja). A LOTAÇÃO (em que
 * lojas o vendedor atua) vive numa tabela SEPARADA `retail_seller_store_assignments`
 * — vincular a outra loja NÃO duplica a identidade.
 *
 * Descoberta por filial (SELL-003): a partir das vendas Alterdata, lista por loja
 * os códigos `CAI_USUARIO` (vendedor) distintos — com nome (confirmado), sem nome
 * (pendência acionável) e suspeitos de compartilhamento (SELL-008: uma filial com
 * volume relevante e UM único código para várias pessoas). É DIAGNÓSTICO, nunca
 * confirmação automática de pessoa (RN §4/§5).
 *
 * Guardrails:
 *  - RN-SELL-1: matrícula/código compartilhado do ERP não é pessoa confirmada.
 *  - RN-SELL-2: identidade canônica; lotação é relação temporal separada.
 *  - RN-SELL-3: tudo isolado por organization_id.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

// Acima disto, uma filial com UM ÚNICO código de vendedor é suspeita de caixa/
// login compartilhado (o código não representa uma pessoa).
const SHARED_CODE_MIN_SALES = 150;

export class RetailSellerDirectoryService {
  /** Lojas (ativas) em que um vendedor está lotado. */
  static storesForSeller(orgId: string, sellerId: string): any[] {
    return db.prepare(
      `SELECT a.store_id, a.is_primary, a.source, a.confirmed_at, s.name AS store_name, s.code AS store_code
         FROM retail_seller_store_assignments a
         JOIN retail_stores s ON s.organization_id = a.organization_id AND s.id = a.store_id
        WHERE a.organization_id = ? AND a.seller_id = ? AND a.active = 1
        ORDER BY a.is_primary DESC, s.name`
    ).all(orgId, sellerId) as any[];
  }

  /** Vendedores lotados numa loja (identidade + se é principal). */
  static sellersForStore(orgId: string, storeId: string): any[] {
    return db.prepare(
      `SELECT s.id AS seller_id, s.matricula, s.name, s.identity_status, a.is_primary
         FROM retail_seller_store_assignments a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND a.active = 1 AND s.active = 1
        ORDER BY s.name`
    ).all(orgId, storeId) as any[];
  }

  /**
   * Define a lotação de um vendedor (SELL-002). Reconcilia: desativa vínculos que
   * saíram (efetiva o fim, nunca DELETE) e cria/reativa os novos. `primaryStoreId`
   * marca a loja principal. Um vendedor pode ter N lojas.
   */
  static setStores(orgId: string, sellerId: string, storeIds: string[], primaryStoreId: string | null, actorId?: string): any[] {
    const seller = db.prepare(`SELECT id FROM retail_sellers WHERE organization_id = ? AND id = ?`).get(orgId, sellerId) as any;
    if (!seller) throw new Error("Vendedor não encontrado.");
    const wanted = new Set((storeIds || []).map(String));
    // valida que as lojas existem na org
    for (const sid of wanted) {
      if (!db.prepare(`SELECT 1 FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, sid)) throw new Error("Loja inválida na lotação.");
    }
    const current = db.prepare(`SELECT id, store_id FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND active = 1`).all(orgId, sellerId) as any[];
    const currentByStore = new Map(current.map((c) => [c.store_id, c]));

    const tx = db.transaction(() => {
      // desativa os que saíram
      for (const c of current) {
        if (!wanted.has(c.store_id)) {
          db.prepare(`UPDATE retail_seller_store_assignments SET active = 0, effective_to = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        }
      }
      // cria os novos + ajusta is_primary
      for (const sid of wanted) {
        const isPrimary = primaryStoreId && sid === primaryStoreId ? 1 : 0;
        const existing = currentByStore.get(sid);
        if (existing) {
          db.prepare(`UPDATE retail_seller_store_assignments SET is_primary = ? WHERE id = ?`).run(isPrimary, existing.id);
        } else {
          db.prepare(
            `INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active, source, confirmed_by, confirmed_at)
             VALUES (?, ?, ?, ?, ?, 1, 'manual', ?, CURRENT_TIMESTAMP)`
          ).run(randomUUID(), orgId, sellerId, sid, isPrimary, actorId || null);
        }
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", sellerId, "RETAIL_SELLER_STORES_SET", { storeIds: [...wanted], primaryStoreId }); } catch { /* noop */ }
    return this.storesForSeller(orgId, sellerId);
  }

  /**
   * Descoberta por filial (SELL-003/005): códigos de vendedor vistos nas vendas
   * da loja, separados em confirmados / pendentes de nome / suspeitos de código
   * compartilhado. Diagnóstico — nunca cria vendedor automaticamente.
   */
  static discoverByStore(orgId: string, storeId: string): { confirmed: any[]; pendingName: any[]; sharedCodeSuspects: any[] } {
    const store = db.prepare(`SELECT code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const code = store.code || "";
    const rows = db.prepare(
      `SELECT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS codigo,
              COUNT(*) AS sales, MIN(sale_date) AS first_sale, MAX(sale_date) AS last_sale
         FROM retail_pdv_sales
        WHERE organization_id = ? AND filial = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> ''
        GROUP BY codigo ORDER BY sales DESC`
    ).all(orgId, code) as any[];

    const distinctCodes = rows.length;
    const confirmed: any[] = [], pendingName: any[] = [], sharedCodeSuspects: any[] = [];
    for (const r of rows) {
      const seller = db.prepare(`SELECT id, name, identity_status FROM retail_sellers WHERE organization_id = ? AND matricula = ?`).get(orgId, r.codigo) as any;
      const item = { codigo: r.codigo, sales: Number(r.sales), firstSale: r.first_sale, lastSale: r.last_sale, sellerId: seller?.id || null, name: seller?.name || null };
      // Suspeita de código compartilhado: a filial tem UM só código e volume alto.
      const shared = distinctCodes === 1 && Number(r.sales) >= SHARED_CODE_MIN_SALES;
      if (shared) sharedCodeSuspects.push({ ...item, reason: "single_code_high_volume" });
      else if (seller?.name) confirmed.push(item);
      else pendingName.push(item);
    }
    return { confirmed, pendingName, sharedCodeSuspects };
  }

  /**
   * Cobertura de vendedores da loja (SELL-006/SCHED-002): lotados + pendências +
   * suspeitos de código compartilhado, num só lugar pro painel.
   */
  static coverage(orgId: string, storeId: string): any {
    const roster = this.sellersForStore(orgId, storeId);
    const discovery = this.discoverByStore(orgId, storeId);
    return {
      storeId,
      lotados: roster,
      pendingName: discovery.pendingName,
      sharedCodeSuspects: discovery.sharedCodeSuspects,
      // SELL-006: a org já usa lotação? (se não, a escala cai no comportamento
      // legado de listar todos os vendedores mapeados — 0-regressão).
      orgUsesAssignments: this.orgUsesAssignments(orgId),
      counts: {
        lotados: roster.length,
        pendingName: discovery.pendingName.length,
        sharedCodeSuspects: discovery.sharedCodeSuspects.length,
        confirmedInErp: discovery.confirmed.length,
      },
    };
  }

  /** A org tem QUALQUER lotação ativa cadastrada? (decide o fallback da escala.) */
  static orgUsesAssignments(orgId: string): boolean {
    const r = db.prepare(`SELECT 1 FROM retail_seller_store_assignments WHERE organization_id = ? AND active = 1 LIMIT 1`).get(orgId);
    return !!r;
  }

  /**
   * Sugere a PRÓXIMA matrícula seguindo o PADRÃO DA REDE (auto-preenchimento no
   * cadastro de um vendedor novo). Regra determinística:
   *  1. incrementa a MAIOR matrícula numérica já vista na loja escolhida — os
   *     códigos `CAI_USUARIO` do PDV daquela filial + os vendedores já lotados —
   *     preservando prefixo e largura (zero-pad). Ex.: 10650047 → 10650048;
   *  2. sem base numérica na loja, usa o CÓDIGO DA FILIAL como prefixo + `0001`
   *     (ex.: filial 1065 → 10650001);
   *  3. por fim, um contador simples de 4 dígitos.
   * Sempre devolve uma matrícula que AINDA NÃO existe em `retail_sellers` (a
   * chave única por org), incrementando até achar uma livre.
   */
  static nextMatricula(orgId: string, storeId: string): string {
    const store = db.prepare(`SELECT code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const code = String(store.code || "").trim();

    const taken = (m: string) => !!db.prepare(`SELECT 1 FROM retail_sellers WHERE organization_id = ? AND matricula = ?`).get(orgId, m);
    // Devolve `base` se estiver livre; senão incrementa (preservando a largura) até achar uma livre.
    const free = (base: string): string => {
      const width = base.length;
      let n = BigInt(base);
      let cand = base;
      while (taken(cand)) { n += 1n; cand = n.toString().padStart(width, "0"); }
      return cand;
    };

    // Pool de matrículas numéricas ligadas à loja: códigos do PDV da filial +
    // vendedores já lotados nela.
    const pool = new Set<string>();
    if (code) {
      for (const r of db.prepare(
        `SELECT DISTINCT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS m FROM retail_pdv_sales
          WHERE organization_id = ? AND filial = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> ''`
      ).all(orgId, code) as any[]) pool.add(String(r.m));
    }
    for (const r of this.sellersForStore(orgId, storeId)) pool.add(String(r.matricula));
    const numeric = [...pool].filter((m) => /^\d+$/.test(m));

    if (numeric.length) {
      const max = numeric.reduce((a, b) => (BigInt(a) >= BigInt(b) ? a : b));
      return free((BigInt(max) + 1n).toString().padStart(max.length, "0"));
    }
    if (/^\d+$/.test(code)) return free(code + "0001"); // 1ª matrícula da loja no padrão da filial
    return free("0001"); // sem qualquer base numérica: contador simples
  }

  /**
   * "Excluir" um vendedor = DESATIVA a identidade (active=0) e ENCERRA todas as
   * lotações ativas. Nunca DELETE físico: a comissão/venda histórica continua
   * ligada pela matrícula (RN-SELL-2 — identidade canônica). Idempotente.
   */
  static deactivateSeller(orgId: string, sellerId: string, actorId?: string): void {
    const seller = db.prepare(`SELECT id, matricula FROM retail_sellers WHERE organization_id = ? AND id = ?`).get(orgId, sellerId) as any;
    if (!seller) throw new Error("Vendedor não encontrado.");
    const tx = db.transaction(() => {
      db.prepare(`UPDATE retail_sellers SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, sellerId);
      db.prepare(`UPDATE retail_seller_store_assignments SET active = 0, effective_to = CURRENT_TIMESTAMP WHERE organization_id = ? AND seller_id = ? AND active = 1`).run(orgId, sellerId);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", sellerId, "RETAIL_SELLER_DEACTIVATED", { matricula: seller.matricula }); } catch { /* noop */ }
  }
}

export default RetailSellerDirectoryService;
