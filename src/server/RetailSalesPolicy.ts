/**
 * Fase 4 (Toulon) — POLÍTICA DE FONTE OFICIAL da venda da loja (meta e comissão).
 *
 * A rede confirmou por escrito que a VENDA OFICIAL é a FOLHA do fechamento
 * (informado), não o caixa da AlterData. Mas o ZapFlow é multi-tenant e a
 * comissão dos demais clientes vinha do caixa (system_total). Para não mudar o
 * cálculo de ninguém em silêncio, a fonte é uma configuração POR ORG:
 *   - 'system' (padrão legado): COALESCE(NULLIF(system_total,0), informed_total)
 *   - 'folha' (Toulon): SÓ a folha — COALESCE(informed_total, 0)
 *
 * 05/11/2026 (fechamento de outubro da TOULON): em 'folha' o caixa NÃO entra
 * mais no lugar da folha que falta. Antes era "folha; caixa se a folha estiver
 * zerada": o dia sem folha lançada entrava no mês com o valor do caixa, sem
 * aviso, e o total do mês deixava de ser a soma das folhas (a soma que o
 * gerente e a Conferência da semana mostram). Decisão do dono: o total do mês
 * segue a folha do gerente; o dia sem folha aparece à parte na Conferência do
 * mês (RetailMonthCheckService), nunca somado em silêncio.
 *
 * Escopo: SÓ meta e comissão (o que a rede confirmou). Faturamento/DRE e as
 * pontes de receita continuam como estão — é uma decisão à parte, não
 * confirmada. As apurações já criadas são snapshots (retail_commission_items),
 * então trocar a política aqui não recalcula comissão já apurada/paga.
 */
import db from "./db.js";

export type OfficialSaleSource = "system" | "folha";

/** Fonte oficial da venda da loja para meta/comissão desta org (default 'system'). */
export function officialSaleSourceOf(orgId: string): OfficialSaleSource {
  try {
    const row = db.prepare(`SELECT retail_official_sale_source AS src FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return String(row?.src) === "folha" ? "folha" : "system";
  } catch { return "system"; }
}

/**
 * Expressão SQL do total oficial da loja por fechamento, conforme a política.
 * `col` é o alias/coluna da tabela retail_daily_closings no SELECT.
 */
export function officialSaleSql(source: OfficialSaleSource, col = ""): string {
  const p = col ? `${col}.` : "";
  return source === "folha"
    ? `COALESCE(${p}informed_total, 0)`                             // só a folha; dia sem folha = 0 (aparece à parte, não vira caixa)
    : `COALESCE(NULLIF(${p}system_total,0), ${p}informed_total)`;  // legado: caixa manda; folha fallback
}
