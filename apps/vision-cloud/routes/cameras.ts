// Inventário de câmeras (PRD §12.2, campos mínimos de vision_cameras). O
// campo `status` aqui é só metadado de cadastro (online/offline/unknown) —
// não reflete stream real até o Vision Edge existir; ver routes/devices.ts
// para o mesmo aviso sobre `/test`.
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req: VisionRequest, res) => {
  const { site_id } = req.query;
  const rows = site_id
    ? db.prepare(`SELECT * FROM vision_cameras WHERE organization_id = ? AND site_id = ? ORDER BY created_at DESC`).all(req.organizationId, site_id)
    : db.prepare(`SELECT * FROM vision_cameras WHERE organization_id = ? ORDER BY created_at DESC`).all(req.organizationId);
  res.json({ cameras: rows });
});

router.get("/:id", (req: VisionRequest, res) => {
  const row = db
    .prepare(`SELECT * FROM vision_cameras WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, req.params.id);
  if (!row) return res.status(404).json({ error: "camera_not_found" });
  res.json({ camera: row });
});

router.post("/", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const { site_id, device_id, gateway_id, name, area_name, camera_role } = req.body || {};
  if (!site_id || !name) return res.status(400).json({ error: "site_id_and_name_required" });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_cameras (id, organization_id, site_id, device_id, gateway_id, name, area_name, camera_role, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, site_id, device_id || null, gateway_id || null, name, area_name || null, camera_role || null, req.userId || null);

  const row = db.prepare(`SELECT * FROM vision_cameras WHERE id = ?`).get(id);
  res.status(201).json({ camera: row });
});

// Habilitar/desabilitar preserva o histórico (não apaga o cadastro) — mesmo
// princípio do PRD §8.2 ("possibilidade de desativar câmera sem apagar
// histórico"), aqui aplicado ao cadastro básico antes de existir gravação.
router.patch("/:id", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const existing = db
    .prepare(`SELECT * FROM vision_cameras WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "camera_not_found" });

  const { name, area_name, camera_role, is_enabled } = req.body || {};
  db.prepare(
    `UPDATE vision_cameras SET name = ?, area_name = ?, camera_role = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = ? AND id = ?`
  ).run(
    name ?? existing.name,
    area_name ?? existing.area_name,
    camera_role ?? existing.camera_role,
    is_enabled != null ? (is_enabled ? 1 : 0) : existing.is_enabled,
    req.organizationId,
    req.params.id
  );

  const row = db.prepare(`SELECT * FROM vision_cameras WHERE id = ?`).get(req.params.id);
  res.json({ camera: row });
});

export default router;
