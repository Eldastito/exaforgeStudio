// ZappFlow Vision Cloud — serviço separado do zappflow-core (server.ts).
//
// Decisão registrada em docs/adr/ADR-001-vision-edge-runtime.md (adendo):
// este processo roda isolado do CRM/WhatsApp/Kanban (nenhum import do grafo
// de módulos do core), mas conecta no MESMO arquivo SQLite (zappflow.db) e
// valida o MESMO JWT emitido no login do core — para o usuário, é tudo o
// mesmo domínio/produto; para a operação, são dois processos independentes
// que podem ser implantados e atualizados em momentos diferentes.
//
// server.ts (core) encaminha `/api/vision/*` para este processo via proxy
// interno. Este serviço NUNCA deve ser exposto publicamente por conta
// própria — só escuta em 127.0.0.1 (ver scripts/supervisor.ts em produção).
//
// Fase 1 (Sprint 1 — Foundation, ver docs/PRD-VISION-VMS.md §27): inventário
// de sites/gateways/dispositivos/câmeras + RBAC granular do Vision. NENHUMA
// conexão real de câmera/stream/gravação/IA visual existe ainda — depende do
// Vision Edge Gateway físico (não construído) e de laboratório com hardware
// real (ver docs/PRD-VISION-VMS-RECONCILIACAO.md, bloco 12).
import express from "express";
import db, { initVisionDb } from "./db.js";
import { requireAuth, VisionRequest } from "./auth.js";
import sitesRoutes from "./routes/sites.js";
import gatewaysRoutes from "./routes/gateways.js";
import devicesRoutes from "./routes/devices.js";
import camerasRoutes from "./routes/cameras.js";
import roleAssignmentsRoutes from "./routes/roleAssignments.js";
import eventsRoutes from "./routes/events.js";
import incidentsRoutes from "./routes/incidents.js";
import panicRoutes from "./routes/panic.js";
import webhooksRoutes from "./routes/webhooks.js";
import zonesRoutes from "./routes/zones.js";
import { startHealthMonitor } from "./healthMonitor.js";
import { startWebhookDispatcher } from "./webhookDispatcher.js";

const PORT = Number(process.env.VISION_CLOUD_PORT || 3101);
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[vision-cloud] JWT_SECRET é obrigatório em produção — precisa ser o MESMO segredo usado pelo zappflow-core.");
  }
  console.warn("[vision-cloud] JWT_SECRET não definido — usando apenas em desenvolvimento local.");
}

initVisionDb();

const app = express();
app.use(express.json());

// Sem autenticação — usado pelo core/supervisor para checar se o processo
// está de pé (ver scripts/supervisor.ts, health-check ativo).
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "vision-cloud" });
});

// Prova de conceito do modelo de implantação (mantido desde a Fase 0): um
// token emitido pelo login do core autentica aqui, e a leitura vem do MESMO
// banco (organization_settings, tabela do core — só leitura).
app.get("/whoami", requireAuth, (req: VisionRequest, res) => {
  const organizationId = req.organizationId;
  const row = db
    .prepare("SELECT organization_id, business_name, status FROM organization_settings WHERE organization_id = ?")
    .get(organizationId);
  res.json({ service: "vision-cloud", organizationId, organization: row || null });
});

app.use("/sites", sitesRoutes);
app.use("/gateways", gatewaysRoutes);
app.use("/devices", devicesRoutes);
app.use("/cameras", camerasRoutes);
app.use("/role-assignments", roleAssignmentsRoutes);
app.use("/events", eventsRoutes);
app.use("/incidents", incidentsRoutes);
app.use("/panic", panicRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/zones", zonesRoutes);

// Detecção de gateway offline por timeout de heartbeat (Sprint 2 — eventos
// técnicos). Ver healthMonitor.ts para o porquê disso roda aqui, não no
// Scheduler.ts do core.
startHealthMonitor();
// Entrega dos webhooks de saída do Vision Integration Gateway (PRD §16.3).
startWebhookDispatcher();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[vision-cloud] ouvindo em http://127.0.0.1:${PORT}`);
});
