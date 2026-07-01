// Botão de pânico (PRD §15). Cria, na mesma chamada, um evento crítico E uma
// ocorrência já aberta com `legal_hold=1` — em produção real, com gravação
// existindo, isso é o gatilho que bloqueia expurgo automático do clipe de
// evidência (ADR-004); aqui, sem `vision_evidence` implementado ainda (Fase
// de gravação, bloqueada em laboratório com hardware real), a flag só marca
// a intenção — não há evidência de vídeo para travar de fato.
//
// Não há chamada automática a serviço de emergência/terceiro nesta
// implementação (PRD §15.2: "nenhuma chamada automática... sem contrato e
// integração validada") — o pânico só registra e abre a ocorrência para a
// equipe humana agir.
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";
import { enqueueWebhookDeliveries } from "../webhooks.js";

const router = Router();
router.use(requireAuth);

// PRD §15.2: acesso apenas para papéis autorizados — quem está na operação
// (portaria/segurança) ou administra o Vision, não papéis de auditoria/
// gestão passiva (evidence_auditor, unit_manager, administradora_master).
const PANIC_ROLES = ["vision_admin", "security_operator", "portaria_operator"] as const;

router.post("/", requireVisionRole(PANIC_ROLES), (req: VisionRequest, res) => {
  const { site_id, gateway_id, reason } = req.body || {};

  const eventId = uuidv4();
  db.prepare(
    `INSERT INTO vision_events (id, organization_id, site_id, gateway_id, event_type, severity, status, payload_json)
     VALUES (?, ?, ?, ?, 'panic_activated', 'critica', 'detected', ?)`
  ).run(eventId, req.organizationId, site_id || null, gateway_id || null, JSON.stringify({ triggered_by: req.userId, reason: reason || null }));

  const incidentId = uuidv4();
  db.prepare(
    `INSERT INTO vision_incidents (id, organization_id, site_id, gateway_id, source_event_id, title, description, severity, is_panic, legal_hold, opened_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'critica', 1, 1, ?)`
  ).run(incidentId, req.organizationId, site_id || null, gateway_id || null, eventId, "Botão de pânico acionado", reason || null, req.userId || null);

  const event = db.prepare(`SELECT * FROM vision_events WHERE id = ?`).get(eventId);
  const incident = db.prepare(`SELECT * FROM vision_incidents WHERE id = ?`).get(incidentId);

  // Este INSERT é direto (não passa por createEventIfNotOpen — o pânico
  // sempre cria, nunca reaproveita um evento já aberto), então enfileira o
  // webhook de evento aqui também, além dos dois tópicos específicos.
  enqueueWebhookDeliveries(req.organizationId!, "vision.event.detected", event as any);
  enqueueWebhookDeliveries(req.organizationId!, "vision.panic.activated", event as any);
  enqueueWebhookDeliveries(req.organizationId!, "vision.incident.created", incident as any);

  res.status(201).json({ event, incident });
});

export default router;
