import { Router } from "express";
import db from "../db.js";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// Já protegida por requireMasterAdmin (cross-tenant, server.ts); esta camada
// extra exige também role='admin' na própria organização do master admin.
//
// Fase 28: aceita filtros (?resource_id=, ?event_type=, ?actor_id=, ?limit=)
// pra permitir investigação dirigida (paciente pergunta "quem viu meu
// prontuário?", auditor filtra por resource_id do contato). Cada consulta
// grava AUDIT_LOG_ACCESSED — o log de acesso ao log fecha o "audit-of-audit"
// (LGPD Art.9 exige rastreabilidade do próprio acesso a dado sensível).
router.get("/", requireRole("admin"), (req: AuthRequest, res) => {
  try {
    const resourceId = typeof req.query.resource_id === "string" ? req.query.resource_id.trim() : "";
    const eventType = typeof req.query.event_type === "string" ? req.query.event_type.trim() : "";
    const actorId = typeof req.query.actor_id === "string" ? req.query.actor_id.trim() : "";
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;

    const filters: string[] = [];
    const params: any[] = [];
    // Nota: a coluna real em auth_audit_logs é `target_user_id`; expomos como
    // `resource_id` na API porque no módulo Clínica esse campo carrega o id
    // do contato/prontuário/receita/etc., não só usuário. Semântica genérica
    // ("o que essa ação afetou") pra permitir busca dirigida sem renomear a
    // coluna e quebrar rows históricos.
    if (resourceId) { filters.push("l.target_user_id = ?"); params.push(resourceId); }
    if (eventType) { filters.push("l.event_type = ?"); params.push(eventType); }
    if (actorId) { filters.push("l.actor_user_id = ?"); params.push(actorId); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const logs = db.prepare(`
      SELECT l.*, u.name as actor_name
      FROM auth_audit_logs l
      LEFT JOIN users u ON l.actor_user_id = u.id
      ${where}
      ORDER BY l.created_at DESC LIMIT ?
    `).all(...params, limit) as any[];

    // Audit-of-audit: rastro do próprio acesso. Usa a org do usuário
    // autenticado (não de nenhuma row filtrada — evita ambiguidade
    // quando query cruza tenants).
    logAuthEvent(
      req.organizationId || null,
      (req.user?.userId || req.user?.id) as any,
      resourceId || null,
      "AUDIT_LOG_ACCESSED",
      {
        filters: { resourceId: resourceId || null, eventType: eventType || null, actorId: actorId || null },
        limit,
        resultCount: logs.length,
      }
    );

    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
