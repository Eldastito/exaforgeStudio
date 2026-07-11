/**
 * Continuity Layer — API do Edge (ADR-082, Fase 4a).
 *
 * Dois conjuntos de rotas com AUTENTICAÇÕES DIFERENTES:
 *
 *  1) SYNC (edgeSyncRoutes) — falado pela MÁQUINA (o nó Edge). Autentica por API
 *     key de máquina (headers `X-Edge-Device` + `X-Edge-Key`), NUNCA por JWT de
 *     usuário. Montado em `/api/edge` FORA do `protectedApi` (como os webhooks).
 *       POST /api/edge/pull      → delta de domain_events após o cursor do nó
 *       POST /api/edge/push      → lote de comandos idempotentes do outbox do nó
 *       POST /api/edge/heartbeat → presença + versão do agente
 *
 *  2) PROVISIONAMENTO (edgeDeviceRoutes) — falado por um HUMANO (owner/admin) no
 *     painel, sob `protectedApi` (JWT). Emite/lista/revoga os nós.
 *       POST   /api/edge/devices          → cria um nó (segredo aparece 1x)
 *       GET    /api/edge/devices          → lista os nós da org
 *       POST   /api/edge/devices/:id/revoke
 *
 * Como edgeSyncRoutes (montado antes) só define /pull|/push|/heartbeat, um GET/
 * POST /api/edge/devices não casa lá e cai no protectedApi (JWT) — sem colisão.
 */
import { Router, Response, NextFunction } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { EdgeSyncService, type EdgeDevice } from "../EdgeSyncService.js";

interface EdgeRequest extends AuthRequest {
  edgeDevice?: EdgeDevice;
}

/** Middleware de auth de MÁQUINA — valida o par (X-Edge-Device, X-Edge-Key). */
async function requireEdgeKey(req: EdgeRequest, res: Response, next: NextFunction): Promise<any> {
  if (!EdgeSyncService.enabled()) return res.status(503).json({ error: "edge_sync_disabled" });
  const deviceId = String(req.headers["x-edge-device"] || "");
  const key = String(req.headers["x-edge-key"] || "");
  if (!deviceId || !key) return res.status(401).json({ error: "edge_key_required" });
  try {
    const device = await EdgeSyncService.authenticate(deviceId, key);
    if (!device) return res.status(401).json({ error: "invalid_edge_key" });
    req.edgeDevice = device;
    next();
  } catch (e: any) {
    return res.status(500).json({ error: "edge_auth_error" });
  }
}

// ── 1) Rotas de SYNC (auth de máquina) ──────────────────────────────────────
export const edgeSyncRoutes = Router();

// PULL — delta de eventos após o cursor do nó.
edgeSyncRoutes.post("/pull", requireEdgeKey, (req: EdgeRequest, res): any => {
  const device = req.edgeDevice!;
  const after = parseInt(String(req.body?.after ?? 0), 10) || 0;
  const limit = parseInt(String(req.body?.limit ?? 200), 10) || 200;
  try {
    res.json(EdgeSyncService.pull(device, after, limit));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUSH — lote de comandos idempotentes do outbox do nó.
edgeSyncRoutes.post("/push", requireEdgeKey, (req: EdgeRequest, res): any => {
  const device = req.edgeDevice!;
  const commands = Array.isArray(req.body?.commands) ? req.body.commands : [];
  if (commands.length > 500) return res.status(413).json({ error: "batch_too_large", max: 500 });
  try {
    res.json(EdgeSyncService.push(device, commands));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// HEARTBEAT — presença/versão; devolve o cursor atual do servidor.
edgeSyncRoutes.post("/heartbeat", requireEdgeKey, (req: EdgeRequest, res): any => {
  const device = req.edgeDevice!;
  try {
    res.json(EdgeSyncService.heartbeat(device, req.body?.agentVersion ? String(req.body.agentVersion) : undefined));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 2) Rotas de PROVISIONAMENTO (JWT de admin, sob protectedApi) ────────────
export const edgeDeviceRoutes = Router();

// Cria um nó Edge para a org. O segredo em texto puro só é devolvido AQUI, 1x.
edgeDeviceRoutes.post("/", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!EdgeSyncService.enabled()) return res.status(503).json({ error: "edge_sync_disabled" });
  try {
    const created = await EdgeSyncService.register(orgId, req.body?.name ? String(req.body.name).slice(0, 120) : null);
    // key = o segredo; o nó guarda (deviceId=created.id, key=created.key).
    res.status(201).json({ id: created.id, name: created.name, key: created.key });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Lista os nós da org (sem segredo/hash).
edgeDeviceRoutes.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ devices: EdgeSyncService.list(orgId), enabled: EdgeSyncService.enabled() });
});

// Revoga um nó da própria org (isolamento por organização).
edgeDeviceRoutes.post("/:id/revoke", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = EdgeSyncService.revoke(orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: "device_not_found" });
  res.json({ revoked: true });
});
