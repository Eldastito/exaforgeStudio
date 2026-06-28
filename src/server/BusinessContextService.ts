import db from "./db.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";

/**
 * Agrega um "raio-x" do negócio para o Orquestrador (Zapp) raciocinar sobre a
 * jornada do cliente, funil, estoque, vendas e campanhas. É READ-ONLY: apenas
 * lê e resume — nunca altera dados. Substitui o contexto antigo (só métricas)
 * por uma visão 360º, permitindo recomendações reais (reativação, ofertas,
 * estoque, oportunidades).
 */
export class BusinessContextService {
  static build(orgId: string): string {
    const blocks: string[] = [];

    // 1. Métricas gerais (30 dias) — reaproveita o AnalyticsService.
    try {
      const m = AnalyticsService.getMetrics(orgId, { period: "month" });
      blocks.push(`MÉTRICAS (30 dias): ${m.totalTickets} atendimentos, ${m.newLeadsCount} novos leads, ${m.salesCount} vendas, ${m.appointmentCount} agendamentos, ${m.handoffCount} repasses p/ humano, ${m.aiResponseCount} respostas da IA. Resolução por IA: ${m.resolutionRateAI}%. Tempo médio 1ª resposta: ${m.averageFirstResponseTime}s.`);
    } catch (e) { /* noop */ }

    // 1b. Revenue Intelligence (IQR + Perda Estimada + RRI) — números
    // determinísticos que o Diretor IA pode citar com segurança. Sempre rotulado
    // como "potencial em risco" para não inflar a narrativa.
    try {
      const r = RevenueIntelligenceService.getSnapshot(orgId, "month");
      const brl = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
      const drv = r.drivers;
      blocks.push(
        `REVENUE INTELLIGENCE (30 dias): IQR ${r.iqr.score}/100 (Atendimento ${drv.atendimento.score}, Comercial ${drv.comercial.score}, Operacional ${drv.operacional.score}; mais fraco: ${r.iqr.weakestDriver}). ` +
        `Potencial em risco: ${brl(r.money.estimatedLoss)} (recuperável ${brl(r.money.recoverable)}). ` +
        `Receita recuperada por fluxos do ZappFlow (janela ${r.attributionWindowDays}d): ${brl(r.money.recovered)}. ` +
        `Premissa de ticket: ${brl(r.money.ticket.value)} (${r.money.ticket.source}). Fórmula: ${r.money.formula}.`
      );
      const top = r.lossSources.filter(s => s.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 3);
      if (top.length) {
        blocks.push(`FONTES DA PERDA: ${top.map(s => `${s.label} (${s.count} × ${(s.prob * 100).toFixed(0)}% = ${brl(s.amount)})`).join('; ')}.`);
      }
    } catch (e) { /* noop */ }

    // 2. Funil (estágios atuais dos tickets abertos).
    try {
      const stages = db.prepare(`SELECT stage, count(*) c FROM tickets WHERE organization_id = ? AND status = 'open' GROUP BY stage`).all(orgId) as any[];
      if (stages.length) blocks.push(`FUNIL (tickets abertos por estágio): ${stages.map(s => `${s.stage}=${s.c}`).join(', ')}.`);
    } catch (e) { /* noop */ }

    // 3. CRM: segmentos de cliente.
    try {
      const temps = db.prepare(`SELECT lead_temperature t, count(*) c FROM contacts WHERE organization_id = ? GROUP BY lead_temperature`).all(orgId) as any[];
      const tmap: any = temps.reduce((a, r) => { a[r.t || 'frio'] = r.c; return a; }, {});
      const inactive = db.prepare(`SELECT count(*) c FROM contacts WHERE organization_id = ? AND purchase_count > 0 AND (last_purchase_at IS NULL OR last_purchase_at < datetime('now','-60 days'))`).get(orgId) as any;
      const totalContacts = db.prepare(`SELECT count(*) c FROM contacts WHERE organization_id = ?`).get(orgId) as any;
      const optouts = db.prepare(`SELECT count(*) c FROM contacts WHERE organization_id = ? AND COALESCE(marketing_opt_out,0)=1`).get(orgId) as any;
      blocks.push(`CRM: ${totalContacts?.c || 0} contatos (quentes=${tmap.quente || 0}, mornos=${tmap.morno || 0}, frios=${tmap.frio || 0}). Inativos há +60 dias com histórico de compra: ${inactive?.c || 0}. Opt-out de campanhas: ${optouts?.c || 0}.`);
    } catch (e) { /* noop */ }

    // 4. Top compradores (oportunidade de ofertas/relacionamento).
    try {
      const top = db.prepare(`SELECT name, identifier, purchase_count, total_spent FROM contacts WHERE organization_id = ? AND purchase_count > 0 ORDER BY total_spent DESC LIMIT 5`).all(orgId) as any[];
      if (top.length) blocks.push(`TOP COMPRADORES: ${top.map(t => `${t.name || t.identifier} (${t.purchase_count}x, R$ ${Number(t.total_spent || 0).toFixed(2)})`).join('; ')}.`);
    } catch (e) { /* noop */ }

    // 5. Vendas por status + receita confirmada.
    try {
      const byStatus = db.prepare(`SELECT status, count(*) c, COALESCE(SUM(total_amount),0) t FROM orders WHERE organization_id = ? GROUP BY status`).all(orgId) as any[];
      if (byStatus.length) {
        const rev = byStatus.filter(s => ['pago','em_preparo','entregue','concluido'].includes(s.status)).reduce((a, s) => a + (s.t || 0), 0);
        blocks.push(`PEDIDOS: ${byStatus.map(s => `${s.status}=${s.c}`).join(', ')}. Receita confirmada (total): R$ ${rev.toFixed(2)}.`);
      }
    } catch (e) { /* noop */ }

    // 6. Estoque baixo / sem estoque (gestão do agente de estoque).
    try {
      const low = db.prepare(`
        SELECT ps.name, inv.quantity_available, inv.quantity_reserved, inv.low_stock_threshold
        FROM products_services ps JOIN inventory_items inv ON inv.product_service_id = ps.id
        WHERE ps.organization_id = ? AND ps.active = 1 AND ps.stock_control_enabled = 1
          AND (inv.quantity_available - inv.quantity_reserved) <= COALESCE(inv.low_stock_threshold,0)
        ORDER BY (inv.quantity_available - inv.quantity_reserved) ASC LIMIT 10
      `).all(orgId) as any[];
      if (low.length) blocks.push(`ESTOQUE BAIXO/ESGOTADO: ${low.map(p => `${p.name} (${Math.max(0,(p.quantity_available||0)-(p.quantity_reserved||0))})`).join(', ')}.`);
    } catch (e) { /* noop */ }

    // 7. Produtos mais vendidos (o que promover).
    try {
      const best = db.prepare(`
        SELECT oi.name_snapshot name, SUM(oi.quantity) qtd
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
        GROUP BY oi.name_snapshot ORDER BY qtd DESC LIMIT 5
      `).all(orgId) as any[];
      if (best.length) blocks.push(`MAIS VENDIDOS: ${best.map(b => `${b.name} (${b.qtd}un)`).join(', ')}.`);
    } catch (e) { /* noop */ }

    // 8. Campanhas recentes.
    try {
      const camps = db.prepare(`SELECT name, status, sent_count, total_targets FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC LIMIT 5`).all(orgId) as any[];
      if (camps.length) blocks.push(`CAMPANHAS: ${camps.map(c => `${c.name} [${c.status}] ${c.sent_count}/${c.total_targets}`).join('; ')}.`);
    } catch (e) { /* noop */ }

    // 9. Agenda próxima (próximos agendamentos/entregas).
    try {
      const appts = db.prepare(`SELECT count(*) c FROM appointments WHERE organization_id = ? AND status NOT IN ('cancelled','completed') AND scheduled_start >= datetime('now')`).get(orgId) as any;
      if (appts?.c) blocks.push(`AGENDA: ${appts.c} agendamento(s) futuro(s) pendente(s).`);
    } catch (e) { /* noop */ }

    return blocks.length ? blocks.join('\n') : "Ainda não há dados suficientes do negócio.";
  }
}
