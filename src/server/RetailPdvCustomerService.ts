/**
 * Retail Ops — Leitura dos clientes do PDV (Alterdata) com contexto de loja.
 *
 * PRD Moda/TOULON, frente CRM (Fase 1). ADITIVO sobre o endpoint existente
 * `/api/retailops/pdv-customers`: acrescenta filtro por FILIAL e enriquece cada
 * cliente com a loja (id/nome) e o timestamp da última sincronização.
 *
 * Invariantes:
 *  - Isolamento por organização (RN nº 1): a filial só ESTREITA dentro da própria
 *    org — o cliente é sempre `organization_id = orgId`. Filtrar por filial NÃO
 *    amplia acesso (hoje todo usuário da org já vê todos os clientes da org).
 *  - CRM-003: `filial` é a de CADASTRO/origem, NÃO exclusividade de compra. Por
 *    isso `store_relation_type` é fixo em 'cadastro' — a relação cliente×loja de
 *    COMPRA (CRM-004) depende de identificador de cliente nas vendas Alterdata e
 *    é fatia futura; não inferir pertencimento a partir da filial gravada.
 *  - Filial sem loja cadastrada (código não bate com `retail_stores.code`) →
 *    `store_id`/`store_name` = null (honesto; não mistura com outra loja).
 *
 * NÃO cobre CRM-002/AC-04 (trava por usuário — gerente restrito a uma loja):
 * isso exige um modelo de escopo-de-loja por usuário que ainda não existe.
 */
import db from "./db.js";

export type PdvCustomerQuery = {
  q?: string;
  store?: string;          // código da filial (retail_stores.code)
  birthdayMonth?: string;  // "MM"
  limit?: string | number;
  offset?: string | number;
};

export class RetailPdvCustomerService {
  static list(orgId: string, query: PdvCustomerQuery = {}) {
    const q = String(query.q || "").trim();
    const store = String(query.store || "").trim();
    const bMonth = String(query.birthdayMonth || "").trim().padStart(2, "0");
    const limit = Math.min(500, Math.max(1, parseInt(String(query.limit ?? "100"), 10) || 100));
    const offset = Math.max(0, parseInt(String(query.offset ?? "0"), 10) || 0);

    const where: string[] = ["c.organization_id = ?"];
    const args: any[] = [orgId];
    if (q) { where.push("(c.nome LIKE ? OR c.cpf LIKE ? OR c.celular LIKE ?)"); const like = `%${q}%`; args.push(like, like, like); }
    // Só filtra por aniversário com um mês REAL (01–12). Sem o mês, `bMonth`
    // vira "00" (padStart de vazio) — que NÃO pode virar filtro, senão a lista
    // volta vazia (bug latente do endpoint original).
    if (/^(0[1-9]|1[0-2])$/.test(bMonth)) { where.push("substr(c.nascimento, 6, 2) = ?"); args.push(bMonth); }
    // CRM-001: filtro por FILIAL (código da loja no ERP).
    if (store) { where.push("c.filial = ?"); args.push(store); }
    const whereSql = where.join(" AND ");

    const total = Number((db.prepare(
      `SELECT COUNT(*) c FROM retail_pdv_customers c WHERE ${whereSql}`
    ).get(...args) as any)?.c || 0);

    // LEFT JOIN só com loja ATIVA: o código é único entre lojas ativas
    // (RetailStoreService.assertCodeFree), então não multiplica linha.
    const rows = db.prepare(
      `SELECT c.codigo_n, c.nome, c.cpf, c.celular, c.email, c.nascimento, c.filial,
              c.cidade, c.ultima_compra, c.updated_at AS source_synced_at,
              s.id AS store_id, s.name AS store_name
         FROM retail_pdv_customers c
         LEFT JOIN retail_stores s
           ON s.organization_id = c.organization_id AND s.active = 1 AND s.code = c.filial
        WHERE ${whereSql}
        ORDER BY c.nome LIMIT ? OFFSET ?`
    ).all(...args, limit, offset) as any[];

    const customers = rows.map((r) => ({
      ...r,
      store_id: r.store_id || null,
      store_name: r.store_name || null,
      // CRM-003: filial de CADASTRO; não é loja de compra.
      store_relation_type: "cadastro" as const,
    }));

    // Lojas ativas da org (para o seletor da UI) — limitado à própria org.
    const stores = db.prepare(
      `SELECT id, code, name FROM retail_stores
        WHERE organization_id = ? AND active = 1 AND code IS NOT NULL AND TRIM(code) <> ''
        ORDER BY name`
    ).all(orgId) as any[];

    return { total, customers, stores };
  }
}
