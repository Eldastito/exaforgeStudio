import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { JWT_SECRET } from "../config/secret.js";
import { TOTPService } from "../TOTPService.js";
import { EncryptionService } from "../EncryptionService.js";
import { ModuleService } from "../ModuleService.js";
import { PlanService } from "../PlanService.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// --- Proteção contra força-bruta no login (em memória, por e-mail) ---
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 15 min
const loginAttempts = new Map<string, { count: number; lockUntil: number }>();

function loginLockRemainingMs(key: string): number {
  const rec = loginAttempts.get(key);
  if (!rec) return 0;
  if (rec.lockUntil && Date.now() < rec.lockUntil) return rec.lockUntil - Date.now();
  return 0;
}
function registerFailedLogin(key: string) {
  const rec = loginAttempts.get(key) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.lockUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}
function clearLoginAttempts(key: string) {
  loginAttempts.delete(key);
}

// Política mínima de senha (cadastro e troca de senha).
function passwordPolicyError(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) {
    return "A senha deve ter pelo menos 8 caracteres.";
  }
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return "A senha deve conter letras e números.";
  }
  return null;
}

// GET /api/auth/org-invite/:token — dados públicos de um convite de NOVA EMPRESA
// (cortesia), para a tela de cadastro mostrar o que está incluído.
router.get("/org-invite/:token", (req: Request, res: Response): any => {
  try {
    const inv = db.prepare(`SELECT * FROM org_invitations WHERE token = ?`).get(req.params.token) as any;
    if (!inv || inv.status !== 'pending') return res.json({ valid: false });
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.json({ valid: false });
    let modules: string[] = [];
    try { modules = inv.enabled_modules ? JSON.parse(inv.enabled_modules) : []; } catch {}
    const plan = db.prepare(`SELECT name FROM plans WHERE id = ?`).get(inv.plan_id) as any;
    res.json({
      valid: true,
      businessName: inv.business_name || "",
      recipientName: inv.recipient_name || "",
      planName: plan?.name || "Cortesia",
      modules,
    });
  } catch (e: any) {
    res.json({ valid: false });
  }
});

