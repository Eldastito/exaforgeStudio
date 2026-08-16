/**
 * Retail Floor — Conciliação declarado × PDV (ADR-150, Fatia 6).
 *
 * O "ponto crítico" do PRD: as vendas da TOULON são lançadas no PDV no FIM DO
 * DIA, então "vendedor declarou que vendeu" ≠ "venda confirmada" (RN-150-004).
 * Esta fatia promove/rebaixa o `reconciliation_state` dos atendimentos
 * `converted` cruzando com as vendas do ERP.
 *
 * REALIDADE DO DADO: `retail_erp_seller_sales` (ADR-105) é AGREGADO DIÁRIO por
 * (filial, matrícula) — não existe venda a venda. Logo o matching é no nível
 * (loja, vendedor, dia), por COBERTURA DE VALOR:
 *
 *  1. Par loja↔ERP: es.store_id quando o sync resolveu; senão filial =
 *     retail_stores.code. Vendedor↔ERP: retail_sellers.matricula.
 *  2. erpValor <= 0 no dia → TODOS os declarados do vendedor viram
 *     `unmatched` (declarou, PDV não registrou nada).
 *  3. erpValor > 0 → confirma na ordem de started_at enquanto a soma dos
 *     valores declarados cabe em erpValor × (1 + 5% de tolerância); o que não
 *     coube vira `unmatched`. Determinístico e conservador — não inventa qual
 *     venda é de quem.
 *  4. Declarado SEM valor informado: confirmado quando o PDV mostra venda no
 *     dia (não dá pra desprovar; não consome o orçamento de cobertura) —
 *     documentado, e o gerente pode rebaixar no override.
 *  5. Re-rodar é idempotente e SÓ PROMOVE: pending/unmatched podem virar
 *     confirmed quando o PDV chega atrasado; confirmed NUNCA é rebaixado
 *     automaticamente — rebaixar é ação humana auditada (override).
 *
 * Override manual (RN-150-005): gestor da loja força confirmed|unmatched com
 * auditoria — o caso "vendeu no CAI_USUARIO do colega" só o humano resolve.
 *
 * RN-150-001: orgId sempre 1º arg; tudo filtra organization_id.
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailFloorService } from "./RetailFloorService.js";

const TOLERANCE = 0.05; // 5% sobre o total do ERP no dia
const OVERRIDE_STATES = ["confirmed", "unmatched"];

type UserRef = { userId?: string; id?: string; role?: string };
const uid = (u: UserRef) => u?.userId || u?.id || null;

export class RetailFloorReconciliationService {
  /**
   * Concilia um DIA de uma loja. Idempotente e só-promove (regra 5 do header).
   * Retorna o resumo do dia (mesma forma do summary).
   */
  static runDay(orgId: string, storeId: string, date: string, actorId?: string | null): any {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("date deve ser YYYY-MM-DD.");
    const store = db.prepare(`SELECT id, code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");

    // Declarados do dia ainda promovíveis (pending|unmatched), por vendedor.
    const pendings = db.prepare(
      `SELECT a.*, s.matricula FROM retail_floor_attendances a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND date(a.started_at) = ?
          AND a.outcome = 'converted' AND a.reconciliation_state IN ('pending','unmatched')
        ORDER BY a.seller_id, a.started_at, a.rowid`
    ).all(orgId, storeId, date) as any[];
    if (!pendings.length) return this.summary(orgId, storeId, date);

    const erpForSeller = db.prepare(
      `SELECT COALESCE(SUM(valor), 0) AS valor FROM retail_erp_seller_sales
        WHERE organization_id = ? AND sale_date = ? AND matricula = ?
          AND (store_id = ? OR (store_id IS NULL AND filial = ?))`
    );
    // Idempotência do só-promove: o que JÁ está confirmado consome o orçamento
    // de cobertura — senão o re-run promoveria o que não coube na 1ª passada.
    const confirmedForSeller = db.prepare(
      `SELECT COALESCE(SUM(declared_value), 0) AS v FROM retail_floor_attendances
        WHERE organization_id = ? AND store_id = ? AND seller_id = ? AND date(started_at) = ?
          AND outcome = 'converted' AND reconciliation_state = 'confirmed'`
    );
    const setState = db.prepare(`UPDATE retail_floor_attendances SET reconciliation_state = ? WHERE organization_id = ? AND id = ?`);

    const bySeller = new Map<string, any[]>();
    for (const a of pendings) {
      if (!bySeller.has(a.seller_id)) bySeller.set(a.seller_id, []);
      bySeller.get(a.seller_id)!.push(a);
    }

    let confirmed = 0, unmatched = 0;
    const tx = db.transaction(() => {
      for (const [, atts] of bySeller) {
        const matricula = atts[0].matricula || "";
        const erpValor = Number((erpForSeller.get(orgId, date, matricula, storeId, store.code || "") as any)?.valor || 0);
        if (erpValor <= 0) {
          for (const a of atts) { setState.run("unmatched", orgId, a.id); unmatched++; }
          continue;
        }
        const budget = erpValor * (1 + TOLERANCE);
        let covered = Number((confirmedForSeller.get(orgId, storeId, atts[0].seller_id, date) as any)?.v || 0);
        for (const a of atts) {
          const declared = a.declared_value != null ? Number(a.declared_value) : null;
          if (declared == null) { setState.run("confirmed", orgId, a.id); confirmed++; continue; } // regra 4
          if (covered + declared <= budget) { covered += declared; setState.run("confirmed", orgId, a.id); confirmed++; }
          else { setState.run("unmatched", orgId, a.id); unmatched++; }
        }
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_FLOOR_RECONCILIATION_RUN", { storeId, date, processed: pendings.length, confirmed, unmatched }); } catch { /* noop */ }
    return this.summary(orgId, storeId, date);
  }

  /** Concilia o dia em todas as lojas ativas da org (job do Scheduler). */
  static runAll(orgId: string, date: string): void {
    const stores = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
    for (const s of stores) {
      try { this.runDay(orgId, s.id, date); } catch { /* best-effort por loja */ }
    }
  }

  /**
   * Resumo + lista do dia pro painel do gerente: cada atendimento convertido
   * com seu estado, totais declarado × ERP e o gap.
   */
  static summary(orgId: string, storeId: string, date: string): any {
    const store = db.prepare(`SELECT id, code, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const atts = db.prepare(
      `SELECT a.id, a.seller_id, s.name AS seller_name, s.matricula, a.started_at, a.ended_at,
              a.declared_value, a.declared_pieces, a.reconciliation_state, a.boleta_number
         FROM retail_floor_attendances a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND date(a.started_at) = ? AND a.outcome = 'converted'
        ORDER BY a.started_at, a.rowid`
    ).all(orgId, storeId, date) as any[];
    // Talão↔boleta (ADR-175): cliques ATIVOS de boleta do dia (chave sem zeros à
    // esquerda). Casamento DERIVADO na leitura (RN-004) — advisório.
    const clickKeys = new Set<string>(
      (db.prepare(
        `SELECT boleta_number FROM retail_boleta_events
          WHERE organization_id = ? AND store_id = ? AND status = 'active' AND day = ?`
      ).all(orgId, storeId, date) as any[])
        .map((r) => String(r.boleta_number ?? "").replace(/\D/g, "").replace(/^0+/, ""))
        .filter(Boolean)
    );
    const boletaKey = (s: any) => String(s ?? "").replace(/\D/g, "").replace(/^0+/, "") || null;
    const erp = db.prepare(
      `SELECT matricula, COALESCE(SUM(valor), 0) AS valor, COALESCE(SUM(pecas), 0) AS pecas
         FROM retail_erp_seller_sales
        WHERE organization_id = ? AND sale_date = ? AND (store_id = ? OR (store_id IS NULL AND filial = ?))
        GROUP BY matricula`
    ).all(orgId, date, storeId, store.code || "") as any[];

    const declaredTotal = atts.reduce((acc, a) => acc + Number(a.declared_value || 0), 0);
    const erpTotal = erp.reduce((acc, r) => acc + Number(r.valor || 0), 0);
    const count = (st: string | null) => atts.filter((a) => a.reconciliation_state === st).length;

    return {
      storeId, date,
      attendances: atts.map((a) => {
        const bk = boletaKey(a.boleta_number);
        return {
          id: a.id, sellerId: a.seller_id, sellerName: a.seller_name || null, matricula: a.matricula,
          startedAt: a.started_at, endedAt: a.ended_at,
          declaredValue: a.declared_value != null ? Number(a.declared_value) : null,
          declaredPieces: a.declared_pieces != null ? Number(a.declared_pieces) : null,
          state: a.reconciliation_state,
          boletaNumber: a.boleta_number || null,
          // null = venda sem talão informado; true/false = talão bate (ou não)
          // com um clique de boleta do dia. Advisório (o clique é opcional).
          boletaClickMatched: bk == null ? null : clickKeys.has(bk),
        };
      }),
      totals: {
        declaredCount: atts.length,
        pending: count("pending"), confirmed: count("confirmed"), unmatched: count("unmatched"),
        withBoleta: atts.filter((a) => a.boleta_number != null).length,
        boletaClickMatched: atts.filter((a) => { const bk = boletaKey(a.boleta_number); return bk != null && clickKeys.has(bk); }).length,
        declaredValue: Math.round(declaredTotal * 100) / 100,
        erpValue: Math.round(erpTotal * 100) / 100,
        gap: Math.round((declaredTotal - erpTotal) * 100) / 100,
      },
      erpBySeller: erp.map((r) => ({ matricula: r.matricula, valor: Number(r.valor), pecas: Number(r.pecas) })),
    };
  }

  /**
   * Override manual do gestor (RN-150-005): força confirmed|unmatched num
   * atendimento convertido — auditado. É o único caminho que REBAIXA um
   * confirmed (a máquina só promove).
   */
  static override(orgId: string, attendanceId: string, state: string, user: UserRef): any {
    if (!OVERRIDE_STATES.includes(String(state))) throw new Error("state inválido (confirmed|unmatched).");
    const att = db.prepare(`SELECT * FROM retail_floor_attendances WHERE organization_id = ? AND id = ?`).get(orgId, attendanceId) as any;
    if (!att) throw new Error("Atendimento não encontrado.");
    if (att.outcome !== "converted") throw new Error("Só atendimento convertido tem conciliação.");
    RetailFloorService.assertStoreManager(orgId, user, att.store_id);
    db.prepare(`UPDATE retail_floor_attendances SET reconciliation_state = ? WHERE organization_id = ? AND id = ?`).run(state, orgId, attendanceId);
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_RECONCILIATION_OVERRIDE", { attendanceId, from: att.reconciliation_state, to: state }); } catch { /* noop */ }
    return { id: attendanceId, state };
  }
}

export default RetailFloorReconciliationService;
