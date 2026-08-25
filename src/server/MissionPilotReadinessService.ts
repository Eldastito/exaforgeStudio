import db from "./db.js";
import { MissionService } from "./MissionService.js";

/**
 * MissionPilotReadinessService — ADR-189 F28 (Mission OS): PRÉ-CHECK do piloto real.
 *
 * Antes de ligar o Mission Layer numa org de verdade, este check DERIVA (RN-004, read-only) se o dado
 * existente sustenta uma missão ÚTIL por família de objetivo — pra o operador escolher a 1ª missão
 * certa e não bater em "premissa faltante" no plano reverso. Não liga nada, não grava nada: só reporta.
 *
 * Por família:
 *   - receita     → precisa de vendas pagas (ticket derivável) + base de contatos + canal.
 *   - agenda      → precisa de histórico de atendimentos (comparecimento derivável) + base + canal.
 *   - cobrança    → precisa de recebíveis em aberto (o que cobrar) + canal.
 * "ready" quando o dado sustenta a cadeia/medição; senão, `reasons` diz honestamente o que falta.
 *
 * Composição pura (sem tabela/motor novo): lê orders/appointments/receivables/contacts/channels +
 * a flag. Isolado por org. Honesto — nunca inventa prontidão que o dado não sustenta.
 */

export interface FamilyReadiness {
  family: "revenue" | "appointments" | "receivables";
  label: string;
  ready: boolean;
  metric: string;
  suggestion: string;               // primeira missão sugerida quando pronta
  facts: Record<string, number>;    // números que embasam (transparência)
  reasons: string[];                // o que falta (vazio quando ready)
}

export interface PilotReadiness {
  organizationId: string;
  missionLayerEnabled: boolean;
  channelConnected: boolean;
  contactsBase: number;
  families: FamilyReadiness[];
  readyFamilies: string[];
  note: string;
}

export class MissionPilotReadinessService {
  private static count(sql: string, orgId: string): number {
    try { return Number((db.prepare(sql).get(orgId) as any)?.n) || 0; } catch { return 0; }
  }

  static check(orgId: string): PilotReadiness {
    const missionLayerEnabled = MissionService.isEnabled(orgId);
    const channelConnected = this.count(`SELECT COUNT(*) n FROM channels WHERE organization_id = ? AND status = 'connected'`, orgId) > 0;
    const contactsBase = this.count(`SELECT COUNT(*) n FROM contacts WHERE organization_id = ?`, orgId);

    // Receita: pedidos pagos (ticket derivável) + base + canal.
    const paidOrders = this.count(`SELECT COUNT(*) n FROM orders WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido')`, orgId);
    const revenueReasons: string[] = [];
    if (paidOrders <= 0) revenueReasons.push("Sem vendas pagas registradas — o ticket médio não pode ser derivado.");
    if (contactsBase <= 0) revenueReasons.push("Sem base de contatos para gerar demanda.");
    if (!channelConnected) revenueReasons.push("Nenhum canal conectado para alcançar a base.");

    // Agenda: histórico de atendimentos (comparecimento derivável) + base + canal.
    const apptHistory = this.count(`SELECT COUNT(*) n FROM appointments WHERE organization_id = ? AND status IN ('completed','no_show','cancelled')`, orgId);
    const agendaReasons: string[] = [];
    if (apptHistory <= 0) agendaReasons.push("Sem histórico de atendimentos — a taxa de comparecimento não pode ser derivada.");
    if (contactsBase <= 0) agendaReasons.push("Sem base de contatos para gerar agendamentos.");
    if (!channelConnected) agendaReasons.push("Nenhum canal conectado para alcançar a base.");

    // Cobrança: recebíveis em aberto (o que cobrar) + canal.
    const openReceivables = this.count(`SELECT COUNT(*) n FROM receivables WHERE organization_id = ? AND status = 'open'`, orgId);
    const receivablesReasons: string[] = [];
    if (openReceivables <= 0) receivablesReasons.push("Nenhum recebível em aberto — não há o que cobrar.");
    if (!channelConnected) receivablesReasons.push("Nenhum canal conectado para enviar a cobrança.");

    const families: FamilyReadiness[] = [
      {
        family: "revenue", label: "Receita", metric: "revenue",
        ready: revenueReasons.length === 0,
        suggestion: 'Ex.: "atingir R$ X de faturamento no mês"',
        facts: { pedidosPagos: paidOrders, contatos: contactsBase },
        reasons: revenueReasons,
      },
      {
        family: "appointments", label: "Agenda", metric: "appointments",
        ready: agendaReasons.length === 0,
        suggestion: 'Ex.: "encher a agenda com X atendimentos no mês"',
        facts: { historicoAtendimentos: apptHistory, contatos: contactsBase },
        reasons: agendaReasons,
      },
      {
        family: "receivables", label: "Cobrança", metric: "receivables",
        ready: receivablesReasons.length === 0,
        suggestion: 'Ex.: "recuperar R$ X de inadimplência"',
        facts: { recebiveisEmAberto: openReceivables },
        reasons: receivablesReasons,
      },
    ];

    const readyFamilies = families.filter((f) => f.ready).map((f) => f.label);
    const note = readyFamilies.length > 0
      ? `Pronto para pilotar: ${readyFamilies.join(", ")}. ${missionLayerEnabled ? "Mission Layer já ligado." : 'Ligue em Configurações → Módulos → "Missões (piloto)".'}`
      : "Nenhuma família tem dado suficiente ainda — registre vendas/atendimentos/recebíveis e um canal conectado antes de pilotar.";

    return { organizationId: orgId, missionLayerEnabled, channelConnected, contactsBase, families, readyFamilies, note };
  }
}

export default MissionPilotReadinessService;
