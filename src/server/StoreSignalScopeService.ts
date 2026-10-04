import db from "./db.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";

/**
 * StoreSignalScopeService — o gerente de LOJA (admin COM loja atribuída, ADR-173) só vê os sinais da(s) loja(s) dele.
 *
 * Origem (TOULON, 04/10): o feed de atenção (`business_signals`) é da EMPRESA inteira; o Hoje, a Central de Saúde e o
 * Insights mostravam ao gerente da Carioca "Produtos com divergência de estoque — Grande Rio", "A loja está abaixo da
 * meta — Av. Brasil" e "100 riscos sendo acompanhados" (que somava as outras lojas).
 *
 * Regra (RN-GRP-style, conservadora — na dúvida ESCONDE): um sinal é "de loja por natureza" quando vem de um publicador do
 * varejo (`source_service` Retail*), de domínio retail_ops/retail_floor, ou tem tipo `retail_*`. Esse sinal só aparece pro
 * gerente se a entidade dele é UMA LOJA do escopo dele (`retail_store`/`store` + id). Sinal de loja sem loja identificável
 * (padrões da rede, usuário/produto, organização) é da REDE → escondido. Sinais que não são de loja (financeiro, cobrança,
 * reputação…) seguem as regras de domínio de sempre. Dono e admin sem loja atribuída: `null` = sem restrição, zero custo.
 */
const storeBound = (a = "") => `(${a}source_service LIKE 'Retail%' OR ${a}domain IN ('retail_ops','retail_floor') OR ${a}signal_type LIKE 'retail\\_%' ESCAPE '\\')`;
const notOwn = (ids: string[], a = "") => (ids.length ? ` AND NOT (${a}source_entity_type IN ('retail_store','store') AND ${a}source_entity_id IN (${ids.map(() => "?").join(",")}))` : "");

export class StoreSignalScopeService {
  /** Ids dos sinais de loja que NÃO são do escopo do usuário. `null` = usuário irrestrito (nada a esconder). */
  static hiddenFor(orgId: string, user: any): Set<string> | null {
    const uid = String(user?.userId || user?.id || "");
    const sc = RetailStoreScopeService.allowed(orgId, uid, String(user?.role || ""));
    if (sc.unrestricted) return null;
    const ids = sc.storeIds;
    const rows = db.prepare(`SELECT id FROM business_signals WHERE organization_id = ? AND ${storeBound()}${notOwn(ids)}`).all(orgId, ...ids) as any[];
    return new Set(rows.map((r) => r.id));
  }

  /** Ids das AÇÕES (decision_actions) nascidas de um sinal de OUTRA loja — o gerente não as vê. `null` = irrestrito. */
  static hiddenActionsFor(orgId: string, user: any): Set<string> | null {
    const uid = String(user?.userId || user?.id || "");
    const sc = RetailStoreScopeService.allowed(orgId, uid, String(user?.role || ""));
    if (sc.unrestricted) return null;
    const ids = sc.storeIds;
    const rows = db.prepare(`SELECT a.id FROM decision_actions a JOIN business_signals s ON s.id = a.signal_id AND s.organization_id = a.organization_id
      WHERE a.organization_id = ? AND ${storeBound("s.")}${notOwn(ids, "s.")}`).all(orgId, ...ids) as any[];
    return new Set(rows.map((r) => r.id));
  }
}

export default StoreSignalScopeService;
