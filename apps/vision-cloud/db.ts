// Banco de dados do Vision Cloud — conexão PRÓPRIA para o MESMO arquivo
// SQLite do zappflow-core (mesma convenção DATA_DIR/zappflow.db, ver
// docs/adr/ADR-002-tenant-isolation-and-storage.md), mas com schema/migrations
// PRÓPRIOS, independentes de src/server/db.ts.
//
// POR QUE UM SCHEMA SEPARADO NO MESMO ARQUIVO (não uma migration a mais
// dentro de src/server/db.ts): o vision-cloud é um processo/deploy
// independente do core (ADR-001) — se ele precisar do core ter rodado
// primeiro para suas próprias tabelas existirem, isso reintroduz um
// acoplamento de ordem de boot que o modelo de dois processos deveria
// evitar. Cada processo cria e é dono das tabelas do SEU domínio:
//   - src/server/db.ts cria `vision_feature_flags` (lida pelo CORE, no
//     gate de módulo do server.ts, antes mesmo de proxied a requisição);
//   - este arquivo cria tudo que é domínio de negócio do Vision Cloud
//     (sites, gateways, dispositivos, câmeras, papéis) — só o vision-cloud
//     lê/escreve essas tabelas.
// Migrations aqui seguem o MESMO estilo do core (`CREATE TABLE IF NOT
// EXISTS`, idempotente, roda no boot) para quem já conhece o padrão do
// projeto não precisar aprender um segundo jeito de fazer migration.

import Database from "better-sqlite3";
import path from "path";

const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, "zappflow.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

export function initVisionDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vision_sites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      timezone TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vision_sites_org ON vision_sites(organization_id);

    -- api_key_hash guarda o HASH (bcrypt) da chave que o Vision Edge Gateway
    -- físico usa para autenticar chamadas de heartbeat — NÃO é o JWT de
    -- usuário (o Edge não é uma sessão de navegador logada). A chave em
    -- texto plano só existe uma vez, na resposta de POST /gateways/register,
    -- e nunca é persistida nem logada.
    CREATE TABLE IF NOT EXISTS vision_gateways (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      agent_version TEXT,
      api_key_hash TEXT,
      last_heartbeat_at DATETIME,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vision_gateways_org ON vision_gateways(organization_id, site_id);

    -- Compatibilidade classificada conforme PRD §7.1 (compatível_direto,
    -- compativel_via_nvr, compativel_com_adaptacao, uso_temporario,
    -- substituicao_recomendada, nao_homologado) — string livre por enquanto
    -- (validada em código, não em CHECK constraint, para não exigir
    -- migration ao adicionar uma categoria nova).
    CREATE TABLE IF NOT EXISTS vision_devices (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      gateway_id TEXT,
      device_type TEXT NOT NULL,
      vendor TEXT,
      model TEXT,
      compatibility_status TEXT NOT NULL DEFAULT 'nao_homologado',
      notes TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vision_devices_org ON vision_devices(organization_id, site_id);

    -- main_stream_config/sub_stream_config ficam como TEXT (JSON) desde já,
    -- mesmo sem uso ainda (PRD §12.2 já define esses campos como "mínimos") —
    -- evita uma migration extra quando o onboarding real de câmera (Fase 1,
    -- pendente de laboratório com hardware real) for implementado.
    CREATE TABLE IF NOT EXISTS vision_cameras (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      device_id TEXT,
      gateway_id TEXT,
      name TEXT NOT NULL,
      area_name TEXT,
      camera_role TEXT,
      main_stream_config TEXT,
      sub_stream_config TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vision_cameras_org ON vision_cameras(organization_id, site_id);

    -- site_id NULL = papel vale para a organização inteira (todos os sites).
    -- expires_at NULL = sem expiração; usado sobretudo para Support Técnico
    -- (PRD §20.1: "acesso temporário, explícito e auditado").
    CREATE TABLE IF NOT EXISTS vision_role_assignments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      site_id TEXT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      granted_by TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vision_role_assignments_scope
      ON vision_role_assignments(organization_id, user_id);

    -- Eventos técnicos (PRD §12.2/§12.3), Sprint 2 — só os tipos que dá pra
    -- detectar honestamente sem câmera/Edge físico: saúde de gateway
    -- (heartbeat perdido/recuperado). Tipos que dependem de vídeo real
    -- (camera_offline por perda de stream, tamper, IA visual) ficam para
    -- quando o Vision Edge existir de verdade.
    -- status segue a máquina de estados do PRD, reduzida ao que faz sentido
    -- agora: detected -> acknowledged/resolved/false_positive.
    CREATE TABLE IF NOT EXISTS vision_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      site_id TEXT,
      gateway_id TEXT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'media',
      status TEXT NOT NULL DEFAULT 'detected',
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vision_events_org ON vision_events(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_vision_events_gateway ON vision_events(gateway_id, event_type, status);
  `);
}

export default db;
