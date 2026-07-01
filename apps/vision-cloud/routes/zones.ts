// Zonas + regras determinísticas de vídeo analytics (PRD §19.1) + o endpoint
// de observação que alimenta o motor (zoneRules.ts).
//
// POST /:id/observations é INTENCIONALMENTE autenticado como ação de usuário
// (mesmos papéis de revisão de evento) e não por chave de gateway — porque
// hoje NENHUM detector real existe ainda (Fase 0, bloqueada em hardware, ver
// docs/PRD-VISION-VMS-RECONCILIACAO.md). Quando o agente do Vision Edge
// Gateway existir de verdade, essa rota deve trocar para autenticação de
// máquina (mesmo padrão de requireGatewayKey em routes/gateways.ts) — não
// antes, pra não desenhar uma autenticação de máquina especulativa sem um
// cliente real pra validar contra.
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";
import { recordObservation, isValidRuleType, isValidHHMM, RULE_TYPES } from "../zoneRules.js";

const router = Router();
router.use(requireAuth);

const MANAGE_ROLES = ["vision_admin", "security_operator", "operations_manager"] as const;
const OBSERVATION_ROLES = ["vision_admin", "security_operator", "operations_manager", "portaria_operator"] as const;

router.get("/", (req: VisionRequest, res) => {
  const rows = db.prepare(`SELECT * FROM vision_zones WHERE organization_id = ? ORDER BY created_at DESC`).all(req.organizationId);
  res.json({ zones: rows });
});

router.post("/", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const { site_id, camera_id, name, description } = req.body || {};
  if (!site_id || !name) return res.status(400).json({ error: "site_id_and_name_required" });

  const site = db.prepare(`SELECT id FROM vision_sites WHERE organization_id = ? AND id = ?`).get(req.organizationId, site_id);
  if (!site) return res.status(400).json({ error: "site_not_found" });

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_zones (id, organization_id, site_id, camera_id, name, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, site_id, camera_id || null, name, description || null, req.userId || null);

  const row = db.prepare(`SELECT * FROM vision_zones WHERE id = ?`).get(id);
  res.status(201).json({ zone: row });
});

router.delete("/:id", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const result = db.prepare(`DELETE FROM vision_zones WHERE organization_id = ? AND id = ?`).run(req.organizationId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "zone_not_found" });
  db.prepare(`DELETE FROM vision_rules WHERE zone_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM vision_zone_occupancy WHERE zone_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

function findZone(orgId: string, zoneId: string) {
  return db.prepare(`SELECT * FROM vision_zones WHERE organization_id = ? AND id = ?`).get(orgId, zoneId) as any;
}

router.get("/:id/rules", (req: VisionRequest, res) => {
  const zone = findZone(req.organizationId!, req.params.id);
  if (!zone) return res.status(404).json({ error: "zone_not_found" });
  const rows = db.prepare(`SELECT * FROM vision_rules WHERE zone_id = ? ORDER BY created_at DESC`).all(req.params.id);
  res.json({ rules: rows });
});

router.post("/:id/rules", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const zone = findZone(req.organizationId!, req.params.id);
  if (!zone) return res.status(404).json({ error: "zone_not_found" });

  const { rule_type, threshold_value, active_hours_start, active_hours_end, severity } = req.body || {};
  if (!rule_type || !isValidRuleType(rule_type)) return res.status(400).json({ error: "invalid_rule_type", allowed: RULE_TYPES });

  if (rule_type === "after_hours_presence") {
    if (!active_hours_start || !active_hours_end || !isValidHHMM(active_hours_start) || !isValidHHMM(active_hours_end)) {
      return res.status(400).json({ error: "active_hours_start_and_end_required_as_HH:MM" });
    }
  } else {
    const t = Number(threshold_value);
    if (!Number.isFinite(t) || t <= 0) return res.status(400).json({ error: "threshold_value_must_be_positive_number" });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_rules (id, organization_id, zone_id, rule_type, threshold_value, active_hours_start, active_hours_end, severity, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.organizationId, req.params.id, rule_type,
    rule_type === "after_hours_presence" ? null : Number(threshold_value),
    active_hours_start || null, active_hours_end || null,
    severity || "media", req.userId || null
  );

  const row = db.prepare(`SELECT * FROM vision_rules WHERE id = ?`).get(id);
  res.status(201).json({ rule: row });
});

router.patch("/:id/rules/:ruleId", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const zone = findZone(req.organizationId!, req.params.id);
  if (!zone) return res.status(404).json({ error: "zone_not_found" });
  const rule = db.prepare(`SELECT * FROM vision_rules WHERE zone_id = ? AND id = ?`).get(req.params.id, req.params.ruleId) as any;
  if (!rule) return res.status(404).json({ error: "rule_not_found" });

  const { is_active, severity } = req.body || {};
  db.prepare(
    `UPDATE vision_rules SET is_active = ?, severity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(is_active !== undefined ? (is_active ? 1 : 0) : rule.is_active, severity || rule.severity, req.params.ruleId);

  const row = db.prepare(`SELECT * FROM vision_rules WHERE id = ?`).get(req.params.ruleId);
  res.json({ rule: row });
});

router.delete("/:id/rules/:ruleId", requireVisionRole(MANAGE_ROLES), (req: VisionRequest, res) => {
  const zone = findZone(req.organizationId!, req.params.id);
  if (!zone) return res.status(404).json({ error: "zone_not_found" });
  const result = db.prepare(`DELETE FROM vision_rules WHERE zone_id = ? AND id = ?`).run(req.params.id, req.params.ruleId);
  if (result.changes === 0) return res.status(404).json({ error: "rule_not_found" });
  res.json({ ok: true });
});

// Ver comentário no topo do arquivo — endpoint temporário até existir um
// detector real de verdade rodando no Edge.
router.post("/:id/observations", requireVisionRole(OBSERVATION_ROLES), (req: VisionRequest, res) => {
  const zone = findZone(req.organizationId!, req.params.id);
  if (!zone) return res.status(404).json({ error: "zone_not_found" });

  const { person_count, observed_at } = req.body || {};
  const count = Number(person_count);
  if (!Number.isFinite(count) || count < 0) return res.status(400).json({ error: "person_count_must_be_a_non_negative_number" });

  const observedAt = observed_at ? new Date(observed_at) : undefined;
  if (observedAt && isNaN(observedAt.getTime())) return res.status(400).json({ error: "invalid_observed_at" });

  recordObservation(req.organizationId!, req.params.id, count, observedAt);

  const occupancy = db.prepare(`SELECT * FROM vision_zone_occupancy WHERE zone_id = ?`).get(req.params.id);
  res.json({ ok: true, occupancy });
});

export default router;
