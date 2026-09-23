/**
 * Conferência SOMENTE LEITURA das fontes monetárias de cada loja em um dia
 * (caso Toulon: "os números não batem" — informado × resumo de caixa da
 * Alterdata × boletas do PDV × lançamento manual × ranking da folha).
 *
 * Nada aqui decide qual valor "vale": o serviço abre as fontes lado a lado,
 * em CENTAVOS (sem erro de float), e marca INDÍCIOS nomeados pro dono/admin
 * investigar (ex.: `fechamento_vs_alterdata` no 19/09 da Av. Brasil, quando o
 * resumo veio parcial sem o bloco de débito). Qualquer diferença ≥ R$ 0,01
 * gera indício — um dia com R$ 0,10 de diferença é exatamente o que a rede
 * reclama e precisa aparecer.
 */
import db from "./db.js";
import { RetailCommissionService } from "./RetailCommissionService.js";
import { isRankingTotalLine } from "./RetailOpsService.js";
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";

const cents = (value: unknown) => Math.round((Number(value) || 0) * 100);
const money = (value: number) => value / 100;

export class RetailMoneyAuditService {
  static day(orgId: string, date: string) {
    // Dia ainda dentro da janela em que o TEF "engorda" o caixa da Alterdata
    // (caso 19/09: resumo lido cedo veio sem o bloco de débito): diferença
    // informado × sistema aqui é PROVAVELMENTE leitura parcial, não erro.
    const tefWindow = (() => {
      const today = Date.parse(new Date().toISOString().slice(0, 10));
      const target = Date.parse(date);
      if (Number.isNaN(target)) return false;
      const daysAgo = Math.round((today - target) / 86_400_000);
      return daysAgo >= 0 && daysAgo <= 2;
    })();
    const sellerRows = RetailCommissionService.salesBySellerStore(orgId, date, date);
    const stores = db.prepare(`SELECT id, name, code, COALESCE(seller_source, 'pdv') AS seller_source
      FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const rows = stores.map((s) => {
      const c = db.prepare(`SELECT status, source, informed_total, system_total, quota_amount, details_json, system_turnos_json
        FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ?`).get(orgId, s.id, date) as any;
      const quota = db.prepare(`SELECT quota_amount FROM retail_store_quotas
        WHERE organization_id = ? AND store_id = ? AND quota_date = ?`).get(orgId, s.id, date) as any;
      const pdv = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS total,
        COUNT(DISTINCT COALESCE(NULLIF(vendedor_codigo, ''), vendedor)) AS seller_codes
        FROM retail_pdv_sales WHERE organization_id = ? AND filial = ? AND sale_date = ?
          AND COALESCE(status, 'N') <> 'C'`).get(orgId, s.code, date) as any;
      // Boletas do dia (a fonte granular): abrir venda a venda é o que permite
      // achar os R$ que faltam/sobram (troca, devolução, boleta cancelada). A
      // lista é truncada em BOLETAS_LIMIT; o total (pdv.total acima) soma TODAS,
      // então a UI precisa avisar "exibindo N de <pdv.count>" pra não parecer
      // que a soma ignora boletas fora da lista.
      const BOLETAS_LIMIT = 60;
      const boletas = db.prepare(`SELECT boleta, valor, status FROM retail_pdv_sales
        WHERE organization_id = ? AND filial = ? AND sale_date = ? AND COALESCE(status, 'N') <> 'C'
        ORDER BY CAST(boleta AS INTEGER), boleta LIMIT ?`).all(orgId, s.code, date, BOLETAS_LIMIT) as any[];
      const manual = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS total
        FROM retail_seller_sales WHERE organization_id = ? AND store_id = ? AND sale_date = ?`).get(orgId, s.id, date) as any;
      const erp = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(valor),0) AS total
        FROM retail_erp_seller_sales WHERE organization_id = ? AND store_id = ? AND sale_date = ?`).get(orgId, s.id, date) as any;
      let details: any = {}, turnos: any = {};
      try { details = JSON.parse(c?.details_json || "{}") || {}; } catch { /* dado legado inválido */ }
      try { turnos = JSON.parse(c?.system_turnos_json || "{}") || {}; } catch { /* dado legado inválido */ }
      const informed = !c || c.status === "pending" || c.informed_total == null ? null : cents(c.informed_total);
      // system_total 0 SEM turnos gravados = "nunca lido", não "leu zero".
      const system = !c || c.system_total == null || (Number(c.system_total) === 0 && !Object.keys(turnos).length)
        ? null : cents(c.system_total);
      const pdvTotal = cents(pdv.total), manualTotal = cents(manual.total), erpTotal = cents(erp.total);
      const ranking = Array.isArray(details.ranking)
        ? details.ranking.filter((r: any) => !isRankingTotalLine(r?.sellerName ?? r?.nome)) : [];
      const rankingTotal = ranking.length ? ranking.reduce((sum: number, r: any) => sum + cents(r.valor), 0) : null;
      const issues: string[] = [];
      if (informed !== null && system !== null && Math.abs(informed - system) >= 1) {
        issues.push("fechamento_vs_alterdata");
        if (tefWindow) issues.push("possivel_leitura_parcial_tef");
      }
      if (rankingTotal !== null && informed !== null && Math.abs(rankingTotal - informed) >= 1) issues.push("ranking_vs_fechamento");
      if (pdv.n && system !== null && Math.abs(pdvTotal - system) >= 1) {
        issues.push("vendas_pdv_vs_resumo_caixa");
        // DIREÇÃO da divergência boletas × caixa (a causa provável muda com o
        // sinal, NÃO com um chute): boletas > caixa = nossa cópia conta a mais
        // → provável boleta cancelada/estornada que o delta ainda não
        // propagou; boletas < caixa = o caixa registrou venda que não está nas
        // boletas → possível venda fora do VendaMalote. Nenhuma correção
        // automática: só nomeia pro humano conferir boleta a boleta.
        if (pdvTotal - system >= 1) issues.push("boletas_acima_do_caixa");
        else if (pdvTotal - system <= -1) issues.push("boletas_abaixo_do_caixa");
      }
      if (pdv.n && manual.n) issues.push("fontes_fisicas_sobrepostas");
      if (erp.n && (pdv.n || manual.n)) issues.push("erp_agregado_vs_outros");
      if (pdv.n > 5 && pdv.seller_codes <= 1) issues.push("codigo_vendedor_compartilhado");
      if (informed !== null && manual.n && Math.abs(manualTotal - informed) >= 1) issues.push("vendedores_vs_fechamento");
      if (system !== null && informed === null) issues.push("sem_fechamento_informado");
      if (details?.derived?.posSwapSuspect) issues.push("credito_debito_trocados");
      const sellerBase = sellerRows.filter((r) => r.storeId === s.id).reduce((sum, r) => sum + cents(r.sales), 0);
      return {
        storeId: s.id, storeName: s.name, filial: s.code, sellerSource: s.seller_source,
        closing: {
          status: c?.status || null, source: c?.source || null,
          informed: informed === null ? null : money(informed),
          system: system === null ? null : money(system),
          quota: money(cents(quota?.quota_amount ?? c?.quota_amount)),
          turnos, ranking: rankingTotal === null ? null : money(rankingTotal),
        },
        sources: {
          sellerBase: money(sellerBase),
          pdv: { count: pdv.n, total: money(pdvTotal), sellerCodes: pdv.seller_codes, boletasShown: boletas.length, boletasTruncated: pdv.n > boletas.length, boletas: boletas.map((b) => ({ boleta: String(b.boleta), valor: Math.round((Number(b.valor) || 0) * 100) / 100, status: b.status || null })) },
          manual: { count: manual.n, total: money(manualTotal) },
          // O relatório ERP pode ser agregado MENSAL numa data representativa —
          // a linha nunca deve ser lida como venda daquele dia específico.
          erp: { count: erp.n, total: money(erpTotal), granularity: "periodo_erp" },
        },
        differences: {
          informedVsSystem: informed === null || system === null ? null : money(informed - system),
          pdvVsSystem: !pdv.n || system === null ? null : money(pdvTotal - system),
          boletasVsSystem: !pdv.n || system === null ? null : money(pdvTotal - system),
          rankingVsInformed: rankingTotal === null || informed === null ? null : money(rankingTotal - informed),
        },
        issues,
      };
    });
    // Boletas do PDV numa filial sem loja ativa: venda existe, painel não vê.
    const orphanFiliais = db.prepare(`SELECT p.filial, COUNT(*) AS salesCount, ROUND(SUM(p.valor),2) AS total
      FROM retail_pdv_sales p LEFT JOIN retail_stores s
        ON s.organization_id = p.organization_id AND s.code = p.filial AND s.active = 1
      WHERE p.organization_id = ? AND p.sale_date = ? AND COALESCE(p.status, 'N') <> 'C'
        AND s.id IS NULL GROUP BY p.filial`).all(orgId, date) as any[];
    // Autenticação da Alterdata morta = nenhum dia novo recebe system_total.
    // O banner na conferência é onde o dono descobre ANTES de divergir tudo.
    const connector = { authError: AlterdataConnectorService.getAuthFailure(orgId) };
    return { date, stores: rows, orphanFiliais, connector };
  }
}
