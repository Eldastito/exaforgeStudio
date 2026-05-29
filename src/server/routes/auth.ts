import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'zappflow_secret_key_123';

const logAuthEvent = (orgId: string | null, actorId: string | null, targetId: string | null, eventType: string, meta: any = {}) => {
  try {
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId, actorId, targetId, eventType, JSON.stringify(meta));
  } catch(e) {
    console.error("Failed to log auth event", e);
  }
};

router.post("/register", async (req: Request, res: Response): Promise<any> => {
  const { name, email, phone, password, organizationName, segment, sizeRange, inviteToken } = req.body;
  
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) {
      return res.status(400).json({ error: "Email already in use" });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    let orgId = '';
    let role = 'owner';

    // Se tiver um token de convite, vamos processar
    if (inviteToken) {
       const invite = db.prepare('SELECT * FROM user_invitations WHERE token_hash = ? AND email = ? AND status = ?').get(inviteToken, email, 'pending') as any;
       if (!invite) {
           return res.status(400).json({ error: "Convite inválido ou expirado" });
       }
       if (new Date(invite.expires_at) < new Date()) {
           return res.status(400).json({ error: "Convite expirado" });
       }
       
       orgId = invite.organization_id;
       role = invite.role;

       db.prepare('UPDATE user_invitations SET status = ?, accepted_at = CURRENT_TIMESTAMP WHERE id = ?').run('accepted', invite.id);
    } else {
       if (!organizationName) {
          return res.status(400).json({ error: "Nome da empresa é obrigatório para nova conta" });
       }
       orgId = "org_" + uuidv4().substring(0, 8);
       db.prepare(`
         INSERT INTO organization_settings (id, organization_id, business_name, phone, segment, size_range, status, onboarding_status)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 'pending')
       `).run(uuidv4(), orgId, organizationName, phone || null, segment || null, sizeRange || null);
    }

    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, organization_id, name, email, phone, password_hash, role, global_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(userId, orgId, name, email, phone || null, passwordHash, role);

    logAuthEvent(orgId, userId, userId, inviteToken ? 'USER_REGISTERED_VIA_INVITE' : 'USER_REGISTERED', { email, inviteToken });

    res.status(201).json({ message: "Registration successful" });
  } catch (error: any) {
    console.error("Register Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/login", async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!user || !user.password_hash) {
      // Don't reveal if user exists
      logAuthEvent(null, null, null, 'LOGIN_FAILED', { email });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.global_status === 'blocked') {
      logAuthEvent(user.organization_id, user.id, user.id, 'LOGIN_BLOCKED', { email });
      return res.status(403).json({ error: "Account blocked." });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      logAuthEvent(user.organization_id, user.id, user.id, 'LOGIN_FAILED', { email });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Update last login
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    logAuthEvent(user.organization_id, user.id, user.id, 'LOGIN_SUCCESS', { email });

    const token = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, role: user.role, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    const org = db.prepare('SELECT onboarding_status FROM organization_settings WHERE organization_id = ?').get(user.organization_id) as any;

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, organizationId: user.organization_id, role: user.role, onboarding_status: org?.onboarding_status } });
  } catch (error: any) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/forgot-password", async (req: Request, res: Response): Promise<any> => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });

  try {
    const user = db.prepare('SELECT id, organization_id FROM users WHERE email = ?').get(email) as any;
    if (user) {
      const token = uuidv4() + uuidv4(); // Simple token for demo
      const hashedToken = await bcrypt.hash(token, 10);
      
      db.prepare(`
        INSERT INTO password_reset_events (id, user_id, token_hash, expires_at)
        VALUES (?, ?, ?, datetime('now', '+1 hour'))
      `).run(uuidv4(), user.id, hashedToken);

      logAuthEvent(user.organization_id, user.id, user.id, 'PASSWORD_RESET_REQUESTED', { email });
      // Here you would send an email with the `token`. For now, we simulate success.
      console.log(`[SIMULATED EMAIL] Password reset token for ${email}: ${token}`);
    }
    // Always return success to prevent enum
    res.json({ message: "Se este e-mail estiver cadastrado, enviaremos instruções para recuperação de acesso." });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/reset-password", async (req: Request, res: Response): Promise<any> => {
  const { token, newPassword, email } = req.body;
  if (!token || !newPassword || !email) return res.status(400).json({ error: "Missing fields" });
  
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
    const user = db.prepare('SELECT id, organization_id FROM users WHERE email = ?').get(email) as any;
    if (!user) return res.status(400).json({ error: "Invalid token or email" });

    // In a real implementation we would fetch pending events, unhash, or look up by a token ID.
    // For this prototype, if there's any pending for the user we accept for simplicity
    const pendingEvent = db.prepare(`
      SELECT * FROM password_reset_events 
      WHERE user_id = ? AND status = 'pending' AND expires_at > datetime('now')
      ORDER BY requested_at DESC LIMIT 1
    `).get(user.id) as any;

    if (!pendingEvent) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const match = await bcrypt.compare(token, pendingEvent.token_hash);
    if (!match) {
      return res.status(400).json({ error: "Invalid token" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashed, user.id);
    db.prepare('UPDATE password_reset_events SET status = ? WHERE id = ?').run('completed', pendingEvent.id);

    logAuthEvent(user.organization_id, user.id, user.id, 'PASSWORD_RESET_COMPLETED', { email });

    res.json({ message: "Password updated successfully" });
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/me", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = db.prepare('SELECT id, organization_id, name, email, role, global_status FROM users WHERE id = ?').get(decoded.userId) as any;
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    if (user.global_status === 'blocked') {
       return res.status(403).json({ error: "Account blocked." });
    }

    const org = db.prepare('SELECT onboarding_status FROM organization_settings WHERE organization_id = ?').get(user.organization_id) as any;
    user.onboarding_status = org ? org.onboarding_status : 'completed';

    res.json(user);
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
});

export default router;

