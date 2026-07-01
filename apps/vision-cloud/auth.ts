// Autenticação e RBAC do Vision Cloud.
//
// `requireAuth` é uma reimplementação DELIBERADA (não importada) da checagem
// de JWT do core (src/server/middleware/auth.ts) — mesmo segredo, mesma
// forma de decodificar tenant/usuário, mas sem acoplar este processo ao
// código do core (ver docs/adr/ADR-001-vision-edge-runtime.md, adendo).
//
// `requireVisionRole` é o RBAC granular do PRD (§20.1: Vision Admin,
// Security Operator, Portaria Operator, etc.) — além do gate grosso de
// módulo ("vms" habilitado/desabilitado) que o CORE já aplica antes de
// proxied a requisição para cá.
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import db from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "";

export interface VisionRequest extends Request {
  organizationId?: string;
  userId?: string;
  coreRole?: string;
}

export function requireAuth(req: VisionRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.organizationId = decoded.organizationId;
    req.userId = decoded.userId;
    req.coreRole = decoded.role;
    next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// Papéis do PRD §20.1. Mantido como union de string (não enum) para casar
// com o padrão do resto do projeto (roles/módulos já são strings soltas
// validadas em código, ver ModuleService.OPTIONAL_MODULES).
export const VISION_ROLES = [
  "vision_admin",
  "security_operator",
  "operations_manager",
  "portaria_operator",
  "access_controller",
  "evidence_auditor",
  "unit_manager",
  "administradora_master",
  "support_tecnico",
  "identity_search_officer",
] as const;
export type VisionRole = (typeof VISION_ROLES)[number];

export function isValidVisionRole(role: string): role is VisionRole {
  return (VISION_ROLES as readonly string[]).includes(role);
}

/**
 * Verifica se o usuário tem UM dos papéis Vision permitidos, escopado à
 * organização e (se `siteId` for informado) ao site.
 *
 * Bootstrap: owner/admin do CORE (já um papel de confiança alta no restante
 * do produto) sempre passa, mesmo sem um vision_role_assignments explícito —
 * sem isso, ninguém conseguiria criar a PRIMEIRA atribuição de papel Vision
 * numa organização nova. Qualquer outro usuário precisa de uma linha
 * explícita em vision_role_assignments.
 */
export function hasVisionRole(req: VisionRequest, allowedRoles: readonly VisionRole[], siteId?: string | null): boolean {
  if (req.coreRole === "owner" || req.coreRole === "admin") return true;
  if (!req.organizationId || !req.userId) return false;

  const rows = db
    .prepare(
      `SELECT role, site_id, expires_at FROM vision_role_assignments
       WHERE organization_id = ? AND user_id = ?`
    )
    .all(req.organizationId, req.userId) as { role: string; site_id: string | null; expires_at: string | null }[];

  const now = Date.now();
  return rows.some((r) => {
    if (!allowedRoles.includes(r.role as VisionRole)) return false;
    if (r.expires_at && new Date(r.expires_at).getTime() < now) return false; // expirado
    if (r.site_id == null) return true; // papel vale para a org inteira
    if (siteId == null) return true; // rota não é escopada a um site específico
    return r.site_id === siteId;
  });
}

/** Middleware pronto para uso em rotas: 403 se nenhum papel permitido bater. */
export function requireVisionRole(allowedRoles: readonly VisionRole[], siteIdFrom?: (req: VisionRequest) => string | null | undefined) {
  return (req: VisionRequest, res: Response, next: NextFunction) => {
    const siteId = siteIdFrom ? siteIdFrom(req) : undefined;
    if (hasVisionRole(req, allowedRoles, siteId ?? undefined)) return next();
    return res.status(403).json({ error: "vision_role_required", allowed: allowedRoles });
  };
}
