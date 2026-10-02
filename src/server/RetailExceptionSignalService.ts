/**
 * RetailExceptionSignalService — as exceções "Bangu está sem escala" e "N vendedores ainda precisam ser identificados" como
 * ASSUNTOS da Central de Saúde (PRD Fase 1 §9 e §26), não só linha do resumo da manhã.
 *
 * FONTE ÚNICA: este serviço define o que é cada exceção; o resumo da manhã (`RetailDayBriefService.morningExceptions`), o panorama
 * do Diretor IA e o publicador de sinais (`RetailOpsSignalPublisher.run`, que já publica e AUTO-RESOLVE os sinais do varejo no
 * agendador existente) leem DAQUI — nada de regra duplicada. Publica em `business_signals` (conv. nº 12 — sem tabela de alerta).
 *
 * Honestidade (nada vira alerta por falta de dado):
 *  - "sem escala": só em org que USA escala (alguma entrada nos últimos 31 dias ou futuras) E só a loja que PARTICIPA dela (tem
 *    entradas nessa janela) e que ABRE no dia, e que não tem NENHUMA entrada pro dia. Folga geral (entradas todas 'off') é loja
 *    fechada/de folga — NÃO é "sem escala"; org ou loja que nunca usou escala não é cobrada;
 *  - "vendedores a identificar": matrículas que vendem sem pessoa confirmada (`RetailSellerIdentityService.unidentified`) — nunca
 *    nomeia, só conta.
 * Nasce LIGADO (`retail_exception_signals_enabled` DEFAULT 1, decisão do dono) e é desligável. Isola por organization_id.
 */
import db from "./db.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";

export const EXCEPTION_SIGNAL_TYPES = ["retail_store_no_schedule", "retail_sellers_unidentified"] as const;
const WINDOW_DAYS = 31;
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T12:00:00Z`) + k * 86400000).toISOString().slice(0, 10);

export type ExceptionItem =
  | { type: "retail_store_no_schedule"; storeId: string; storeName: string; text: string }
  | { type: "retail_sellers_unidentified"; count: number; text: string };

export class RetailExceptionSignalService {
  /** Ligado por padrão (coluna ausente/nula = ligado). */
  static enabled(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT retail_exception_signals_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return r?.e === null || r?.e === undefined ? true : Number(r.e) !== 0;
    } catch { return true; }
  }
  static setEnabled(orgId: string, on: boolean): boolean {
    db.prepare(`UPDATE organization_settings SET retail_exception_signals_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    return this.enabled(orgId);
  }

  /** Lojas ativas que abrem na data, participam da escala e não têm NENHUMA entrada pro dia. Org que não usa escala → []. */
  static storesWithoutSchedule(orgId: string, date: string): Array<{ id: string; name: string }> {
    const from = addDays(date, -WINDOW_DAYS);
    const usesSchedule = !!db.prepare(`SELECT 1 FROM retail_schedule_entries WHERE organization_id = ? AND work_date >= ? LIMIT 1`).get(orgId, from);
    if (!usesSchedule) return [];
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const out: Array<{ id: string; name: string }> = [];
    for (const st of stores) {
      try { if (RetailClosingService.isStoreClosedOnDate(orgId, st.id, date)) continue; } catch { /* sem regra de fechamento: assume aberta */ }
      const participates = !!db.prepare(`SELECT 1 FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date >= ? LIMIT 1`).get(orgId, st.id, from);
      if (!participates) continue;
      const today = db.prepare(`SELECT 1 FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date = ? LIMIT 1`).get(orgId, st.id, date);
      if (!today) out.push({ id: st.id, name: st.name });
    }
    return out;
  }

  static unidentifiedCount(orgId: string): number {
    try { return RetailSellerIdentityService.unidentified(orgId).length; } catch { return 0; }
  }

  /** As exceções do dia, já com o texto do gestor — a fonte que o resumo, o panorama e o publicador usam. */
  static items(orgId: string, date: string): ExceptionItem[] {
    const out: ExceptionItem[] = [];
    try { for (const s of this.storesWithoutSchedule(orgId, date)) out.push({ type: "retail_store_no_schedule", storeId: s.id, storeName: s.name, text: `${s.name} está sem escala.` }); } catch { /* best-effort */ }
    const n = this.unidentifiedCount(orgId);
    if (n > 0) out.push({ type: "retail_sellers_unidentified", count: n, text: n === 1 ? "1 vendedor ainda precisa ser identificado." : `${n} vendedores ainda precisam ser identificados.` });
    return out;
  }
}

export default RetailExceptionSignalService;
