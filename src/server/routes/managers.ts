import { Router, Request, Response } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";

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
router.post("/", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const actor = (req as any).user;
  const { name } = req.body;
  const identifier = normalizeNumber(req.body.identifier);

  if (actor.role !== 'owner' && actor.role !== 'admin') {
    return res.status(403).json({ error: "Apenas dono/admin podem cadastrar gestores" });
  }
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

    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId, actor.userId, 'MANAGER_ADDED', JSON.stringify({ identifier, name }));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Falha ao cadastrar gestor" });
  }
});

// DELETE /api/managers/:id — remove um gestor
router.delete("/:id", (req: Request, res: Response): any => {
  const orgId = getOrgId(req);
  const actor = (req as any).user;
  const { id } = req.params;

  if (actor.role !== 'owner' && actor.role !== 'admin') {
    return res.status(403).json({ error: "Apenas dono/admin podem remover gestores" });
  }

  try {
    db.prepare('DELETE FROM authorized_managers WHERE id = ? AND organization_id = ?').run(id, orgId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Falha ao remover gestor" });
  }
});

export default router;
