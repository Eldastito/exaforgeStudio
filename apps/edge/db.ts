// ZappFlow Edge — banco LOCAL do nó (ADR-082, Fase 4b).
//
// Diferente do vision-cloud (que abre o MESMO zappflow.db do core, só com
// schema próprio), o Edge é um nó que roda ON-PREMISE no cliente, num
// processo/container SEPARADO da nuvem. Por isso ele tem um arquivo SQLite
// PRÓPRIO e local (`edge.db`) — a fonte da verdade offline enquanto a internet
// até a nuvem está caída. Nada aqui depende do banco da nuvem.
//
// Convenção de caminho: EDGE_DATA_DIR (volume local do nó) senão DATA_DIR senão
// cwd; arquivo `edge.db`. WAL + busy_timeout, igual ao resto do projeto.
//
// Tabelas locais do nó:
//   - edge_outbox: comandos criados offline, aguardando envio à nuvem (a fila
//     durável do nó). Espelha o ciclo do MessageDeliveryService (lease/backoff).
//   - edge_inbox: cache dos domain_events puxados da nuvem (delta). Aplicar cada
//     evento por agregado é a Fase 4c; aqui só guardamos e marcamos `applied=0`.
//   - edge_state: key/value do nó (cursor de leitura, timestamps de sync).
import Database from "better-sqlite3";
import path from "path";

const dataDir = process.env.EDGE_DATA_DIR || process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, "edge.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

export function initEdgeDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edge_outbox (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,       -- idempotência ponta a ponta com a nuvem
      operation_type TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_edge_outbox_due ON edge_outbox (status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS edge_inbox (
      seq INTEGER PRIMARY KEY,               -- domain_events.seq da org do nó (monotônico)
      aggregate_type TEXT,
      aggregate_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      applied INTEGER NOT NULL DEFAULT 0,    -- aplicado localmente? (Fase 4c)
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS edge_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Projeção local dos agregados (ADR-082, Fase 4c). Cada domain_event puxado
    -- é dobrado aqui por (aggregate_type, aggregate_id): o nó passa a ter o
    -- ESTADO ATUAL consultável offline, sem depender da nuvem. Versionamento
    -- otimista pelo seq monotônico (last-write-wins ordenado) — reaplicar um seq
    -- <= ao já projetado é no-op (idempotente / à prova de reentrega).
    CREATE TABLE IF NOT EXISTS edge_aggregates (
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      last_event_type TEXT,
      state_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (aggregate_type, aggregate_id)
    );

    -- Materialização DEDICADA do ticket (ADR-082, eventos "gordos"): o nó tem o
    -- board consultável offline (estágio + IA pausada), montado a partir dos
    -- domain_events de ticket. Alimentado pelo materializador 'ticket' do
    -- EdgeInboxApplicator; a projeção genérica (edge_aggregates) segue existindo.
    CREATE TABLE IF NOT EXISTS edge_tickets (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      stage TEXT,
      ai_paused INTEGER,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export default db;
