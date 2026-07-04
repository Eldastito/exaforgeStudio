import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * CRUD genérico de "ação pendente do gestor" (pending_manager_actions) —
 * extraído de AIOrchestratorService.ts para ser reaproveitado também por
 * WhatsAppInventoryIntake.ts sem criar import circular entre os dois
 * (AIOrchestratorService chama o intake; o intake não deve depender de volta
 * do orquestrador). Um gestor tem no máximo UMA ação pendente por vez —
 * salvar substitui qualquer pendência anterior.
 */
export function getPendingAction(orgId: string, identifier: string): any {
  try {
    return db.prepare(`SELECT * FROM pending_manager_actions WHERE organization_id = ? AND identifier = ? ORDER BY created_at DESC LIMIT 1`).get(orgId, identifier);
  } catch (e) { return null; }
}

export function savePendingAction(orgId: string, identifier: string, type: string, payload: any) {
  try {
    db.prepare(`DELETE FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).run(orgId, identifier);
    db.prepare(`INSERT INTO pending_manager_actions (id, organization_id, identifier, action_type, payload_json, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now','+1 hour'))`)
      .run(uuidv4(), orgId, identifier, type, JSON.stringify(payload));
  } catch (e) { /* noop */ }
}

export function clearPendingAction(id: string) {
  try { db.prepare(`DELETE FROM pending_manager_actions WHERE id = ?`).run(id); } catch (e) { /* noop */ }
}
