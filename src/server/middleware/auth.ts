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

    // Revogação em tempo real (auditoria 2026): sem isto, um usuário bloqueado/
    // removido continuava com acesso até o token de 24h expirar. Rechecamos o
    // global_status do usuário do JWT a cada requisição protegida (lookup por PK).
    if (req.user?.userId) {
      const u: any = db.prepare('SELECT global_status FROM users WHERE id = ?').get(req.user.userId);
      if (u && (u.global_status === 'blocked' || u.global_status === 'deleted')) {
        return res.status(403).json({ error: "Acesso revogado. Faça login novamente." });
      }
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

// RBAC granular (ADR-095 Bloco 5): enforcement GLOBAL por módulo, aplicado uma
// vez no protectedApi (em vez de rota a rota). Deriva o módulo do 1º segmento da
// rota (ROUTE_MODULE) e a ação do método HTTP. Só age sobre usuários COM perfil
// atribuído (opt-in via hasProfile) — o parque legado passa intacto. Segmentos
// fora do mapa (core/infra, add-ons auto-gated) e o master admin nunca são
// barrados. As rotas que já têm requirePermission próprio (users/permissions)
// não estão no mapa, então não há dupla checagem.
export const enforceModulePermission = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) return next(); // requireAuth já cuidou; aqui é só o gate de módulo
  if (req.user.email && req.user.email === MASTER_ADMIN_EMAIL) return next();
  const seg = (req.path || "").split("/").filter(Boolean)[0];
  const module = PermissionService.moduleForSegment(seg);
  if (!module) return next(); // segmento não gateado
  const orgId = req.organizationId || req.user.organizationId;
  if (!PermissionService.hasProfile(orgId, req.user)) return next(); // legado: sem perfil, sem restrição
  const act = methodAction(req.method);
  if (!PermissionService.can(orgId, req.user, module, act)) {
    return res.status(403).json({ error: `Sem permissão de ${act} em ${module}` });
  }
  next();
};
