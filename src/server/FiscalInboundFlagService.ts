/**
 * FiscalInboundFlagService — kill-switch por ORGANIZAÇÃO da Entrada Automática
 * de NF-e (ADR-200, Fase 0).
 *
 * Semântica OPOSTA ao RetailFeatureFlagService: aqui o DEFAULT é DESLIGADO.
 * A captura fiscal de entrada é feature nova e de risco (segredo de provedor,
 * XML fiscal, escrita em estoque de sombra) — só roda quando o dono LIGA
 * explicitamente, por org. Coluna ausente (pré-migração) ou linha inexistente
 * → DESLIGADO (nunca liga sozinho).
 *
 * Fase 0 entrega apenas o gate: enquanto este flag estiver 0, nenhum adapter,
 * job, webhook ou rota de entrada de NF-e deve executar efeito. Isolado por
 * organization_id.
 */
import db from "./db.js";

export class FiscalInboundFlagService {
  /** Entrada automática de NF-e ligada para a org? (default false). */
  static isEnabled(orgId: string): boolean {
    try {
      const row = db.prepare(`SELECT fiscal_inbound_enabled AS v FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      if (!row || row.v === undefined || row.v === null) return false; // sem dado → desligado
      return Number(row.v) !== 0;
    } catch {
      return false; // coluna ausente (pré-migração) → desligado
    }
  }

  /** Liga/desliga o gate (owner/admin decide na rota). Retorna o novo estado. */
  static set(orgId: string, on: boolean): boolean {
    db.prepare(`UPDATE organization_settings SET fiscal_inbound_enabled = ? WHERE organization_id = ?`).run(on ? 1 : 0, orgId);
    return this.isEnabled(orgId);
  }

  /** Estado do flag para UI/admin. */
  static status(orgId: string): { fiscalInboundEnabled: boolean } {
    return { fiscalInboundEnabled: this.isEnabled(orgId) };
  }
}

export default FiscalInboundFlagService;
