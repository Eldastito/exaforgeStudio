import { randomUUID } from "node:crypto";
import db from "./db.js";

// Auditoria compartilhada entre RadarService e ConversionVelocityService.
// Reaproveita auth_audit_logs (namespace de eventos radar_*, PRD §24) em vez
// de criar uma tabela de auditoria só para o módulo — é o padrão mais próximo
// já ativo no projeto (ver docs/adr/ADR-009-radar-execucao-ia.md).
export function logRadarEvent(
  organizationId: string,
  actorUserId: string | null | undefined,
  eventType: string,
  metadata: Record<string, any> = {}
) {
  db.prepare(
    `INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(randomUUID(), organizationId, actorUserId || null, eventType, JSON.stringify(metadata));
}
