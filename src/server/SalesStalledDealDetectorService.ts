import db from "./db.js";

/**
 * Detector de oportunidades comerciais paradas (ADR-152 F4c).
 *
 * "Oportunidade comercial" no ExaforgeStudio é o `tickets` com stage
 * dentro do funil de vendas. Não existe tabela `deals` ou `opportunities`
 * separada — o funil vive no `tickets.stage` (`novo_lead → qualificado →
 * proposta → negociacao → ganho|perdido|desqualificado`).
 *
 * "Parada" = todos abaixo verdadeiros:
 *   - status = 'open' (não cancelou nem fechou)
 *   - stage ∈ SALES_STAGES (não é `novo_lead` — que ainda não engajou —
 *     nem terminal `ganho|perdido|desqualificado`)
 *   - updated_at < now - N dias (config `sales_recovery_stalled_days`,
 *     default 10)
 *   - nenhuma mensagem inbound do CONTATO (sender_type='contact') nos
 *     últimos N dias — se o cliente respondeu recentemente, o ticket
 *     não está "parado" (dono do funil ativo)
 *
 * MVP: hardcode dos SALES_STAGES. F4c.2+ pode expor config por-org
 * (`sales_recovery_stages_json`).
 *
 * Guardas RN F4c-DETECTOR:
 *   G-4c-D-1: NUNCA propõe pra ticket closed/won/lost (query strict).
 *   G-4c-D-2: Skip se cliente respondeu recentemente (join messages).
 *   G-4c-D-3: Ignora tickets sem contact_id (defesa em profundidade).
 *   G-4c-D-4: Isolamento cross-tenant (todas queries com org).
 *   G-4c-D-5: Detector é PURO — não side-effect (não publica sinal,
 *             não escreve nada). O playbook usa o resultado pra decidir.
 */

const SALES_STAGES = ["qualificado", "proposta", "negociacao", "orcamento"];
const DEFAULT_STALLED_DAYS = 10;

export interface StalledDeal {
  ticketId: string;
  contactId: string;
  channelId: string;
  stage: string;
  temperature: string | null;
  updatedAt: string;
  contactName: string | null;
  contactPhone: string | null;
  daysSinceLastActivity: number;
  lastContactMessageAt: string | null;
}

export class SalesStalledDealDetectorService {
  /**
   * Devolve todos os deals parados da org. Fetch por-org, isolamento
   * garantido. Ordenado por dias-parado DESC (mais críticos primeiro).
   */
  static detect(orgId: string, opts: { stalledDays?: number; limit?: number } = {}): StalledDeal[] {
    if (!orgId) return [];
    const stalledDays = Math.max(1, Number(opts.stalledDays ?? DEFAULT_STALLED_DAYS));
    const limit = Math.max(1, Math.min(Number(opts.limit ?? 100), 500));
    const cutoffMs = Date.now() - stalledDays * 86400_000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const stagesPlaceholders = SALES_STAGES.map(() => "?").join(",");
    // A subquery `MAX(created_at) FROM messages WHERE ticket_id=t.id AND
    // sender_type='contact'` dá o timestamp da última msg do CLIENTE
    // (ignora bot/agent). Se essa data > cutoff, o ticket teve resposta
    // recente e NÃO está parado — filtramos com HAVING (LEFT JOIN
    // preserva tickets sem nenhuma msg do contato).
    // ADR-152 F4c.2 — filtro LGPD: `contacts.marketing_opt_out=0`.
    // Contatos que pediram opt-out via reply intent=remove_me nunca
    // mais entram na fila de recuperação. `COALESCE` porque orgs
    // pré-existentes podem ter null.
    const rows = db.prepare(`
      SELECT t.id AS ticketId, t.contact_id AS contactId, t.stage, t.temperature,
             t.updated_at AS updatedAt,
             c.channel_id AS channelId, c.name AS contactName, c.identifier AS contactPhone,
             (SELECT MAX(created_at) FROM messages m WHERE m.ticket_id = t.id AND m.sender_type = 'contact' AND m.organization_id = t.organization_id) AS lastContactMessageAt
        FROM tickets t
        JOIN contacts c ON c.id = t.contact_id AND c.organization_id = t.organization_id
       WHERE t.organization_id = ?
         AND t.status = 'open'
         AND t.stage IN (${stagesPlaceholders})
         AND t.updated_at < ?
         AND COALESCE(c.marketing_opt_out, 0) = 0
       ORDER BY t.updated_at ASC
       LIMIT ?
    `).all(orgId, ...SALES_STAGES, cutoffIso, limit) as any[];

    const out: StalledDeal[] = [];
    for (const r of rows) {
      // G-4c-D-2: skip se cliente respondeu recentemente.
      if (r.lastContactMessageAt && String(r.lastContactMessageAt) >= cutoffIso) continue;
      if (!r.contactId || !r.channelId) continue;
      const updatedMs = new Date(r.updatedAt).getTime();
      const daysSince = Math.floor((Date.now() - updatedMs) / 86400_000);
      out.push({
        ticketId: r.ticketId,
        contactId: r.contactId,
        channelId: r.channelId,
        stage: r.stage,
        temperature: r.temperature || null,
        updatedAt: r.updatedAt,
        contactName: r.contactName || null,
        contactPhone: r.contactPhone || null,
        daysSinceLastActivity: daysSince,
        lastContactMessageAt: r.lastContactMessageAt || null,
      });
    }
    // Ordenação final: mais parados primeiro (útil pra priorização).
    out.sort((a, b) => b.daysSinceLastActivity - a.daysSinceLastActivity);
    return out;
  }

  /** Expõe a lista de stages considerados "funil de vendas" pro debug/UI. */
  static getSalesStages(): string[] { return [...SALES_STAGES]; }
}

export default SalesStalledDealDetectorService;
