// Vision Integration Gateway — webhooks de saída (PRD §16.1/§16.3). Gestão de
// assinaturas + consulta do log de entregas + reprocessamento manual
// autorizado. A entrega de verdade (HTTP + assinatura + retry) fica em
// ../webhookDispatcher.ts; este arquivo só administra o CRUD e enfileira
// reprocessamentos.
//
// RBAC restrito a vision_admin em TODAS as rotas (inclusive leitura): a URL e
// o segredo de assinatura são credenciais de integração externa (PRD §16.2:
// "credenciais protegidas"), não inventário operacional do dia a dia como
// sites/câmeras — mais perto, em sensibilidade, de gateways.register do que
// de sites.get.
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";
import { isSafeWebhookUrl, isValidWebhookTopic, EVENT_TOPICS } from "../webhooks.js";
import { encryptSecret } from "../crypto.js";
import { requeueDelivery } from "../webhookDispatcher.js";

const router = Router();
router.use(requireAuth);
router.use(requireVisionRole(["vision_admin"]));

function parseEventTypes(input: any): { ok: boolean; json: string | null; error?: string } {
  if (input == null) return { ok: true, json: null };
  if (!Array.isArray(input)) return { ok: false, json: null, error: "event_types_must_be_array" };
  if (input.length === 0) return { ok: true, json: null };
  for (const t of input) {
    if (!isValidWebhookTopic(t)) return { ok: false, json: null, error: `invalid_event_type:${t}` };
  }
  return { ok: true, json: JSON.stringify(input) };
}

// Nunca inclui secret_enc na resposta — só existe em claro na criação.
const PUBLIC_COLUMNS = "id, organization_id, url, event_types, is_active, created_by, created_at, updated_at";

router.get("/", (req: VisionRequest, res) => {
  const rows = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM vision_webhooks WHERE organization_id = ? ORDER BY created_at DESC`).all(req.organizationId);
  res.json({ webhooks: rows, available_topics: EVENT_TOPICS });
});

router.post("/", (req: VisionRequest, res) => {
  const { url, event_types } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url_required" });
  if (!isSafeWebhookUrl(url)) return res.status(400).json({ error: "invalid_or_unsafe_url" });

  const parsed = parseEventTypes(event_types);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, allowed: EVENT_TOPICS });

  const id = uuidv4();
  const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
  db.prepare(
    `INSERT INTO vision_webhooks (id, organization_id, url, secret_enc, event_types, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.organizationId, url, encryptSecret(secret), parsed.json, req.userId || null);

  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM vision_webhooks WHERE id = ?`).get(id);
  res.status(201).json({
    webhook: row,
    secret,
    warning: "Guarde este segredo agora — ele não pode ser recuperado depois, só regerado (recrie o webhook).",
  });
});

router.patch("/:id", (req: VisionRequest, res) => {
  const existing = db.prepare(`SELECT id FROM vision_webhooks WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id);
  if (!existing) return res.status(404).json({ error: "webhook_not_found" });

  const { url, event_types, is_active } = req.body || {};
  if (url !== undefined && !isSafeWebhookUrl(url)) return res.status(400).json({ error: "invalid_or_unsafe_url" });

  let eventTypesJson: string | null | undefined = undefined;
  if (event_types !== undefined) {
    const parsed = parseEventTypes(event_types);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, allowed: EVENT_TOPICS });
    eventTypesJson = parsed.json;
  }

  const current = db.prepare(`SELECT * FROM vision_webhooks WHERE id = ?`).get(req.params.id) as any;
  db.prepare(
    `UPDATE vision_webhooks SET url = ?, event_types = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(
    url !== undefined ? url : current.url,
    eventTypesJson !== undefined ? eventTypesJson : current.event_types,
    is_active !== undefined ? (is_active ? 1 : 0) : current.is_active,
    req.params.id
  );

  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM vision_webhooks WHERE id = ?`).get(req.params.id);
  res.json({ webhook: row });
});

router.delete("/:id", (req: VisionRequest, res) => {
  const result = db.prepare(`DELETE FROM vision_webhooks WHERE organization_id = ? AND id = ?`).run(req.organizationId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "webhook_not_found" });
  db.prepare(`DELETE FROM vision_webhook_deliveries WHERE webhook_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.get("/:id/deliveries", (req: VisionRequest, res) => {
  const webhook = db.prepare(`SELECT id FROM vision_webhooks WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id);
  if (!webhook) return res.status(404).json({ error: "webhook_not_found" });

  const rows = db
    .prepare(
      `SELECT id, event_type, status, attempt_count, last_response_status, last_error, delivered_at, next_attempt_at, created_at
       FROM vision_webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 200`
    )
    .all(req.params.id);
  res.json({ deliveries: rows });
});

router.post("/:id/deliveries/:deliveryId/retry", (req: VisionRequest, res) => {
  const webhook = db.prepare(`SELECT id FROM vision_webhooks WHERE organization_id = ? AND id = ?`).get(req.organizationId, req.params.id);
  if (!webhook) return res.status(404).json({ error: "webhook_not_found" });

  const delivery = db.prepare(`SELECT id, status FROM vision_webhook_deliveries WHERE webhook_id = ? AND id = ?`).get(req.params.id, req.params.deliveryId) as any;
  if (!delivery) return res.status(404).json({ error: "delivery_not_found" });

  requeueDelivery(delivery.id);
  const row = db.prepare(`SELECT id, event_type, status, attempt_count, last_response_status, last_error, delivered_at, next_attempt_at, created_at FROM vision_webhook_deliveries WHERE id = ?`).get(delivery.id);
  res.json({ delivery: row });
});

export default router;
