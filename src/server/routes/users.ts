import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { requirePermission } from "../middleware/auth.js";
import { PermissionService } from "../PermissionService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// Used inside requireOrganizationAccess and requireAuth middlewares
// Sempre usa o org do JWT verificado; nunca confia no header x-organization-id.
const getOrgId = (req: any) => req.organizationId;

// GET /api/users
router.get("/", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const actor = (req as any).user;
  try {
    const users = db.prepare('SELECT id, name, email, role, role_profile_id, phone, avatar_url, global_status, last_login_at, created_at FROM users WHERE organization_id = ?').all(orgId);

    // O token só é exposto a quem administra usuários (nível ≥ write no módulo
    // "usuarios") — são eles que compartilham o convite manualmente (o app não
    // envia e-mail). RBAC granular (ADR-095): cobre owner/admin legados e perfis.
    const canSeeToken = actor && PermissionService.can(orgId, actor, 'usuarios', 'write');
    const inviteCols = canSeeToken
      ? 'id, email, role, status, expires_at, created_at, token_hash AS token'
      : 'id, email, role, status, expires_at, created_at';
    const invites = db.prepare(`SELECT ${inviteCols} FROM user_invitations WHERE organization_id = ? AND status = 'pending'`).all(orgId);

    res.json({ users, invites });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/users/invite
router.post("/invite", requirePermission("usuarios", "write"), (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { email, role } = req.body;
  const actor = (req as any).user;

  if (!email || !role) {
    return res.status(400).json({ error: "Missing email or role" });
  }

  try {
    // Check if already user or invited
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    // In this MVP, we just create the user straight away with a random password if we want, or create an invite.
    // The PRD says: "invite user, user clicks link, sets password". We'll just create the invite.
    const token = uuidv4();
    
    db.prepare(`
      INSERT INTO user_invitations (id, organization_id, email, role, token_hash, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'), ?)
    `).run(uuidv4(), orgId, email, role, token, actor.userId);

    // Envio de e-mail simulado. Por segurança, não logamos o token em produção.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[SIMULATED EMAIL] Invite to ${email} with role ${role}. Token is: ${token}`);
    } else {
      console.warn(`[USERS] Convite criado para ${email} (${role}). Configure um provedor de e-mail para entregar o token.`);
    }
    
    logAuthEvent(orgId, actor.userId, undefined, 'USER_INVITED', { email, role });

    // Retornamos o token para o owner/admin compartilhar o convite manualmente
    // (o app não envia e-mail). O front monta o link de convite com esse token.
    res.json({ message: "Invite sent successfully", token, email });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/users/:id/status
router.put("/:id/status", requirePermission("usuarios", "write"), (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { id } = req.params;
  const { status } = req.body; // active, blocked
  const actor = (req as any).user;

  try {
     db.prepare('UPDATE users SET global_status = ? WHERE id = ? AND organization_id = ?').run(status, id, orgId);
     logAuthEvent(orgId, actor.userId, id, 'USER_STATUS_CHANGED', { status });
     res.json({ success: true });
  } catch(e) {
     res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/users/:id/phone — telefone do colaborador (para o Coordenador IA
// reconhecê-lo no WhatsApp interno). Permitido ao próprio usuário ou a owner/admin.
router.put("/:id/phone", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { id } = req.params;
  const actor = (req as any).user;
  if (actor.userId !== id && actor.role !== 'owner' && actor.role !== 'admin') {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '') || null;
    db.prepare('UPDATE users SET phone = ? WHERE id = ? AND organization_id = ?').run(phone, id, orgId);
    res.json({ success: true, phone: phone || '' });
  } catch (e) {
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/users/:id/role — troca o papel de um colaborador (ex.: agent -> admin).
// Mutação sensível (pode dar acesso de administrador a alguém): antes desta
// mudança não gerava NENHUM registro de auditoria — corrigido abaixo.
router.put("/:id/role", requirePermission("usuarios", "write"), (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { id } = req.params;
  const { role } = req.body;
  const actor = (req as any).user;

  try {
     const before = db.prepare('SELECT role FROM users WHERE id = ? AND organization_id = ?').get(id, orgId) as any;
     db.prepare('UPDATE users SET role = ? WHERE id = ? AND organization_id = ?').run(role, id, orgId);
     logAuthEvent(orgId, actor.userId, id, 'USER_ROLE_CHANGED', { from: before?.role ?? null, to: role });
     res.json({ success: true });
  } catch(e) {
     res.status(500).json({ error: "Internal error" });
  }
});

export default router;
