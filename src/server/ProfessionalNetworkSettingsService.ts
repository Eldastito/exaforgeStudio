/**
 * ProfessionalNetworkSettingsService — ADR-180 F4b: leitura/escrita das duas flags
 * opt-in da Agenda Federada (RN-PN-8).
 *
 * A UI da clínica (F4b) precisa LER o estado das flags (pra decidir se mostra a rede
 * ou o convite de ativação) e ESCREVÊ-LAS (o dono liga a rede). Este service é o único
 * ponto que NÃO passa pelo gate da flag — senão nunca seria possível ligá-la. As rotas
 * de operação (convite/config/booking) seguem gated (recusam 403 sem `network`).
 *
 * Guardrails: isolamento por org (convenção nº 1 — orgId 1º arg, toda query filtra
 * organization_id); `autobooking` só faz sentido com `network` ligada (ligar autobooking
 * liga a rede junto; desligar a rede desliga o autobooking — nunca deixa autobooking
 * órfão). Aditivo/reversível (colunas já existentes, default 0).
 */
import db from "./db.js";

export interface ProfessionalNetworkSettings {
  networkEnabled: boolean;
  autobookingEnabled: boolean;
}

export class ProfessionalNetworkSettingsService {
  static get(orgId: string): ProfessionalNetworkSettings {
    const row = db.prepare(
      `SELECT professional_network_enabled AS net, autobooking_enabled AS auto FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    return {
      networkEnabled: !!(row && row.net),
      autobookingEnabled: !!(row && row.auto),
    };
  }

  /**
   * Atualiza as flags (parcial — só o que veio no patch). Coerência: autobooking ON
   * exige network ON (liga junto); network OFF força autobooking OFF (nunca órfão).
   * Só UPDATE — orgs de clínica sempre têm a linha de organization_settings.
   */
  static set(orgId: string, patch: { networkEnabled?: boolean; autobookingEnabled?: boolean }): ProfessionalNetworkSettings {
    const cur = this.get(orgId);
    const netGiven = patch.networkEnabled !== undefined;
    let net = netGiven ? !!patch.networkEnabled : cur.networkEnabled;
    let auto = patch.autobookingEnabled === undefined ? cur.autobookingEnabled : !!patch.autobookingEnabled;
    // autobooking ON implica rede ON — a MENOS que o caller tenha desligado a rede
    // explicitamente no MESMO patch (desligar a rede é a intenção mais forte).
    if (auto && !(netGiven && !net)) net = true;
    // rede desligada → sem autobooking órfão (domina o auto herdado).
    if (!net) auto = false;
    db.prepare(
      `UPDATE organization_settings SET professional_network_enabled = ?, autobooking_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`
    ).run(net ? 1 : 0, auto ? 1 : 0, orgId);
    return this.get(orgId);
  }
}

export default ProfessionalNetworkSettingsService;
