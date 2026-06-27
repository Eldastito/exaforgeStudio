import { Router } from "express";
import db from "../db.js";
import bcrypt from "bcrypt";
import QRCode from "qrcode";
import { AuthRequest } from "../middleware/auth.js";
import { TOTPService } from "../TOTPService.js";
import { EncryptionService } from "../EncryptionService.js";

const router = Router();

// GET /api/mfa/status — diz se o 2FA do usuário logado está ativo.
router.get("/status", (req: AuthRequest, res): any => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const u = db.prepare("SELECT mfa_enabled FROM users WHERE id = ?").get(userId) as any;
  res.json({ enabled: !!u?.mfa_enabled });
});

// POST /api/mfa/setup — gera um segredo PENDENTE e devolve QR + segredo manual.
router.post("/setup", async (req: AuthRequest, res): Promise<any> => {
  const userId = req.user?.userId;
  const email = req.user?.email || "conta";
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const secret = TOTPService.generateSecret();
    db.prepare("UPDATE users SET mfa_pending_secret = ? WHERE id = ?").run(EncryptionService.encrypt(secret), userId);
    const url = TOTPService.otpauthURL(secret, String(email));
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ secret, otpauthUrl: url, qr: qrDataUrl });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/mfa/enable — confirma um código do app e ATIVA o 2FA. Retorna os
// códigos de backup (mostrados uma única vez).
router.post("/enable", (req: AuthRequest, res): any => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { token } = req.body || {};
  const u = db.prepare("SELECT mfa_pending_secret FROM users WHERE id = ?").get(userId) as any;
  const secret = EncryptionService.decrypt(u?.mfa_pending_secret);
  if (!secret) return res.status(400).json({ error: "Inicie a configuração do 2FA primeiro." });
  if (!TOTPService.verify(secret, String(token || ""))) {
    return res.status(400).json({ error: "Código inválido. Confira o app autenticador." });
  }
  const backupCodes = TOTPService.generateBackupCodes();
  db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_pending_secret = NULL, mfa_backup_codes = ? WHERE id = ?")
    .run(EncryptionService.encrypt(secret), EncryptionService.encrypt(JSON.stringify(backupCodes)), userId);
  res.json({ success: true, backupCodes });
});

// POST /api/mfa/disable — desativa o 2FA (exige a senha atual como confirmação).
router.post("/disable", async (req: AuthRequest, res): Promise<any> => {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { password } = req.body || {};
  const u = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as any;
  if (!u) return res.status(404).json({ error: "Usuário não encontrado" });
  const ok = u.password_hash && await bcrypt.compare(String(password || ""), u.password_hash);
  if (!ok) return res.status(400).json({ error: "Senha incorreta." });
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_pending_secret = NULL, mfa_backup_codes = NULL WHERE id = ?").run(userId);
  res.json({ success: true });
});

export default router;
