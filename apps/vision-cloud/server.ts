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
// interno (ver `visionCloudProxy` em server.ts). Este serviço NUNCA deve ser
// exposto publicamente por conta própria — só escuta em 127.0.0.1.
//
// Nenhuma funcionalidade de câmera/streaming/gravação/IA visual é implementada
// aqui ainda — isso é Fase 1+ do PRD (docs/PRD-VISION-VMS.md). Este arquivo é
// apenas o esqueleto que prova o modelo de implantação (processo separado +
// banco compartilhado + autenticação compartilhada).

import express from "express";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import path from "path";

const PORT = Number(process.env.VISION_CLOUD_PORT || 3101);
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[vision-cloud] JWT_SECRET é obrigatório em produção — precisa ser o MESMO segredo usado pelo zappflow-core.");
  }
  console.warn("[vision-cloud] JWT_SECRET não definido — usando apenas em desenvolvimento local.");
}

// Mesmo arquivo de banco do zappflow-core (src/server/db.ts), mesma convenção
// de DATA_DIR. Conexão própria (não importa src/server/db.ts) para manter
// este processo desacoplado do grafo de módulos do core, conforme ADR-001.
const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, "zappflow.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const app = express();
app.use(express.json());

// Reimplementação deliberada (não importada) da checagem de JWT do core
// (src/server/middleware/auth.ts) — mesmo segredo, mesma forma de decodificar
// tenant/usuário, mas sem acoplar este processo ao código do core.
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (req as any).user = decoded;
    (req as any).organizationId = decoded.organizationId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// Sem autenticação — usado pelo core/infra para checar se o processo está de pé.
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "vision-cloud" });
});

// Prova de conceito do modelo de implantação: um token emitido pelo login do
// core autentica aqui, e a leitura vem do MESMO banco (organization_settings).
// Remover/substituir quando as rotas reais do Vision Cloud (sites, câmeras,
// eventos) começarem a ser implementadas na Fase 1.
app.get("/whoami", requireAuth, (req, res) => {
  const organizationId = (req as any).organizationId;
  const row = db
    .prepare("SELECT organization_id, business_name, status FROM organization_settings WHERE organization_id = ?")
    .get(organizationId);
  res.json({ service: "vision-cloud", organizationId, organization: row || null });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[vision-cloud] ouvindo em http://127.0.0.1:${PORT} (banco: ${dbPath})`);
});
