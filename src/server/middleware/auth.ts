import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import db from "../db.js";
import { JWT_SECRET, MASTER_ADMIN_EMAIL } from "../config/secret.js";
import { PermissionService, Action } from "../PermissionService.js";

export interface AuthRequest extends Request {
  user?: any;
  organizationId?: string;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    req.organizationId = decoded.organizationId;
    req.headers['x-organization-id'] = decoded.organizationId; // for backwards compatibility
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

export const requireOrganizationAccess = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.organizationId) {
    return res.status(403).json({ error: "Forbidden: No organization assigned" });
  }

  try {
    const org: any = db.prepare('SELECT status FROM organization_settings WHERE organization_id = ?').get(req.organizationId);
    
    if (!org) {
       return res.status(404).json({ error: "Organization not found" });
    }

    if (org.status === 'blocked') {
       return res.status(403).json({ error: "CONTA BLOQUEADA. Entre em contato com o suporte." });
    }
    
    next();
  } catch (e) {
    return res.status(500).json({ error: "Internal server error checking organization" });
  }
};

export const requireMasterAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.email !== MASTER_ADMIN_EMAIL) {
     return res.status(403).json({ error: "Forbidden: Master Admin Access Required" });
  }
  next();
};

// Papel do usuário dentro da própria organização (owner/admin/agent — ver
// users.role, db.ts). Diferente de requireMasterAdmin, que é cross-tenant.
//
// Antes de existir, cada rota repetia `if (actor.role !== 'owner' && actor.role
// !== 'admin') return res.status(403)...` na mão — 8 cópias da mesma checagem
// espalhadas em managers.ts/users.ts/audit.ts, cada uma podendo divergir. Uso:
// `router.post("/x", requireRole("owner", "admin"), handler)`.
export const requireRole = (...roles: string[]) => (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden: insufficient role" });
  }
  next();
};

// RBAC granular (ADR-095): autoriza por NÍVEL de acesso do perfil do usuário a um
// módulo, substituindo o gating binário de requireRole. A ação, quando não
// informada, é derivada do método HTTP (GET=read; POST/PUT/PATCH=write;
// DELETE=delete). Enquanto o usuário não tiver perfil atribuído, o
// PermissionService cai no fallback dos papéis legados — nada muda de imediato.
//
// Uso: `router.post("/x", requirePermission("vendas"), handler)` (ação = write,
// derivada) ou `requirePermission("vendas", "delete")` para fixar a ação.
const methodAction = (method: string): Action => {
  const m = (method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  if (m === "DELETE") return "delete";
  return "write";
};

export const requirePermission = (module: string, action?: Action) => (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  // Master admin é cross-tenant e nunca é barrado pelo RBAC da org.
  if (req.user.email && req.user.email === MASTER_ADMIN_EMAIL) return next();
  const act = action || methodAction(req.method);
  if (!PermissionService.can(req.organizationId || req.user.organizationId, req.user, module, act)) {
    return res.status(403).json({ error: `Forbidden: sem permissão de ${act} em ${module}` });
  }
  next();
};
