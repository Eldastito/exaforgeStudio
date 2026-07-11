// ZappFlow Edge — runtime do nó (ADR-082, Fase 4b).
//
// Processo STANDALONE que roda ON-PREMISE no cliente (container/máquina própria,
// SEPARADA da nuvem — não é filho do supervisor da nuvem). Mantém o banco local
// (edge.db), aceita comandos locais mesmo com a internet caída, e sincroniza
// com a nuvem em loop pelo protocolo da Fase 4a.
//
// No site do cliente ele pode ser supervisionado pelo MESMO padrão de
// scripts/supervisor.ts (health-check em /health + restart) — por isso expõe
// /health sem autenticação. O supervisor da NUVEM (core+vision-cloud) não é
// tocado: são deploys distintos.
//
// Build/execução:  npm run build:edge && npm run start:edge
// Config por env:  CLOUD_URL, EDGE_DEVICE_ID, EDGE_KEY (credencial de máquina
//                  emitida na nuvem, Fase 4a), EDGE_PORT, EDGE_SYNC_INTERVAL_MS,
//                  EDGE_DATA_DIR, EDGE_AGENT_VERSION.
import express from "express";
import { initEdgeDb } from "./db.js";
import { EdgeOutbox } from "./EdgeOutbox.js";
import { EdgeSyncClient, HttpEdgeTransport, getCursor } from "./EdgeSyncClient.js";
import { registerBuiltinAppliers } from "./EdgeInboxApplicator.js";

const PORT = Number(process.env.EDGE_PORT || 3201);
const SYNC_INTERVAL_MS = Number(process.env.EDGE_SYNC_INTERVAL_MS || 15_000);
const AGENT_VERSION = process.env.EDGE_AGENT_VERSION || "0.1.0";

const CLOUD_URL = process.env.CLOUD_URL || "";
const DEVICE_ID = process.env.EDGE_DEVICE_ID || "";
const KEY = process.env.EDGE_KEY || "";

initEdgeDb();
registerBuiltinAppliers(); // materializadores dedicados (edge_tickets, …)

const app = express();
app.use(express.json());

// Sem autenticação — só o supervisor local checa se o processo está de pé.
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "zappflow-edge", pending: EdgeOutbox.pending(), cursor: getCursor() });
});

// Intake LOCAL de comandos: apps do nó submetem trabalho mesmo offline; o
// outbox garante a entrega quando a nuvem voltar. Escuta só em 127.0.0.1.
app.post("/enqueue", (req, res): any => {
  const { commandId, operationType, payload } = req.body || {};
  if (!commandId || !operationType) return res.status(400).json({ error: "commandId e operationType são obrigatórios" });
  const r = EdgeOutbox.enqueue({ commandId: String(commandId), operationType: String(operationType), payload });
  res.status(r.deduped ? 200 : 201).json({ id: r.id, deduped: r.deduped });
});

// ── Loop de sync ────────────────────────────────────────────────────────────
let syncing = false;
async function runSync() {
  if (syncing) return; // guarda de reentrância (processo único)
  if (!CLOUD_URL || !DEVICE_ID || !KEY) return; // sem credencial → não sincroniza
  syncing = true;
  try {
    const transport = new HttpEdgeTransport({ cloudUrl: CLOUD_URL, deviceId: DEVICE_ID, key: KEY });
    const r = await EdgeSyncClient.syncOnce(transport, { agentVersion: AGENT_VERSION });
    if (r.pushed.sent || r.pulled) console.log(`[edge] sync: push=${r.pushed.sent} pull=${r.pulled} cursor=${r.cursor}`);
  } catch (e) {
    console.error("[edge] ciclo de sync falhou", e);
  } finally {
    syncing = false;
  }
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[edge] runtime ouvindo em http://127.0.0.1:${PORT} (sync a cada ${SYNC_INTERVAL_MS}ms)`);
  if (!CLOUD_URL || !DEVICE_ID || !KEY) {
    console.warn("[edge] CLOUD_URL/EDGE_DEVICE_ID/EDGE_KEY não configurados — operando offline (sem sync). Comandos ficam no outbox.");
  }
  setImmediate(runSync);
  setInterval(runSync, SYNC_INTERVAL_MS);
});
