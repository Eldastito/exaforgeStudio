/**
 * Retail Ops — CONFERÊNCIA DO MÊS: folha × caixa, dia a dia, por loja.
 *
 * Origem (05/11/2026, fechamento de outubro da TOULON): o total do mês da
 * loja no app não batia com a soma das semanas que o gerente mandou
 * (Avenida Brasil +R$ 50,01, Grande Rio +R$ 83,91, Nova Iguaçu +R$ 699,26;
 * Carioca batia). A soma em si estava certa: o total do mês usava a "venda
 * oficial" (RetailSalesPolicy) — caixa do PDV na política 'system', ou caixa
 * no dia sem folha na política 'folha' antiga — enquanto a semana conferida
 * mostrava a FOLHA do gerente. Sem acesso à base de produção, não havia como
 * provar QUAL dia carregava a diferença; esta conferência mostra isso no app.
 *
 * Regras:
 *  - SOMENTE LEITURA. Nada é gravado nem corrigido aqui.
 *  - "Total do mês" = a MESMA expressão SQL da corrida/metas/comissão
 *    (officialSaleSql) — não uma conta paralela. Assim o número desta tela é
 *    exatamente o do resto do app, e a diferença para a folha fica explicada.
 *  - As semanas são as da corrida (weeksOfMonthFor, com override da org) e a
 *    soma delas é conferida contra o total do mês (`weeksMatchMonth`).
 *  - Fechamento REJEITADO não entra em nenhum total (igual à corrida), mas
 *    aparece na lista para explicar por que a grade semanal pode mostrá-lo.
 *  - Dinheiro de loja: o gerente (escopo restrito) só vê as lojas dele.
 */
import db from "./db.js";
import { officialSaleSourceOf, officialSaleSql, type OfficialSaleSource } from "./RetailSalesPolicy.js";
import { RetailCommissionRaceService } from "./RetailCommissionRaceService.js";

const r2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const TOL = 0.009;

export type MonthCheckSituation =
  | "ok"                        // folha = caixa (ou só há folha e não há caixa nenhum no mês)
  | "folha_diferente_do_caixa"  // as duas existem e diferem
  | "sem_folha"                 // caixa com venda, folha zerada/não lançada
  | "sem_caixa"                 // folha lançada, caixa do PDV não chegou nesse dia
  | "rejeitado";                // fechamento rejeitado: fora de todos os totais

export type MonthCheckDay = {
  date: string; folha: number; caixa: number; counted: number;
  folhaMinusCaixa: number | null; situation: MonthCheckSituation; status: string;
};

export class RetailMonthCheckService {
  static month(orgId: string, month: string, restrictStoreIds?: string[] | null): any {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const source: OfficialSaleSource = officialSaleSourceOf(orgId);
    const { start, end } = RetailCommissionRaceService.monthRange(month);
    const weeks = RetailCommissionRaceService.weeksOfMonthFor(orgId, month);

    let stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name COLLATE NOCASE`).all(orgId) as any[];
    if (restrictStoreIds) { const ok = new Set(restrictStoreIds); stores = stores.filter((s) => ok.has(s.id)); }

    const rows = db.prepare(
      `SELECT store_id, closing_date, status, COALESCE(informed_total,0) AS folha, COALESCE(system_total,0) AS caixa,
              ${officialSaleSql(source)} AS counted
         FROM retail_daily_closings
        WHERE organization_id = ? AND closing_date BETWEEN ? AND ?
        ORDER BY closing_date`
    ).all(orgId, start, end) as any[];
    const byStore = new Map<string, any[]>();
    for (const r of rows) { if (!byStore.has(r.store_id)) byStore.set(r.store_id, []); byStore.get(r.store_id)!.push(r); }

    const outStores = stores.map((s) => {
      const list = byStore.get(s.id) || [];
      const storeHasCaixa = list.some((r) => r.status !== "rejected" && Number(r.caixa) > 0);
      const days: MonthCheckDay[] = list.map((r) => {
        const folha = r2(r.folha), caixa = r2(r.caixa);
        const rejected = r.status === "rejected";
        let situation: MonthCheckSituation = "ok";
        if (rejected) situation = "rejeitado";
        else if (folha > 0 && caixa > 0 && Math.abs(folha - caixa) > TOL) situation = "folha_diferente_do_caixa";
        else if (folha <= 0 && caixa > 0) situation = "sem_folha";
        else if (folha > 0 && caixa <= 0 && storeHasCaixa) situation = "sem_caixa";
        return {
          date: String(r.closing_date), folha, caixa, counted: rejected ? 0 : r2(r.counted),
          folhaMinusCaixa: folha > 0 && caixa > 0 ? r2(folha - caixa) : null, situation, status: String(r.status || ""),
        };
      });
      const live = days.filter((d) => d.situation !== "rejeitado");
      const sum = (pick: (d: MonthCheckDay) => number, ds = live) => r2(ds.reduce((a, d) => a + pick(d), 0));
      const totals = { folha: sum((d) => d.folha), caixa: sum((d) => d.caixa), counted: sum((d) => d.counted) };
      const weekRows = weeks.map((w) => {
        const ds = live.filter((d) => d.date >= w.start && d.date <= w.end);
        return { start: w.start, end: w.end, folha: sum((d) => d.folha, ds), caixa: sum((d) => d.caixa, ds), counted: sum((d) => d.counted, ds) };
      });
      const issues = days.filter((d) => d.situation !== "ok");
      return {
        storeId: s.id, storeName: s.name,
        totals: { ...totals, countedMinusFolha: r2(totals.counted - totals.folha), folhaMinusCaixa: storeHasCaixa ? r2(totals.folha - totals.caixa) : null },
        // Loja sem NENHUM caixa no mês: o total só pode ser a folha (explica "essa loja bate") — e não há com o que conferir.
        caixaAvailable: storeHasCaixa,
        weeks: weekRows,
        weeksMatchMonth: Math.abs(r2(weekRows.reduce((a, w) => a + w.counted, 0)) - totals.counted) <= TOL,
        counts: {
          folhaDiferenteDoCaixa: issues.filter((d) => d.situation === "folha_diferente_do_caixa").length,
          semFolha: issues.filter((d) => d.situation === "sem_folha").length,
          semCaixa: issues.filter((d) => d.situation === "sem_caixa").length,
          rejeitados: issues.filter((d) => d.situation === "rejeitado").length,
        },
        issues,
      };
    });

    const net = (pick: (s: any) => number) => r2(outStores.reduce((a, s) => a + pick(s), 0));
    return {
      month, start, end, source, scoped: !!restrictStoreIds,
      stores: outStores,
      network: { folha: net((s) => s.totals.folha), caixa: net((s) => s.totals.caixa), counted: net((s) => s.totals.counted), countedMinusFolha: net((s) => s.totals.countedMinusFolha) },
    };
  }
}
