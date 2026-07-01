// Inventário de dispositivos (câmeras avulsas, NVR/DVR, encoders) — cadastro
// e classificação de compatibilidade (PRD §7.1), ANTES de qualquer conexão
// real de stream (que depende do Vision Edge Gateway físico, ainda não
// construído — ver docs/PRD-VISION-VMS-RECONCILIACAO.md, bloco 12).
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";

const router = Router();
router.use(requireAuth);

const COMPATIBILITY_STATUSES = [
  "compativel_direto",
  "compativel_via_nvr",
  "compativel_com_adaptacao",
  "uso_temporario",
  "substituicao_recomendada",
  "nao_homologado",
] as const;

router.get("/", (req: VisionRequest, res) => {
  const { site_id } = req.query;
  const rows = site_id
    ? db.prepare(`SELECT * FROM vision_devices WHERE organization_id = ? AND site_id = ? ORDER BY created_at DESC`).all(req.organizationId, site_id)
    : db.prepare(`SELECT * FROM vision_devices WHERE organization_id = ? ORDER BY created_at DESC`).all(req.organizationId);
  res.json({ devices: rows });
});

router.post("/", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const { site_id, gateway_id, device_type, vendor, model, compatibility_status, notes } = req.body || {};
  if (!site_id || !device_type) return res.status(400).json({ error: "site_id_and_device_type_required" });

  const status = COMPATIBILITY_STATUSES.includes(compatibility_status) ? compatibility_status : "nao_homologado";

  const id = uuidv4();
  db.prepare(
    `INSERT INTO vision_devices (id, organization_id, site_id, gateway_id, device_type, vendor, model, compatibility_status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, site_id, gateway_id || null, device_type, vendor || null, model || null, status, notes || null, req.userId || null);

  const row = db.prepare(`SELECT * FROM vision_devices WHERE id = ?`).get(id);
  res.status(201).json({ device: row });
});

// Testar credenciais/stream de verdade exige o Vision Edge Gateway rodando
// na rede do cliente, com câmera física conectada — nenhum dos dois existe
// neste ambiente de desenvolvimento (ver ADR-003 e a matriz de reconciliação,
// bloco 12: "PRECISA SER VALIDADO COM DISPOSITIVO REAL"). Responder algo
// diferente de "não implementado" aqui seria fingir uma capacidade que não
// existe — pior do que não ter o endpoint.
router.post("/:id/test", requireVisionRole(["vision_admin"]), (req: VisionRequest, res) => {
  const device = db
    .prepare(`SELECT id FROM vision_devices WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, req.params.id);
  if (!device) return res.status(404).json({ error: "device_not_found" });

  res.status(501).json({
    error: "not_implemented",
    reason:
      "Teste de conexão real depende do Vision Edge Gateway (ainda não implementado) rodando na rede do cliente, com câmera/NVR físico. Ver docs/adr/ADR-001-vision-edge-runtime.md e docs/PRD-VISION-VMS-RECONCILIACAO.md (bloco 12).",
  });
});

export default router;
