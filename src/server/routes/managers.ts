import { Router, Request, Response } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { requireRole } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// Sempre usa o org do JWT verificado; nunca confia no header x-organization-id.
const getOrgId = (req: any) => req.organizationId;

// Normaliza o número do WhatsApp para apenas dígitos (com DDI/DDD),
// para casar com o senderId derivado do remoteJid (ex.: 5521999998888).
function normalizeNumber(input: string): string {
  return String(input || "").replace(/\D/g, "");
}

// GET /api/managers — lista gestores autorizados (Zapp) da organização
router.get("/", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  try {
    const managers = db.prepare(
      'SELECT id, identifier, name, created_at FROM authorized_managers WHERE organization_id = ? ORDER BY created_at DESC'
    ).all(orgId);
    res.json(managers);
  } catch (e) {
    res.status(500).json({ error: "Falha ao listar gestores" });
  }
});

// POST /api/managers — cadastra um número de gestor (dono/sócios)
router.post("/", requireRole("owner", "admin"), (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const actor = (req as any).user;
  const { name } = req.body;
  const identifier = normalizeNumber(req.body.identifier);

  if (!identifier || identifier.length < 10) {
    return res.status(400).json({ error: "Número inválido. Use DDI+DDD+número (ex.: 5521999998888)." });
  }

  try {
    const existing = db.prepare(
      'SELECT id FROM authorized_managers WHERE organization_id = ? AND identifier = ?'
    ).get(orgId, identifier);
    if (existing) return res.status(400).json({ error: "Este número já está cadastrado." });

    db.prepare(
      'INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, ?)'
    ).run(uuidv4(), orgId, identifier, name || null);

    logAuthEvent(orgId, actor.userId, undefined, 'MANAGER_ADDED', { identifier, name });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Falha ao cadastrar gestor" });
  }
});

// DELETE /api/managers/:id — remove um gestor
router.delete("/:id", requireRole("owner", "admin"), (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const actor = (req as any).user;
  const { id } = req.params;

  try {
    // Registra ANTES de apagar, para o log guardar quem era o gestor removido
    // (antes desta mudança, remover um gestor não deixava rastro nenhum).
    const existing = db.prepare('SELECT identifier, name FROM authorized_managers WHERE id = ? AND organization_id = ?').get(id, orgId) as any;
    db.prepare('DELETE FROM authorized_managers WHERE id = ? AND organization_id = ?').run(id, orgId);
    if (existing) logAuthEvent(orgId, actor.userId, id, 'MANAGER_REMOVED', { identifier: existing.identifier, name: existing.name });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Falha ao remover gestor" });
  }
});

export default router;
