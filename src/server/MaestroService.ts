import db from "./db.js";
import { TaskService } from "./TaskService.js";
import { NotificationService } from "./NotificationService.js";

// Rótulos legíveis para os poucos event_type que o Vision Cloud já é capaz de
// detectar honestamente hoje (ver apps/vision-cloud/healthMonitor.ts e
// apps/vision-cloud/routes/panic.ts). Tipos futuros (IA visual, tamper, LPR...)
// caem no fallback (usa o event_type cru) — não bloqueia a ponte por não ter
// um rótulo bonito ainda.
const VISION_EVENT_LABELS: Record<string, string> = {
  gateway_offline: "Gateway offline",
  panic_activated: "Botão de pânico acionado",
  zone_dwell_time: "Permanência prolongada em zona monitorada",
  zone_occupancy_count: "Ocupação acima do limite em zona monitorada",
  zone_after_hours_presence: "Presença fora do horário em zona monitorada",
};

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

  /**
   * Ponte Vision VMS -> Tarefas + Notificação in-app (poll periódico, chamado
   * por Scheduler.fastPass). O core NUNCA escreve em `vision_events` (tabela
   * do vision-cloud, ver apps/vision-cloud/db.ts) — só faz SELECT, no MESMO
   * arquivo SQLite (ADR-001 addendum: Vision Cloud é processo/deploy
   * separado, mas compartilha o arquivo do core). Idempotência via
   * `vision_event_tasks` (tabela do CORE, ver src/server/db.ts), que registra
   * que evento já virou tarefa — nunca duplica (tarefa OU notificação) mesmo
   * rodando este poll repetidas vezes.
   *
   * Regra deliberadamente simples (determinística, sem IA): severidade
   * 'alta'/'critica' e ainda não revisado ('detected') — hoje isso cobre
   * exatamente gateway_offline (health monitor) e panic_activated (botão de
   * pânico), os dois únicos tipos de evento que o Vision Cloud já detecta sem
   * depender do Edge físico. Opt-in por organização
   * (organization_settings.vision_auto_task_enabled), mesmo padrão de
   * auto_task_on_handoff.
   *
   * Deliberadamente NÃO em tempo real: continua no mesmo passe rápido do
   * Scheduler (minutos, não segundos) — o PRD §15.2 é explícito que o botão
   * de pânico "registra e abre para a equipe humana agir", não é uma sirene;
   * dar um SLA de segundos exigiria o vision-cloud chamar de volta o core de
   * forma síncrona, reacoplando os dois processos que o ADR-001 deliberou
   * manter separados. Mais simples e com menos superfície de falha assim.
   */
  static reactToVisionEvents(): void {
    let events: any[] = [];
    try {
      events = db.prepare(`
        SELECT e.id, e.organization_id, e.event_type, e.severity
        FROM vision_events e
        JOIN organization_settings o ON o.organization_id = e.organization_id
        WHERE e.severity IN ('alta', 'critica')
          AND e.status = 'detected'
          AND COALESCE(o.vision_auto_task_enabled, 0) = 1
          AND NOT EXISTS (SELECT 1 FROM vision_event_tasks vet WHERE vet.event_id = e.id)
        LIMIT 200
      `).all() as any[];
    } catch (e) {
      // vision_events pode não existir nesta instância (vision-cloud nunca
      // rodou / módulo nunca foi usado) — ausência, não erro.
      return;
    }

    for (const ev of events) {
      try {
        const label = VISION_EVENT_LABELS[ev.event_type] || ev.event_type;
        const task = TaskService.create(ev.organization_id, {
          title: `[Vision VMS] ${label}`,
          description: `Evento de severidade "${ev.severity}" detectado no Vision VMS. Abra o módulo Vision VMS > Eventos para revisar e agir.`,
          priority: "alta",
          source: "vision",
          refLabel: `vision_event:${ev.id}`,
        });
        db.prepare(`INSERT OR IGNORE INTO vision_event_tasks (event_id, task_id) VALUES (?, ?)`).run(ev.id, task.id);
        NotificationService.visionCriticalEvent(ev.organization_id, label, ev.severity);
        console.log(`[Maestro] Tarefa criada a partir de evento Vision VMS (org ${ev.organization_id}, evento ${ev.id}, tipo ${ev.event_type}).`);
      } catch (e) {
        console.error("[Maestro] Falha ao criar tarefa a partir de evento Vision VMS:", ev.id, e);
      }
    }
  }
}
