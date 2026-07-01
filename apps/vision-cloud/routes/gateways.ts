// Registro, listagem, saúde e heartbeat de Vision Edge Gateways.
//
// IMPORTANTE: heartbeat é chamado pelo GATEWAY FÍSICO (uma máquina, não um
// usuário logado no navegador) — por isso usa autenticação por CHAVE DE API
// própria (header `X-Gateway-Key`), não o JWT de usuário do `requireAuth`.
// Isso é deliberado e simétrico ao resto do sistema: credenciais de máquina
// e credenciais de usuário são mecanismos diferentes (ver PRD §14.1 sobre
// nunca misturar identificação com autorização de ação).
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import bcrypt from "bcrypt";
import db from "../db.js";
import { VisionRequest, requireAuth, requireVisionRole } from "../auth.js";

const router = Router();

// requireAuth (JWT de usuário) aplicado individualmente a cada rota, EXCETO
// /:id/heartbeat — essa usa requireGatewayKey (chave de API da máquina),
// definido mais abaixo neste arquivo. Ver comentário no topo do arquivo.
router.get("/", requireAuth, (req: VisionRequest, res) => {
  const rows = db
    .prepare(`SELECT id, organization_id, site_id, name, status, agent_version, last_heartbeat_at, created_at, updated_at
              FROM vision_gateways WHERE organization_id = ? ORDER BY created_at DESC`)
    .all(req.organizationId);
  res.json({ gateways: rows });
});

router.get("/:id/health", requireAuth, (req: VisionRequest, res) => {
  const row = db
    .prepare(`SELECT id, name, status, agent_version, last_heartbeat_at, updated_at
              FROM vision_gateways WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, req.params.id);
  if (!row) return res.status(404).json({ error: "gateway_not_found" });
  res.json({ gateway: row });
});

// A chave de API em texto puro só existe UMA VEZ, nesta resposta. Só o hash
// (bcrypt) é persistido — igual ao padrão já usado para senha de usuário no
// core. Se a chave for perdida, a única recuperação é gerar uma nova
// (endpoint de rotação fica para quando houver um Edge real para testar).
router.post("/register", requireAuth, requireVisionRole(["vision_admin"]), async (req: VisionRequest, res) => {
  const { site_id, name } = req.body || {};
  if (!site_id || !name) return res.status(400).json({ error: "site_id_and_name_required" });

  const site = db
    .prepare(`SELECT id FROM vision_sites WHERE organization_id = ? AND id = ?`)
    .get(req.organizationId, site_id);
  if (!site) return res.status(400).json({ error: "site_not_found" });

  const id = uuidv4();
  const apiKey = `vgw_${crypto.randomBytes(24).toString("hex")}`;
  const apiKeyHash = await bcrypt.hash(apiKey, 10);

  db.prepare(
    `INSERT INTO vision_gateways (id, organization_id, site_id, name, status, api_key_hash, created_by)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, req.organizationId, site_id, name, apiKeyHash, req.userId || null);

  res.status(201).json({
    gateway: { id, organization_id: req.organizationId, site_id, name, status: "pending" },
    api_key: apiKey,
    warning: "Guarde esta chave agora — ela não pode ser recuperada depois, só regerada.",
  });
});

// Autenticação por chave de API (não JWT) — ver comentário no topo do arquivo.
async function requireGatewayKey(req: any, res: any, next: any) {
  const key = req.headers["x-gateway-key"];
  if (!key || typeof key !== "string") return res.status(401).json({ error: "gateway_key_required" });

  const gateway = db
    .prepare(`SELECT id, organization_id, api_key_hash FROM vision_gateways WHERE id = ?`)
    .get(req.params.id) as any;
  if (!gateway || !gateway.api_key_hash) return res.status(401).json({ error: "invalid_gateway_key" });

  const ok = await bcrypt.compare(key, gateway.api_key_hash);
  if (!ok) return res.status(401).json({ error: "invalid_gateway_key" });

  req.gatewayOrganizationId = gateway.organization_id;
  next();
}

router.post("/:id/heartbeat", requireGatewayKey, (req: any, res) => {
  const { agent_version } = req.body || {};
  const result = db
    .prepare(
      `UPDATE vision_gateways SET status = 'online', last_heartbeat_at = CURRENT_TIMESTAMP,
       agent_version = COALESCE(?, agent_version), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    )
    .run(agent_version || null, req.params.id, req.gatewayOrganizationId);
  if (result.changes === 0) return res.status(404).json({ error: "gateway_not_found" });
  res.json({ ok: true });
});

export default router;
