import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import db from "../db.js";
import { JWT_SECRET, MASTER_ADMIN_EMAIL } from "../config/secret.js";

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
