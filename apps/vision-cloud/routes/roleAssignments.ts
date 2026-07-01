// Atribuição de papéis Vision (PRD §20.1) a usuários. Só quem já é
// vision_admin (ou owner/admin do core, via bootstrap — ver auth.ts) pode
// conceder ou revogar papéis — evita escalonamento de privilégio por um
// usuário comum.
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole, isValidVisionRole, VISION_ROLES } from "../auth.js";

const router = Router();
router.use(requireAuth);

router.get("/", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const rows = db
    .prepare(`SELECT * FROM vision_role_assignments WHERE organization_id = ? ORDER BY created_at DESC`)
    .all(req.organizationId);
  res.json({ role_assignments: rows });
});

router.post("/", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const { user_id, role, site_id, expires_at } = req.body || {};
  if (!user_id || !role) return res.status(400).json({ error: "user_id_and_role_required" });
  if (!isValidVisionRole(role)) return res.status(400).json({ error: "invalid_role", allowed: VISION_ROLES });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_role_assignments (id, organization_id, site_id, user_id, role, granted_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, site_id || null, user_id, role, req.userId || null, expires_at || null);

  const row = db.prepare(`SELECT * FROM vision_role_assignments WHERE id = ?`).get(id);
  res.status(201).json({ role_assignment: row });
});

router.delete("/:id", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const result = db
    .prepare(`DELETE FROM vision_role_assignments WHERE organization_id = ? AND id = ?`)
    .run(req.organizationId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "role_assignment_not_found" });
  res.json({ ok: true });
});

export default router;
