import { logAuthEvent } from "./auditLog.js";

// Wrapper fino do Radar sobre o helper único de auditoria do app
// (src/server/auditLog.ts) — namespace de eventos radar_* (PRD §24). Existe
// só para os call sites de RadarService/ConversionVelocityService não
// precisarem passar `null` de targetId toda vez.
export function logRadarEvent(
  organizationId: string,
  actorUserId: string | null | undefined,
  eventType: string,
  metadata: Record<string, any> = {}
) {
  logAuthEvent(organizationId, actorUserId, null, eventType, metadata);
}