router.post("/register", async (req: Request, res: Response): Promise<any> => {
  const { name, email, phone, password, organizationName, segment, sizeRange, inviteToken, orgInviteToken, planId } = req.body;
  
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const pwErr = passwordPolicyError(password);
  if (pwErr) {
    return res.status(400).json({ error: pwErr });
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
    } else if (orgInviteToken) {
       // Convite de NOVA EMPRESA (cortesia): cria uma org NOVA, já com o plano e
       // os módulos definidos pelo super admin. O usuário vira owner.
       const inv = db.prepare("SELECT * FROM org_invitations WHERE token = ? AND status = 'pending'").get(orgInviteToken) as any;
       if (!inv) return res.status(400).json({ error: "Convite inválido ou já utilizado" });
       if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: "Convite expirado" });

       orgId = "org_" + uuidv4().substring(0, 8);
       const bizName = inv.business_name || organizationName || (name ? `Empresa de ${name}` : "Minha Empresa");
       db.prepare(`
         INSERT INTO organization_settings (id, organization_id, business_name, phone, status, onboarding_status, plan_id, billing_status)
         VALUES (?, ?, ?, ?, 'active', 'completed', ?, ?)
       `).run(uuidv4(), orgId, bizName, phone || null, inv.plan_id || 'cortesia', inv.billing_status || 'active');

       // Módulos: lista explícita do convite ou preset da vertical; senão, libera tudo.
       try {
         let mods: any = null;
         if (inv.enabled_modules) { try { mods = JSON.parse(inv.enabled_modules); } catch {} }
         if (Array.isArray(mods) && mods.length) ModuleService.setModules(orgId, mods);
         else ModuleService.applyVertical(orgId, inv.vertical || 'outro');
       } catch (e) { /* noop */ }

       role = 'owner';
       db.prepare("UPDATE org_invitations SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP, created_org_id = ? WHERE id = ?").run(orgId, inv.id);
    } else {
       if (!organizationName) {
          return res.status(400).json({ error: "Nome da empresa é obrigatório para nova conta" });
       }
       orgId = "org_" + uuidv4().substring(0, 8);
       db.prepare(`
         INSERT INTO organization_settings (id, organization_id, business_name, phone, segment, size_range, status, onboarding_status)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 'pending')
       `).run(uuidv4(), orgId, organizationName, phone || null, segment || null, sizeRange || null);

       // Self-service: se escolheu um plano no cadastro, inicia o teste grátis.
       if (planId) {
         try { PlanService.selectPlan(orgId, String(planId)); } catch (e) { /* noop */ }
       }
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
  const { email, password, mfaToken } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  const attemptKey = String(email).toLowerCase();
  const lockMs = loginLockRemainingMs(attemptKey);
  if (lockMs > 0) {
    logAuthEvent(null, null, null, 'LOGIN_LOCKED', { email });
    return res.status(429).json({
      error: `Muitas tentativas. Tente novamente em ${Math.ceil(lockMs / 60000)} minuto(s).`,
    });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!user || !user.password_hash) {
      // Don't reveal if user exists
      registerFailedLogin(attemptKey);
      logAuthEvent(null, null, null, 'LOGIN_FAILED', { email });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.global_status === 'blocked') {
      logAuthEvent(user.organization_id, user.id, user.id, 'LOGIN_BLOCKED', { email });
      return res.status(403).json({ error: "Account blocked." });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      registerFailedLogin(attemptKey);
      logAuthEvent(user.organization_id, user.id, user.id, 'LOGIN_FAILED', { email });
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // 2FA: se o usuário tem MFA ativo, exige o código (do app ou um backup code)
    // ANTES de emitir o token. Mantém o contador de tentativas para o 2º fator.
    if (user.mfa_enabled) {
      const provided = String(mfaToken || "").replace(/\s/g, "");
      if (!provided) {
        return res.status(401).json({ mfaRequired: true, error: "Código de verificação (2FA) necessário." });
      }
      const secret = EncryptionService.decrypt(user.mfa_secret);
      let ok = !!secret && TOTPService.verify(secret, provided);
      // Tenta um código de backup (consumido ao usar).
      if (!ok && user.mfa_backup_codes) {
        try {
          const codes: string[] = JSON.parse(EncryptionService.decrypt(user.mfa_backup_codes) || "[]");
          const idx = codes.indexOf(provided);
          if (idx >= 0) {
            codes.splice(idx, 1);
            db.prepare("UPDATE users SET mfa_backup_codes = ? WHERE id = ?").run(EncryptionService.encrypt(JSON.stringify(codes)), user.id);
            ok = true;
            logAuthEvent(user.organization_id, user.id, user.id, 'MFA_BACKUP_CODE_USED', { email });
          }
        } catch (e) { /* noop */ }
      }
      if (!ok) {
        registerFailedLogin(attemptKey);
        logAuthEvent(user.organization_id, user.id, user.id, 'MFA_FAILED', { email });
        return res.status(401).json({ mfaRequired: true, error: "Código 2FA inválido." });
      }
    }

    // Login OK: zera o contador de tentativas
    clearLoginAttempts(attemptKey);

    // Update last login
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    logAuthEvent(user.organization_id, user.id, user.id, 'LOGIN_SUCCESS', { email });

    const token = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, role: user.role, role_profile_id: user.role_profile_id || null, email: user.email, name: user.name },
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
      // O envio de e-mail é simulado. Por segurança, NÃO logamos o token em
      // produção (apareceria nos logs do servidor). Configure um provedor de
      // e-mail real para entregar o token ao usuário.
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SIMULATED EMAIL] Password reset token for ${email}: ${token}`);
      } else {
        console.warn(`[AUTH] Pedido de reset de senha para ${email}. Configure um provedor de e-mail para entregar o token.`);
      }
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
  
  const pwErr = passwordPolicyError(newPassword);
  if (pwErr) {
    return res.status(400).json({ error: pwErr });
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
    const user = db.prepare('SELECT id, organization_id, name, email, role, role_profile_id, global_status FROM users WHERE id = ?').get(decoded.userId) as any;
    
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

