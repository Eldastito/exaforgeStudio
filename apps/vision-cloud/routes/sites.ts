// CRUD de sites (unidades físicas — condomínio, loja, fábrica, etc.).
// Ver PRD §10.1 (inventário) e docs/adr/ADR-002-tenant-isolation-and-storage.md
// (hierarquia tenant -> site -> área -> câmera).
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";

const router = Router();
router.use(requireAuth);

// Qualquer papel Vision autenticado pode LER sites da própria organização —
// só criar/editar exige vision_admin (ou owner/admin do core, via bootstrap).
router.get("/", (req: VisionRequest, res) => {
  const rows = db
    .prepare(`SELECT * FROM vision_sites WHERE organization_id = ? ORDER BY created_at DESC`)
    .all(req.organizationId);
  res.json({ sites: rows });
});

router.get("/:id", (req: VisionRequest, res) => {
  const row = db
    .prepare(`SELECT * FROM vision_sites WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, req.params.id);
  if (!row) return res.status(404).json({ error: "site_not_found" });
  res.json({ site: row });
});

router.post("/", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const { name, address, timezone } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name_required" });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_sites (id, organization_id, name, address, timezone, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, name, address || null, timezone || null, req.userId || null);

  const row = db.prepare(`SELECT * FROM vision_sites WHERE id = ?`).get(id);
  res.status(201).json({ site: row });
});

router.patch("/:id", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const existing = db
    .prepare(`SELECT * FROM vision_sites WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "site_not_found" });

  const { name, address, timezone } = req.body || {};
  db.prepare(
    `UPDATE vision_sites SET name = ?, address = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = ? AND id = ?`
  ).run(name ?? existing.name, address ?? existing.address, timezone ?? existing.timezone, req.organizationId, req.params.id);

  const row = db.prepare(`SELECT * FROM vision_sites WHERE id = ?`).get(req.params.id);
  res.json({ site: row });
});

export default router;
