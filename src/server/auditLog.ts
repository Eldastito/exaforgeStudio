import { randomUUID } from "node:crypto";
import db from "./db.js";

/**
 * Mascara identificador pra ir no metadata de audit (ADR-080 Fase 32).
 * Motivação: audit é lido em telas por operadores/gestor/master admin;
 * expor telefone completo do paciente em toda linha de log é
 * proporcionalidade ruim (LGPD Art.6 III — necessidade). O identifier
 * fica traceável (primeiros 4 + últimos 4) mas não legível na íntegra.
 *
 * Exemplos:
 *   "5511987654321"           → "5511***4321"
 *   "user@example.com"        → "user***.com"   (fallback genérico)
 *   ""/null                   → null
 *   "12345"                   → "12345"          (curto demais pra mascarar)
 */
export function maskIdentifier(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = String(id);
  if (s.length <= 8) return s; // curto demais — mascarar deixaria ilegível
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

// Trilha de auditoria única do ZappFlow. Apesar do nome histórico da tabela
// (`auth_audit_logs`), ela já cobre toda mutação relevante do produto, não só
// login/segurança — eventos como PRODUCT_UPDATED, STOCK_MOVEMENT,
// ADMIN_PLAN_UPDATED, CHANNEL_DELETED etc. já são gravados aqui.
//
// Antes desta extração, a MESMA função existia copiada em 10 arquivos de rota
// (auth.ts, products.ts, tickets.ts, messages.ts, rag.ts, channels.ts,
// integrations.ts, admin.ts, appointments.ts, notifications.ts) — qualquer
// correção ou extensão precisava ser replicada 10 vezes, com risco real de
// divergência. Consolidado aqui: uma implementação, um comportamento.
//
// users.ts e managers.ts faziam INSERT direto na tabela (sem passar por
// nenhum helper) e tinham mutações sem NENHUM registro (troca de papel de
// usuário, remoção de gestor) — corrigido ao migrarem para este helper.
export function logAuthEvent(
  orgId: string | null | undefined,
  actorId: string | null | undefined,
  targetId: string | null | undefined,
  eventType: string,
  meta: Record<string, any> = {}
) {
  try {
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch (e) {
    console.error("[Audit] Falha ao registrar evento", eventType, e);
  }
}
