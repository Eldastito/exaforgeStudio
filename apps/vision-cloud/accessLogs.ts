import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

/**
 * Auditoria de acesso a evidências (PRD-VISION-VMS §19.1). Serviço fino
 * chamado por rotas que abrem stream ao vivo, tocam gravação, exportam ou
 * baixam snapshot — grava QUEM (userId), DE QUAL organização, viu O QUÊ
 * (câmera + intervalo de tempo quando aplicável) e DE ONDE (IP + UA).
 *
 * Best-effort: nunca lança para o chamador — a rota principal não deve
 * quebrar se a auditoria falhar. Mas o insert é síncrono para que a linha
 * já esteja no banco antes de a resposta HTTP ser devolvida ao usuário.
 */

export type AccessAction = "live_view" | "playback" | "export" | "snapshot";

export interface AccessLogInput {
  organizationId: string;
  userId?: string | null;
  cameraId?: string | null;
  siteId?: string | null;
  action: AccessAction;
  targetRef?: string | null;
  windowStart?: string | Date | null;
  windowEnd?: string | Date | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  try {
    const d = typeof v === "string" ? new Date(v) : v;
    return isNaN(d.getTime()) ? null : d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  } catch { return null; }
}

const VALID: AccessAction[] = ["live_view", "playback", "export", "snapshot"];

export function recordAccess(input: AccessLogInput): string | null {
  try {
    if (!input.organizationId) return null;
    if (!VALID.includes(input.action)) return null;
    const id = uuidv4();
    db.prepare(
      `INSERT INTO vision_access_logs (id, organization_id, user_id, camera_id, site_id, action, target_ref, window_start, window_end, user_agent, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.organizationId, input.userId || null, input.cameraId || null, input.siteId || null,
      input.action, input.targetRef || null, iso(input.windowStart), iso(input.windowEnd),
      (input.userAgent || "").slice(0, 300) || null, (input.ipAddress || "").slice(0, 60) || null,
    );
    return id;
  } catch (e) {
    console.error("[VisionAccessLogs] falha ao registrar acesso:", e);
    return null;
  }
}

export interface ListAccessOpts {
  cameraId?: string | null;
  siteId?: string | null;
  userId?: string | null;
  action?: AccessAction | null;
  since?: string | null; // ISO ou 'YYYY-MM-DD HH:MM:SS'
  limit?: number;
}
export function listAccess(orgId: string, opts: ListAccessOpts = {}): any[] {
  const wheres: string[] = ["organization_id = ?"];
  const params: any[] = [orgId];
  if (opts.cameraId) { wheres.push("camera_id = ?"); params.push(opts.cameraId); }
  if (opts.siteId)   { wheres.push("site_id = ?"); params.push(opts.siteId); }
  if (opts.userId)   { wheres.push("user_id = ?"); params.push(opts.userId); }
  if (opts.action && VALID.includes(opts.action)) { wheres.push("action = ?"); params.push(opts.action); }
  if (opts.since)    { wheres.push("created_at >= ?"); params.push(String(opts.since)); }
  const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 100)));
  return db.prepare(
    `SELECT id, user_id, camera_id, site_id, action, target_ref, window_start, window_end, user_agent, ip_address, created_at
       FROM vision_access_logs WHERE ${wheres.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`
  ).all(...params) as any[];
}
