import db from "./db.js";
import { TaskService } from "./TaskService.js";

/**
 * Maestro (Execution Intelligence, Fase 3) — a ponte AUTOMÁTICA entre o fluxo
 * externo (cliente) e o interno (equipe). Hoje: quando um atendimento é
 * repassado para um humano, cria uma TAREFA interna delegada para que nada caia
 * no esquecimento. Opt-in por organização (auto_task_on_handoff) e idempotente
 * por ticket (não duplica a tarefa se o mesmo atendimento repassar de novo).
 */
export class MaestroService {
  static onHandoff(orgId: string, ctx: { contactId: string; ticketId: string; contactName?: string; summary?: string }): void {
    try {
      const o = db.prepare("SELECT COALESCE(auto_task_on_handoff,0) AS enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      if (!o || !o.enabled) return; // recurso desligado para esta empresa

      // Idempotência: já existe tarefa aberta deste handoff para este ticket?
      const existing = db.prepare(
        "SELECT id FROM tasks WHERE organization_id = ? AND ticket_id = ? AND source = 'ia' AND status NOT IN ('feito','cancelada') LIMIT 1"
      ).get(orgId, ctx.ticketId);
      if (existing) return;

      const name = (ctx.contactName || "cliente").trim();
      TaskService.create(orgId, {
        title: `Atender ${name} (repasse para humano)`,
        description: ctx.summary || "A IA repassou esta conversa para um atendente humano.",
        priority: "alta",
        source: "ia",
        contactId: ctx.contactId,
        ticketId: ctx.ticketId,
      });
      console.log(`[Maestro] Tarefa de repasse criada (org ${orgId}, ticket ${ctx.ticketId}).`);
    } catch (e) {
      console.error("[Maestro] Falha ao criar tarefa de repasse:", e);
    }
  }
}
