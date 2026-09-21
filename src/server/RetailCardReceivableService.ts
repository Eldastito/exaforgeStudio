/**
 * Retail Ops — Recebíveis de cartão em modo D+1 (ADR-083, aditivo).
 *
 * Contexto (pedido da dona TOULON, 20/09/2026): a loja recebe do adquirente
 * D+1 o VALOR INTEIRO da venda à vista — mesmo quando o CLIENTE parcelou. O
 * adquirente antecipa e deposita fechado no dia seguinte. O modo padrão da aba
 * Recebíveis mostra as PARCELAS DO CLIENTE (uma linha por parcela, no vencimento
 * de cada uma), repetindo valor mês a mês — o que NÃO reflete o caixa dessa
 * loja e quebra a conferência diária e mensal.
 *
 * Este serviço computa a visão D+1: por TRANSAÇÃO de cartão (não por parcela),
 * o valor inteiro (soma das parcelas do mesmo comprovante) entra em (venda + 1).
 *
 * Decisões:
 *  - OPT-IN por org (`organization_settings.retail_card_dplus1_enabled`). Sem a
 *    flag, a aba segue no modo parcelas — 0-regressão pras lojas que de fato
 *    recebem parcelado.
 *  - Retorna as MESMAS SHAPES de linha cruas que o endpoint já mapeia
 *    (byDayRows / byBrandRows / rowsD), pra a normalização de bandeira e o
 *    mapeamento final continuarem num lugar só (a rota). Só a FONTE do dado muda.
 *  - Data de recebimento = `date(sale_date, '+N day')` (N=1 fixo hoje). Linha
 *    sem `sale_date` não tem D+1 calculável e fica de fora (nunca inventa data).
 *  - Isolamento multi-tenant estrito por organization_id.
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const RECEIVABLE_DAYS = 1; // D+1 fixo (pedido da dona). Fica isolado se um dia virar configurável.

export class RetailCardReceivableService {
  /** Modo de recebíveis da org: 'dplus1' (flag ligada) ou 'installments'. */
  static getMode(orgId: string): "dplus1" | "installments" {
    const r = db.prepare(`SELECT retail_card_dplus1_enabled AS f FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return Number(r?.f) === 1 ? "dplus1" : "installments";
  }

  static isDplus1(orgId: string): boolean {
    return this.getMode(orgId) === "dplus1";
  }

  /** Liga/desliga o modo D+1 (owner/admin — imposto na rota). */
  static setDplus1(orgId: string, enabled: boolean, actorId?: string): "dplus1" | "installments" {
    db.prepare(`UPDATE organization_settings SET retail_card_dplus1_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    try { logAuthEvent(orgId, actorId || "system", "card_receivable", "RETAIL_CARD_DPLUS1_SET", { enabled: !!enabled }); } catch { /* noop */ }
    return this.getMode(orgId);
  }

  /**
   * Linhas CRUAS da visão D+1 no MESMO formato que o endpoint já mapeia:
   *  - byDayRows: { vencimento(=recebimento), parcelas(=nº de vendas), bruto, liquido }
   *  - byBrandRows: { codigo_cartao, parcelas(=nº de vendas), bruto, liquido }
   *  - rowsD (se detailed): 1 linha por TRANSAÇÃO (valor inteiro), com parcela
   *    'à vista' e taxa efetiva (%).
   * `bruto`/`liquido` são a SOMA das parcelas do mesmo comprovante = valor inteiro.
   */
  static dplus1Rows(orgId: string, start: string, end: string, opts: { filial?: string | null; detailed?: boolean } = {}): {
    byDayRows: any[]; byBrandRows: any[]; rowsD: any[] | undefined;
  } {
    const filial = String(opts.filial || "").trim();
    // Filtro comum: recebimento = venda + N dias, dentro da janela; sale_date presente.
    const where = `organization_id = ? AND sale_date IS NOT NULL
                   AND date(sale_date, '+${RECEIVABLE_DAYS} day') BETWEEN ? AND ?${filial ? " AND filial = ?" : ""}`;
    const args: any[] = [orgId, start, end];
    if (filial) args.push(filial);
    // Conta VENDAS distintas (transação = filial|numero), não parcelas.
    const txCount = `COUNT(DISTINCT filial || '|' || COALESCE(numero, ''))`;

    // GROUP/ORDER BY a EXPRESSÃO (não o alias `vencimento`): a tabela já tem uma
    // coluna `vencimento` (o vencimento do cliente) e o SQLite prioriza a coluna
    // no GROUP BY — agruparia errado pela parcela do cliente em vez do recebimento.
    const recExpr = `date(sale_date, '+${RECEIVABLE_DAYS} day')`;
    const byDayRows = db.prepare(
      `SELECT ${recExpr} AS vencimento,
              ${txCount} AS parcelas, SUM(valor) AS bruto, SUM(liquido) AS liquido
         FROM retail_pdv_card_installments
        WHERE ${where}
        GROUP BY ${recExpr} ORDER BY ${recExpr}`
    ).all(...args) as any[];

    const byBrandRows = db.prepare(
      `SELECT codigo_cartao, ${txCount} AS parcelas, SUM(valor) AS bruto, SUM(liquido) AS liquido
         FROM retail_pdv_card_installments
        WHERE ${where}
        GROUP BY codigo_cartao ORDER BY SUM(valor) DESC`
    ).all(...args) as any[];

    let rowsD: any[] | undefined;
    if (opts.detailed) {
      const raw = db.prepare(
        `SELECT filial, ${recExpr} AS vencimento,
                numero, MAX(boleta) AS boleta, codigo_cartao, sale_date,
                SUM(valor) AS valor, SUM(liquido) AS liquido
           FROM retail_pdv_card_installments
          WHERE ${where}
          GROUP BY filial, numero, sale_date, codigo_cartao
          ORDER BY ${recExpr}, filial, numero
          LIMIT 1000`
      ).all(...args) as any[];
      rowsD = raw.map((r) => {
        const bruto = Number(r.valor) || 0;
        const liquido = Number(r.liquido) || 0;
        const taxa = bruto > 0 ? Math.round(((bruto - liquido) / bruto) * 10000) / 100 : 0; // % efetiva
        return {
          filial: r.filial, vencimento: r.vencimento, parcela: "à vista", seq: 1,
          numero: r.numero, boleta: r.boleta, codigo_cartao: r.codigo_cartao,
          valor: bruto, liquido, taxa, sale_date: r.sale_date,
        };
      });
    }
    return { byDayRows, byBrandRows, rowsD };
  }
}
