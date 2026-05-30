import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// Used inside requireOrganizationAccess and requireAuth middlewares
const getOrgId = (req: any) => req.headers['x-organization-id'] || req.organizationId;

// GET /api/users
router.get("/", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  try {
    const users = db.prepare('SELECT id, name, email, role, phone, avatar_url, global_status, last_login_at, created_at FROM users WHERE organization_id = ?').all(orgId);
    
    const invites = db.prepare('SELECT id, email, role, status, expires_at, created_at FROM user_invitations WHERE organization_id = ?').all(orgId);

    res.json({ users, invites });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// POST /api/users/invite
router.post("/invite", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { email, role } = req.body;
  const actor = (req as any).user;

  if (!email || !role) {
    return res.status(400).json({ error: "Missing email or role" });
  }
  
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    return res.status(403).json({ error: "Insufficient permissions" });
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
    
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId, actor.userId, 'USER_INVITED', JSON.stringify({ email, role }));

    res.json({ message: "Invite sent successfully" });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/users/:id/status
router.put("/:id/status", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { id } = req.params;
  const { status } = req.body; // active, blocked
  const actor = (req as any).user;

  if (actor.role !== 'owner' && actor.role !== 'admin') {
     return res.status(403).json({ error: "Insufficient permissions" });
  }
  
  try {
     db.prepare('UPDATE users SET global_status = ? WHERE id = ? AND organization_id = ?').run(status, id, orgId);
     
     db.prepare(`
        INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), orgId, actor.userId, id, 'USER_STATUS_CHANGED', JSON.stringify({ status }));

     res.json({ success: true });
  } catch(e) {
     res.status(500).json({ error: "Internal error" });
  }
});

// PUT /api/users/:id/role
router.put("/:id/role", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const { id } = req.params;
  const { role } = req.body; 
  const actor = (req as any).user;

  if (actor.role !== 'owner' && actor.role !== 'admin') {
     return res.status(403).json({ error: "Insufficient permissions" });
  }
  
  try {
     db.prepare('UPDATE users SET role = ? WHERE id = ? AND organization_id = ?').run(role, id, orgId);
     res.json({ success: true });
  } catch(e) {
     res.status(500).json({ error: "Internal error" });
  }
});

export default router;
