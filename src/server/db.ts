import Database from 'better-sqlite3';
import path from 'path';
import { applyPlanGrade } from './plansGrade.js';
import { applyFalatuPlans } from './falatuPlans.js';

// DATA_DIR permite apontar o banco para um volume persistente (ex.: /data no
// Coolify), evitando perda de dados a cada redeploy. Sem ela, usa o cwd.
const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, 'zappflow.db');
const db = new Database(dbPath, process.env.NODE_ENV === 'production' ? {} : { verbose: console.log });

db.pragma('journal_mode = WAL');
// busy_timeout: com o vision-cloud (processo separado, ver ADR-001 addendum)
// abrindo o MESMO arquivo, uma escrita concorrente rara deve esperar e tentar
// de novo em vez de falhar imediatamente com SQLITE_BUSY.
db.pragma('busy_timeout = 5000');

// Migrations / Create Tables
const initDb = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      identifier TEXT,
      status TEXT DEFAULT 'disconnected',
      ai_enabled INTEGER DEFAULT 1,
      human_handoff_enabled INTEGER DEFAULT 1,
      webhook_secret TEXT,
      token_encrypted TEXT,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT,
      identifier TEXT NOT NULL,
      profile_pic_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, channel_id, identifier)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      stage TEXT DEFAULT 'novo_lead',
      ai_paused INTEGER DEFAULT 0,
      priority TEXT DEFAULT 'media',
      temperature TEXT DEFAULT 'warm',
      assigned_to TEXT,
      handoff_reason TEXT,
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticket_summaries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticket_closures (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      closed_by TEXT NOT NULL,
      result_status TEXT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticket_stage_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      sender_type TEXT NOT NULL, -- 'contact', 'bot', 'agent'
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Chunks vetorizados (RAG) persistidos com o embedding em JSON.
    -- Antes os vetores ficavam só em memória e eram perdidos a cada redeploy.
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      channel_id TEXT DEFAULT 'global',
      chunk_index INTEGER DEFAULT 0,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_interactions_log (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      agent_used TEXT,
      input_prompt TEXT,
      output_response TEXT,
      confidence REAL,
      needs_human INTEGER DEFAULT 0,
      actions TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Consumo de IA por empresa: tokens e custo (em USD e R$) de cada chamada de
    -- LLM (chat/embeddings/visão/áudio), para medir quanto cada conta gasta.
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      model TEXT,
      kind TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      cost_brl REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_org_date ON ai_usage_log (organization_id, created_at);

    -- Estúdio de Criação: identidade visual da marca (1 por empresa) + criações.
    CREATE TABLE IF NOT EXISTS brand_profiles (
      organization_id TEXT PRIMARY KEY,
      palette TEXT,
      tone TEXT,
      style TEXT,
      summary TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS studio_creations (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      kind TEXT,
      prompt TEXT,
      media_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_studio_creations_org ON studio_creations (organization_id, created_at);

    -- Estúdio: agendamento de posts no Instagram por objetivo de campanha.
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      creation_id TEXT,
      objective TEXT,
      caption TEXT,
      scheduled_at DATETIME,
      status TEXT DEFAULT 'scheduled',   -- scheduled | published | failed | canceled
      ig_media_id TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      published_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts (status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_org ON scheduled_posts (organization_id, scheduled_at);

    CREATE TABLE IF NOT EXISTS authorized_managers (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      identifier TEXT NOT NULL, -- WhatsApp number
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS products_services (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      type TEXT NOT NULL, -- 'product', 'service', 'reservation'
      name TEXT NOT NULL,
      description TEXT,
      price REAL,
      currency TEXT DEFAULT 'BRL',
      active INTEGER DEFAULT 1,
      stock_control_enabled INTEGER DEFAULT 0,
      duration_minutes INTEGER,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      product_service_id TEXT NOT NULL,
      sku TEXT,
      quantity_available INTEGER DEFAULT 0,
      quantity_reserved INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT,
      contact_id TEXT NOT NULL,
      product_service_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      scheduled_start DATETIME,
      scheduled_end DATETIME,
      status TEXT DEFAULT 'pending', -- pending, confirmed, in_progress, completed, cancelled, no_show
      assigned_to TEXT,
      reminder_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT,
      contact_id TEXT NOT NULL,
      product_service_id TEXT,
      address TEXT,
      delivery_window_start DATETIME,
      delivery_window_end DATETIME,
      status TEXT DEFAULT 'pending', -- pending, scheduled, out_for_delivery, delivered, failed, cancelled
      proof_url TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      type TEXT NOT NULL,
      config_json TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS oauth_connections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      scopes TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS backup_jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      type TEXT,
      status TEXT DEFAULT 'pending',
      file_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT,
      secret TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Áreas de Atendimento (departamentos/profissionais que dividem o mesmo número).
    CREATE TABLE IF NOT EXISTS service_areas (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      persona TEXT,             -- instruções/tom da IA ao atender por esta área
      assigned_user_id TEXT,    -- atendente responsável (recebe a conversa)
      position INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_service_areas_org ON service_areas(organization_id);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      event_type TEXT,
      payload TEXT,
      status TEXT,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS organization_settings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL UNIQUE,
      business_name TEXT,
      legal_name TEXT,
      cnpj_cpf TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      logo_url TEXT,
      primary_color TEXT DEFAULT '#4f46e5',
      report_footer TEXT,
      status TEXT DEFAULT 'active',
      plan_id TEXT,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT,
      price REAL,
      features TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT,
      email TEXT UNIQUE,
      password_hash TEXT,
      phone TEXT,
      avatar_url TEXT,
      global_status TEXT DEFAULT 'active',
      last_login_at DATETIME,
      role TEXT DEFAULT 'agent', 
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_invitations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, accepted, expired, cancelled
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_reset_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, completed, expired
      expires_at DATETIME NOT NULL,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      ip_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_audit_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      actor_user_id TEXT,
      target_user_id TEXT,
      event_type TEXT NOT NULL,
      metadata_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      title TEXT,
      message TEXT,
      type TEXT,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      user_id TEXT,
      action TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vision VMS (Fase 0/1): flags granulares por org/site/câmera, complementares
    -- ao gate grosso de ModuleService.enabled_modules (módulo "vms" liga/desliga
    -- o produto inteiro; esta tabela liga/desliga sub-recursos dentro dele, ex.:
    -- vision_ptz, vision_lpr — ver docs/PRD-VISION-VMS-RECONCILIACAO.md bloco 4).
    CREATE TABLE IF NOT EXISTS vision_feature_flags (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      site_id TEXT,
      flag_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vision_feature_flags_scope
      ON vision_feature_flags(organization_id, COALESCE(site_id, ''), flag_key);

    -- Ponte Maestro <-> Vision (MaestroService.reactToVisionEvents): tabela
    -- PRÓPRIA do core que registra quais vision_events já viraram tarefa, para
    -- o poll periódico nunca criar duas tarefas para o mesmo evento. Vive aqui
    -- (não em apps/vision-cloud/db.ts) porque é o CORE quem escreve nela — o
    -- core só faz SELECT em vision_events (nunca escreve lá; dono continua
    -- sendo o vision-cloud, ver apps/vision-cloud/db.ts), e escreve/lê esta
    -- tabela para o próprio controle de idempotência.
    CREATE TABLE IF NOT EXISTS vision_event_tasks (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Migrations for existing tables
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN status TEXT DEFAULT 'active'`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN plan_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN deleted_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN global_status TEXT DEFAULT 'active'`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN last_login_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`); } catch(e){}
  // LGPD — retenção de dados (opt-in): expurga conteúdo de mensagens antigas de
  // tickets já encerrados após N dias. 0/desligado = nunca expurga (legado).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retention_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retention_days INTEGER DEFAULT 365`); } catch(e){}
  // Marca de anonimização (direito ao esquecimento) no contato.
  try { db.exec(`ALTER TABLE contacts ADD COLUMN anonymized_at DATETIME`); } catch(e){}
  // MFA / 2FA (TOTP) — opt-in por usuário. Segredos cifrados em repouso.
  try { db.exec(`ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN mfa_secret TEXT`); } catch(e){}           // segredo ativo (cifrado)
  try { db.exec(`ALTER TABLE users ADD COLUMN mfa_pending_secret TEXT`); } catch(e){}   // durante o setup, antes de confirmar
  try { db.exec(`ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT`); } catch(e){}     // JSON cifrado de códigos de backup
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN onboarding_status TEXT DEFAULT 'pending'`); } catch(e){}
  // ADR-093 §1: sinaliza que o Quick-Start já foi aplicado — o card de
  // onboarding no Dashboard some depois disso (a aba saiu de Configurações).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN quickstart_applied INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN segment TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN size_range TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN billing_status TEXT DEFAULT 'active'`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN trial_ends_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN current_period_start DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN current_period_end DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN payment_provider TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN external_customer_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN external_subscription_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN blocked_reason TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN blocked_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN blocked_by TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN reactivated_at DATETIME`); } catch(e){}
  // ASAAS (ADR-091 Bloco B): cobrança ZappFlow → lojista. Reusa payment_provider/
  // external_customer_id/external_subscription_id. Bookkeeping da régua de
  // inadimplência (D-5→D+30): estágio + última execução (idempotência do Scheduler).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN billing_dunning_stage TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN billing_dunning_last_run DATETIME`); } catch(e){}
  // Performance fee (ADR-091 §6 / Bloco C): consentimento EXPLÍCITO e revogável
  // para ATIVAR a cobrança de 2% do ganho incremental. Sem consentimento, o
  // painel só MOSTRA o valor (modo beta) — nunca cobra.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN performance_fee_billing_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN performance_fee_consented_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN performance_fee_revoked_at DATETIME`); } catch(e){}
  // Idempotência dos eventos de webhook do ASAAS: cada evento tem id único; um
  // reenvio (PAYMENT_CONFIRMED redelivered) NÃO deve avançar o billing de novo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS asaas_webhook_events (
        id TEXT PRIMARY KEY,            -- id do evento no ASAAS (evt_...)
        organization_id TEXT,
        event_type TEXT,
        payment_id TEXT,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (e) { console.error('[DB] Falha ao criar asaas_webhook_events', e); }
  // Consumo excedente de IA (ADR-091 §4, Bloco D): pacote extra comprado por mês
  // (ledger — soma das ações extras do mês vira folga adicional sobre o limite
  // do plano) + opt-in de recompra automática ao atingir 90%.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN ai_auto_topup_enabled INTEGER DEFAULT 0`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_topup_credits (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        month TEXT NOT NULL,          -- 'YYYY-MM' (folga vale só no mês da compra)
        actions INTEGER NOT NULL,     -- ações extras liberadas
        amount REAL NOT NULL,         -- preço do pacote (R$)
        source TEXT DEFAULT 'manual', -- manual | auto
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ai_topup_org_month ON ai_topup_credits(organization_id, month);
    `);
  } catch (e) { console.error('[DB] Falha ao criar ai_topup_credits', e); }
  // Add-ons contratáveis (ADR-091 §5, Bloco D): módulos acima do teto do plano
  // que a org contrata avulso (cobrança mensal). Ativos estendem o teto de
  // módulos (PlanService.modulesForPlan une os add-ons ativos).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_addons (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        addon_key TEXT NOT NULL,       -- chave do módulo (reservas, compras, vms, ...)
        price REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', -- active | cancelled
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        cancelled_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_org_addons ON org_addons(organization_id, status);
    `);
  } catch (e) { console.error('[DB] Falha ao criar org_addons', e); }
  // Mídia (imagem/etc) anexada a uma mensagem
  try { db.exec(`ALTER TABLE messages ADD COLUMN media_url TEXT`); } catch(e){}
  // Status de entrega da resposta enviada ao provedor (WhatsApp/Instagram/etc.).
  // 'sent' quando a Graph/Evolution API confirmou 2xx; 'failed' quando o envio
  // quebrou (ex.: token expirado, IG não inscrito no webhook messages, host
  // errado). Antes disto o erro era engolido no catch do webhookProcessor e a
  // mensagem aparecia no painel como se tivesse ido — deixando o lojista sem
  // saber que o cliente não recebeu.
  try { db.exec(`ALTER TABLE messages ADD COLUMN delivery_status TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE messages ADD COLUMN delivery_error TEXT`); } catch(e){}
  // Continuity Layer (ADR-082, Fase 0/D3) — idempotência do envio manual: o
  // outbox reenvia com o mesmo command_id; o servidor deduplica em vez de
  // duplicar a mensagem. UNIQUE parcial por organização.
  try { db.exec(`ALTER TABLE messages ADD COLUMN command_id TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_command ON messages (organization_id, command_id) WHERE command_id IS NOT NULL`); } catch(e){}

  // Continuity Layer (ADR-082, Fase 1) — event log com sequência POR organização
  // (fonte do delta sync na reconexão) + comandos idempotentes (client_commands).
  // O Socket.IO passa a ser só notificador; o cliente reconcilia pedindo os
  // eventos após o seu último seq. Gravar eventos é opt-in (flag por env).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        seq INTEGER NOT NULL,           -- monotônico por organização (1,2,3,...)
        aggregate_type TEXT NOT NULL,   -- ticket | message | order | ...
        aggregate_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_seq ON domain_events (organization_id, seq);
      CREATE INDEX IF NOT EXISTS idx_domain_events_agg ON domain_events (organization_id, aggregate_type, aggregate_id);

      CREATE TABLE IF NOT EXISTS client_commands (
        organization_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        device_id TEXT,
        user_id TEXT,
        operation_type TEXT,
        status TEXT DEFAULT 'processed', -- processed | failed
        result_json TEXT,
        attempts INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        PRIMARY KEY (organization_id, command_id)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar Continuity (domain_events/client_commands)', e); }

  // Continuity Layer (ADR-082, Fase 3 / D6) — FILA DE ENTREGA AO PROVEDOR.
  // Separa "salvo no ZappFlow" de "entregue ao WhatsApp": a mensagem é gravada
  // na hora (queued) e um dispatcher tenta o provedor com retry/backoff
  // exponencial (mesmo padrão do webhookDispatcher do Vision), evoluindo o
  // status queued → sent → delivered | failed. Assim uma indisponibilidade
  // momentânea do provedor não vira falha permanente (antes: uma tentativa só).
  // `command_id` correlaciona com o balão otimista do front (id local da msg).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_deliveries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ticket_id TEXT,
        channel_id TEXT NOT NULL,
        command_id TEXT,
        recipient TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | delivered | failed
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 6,
        next_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_error TEXT,
        sent_at DATETIME,
        delivered_at DATETIME,
        provider_message_id TEXT,              -- id do provedor (wamid) p/ correlacionar recibos de status
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_message_deliveries_due ON message_deliveries (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_message_deliveries_msg ON message_deliveries (organization_id, message_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar message_deliveries', e); }
  // Recibos de entrega (ADR-082, evolução): correlaciona o status do provedor
  // (WhatsApp Cloud `statuses[]`) com a entrega pelo id do provedor (wamid).
  try { db.exec(`ALTER TABLE message_deliveries ADD COLUMN provider_message_id TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_message_deliveries_provider ON message_deliveries (organization_id, provider_message_id)`); } catch(e){}

  // Continuity Layer (ADR-082, Fase 4a) — REGISTRO DE NÓS EDGE + protocolo de
  // sync. Um "ZappFlow Edge" é um processo/instalação local do cliente que
  // continua operando quando a internet até a nuvem cai. Cada nó pertence a UMA
  // organização e autentica com uma API key de MÁQUINA (não JWT de usuário) —
  // generalizando o padrão do gateway do Vision (vgw_*, hash bcrypt, header
  // próprio). O sync reusa a fundação já pronta: o Edge PUXA `domain_events`
  // (delta via ContinuityService.since) e EMPURRA comandos idempotentes para
  // `client_commands`. `cursor` guarda o progresso de leitura do nó.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS edge_devices (
        id TEXT PRIMARY KEY,               -- edg_<hex> (id público, vai no header)
        organization_id TEXT NOT NULL,
        name TEXT,
        api_key_hash TEXT NOT NULL,        -- bcrypt do segredo (o texto puro só aparece 1x)
        status TEXT NOT NULL DEFAULT 'active', -- active | revoked
        cursor INTEGER NOT NULL DEFAULT 0, -- último domain_events.seq confirmado pelo nó
        agent_version TEXT,
        last_seen_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_edge_devices_org ON edge_devices (organization_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar edge_devices', e); }

  // Metadados da base de conhecimento (RAG)
  try { db.exec(`ALTER TABLE knowledge_documents ADD COLUMN channel_id TEXT DEFAULT 'global'`); } catch(e){}
  try { db.exec(`ALTER TABLE knowledge_documents ADD COLUMN chunk_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE knowledge_documents ADD COLUMN size_bytes INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_org ON knowledge_chunks(organization_id)`); } catch(e){}

  // ===== Vendas / Pedidos (canal de venda via WhatsApp) =====
  // Interruptor de autonomia da IA nas vendas: 0 = reserva e humano confirma
  // (padrão, mais seguro); 1 = IA fecha a venda e baixa o estoque sozinha.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN ai_auto_close_sales INTEGER DEFAULT 0`); } catch(e){}
  // SKU/estoque mínimo para alertas
  try { db.exec(`ALTER TABLE inventory_items ADD COLUMN low_stock_threshold INTEGER DEFAULT 0`); } catch(e){}

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        ticket_id TEXT,
        status TEXT NOT NULL DEFAULT 'aguardando_pagamento',
        -- aguardando_pagamento | pago | em_preparo | entregue | concluido
        -- | cancelado | reembolso | devolucao
        total_amount REAL DEFAULT 0,
        currency TEXT DEFAULT 'BRL',
        created_by TEXT,           -- 'ai' | userId | null
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        product_service_id TEXT,
        name_snapshot TEXT NOT NULL,
        unit_price REAL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        line_total REAL DEFAULT 0,
        stock_committed INTEGER DEFAULT 0, -- 1 = baixa definitiva ja aplicada
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_orders_org_status ON orders(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de pedidos', e); }

  // ===== CRM: perfil de compra e relacionamento por contato =====
  // Mantidos automaticamente pelo CustomerProfileService (venda/mensagem).
  try { db.exec(`ALTER TABLE contacts ADD COLUMN last_contact_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN last_purchase_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN purchase_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN total_spent REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN avg_ticket REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN lead_temperature TEXT DEFAULT 'frio'`); } catch(e){} // frio | morno | quente
  // Lead Scoring: pontuação 0-100 calculada por comportamento (recência, compras, intenção).
  try { db.exec(`ALTER TABLE contacts ADD COLUMN lead_score INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN lead_score_updated_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN tags TEXT`); } catch(e){} // CSV de tags
  try { db.exec(`ALTER TABLE contacts ADD COLUMN notes TEXT`); } catch(e){} // anotações/biografia do cliente
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(organization_id)`); } catch(e){}
  // Opt-out de mensagens ativas (campanhas) — respeitar quem pediu para não receber.
  try { db.exec(`ALTER TABLE contacts ADD COLUMN marketing_opt_out INTEGER DEFAULT 0`); } catch(e){}

  // ===== Campanhas / Outbound (mensagem ativa) =====
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        segment TEXT,            -- json: { temperature?, tag?, inactiveDays?, topBuyers? }
        status TEXT DEFAULT 'draft', -- draft | running | paused | completed | cancelled
        channel_id TEXT,
        total_targets INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS campaign_recipients (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        identifier TEXT NOT NULL,
        status TEXT DEFAULT 'pending', -- pending | sent | failed | skipped
        error TEXT,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients ON campaign_recipients(campaign_id, status);
      CREATE INDEX IF NOT EXISTS idx_campaigns_org ON campaigns(organization_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de campanhas', e); }

  // ===== Estoque avançado: variações + movimentações (loja física -> e-commerce) =====
  // Variação de produto (tamanho/cor/tipo). Produto sem variação continua usando
  // inventory_items com variant_id NULL (compatível com o que já existe).
  try { db.exec(`ALTER TABLE inventory_items ADD COLUMN variant_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE inventory_items ADD COLUMN avg_cost REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE order_items ADD COLUMN variant_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE order_items ADD COLUMN unit_cost REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN has_variants INTEGER DEFAULT 0`); } catch(e){}
  // Negociador: preço mínimo que o produto pode chegar numa negociação (0 = sem negociação).
  try { db.exec(`ALTER TABLE products_services ADD COLUMN min_price REAL`); } catch(e){}
  // Negociador: config por organização.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN negotiator_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN negotiator_max_discount INTEGER DEFAULT 0`); } catch(e){} // % máximo de desconto
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN negotiator_rules TEXT`); } catch(e){} // instruções extras do dono
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_variants (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        name TEXT NOT NULL,            -- ex.: "M / Azul"
        sku TEXT,
        size TEXT,
        color TEXT,
        variant_type TEXT,
        price REAL,                    -- preço próprio (opcional; senão usa o do produto)
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT,
        type TEXT NOT NULL,            -- entrada | saida | ajuste | transferencia
        quantity INTEGER NOT NULL,     -- sempre positivo; o type define a direção
        unit_cost REAL DEFAULT 0,
        origin TEXT,                   -- ex.: "loja física", "fornecedor X"
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_service_id);
      CREATE INDEX IF NOT EXISTS idx_movements_org ON stock_movements(organization_id, product_service_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de estoque avançado', e); }

  // ===== Zapp dispara campanhas (com confirmação) + auto-reativação =====
  // Ação proposta pelo Zapp aguardando o "SIM" do gestor.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_manager_actions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        identifier TEXT NOT NULL,    -- número do gestor
        action_type TEXT NOT NULL,   -- 'create_campaign'
        payload_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_pending_actions ON pending_manager_actions(organization_id, identifier);
    `);
  } catch(e){ console.error('[DB] Falha ao criar pending_manager_actions', e); }
  // Auto-reativação semanal (cron): por organização.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_reactivation_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_reactivation_days INTEGER DEFAULT 60`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_reactivation_message TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_reactivation_last_run DATETIME`); } catch(e){}
  // Lembretes automáticos de agendamento (cron): por organização.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN appointment_reminders_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN appointment_reminder_hours INTEGER DEFAULT 24`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN appointment_reminder_message TEXT`); } catch(e){}

  // ===== Recebimento de pagamentos (por empresa / multi-tenant) =====
  // Estrutura genérica: suporta Pix manual e gateways (Mercado Pago, etc.).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_provider TEXT DEFAULT 'pix_manual'`); } catch(e){} // pix_manual | mercadopago | custom
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_pix_key TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_pix_name TEXT`); } catch(e){}      // nome do beneficiário
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_pix_city TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_instructions TEXT`); } catch(e){} // instruções enviadas ao cliente
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_gateway_token TEXT`); } catch(e){} // credencial do gateway (quando houver)
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_webhook_secret TEXT`); } catch(e){} // segredo do webhook de confirmação
  // Campos de pagamento no pedido.
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_method TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'pending'`); } catch(e){} // pending | paid | failed | refunded
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_link TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_external_id TEXT`); } catch(e){} // id do pagamento no gateway
  try { db.exec(`ALTER TABLE orders ADD COLUMN paid_at DATETIME`); } catch(e){}
  // Cupom/desconto aplicado ao pedido (vitrine).
  try { db.exec(`ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE orders ADD COLUMN coupon_code TEXT`); } catch(e){}
  // Cobranças dinâmicas (PIX do gateway). Guardamos o "copia e cola" e o link
  // para reaproveitar a mesma cobrança e exibir na UI sem recriar no gateway.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_charges (
        id TEXT PRIMARY KEY,              -- id do pagamento no gateway (ex.: Mercado Pago)
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        provider TEXT,                    -- mercadopago | ...
        amount REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',    -- pending | approved | cancelled | expired
        qr_code TEXT,                     -- Pix copia e cola
        qr_code_base64 TEXT,              -- imagem do QR (data base64)
        ticket_url TEXT,                  -- link de pagamento do gateway
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_payment_charges_order ON payment_charges(order_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar payment_charges', e); }
  // Fase 3 — Pesquisa de satisfação (CSAT 1-5) enviada após a venda.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS satisfaction_surveys (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ticket_id TEXT,
        contact_id TEXT NOT NULL,
        order_id TEXT,
        status TEXT DEFAULT 'sent',     -- sent | answered | skipped
        score INTEGER,                  -- 1..5 (1-3 detrator, 4 neutro, 5 promotor)
        comment TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        answered_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_satisfaction_contact ON satisfaction_surveys(contact_id);
      CREATE INDEX IF NOT EXISTS idx_satisfaction_order ON satisfaction_surveys(order_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar satisfaction_surveys', e); }
  // Número de WhatsApp da empresa para a IA encaminhar leads (ex.: vindos do Instagram).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN forward_whatsapp TEXT`); } catch(e){}
  // Tutor de Gestão no WhatsApp (ADR-131): resumo diário proativo para o DONO.
  // Opt-in + número de destino + dedupe da manhã por data (SP).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_wa_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_wa_phone TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_wa_last_morning TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_wa_last_midday TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_wa_last_evening TEXT`); } catch(e){}
  // Loop conversacional do tutor (ADR-131 Fatia 4): oferta de cobrança feita à
  // noite (data SP) e o dia agendado para o lembrete de cobrança da manhã.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_collect_offer_at TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN tutor_collect_scheduled_for TEXT`); } catch(e){}
  // Enterprise Intelligence (ADR-135): feature-flag do Diretor consumir o
  // Business Snapshot V2 (panorama financeiro). Desligada por padrão.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN diretor_snapshot_v2 INTEGER DEFAULT 0`); } catch(e){}
  // Epic 0 (RBAC financeiro): enforcement dos módulos financeiros é OPT-IN por
  // organização. 0 = intacto (comportamento atual); 1 = gateia financeiro/
  // saúde. Ligado só para contas validadas (ex.: Toulon em produção).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN rbac_finance_enabled INTEGER DEFAULT 0`); } catch(e){}
  // Epic 3 (WhatsApp como interface de gestão): consultas de gestão/finanças
  // pelo WhatsApp do gestor. OPT-IN por organização (default off).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN wa_gestor_enabled INTEGER DEFAULT 0`); } catch(e){}
  // Ponte Fechamento → Faturamento: os fechamentos diários de loja (Operação da
  // Rede) viram ENTRADA de caixa/receita, para o Diretor IA / Pareto / DRE
  // enxergarem o faturamento da loja supervisionada. OPT-IN por organização
  // (default off) — nada muda até o gestor ligar. Ver RetailRevenueBridgeService.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_revenue_bridge INTEGER DEFAULT 0`); } catch(e){}
  // Memória de Padrões do Varejo (ADR-142 Fatia 1): loop de aprendizado da loja
  // (observar→hipotetizar→verificar→lembrar). OPT-IN por organização (default
  // off). Ver RetailPatternMemoryService.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_pattern_memory INTEGER DEFAULT 0`); } catch(e){}
  // Memória de Padrões GENÉRICA (ADR-142 generalizada): o mesmo loop de
  // aprendizado (observar→hipotetizar→verificar→lembrar→medir) para QUALQUER
  // domínio (produção, compras, finanças…). Opt-in por org (default off).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pattern_memory INTEGER DEFAULT 0`); } catch(e){}
  // Loja Virtual → PDV (ADR-143 Fase 0): reserva e-commerce + baixa pendente +
  // reconciliação anti-clobber no sync. OPT-IN por organização (default off).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN online_store_reserve INTEGER DEFAULT 0`); } catch(e){}
  // Filial da qual a LOJA VIRTUAL (checkout público) vende — a reserva daquela
  // loja governa o estoque online. NULL = storefront não aplica reserva (ADR-143).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN online_store_id TEXT`); } catch(e){}
  // Vendedor PADRÃO da loja online: recebe a comissão das vendas por link quando
  // a conversa não tem dono humano (venda 100% IA). NULL = venda headless fica
  // SEM vendedor/comissão (decisão do dono). Ver RetailOnlineReserveService.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN online_default_seller_user_id TEXT`); } catch(e){}
  // store_id no pedido (ADR-143 D2): pedido nativo passa a poder pertencer a uma
  // filial (loja virtual multi-loja). NULL = org (comportamento atual).
  try { db.exec(`ALTER TABLE orders ADD COLUMN store_id TEXT`); } catch(e){}
  // seller_user_id no pedido: vendedor atribuído à venda (comissão por vendedor).
  // NULL = sem vendedor (não entra na apuração por vendedor).
  try { db.exec(`ALTER TABLE orders ADD COLUMN seller_user_id TEXT`); } catch(e){}
  // product_service_id no item de comissão: comissão por PRODUTO (apuração sobre
  // as vendas do ZappFlow por produto).
  try { db.exec(`ALTER TABLE retail_commission_items ADD COLUMN product_service_id TEXT`); } catch(e){}

  // ===== Planos / Billing (Fase 2) — grade ADR-091 =====
  // Plans.features (JSON) com limites: ai_monthly_limit, contacts_limit,
  // channels_limit, users_limit, trial_days, price_annual_month, modules.
  // applyPlanGrade é idempotente: garante os 5 tiers da grade nova (Autônomo/
  // Start/Growth/Scale/Enterprise), migra as orgs da grade antiga (Starter→
  // Autônomo, Pro→Growth, Business→Scale) e remove os planos legados.
  try {
    applyPlanGrade(db);
  } catch (e) { console.error('[DB] Falha ao aplicar a grade de planos', e); }

  // Plano "Cortesia": conta gratuita criada pelo super admin (acesso liberado,
  // sem cobrança). IA ilimitada (ai_monthly_limit=0 ⇒ sem trava) e limites altos.
  try {
    db.prepare(`INSERT OR IGNORE INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`)
      .run('cortesia', 'Cortesia', 0, JSON.stringify({ ai_monthly_limit: 0, contacts_limit: 0, channels_limit: 0, users_limit: 0, trial_days: 0 }));
  } catch (e) { /* noop */ }

  // ADR-154 F2.2 (Fatia A) — catálogo comercial B2C do FalaTu (Solo/Pro/Família,
  // R$19/29/49). Ids `falatu_*` ficam fora do seletor B2B (PlanService filtra) e
  // não colidem com o DELETE de planos legados do applyPlanGrade. Idempotente.
  try {
    applyFalatuPlans(db);
  } catch (e) { console.error('[DB] Falha ao aplicar o catálogo FalaTu', e); }

  // Convites de NOVA EMPRESA (cortesia): diferente de user_invitations (que adiciona
  // alguém à MESMA org). Aqui o token cria uma empresa NOVA com plano+módulos já
  // definidos pelo super admin. O link é entregue pelo WhatsApp.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_invitations (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        business_name TEXT,
        recipient_name TEXT,
        recipient_phone TEXT,
        plan_id TEXT,
        enabled_modules TEXT,
        vertical TEXT,
        billing_status TEXT DEFAULT 'active',
        status TEXT DEFAULT 'pending',
        created_by TEXT,
        created_org_id TEXT,
        accepted_at DATETIME,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) { console.error('[DB] Falha ao criar org_invitations', e); }

  // ===== Follow-up Sequencial (Cadências) =====
  // Cadência = sequência de mensagens automáticas quando o contato não responde.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cadences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        trigger_stage TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS cadence_steps (
        id TEXT PRIMARY KEY,
        cadence_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        delay_hours REAL NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS contact_cadences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        cadence_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        contact_identifier TEXT NOT NULL,
        contact_name TEXT,
        current_step INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        next_send_at DATETIME,
        last_contact_message_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_contact_cadences_ticket ON contact_cadences(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_contact_cadences_org ON contact_cadences(organization_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de cadências', e); }
  // Cadências só disparam para leads com score >= min_lead_score (0 = todos).
  try { db.exec(`ALTER TABLE cadences ADD COLUMN min_lead_score INTEGER DEFAULT 0`); } catch(e){}

  // ===== Loja virtual / Landing Page "Glass Toggle" =====
  // Vitrine pública por organização. O dono configura tema, slug e quais
  // produtos exibir; o cliente acessa via link gerado pela IA.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS storefront_settings (
        organization_id TEXT PRIMARY KEY,
        slug TEXT UNIQUE,
        title TEXT,
        subtitle TEXT,
        logo_url TEXT,
        banner_url TEXT,
        accent_color TEXT DEFAULT '#ec4899',
        default_mode TEXT DEFAULT 'night',     -- 'day' | 'night' (estado inicial do Glass Toggle)
        whatsapp_number TEXT,                  -- número p/ finalizar a compra (IA cobra)
        published INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      -- Múltiplas imagens por produto (a 1ª, menor position, é a capa).
      CREATE TABLE IF NOT EXISTS product_images (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        url TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_service_id);
      -- Rascunho do Cadastro Inteligente (Smart Inventory, ADR-020): a extração
      -- da IA fica gravada aqui ANTES de qualquer produto existir — se o
      -- usuário fechar a tela sem confirmar, nada se perde (dá pra auditar o
      -- que a IA disse mesmo sem virar produto). Vira 'confirmed' só quando o
      -- humano publica de fato (product_id preenchido nesse momento).
      CREATE TABLE IF NOT EXISTS product_scan_drafts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        uploaded_by TEXT,
        image_url TEXT NOT NULL,
        raw_extraction_json TEXT,
        confidence_score REAL,
        status TEXT DEFAULT 'pending', -- pending | confirmed | discarded
        product_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_product_scan_drafts_org ON product_scan_drafts(organization_id, status, created_at);
      -- Rascunho do Cadastro por Nota Fiscal (Smart Inventory Fase 1, ADR-021):
      -- mesma lógica do product_scan_drafts, mas para UMA foto que pode conter
      -- VÁRIOS itens de compra. raw_extraction_json guarda a lista bruta que a
      -- IA leu (fornecedor + itens com custo unitário); os produtos/baixas de
      -- estoque só são criados de verdade em POST /invoice-scan/:draftId/confirm,
      -- item por item, conforme a decisão do humano (criar produto novo, repor
      -- estoque de um produto existente, ou ignorar aquele item).
      CREATE TABLE IF NOT EXISTS invoice_scan_drafts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        uploaded_by TEXT,
        image_url TEXT NOT NULL,
        raw_extraction_json TEXT,
        confidence_score REAL,
        status TEXT DEFAULT 'pending', -- pending | confirmed | discarded
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_scan_drafts_org ON invoice_scan_drafts(organization_id, status, created_at);
      -- Token público que amarra um acesso da vitrine a um contato/ticket do WhatsApp.
      CREATE TABLE IF NOT EXISTS storefront_links (
        token TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        ticket_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_links_org ON storefront_links(organization_id);

      CREATE TABLE IF NOT EXISTS storefront_collections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        title TEXT NOT NULL,
        rule TEXT NOT NULL DEFAULT 'featured', -- featured | best_sellers | newest
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_collections_org ON storefront_collections(organization_id);

      CREATE TABLE IF NOT EXISTS storefront_coupons (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        code TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'percent', -- percent | fixed
        value REAL NOT NULL DEFAULT 0,        -- % (0-100) ou R$
        min_order REAL DEFAULT 0,             -- pedido mínimo para valer
        active INTEGER DEFAULT 1,
        expires_at DATETIME,                  -- null = sem validade
        usage_limit INTEGER,                  -- null = ilimitado
        used_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_coupons_org ON storefront_coupons(organization_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_storefront_coupons_code ON storefront_coupons(organization_id, code);

      CREATE TABLE IF NOT EXISTS storefront_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        type TEXT NOT NULL,          -- view | product_click
        product_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_events_org ON storefront_events(organization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_storefront_events_prod ON storefront_events(organization_id, type, product_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas da loja virtual', e); }

  // Modo de venda por produto: define o seletor que a vitrine mostra.
  //   unit   -> quantidade simples (un.)
  //   size   -> tamanhos (P/M/G...) em sale_options_json.sizes
  //   weight -> peso (price é por kg); sale_options_json.steps = [100,250,500,1000] em gramas
  //   volume -> volume (price por litro); sale_options_json.steps em ml
  try { db.exec(`ALTER TABLE products_services ADD COLUMN sale_mode TEXT DEFAULT 'unit'`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN sale_options_json TEXT`); } catch(e){}
  // Visibilidade e destaque na vitrine.
  try { db.exec(`ALTER TABLE products_services ADD COLUMN storefront_visible INTEGER DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN featured INTEGER DEFAULT 0`); } catch(e){}
  // Ordem manual dos produtos na vitrine (drag-and-drop).
  try { db.exec(`ALTER TABLE products_services ADD COLUMN storefront_position INTEGER`); } catch(e){}
  // Área de atendimento à qual a conversa foi direcionada.
  try { db.exec(`ALTER TABLE tickets ADD COLUMN area_id TEXT`); } catch(e){}
  // Transição Invisível: resumo gerado pela IA no handoff, exibido ao atendente.
  try { db.exec(`ALTER TABLE tickets ADD COLUMN handoff_summary TEXT`); } catch(e){}
  // Conta vinculada nas conexões OAuth (ex.: e-mail/nome do Google).
  try { db.exec(`ALTER TABLE oauth_connections ADD COLUMN account_email TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE oauth_connections ADD COLUMN account_name TEXT`); } catch(e){}
  // Sincronização do agendamento com o Google Calendar.
  try { db.exec(`ALTER TABLE appointments ADD COLUMN google_event_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN google_event_link TEXT`); } catch(e){}
  // Automações Google: registrar pedidos numa planilha do Sheets.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_log_orders INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_orders_sheet_id TEXT`); } catch(e){}
  // Google Sheets live sync: um painel vivo (planilha com abas Vendas/Estoque/
  // Resumo) que o Scheduler reescreve de tempos em tempos — ao contrário do
  // log append-only acima, reflete o estado ATUAL (status/pagamento de pedidos,
  // níveis de estoque), então o lojista pode fixar/filtrar/compartilhar a
  // planilha como dashboard. `google_sync_sheet_id` guarda a planilha viva;
  // `google_sync_last_run` marca a última reescrita.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_sync_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_sync_sheet_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_sync_last_run DATETIME`); } catch(e){}
  // SLA de primeira resposta por PRIORIDADE e SEGMENTO (VIP). Estende o SLA por
  // canal (ADR-026) para uma promessa mais fina: cada ticket herda a meta mais
  // APERTADA entre a da sua prioridade e — se o contato for VIP (gasto acumulado
  // >= sla_vip_min_spent) — a meta VIP. O monitor (Scheduler.ticketSlaPass) só
  // roda quando sla_monitor_enabled = 1; desligado, nada muda no comportamento
  // atual. Metas em segundos; defaults: alta 30min, média 4h, baixa 24h, VIP 15min.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sla_monitor_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sla_priority_alta_seconds INTEGER DEFAULT 1800`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sla_priority_media_seconds INTEGER DEFAULT 14400`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sla_priority_baixa_seconds INTEGER DEFAULT 86400`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sla_vip_seconds INTEGER DEFAULT 900`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sla_vip_min_spent REAL DEFAULT 1000`); } catch(e){}
  // Estado de SLA persistido por ticket (reescrito pelo monitor a cada tick).
  try { db.exec(`ALTER TABLE tickets ADD COLUMN sla_first_response_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE tickets ADD COLUMN sla_due_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE tickets ADD COLUMN sla_breached INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE tickets ADD COLUMN sla_segment TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE tickets ADD COLUMN sla_breach_notified_at DATETIME`); } catch(e){}
  // E-mail do cliente (para confirmações) + interruptores das confirmações.
  try { db.exec(`ALTER TABLE contacts ADD COLUMN email TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_email_appointments INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN google_email_orders INTEGER DEFAULT 0`); } catch(e){}
  // Lembrete automático de PIX não pago (cutucão gentil pelo WhatsApp).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pix_reminder_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pix_reminder_minutes INTEGER DEFAULT 30`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pix_reminder_message TEXT`); } catch(e){}
  // Marca se já enviamos o lembrete de pagamento para uma cobrança (envia 1x).
  try { db.exec(`ALTER TABLE payment_charges ADD COLUMN reminder_status TEXT`); } catch(e){}
  // Expiração de pedido não pago (opt-in): cancela e libera o estoque após N horas.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN order_expiry_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN order_expiry_hours INTEGER DEFAULT 48`); } catch(e){}
  // Fase 2 — Retentativa PROGRESSIVA de PIX: nº máximo de lembretes (intervalos
  // crescentes). Contagem por cobrança (dinâmico) e por pedido (PIX manual).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pix_reminder_max INTEGER DEFAULT 3`); } catch(e){}
  try { db.exec(`ALTER TABLE payment_charges ADD COLUMN reminder_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE payment_charges ADD COLUMN last_reminder_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE orders ADD COLUMN pix_reminder_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE orders ADD COLUMN pix_last_reminder_at DATETIME`); } catch(e){}
  // Fase 2 — Carrinho abandonado (opt-in): re-engaja tickets com intenção de
  // compra (proposta/qualificado) que ficaram em silêncio sem fechar pedido.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN abandoned_cart_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN abandoned_cart_hours INTEGER DEFAULT 4`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN abandoned_cart_message TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE tickets ADD COLUMN abandoned_nudged_at DATETIME`); } catch(e){}
  // Memória de relacionamento por cliente: a IA lembra de conversas anteriores
  // (fatos durÁveis p/ rapport) e reconhece quem volta após um tempo parado.
  try { db.exec(`ALTER TABLE contacts ADD COLUMN memory_facts TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN memory_summary TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN memory_updated_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN ai_memory_enabled INTEGER DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN returning_greeting_enabled INTEGER DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN returning_greeting_min_days INTEGER DEFAULT 7`); } catch(e){}
  // Estúdio: status/operação do fluxo assíncrono de vídeo (Veo).
  try { db.exec(`ALTER TABLE studio_creations ADD COLUMN status TEXT DEFAULT 'done'`); } catch(e){}
  try { db.exec(`ALTER TABLE studio_creations ADD COLUMN operation TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE studio_creations ADD COLUMN ig_media_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE studio_creations ADD COLUMN ig_posted_at DATETIME`); } catch(e){}
  // Fase 3 — Pesquisa de satisfação (CSAT): opt-in + atraso após o pagamento.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN nps_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN nps_delay_hours INTEGER DEFAULT 24`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN nps_message TEXT`); } catch(e){}
  // Fase 3b — Programa de indicação (cupom de desconto na próxima).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN referral_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN referral_reward_percent INTEGER DEFAULT 10`); } catch(e){}   // desconto p/ quem indica
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN referral_welcome_percent INTEGER DEFAULT 10`); } catch(e){} // desconto p/ o indicado
  // Código de indicação por contato (compartilhável).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS referral_codes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(organization_id, code);
      CREATE INDEX IF NOT EXISTS idx_referral_codes_contact ON referral_codes(organization_id, contact_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar referral_codes', e); }
  // Cupons de desconto (boas-vindas do indicado e recompensa de quem indica).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coupons (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        owner_contact_id TEXT NOT NULL,   -- quem pode usar o cupom
        kind TEXT,                        -- referral_welcome | referral_reward
        discount_percent INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',      -- active | used | expired
        source_contact_id TEXT,           -- p/ recompensa: quem foi indicado e comprou
        used_order_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_coupons_owner ON coupons(organization_id, owner_contact_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar coupons', e); }
  // Atribuição da indicação no pedido.
  try { db.exec(`ALTER TABLE orders ADD COLUMN coupon_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN referred_by_contact_id TEXT`); } catch(e){}
  // Supply (Fase 1) — Reposição inteligente: requisição de compra rascunho gerada
  // pela IA quando o estoque cai abaixo do mínimo crítico, para aprovação humana.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS purchase_requisitions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        status TEXT DEFAULT 'draft',     -- draft | approved | dismissed | ordered
        created_by TEXT,                 -- 'ai' | user_id
        approved_by TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS purchase_requisition_items (
        id TEXT PRIMARY KEY,
        requisition_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT,
        current_stock INTEGER,
        threshold INTEGER,
        suggested_qty INTEGER,
        avg_daily_consumption REAL,
        days_of_cover REAL
      );
      CREATE INDEX IF NOT EXISTS idx_purchase_req_org ON purchase_requisitions(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_purchase_req_items_req ON purchase_requisition_items(requisition_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar purchase_requisitions', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN procurement_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN procurement_target_days INTEGER DEFAULT 14`); } catch(e){}
  // ADR-099: item do gestor (pedido por áudio/texto) vs. item auto de estoque baixo.
  // 'auto' é reposto/substituído pelo syncDraft; 'manual' é preservado.
  try { db.exec(`ALTER TABLE purchase_requisition_items ADD COLUMN source TEXT DEFAULT 'auto'`); } catch(e){}
  // Supply (Fase 2) — fornecedores e cotações com fornecedores conhecidos.
  try { db.exec(`ALTER TABLE contacts ADD COLUMN is_supplier INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN supplier_categories TEXT`); } catch(e){} // CSV de categorias atendidas
  try { db.exec(`ALTER TABLE products_services ADD COLUMN category TEXT`); } catch(e){}    // categoria do produto (casa com a do fornecedor)
  try { db.exec(`ALTER TABLE products_services ADD COLUMN ean TEXT`); } catch(e){}         // EAN/GTIN do produto (extraído da NF-e ou manual)
  // CONTROLER (PRD-E-007, Fatia 1c): classificação OPERACIONAL do item. Aditivo e
  // opt-in — itens existentes nascem 'resale' com consumo desligado (§30.2), sem
  // mudar nenhum fluxo. Dá finalidade ao item, unidade de compra × consumo (com
  // conversão de embalagem) e vínculos-padrão às dimensões do CONTROLER.
  try { db.exec(`ALTER TABLE products_services ADD COLUMN operational_item_type TEXT DEFAULT 'resale'`); } catch(e){} // resale|raw_material|packaging|consumable|office_supply|cleaning_supply|mro|ppe|spare_part|fuel|asset_low_value|service|utility|subscription|other_operational
  try { db.exec(`ALTER TABLE products_services ADD COLUMN consumption_control_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN default_uom TEXT`); } catch(e){}       // unidade de CONSUMO (ex.: folha)
  try { db.exec(`ALTER TABLE products_services ADD COLUMN purchase_uom TEXT`); } catch(e){}      // unidade de COMPRA (ex.: caixa)
  try { db.exec(`ALTER TABLE products_services ADD COLUMN conversion_factor REAL DEFAULT 1`); } catch(e){} // quantas default_uom há em 1 purchase_uom
  try { db.exec(`ALTER TABLE products_services ADD COLUMN default_cost_center_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN default_location_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN criticality TEXT DEFAULT 'normal'`); } catch(e){}  // baixa|normal|alta|critica
  try { db.exec(`ALTER TABLE products_services ADD COLUMN requires_request INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN requires_return INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN requires_recipient_ack INTEGER DEFAULT 0`); } catch(e){}
  // Smart Inventory — backlog ADR-024: vínculo da entrada de estoque com o
  // fornecedor do CRM (quando o nome da nota casa com um contato is_supplier=1),
  // chave de acesso da NF-e para dedupe de importação, e markup padrão
  // configurável para o preço sugerido (antes fixo em 40%, ADR-023).
  try { db.exec(`ALTER TABLE stock_movements ADD COLUMN supplier_contact_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE invoice_scan_drafts ADD COLUMN access_key TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN default_markup_percent REAL`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS purchase_quotes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        requisition_id TEXT NOT NULL,
        supplier_contact_id TEXT NOT NULL,
        status TEXT DEFAULT 'sent',     -- sent | answered | accepted | rejected
        delivery_days INTEGER,
        total_amount REAL,
        notes TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        answered_at DATETIME,
        accepted_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS purchase_quote_items (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        product_name TEXT,
        unit_price REAL,
        available_qty INTEGER,
        line_total REAL
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_req ON purchase_quotes(organization_id, requisition_id);
      CREATE INDEX IF NOT EXISTS idx_quote_items_q ON purchase_quote_items(quote_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar purchase_quotes', e); }
  // Epic 5 (Comprador IA) — fechamento do ciclo: ordem de compra IMUTÁVEL a
  // partir da cotação aceita (snapshot dos itens). UNIQUE(org, quote_id)
  // garante "uma cotação aceita gera exatamente uma ordem" (PRD §16).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        requisition_id TEXT NOT NULL,
        quote_id TEXT NOT NULL,
        supplier_contact_id TEXT,
        network_org_id TEXT,
        supplier_name TEXT,                  -- snapshot do nome do fornecedor
        status TEXT NOT NULL DEFAULT 'open',  -- open|confirmed|receiving|received|cancelled
        total_amount REAL DEFAULT 0,
        delivery_days INTEGER,
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME,
        received_at DATETIME,
        UNIQUE(organization_id, quote_id)
      );
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id TEXT PRIMARY KEY,
        purchase_order_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        product_name TEXT,                   -- snapshot imutável
        ordered_qty INTEGER NOT NULL DEFAULT 0,
        unit_price REAL,
        line_total REAL,
        received_qty INTEGER NOT NULL DEFAULT 0  -- preenchido no recebimento (fatia seguinte)
      );
      CREATE INDEX IF NOT EXISTS idx_purchase_orders_org ON purchase_orders(organization_id, requisition_id, status);
      CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
      -- Epic 5 (E5.2) — RECEBIMENTO: completo/parcial/divergência/avaria/nota
      -- ausente. Estoque entra só pela quantidade CONFIRMADA (boa); divergência
      -- gera sinal e tarefa, nunca baixa silenciosa (PRD §16).
      CREATE TABLE IF NOT EXISTS goods_receipts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        purchase_order_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'partial',   -- partial|complete (se este recebimento fechou a ordem)
        invoice_present INTEGER NOT NULL DEFAULT 1,
        has_divergence INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        received_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS goods_receipt_items (
        id TEXT PRIMARY KEY,
        goods_receipt_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        purchase_order_item_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        product_name TEXT,
        expected_qty INTEGER NOT NULL DEFAULT 0,  -- saldo pendente antes deste recebimento
        received_qty INTEGER NOT NULL DEFAULT 0,  -- fisicamente recebido
        good_qty INTEGER NOT NULL DEFAULT 0,      -- confirmado bom → entrou no estoque
        condition TEXT NOT NULL DEFAULT 'ok',     -- ok|damaged|wrong_item|missing
        divergence TEXT,                          -- shortfall|over|damaged|wrong_item|missing (NULL = sem divergência)
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goods_receipts_po ON goods_receipts(organization_id, purchase_order_id);
      CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_gr ON goods_receipt_items(goods_receipt_id);
      -- Epic 5 (E5.4) — retrato de performance do fornecedor (preço × média,
      -- prazo prometido × realizado, completude, divergências, taxa de
      -- resposta). Um snapshot por (org, fornecedor, período). PRD §16.
      CREATE TABLE IF NOT EXISTS supplier_performance_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        supplier_key TEXT NOT NULL,          -- contact_id OU 'net:'||network_org_id
        supplier_name TEXT,
        period TEXT NOT NULL,                -- rótulo do período (ex.: 'all' | 'YYYY-MM')
        metrics_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, supplier_key, period)
      );
      CREATE INDEX IF NOT EXISTS idx_supplier_perf_org ON supplier_performance_snapshots(organization_id, period);
    `);
  } catch(e){ console.error('[DB] Falha ao criar purchase_orders', e); }
  // Supply (Fase 3) — Rede ZappFlow: a própria org pode se oferecer como
  // fornecedora; cotação cross-org via API (sem WhatsApp), com geo (cidade + raio).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN is_network_supplier INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN network_categories TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN address_city TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN address_state TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN address_lat REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN address_lng REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN network_delivery_radius_km INTEGER DEFAULT 50`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN network_min_order_amount REAL DEFAULT 0`); } catch(e){}
  // ADR-099: contato do perfil de rede (quem te acha na rede precisa te chamar).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN network_contact_whatsapp TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN network_contact_email TEXT`); } catch(e){}
  // Cotação pode ser endereçada a uma org da rede (em vez de um contato local).
  try { db.exec(`ALTER TABLE purchase_quotes ADD COLUMN network_org_id TEXT`); } catch(e){}
  // Cache de geocoding (cidade/estado → lat/lng) para não martelar Nominatim.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS geocode_cache (
        key TEXT PRIMARY KEY,
        lat REAL, lng REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ /* noop */ }
  // Hotelaria — Orçamentos enviados ao cliente (rastreio sent/accepted/declined/expired).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        ticket_id TEXT,
        status TEXT DEFAULT 'sent',     -- sent | viewed | accepted | declined | expired
        total_amount REAL DEFAULT 0,
        items_snapshot TEXT,            -- JSON com itens + preços do momento
        notes TEXT,
        valid_until DATETIME,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        accepted_at DATETIME,
        declined_at DATETIME,
        last_followup_at DATETIME,
        followup_count INTEGER DEFAULT 0,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_contact ON quotes(organization_id, contact_id, status);
      CREATE INDEX IF NOT EXISTS idx_quotes_ticket ON quotes(ticket_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar quotes', e); }
  // Hotelaria — Pipeline de Eventos & Grupos (consultas de convenção, casamento,
  // day use, corporativo). Diferente de reserva pontual: tem qualificação consultiva.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_inquiries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        ticket_id TEXT,
        event_type TEXT,                -- casamento | convencao | day_use | corporativo | aniversario | outro
        headcount INTEGER,
        event_date DATETIME,
        halls TEXT,                     -- salas/espaços pedidos
        budget REAL,
        special_requests TEXT,
        status TEXT DEFAULT 'novo',     -- novo | qualificado | proposta | fechado | perdido
        notes TEXT,
        won_amount REAL,
        loss_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_event_inquiries_org ON event_inquiries(organization_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar event_inquiries', e); }
  // Hotelaria — settings: validade do orçamento, intervalos de follow-up.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN quote_validity_hours INTEGER DEFAULT 72`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN quote_followup_hours INTEGER DEFAULT 24`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN quote_followup_max INTEGER DEFAULT 2`); } catch(e){}
  // Conector genérico (Fase A — integração agnóstica de PMS/OTA/ERP). Token de
  // entrada para sistemas externos empurrarem disponibilidade/preço por data.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN integration_token TEXT`); } catch(e){}
  // Override de disponibilidade/preço por recurso e data (fonte externa). Quando
  // existe, a reserva respeita estes números (teto de unidades + preço da diária).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS resource_availability (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        date TEXT NOT NULL,               -- YYYY-MM-DD
        available_units INTEGER,          -- unidades vendáveis no dia (teto)
        price_override REAL,              -- preço da diária no dia (opcional)
        source TEXT,                      -- 'csv' | 'webhook' | nome do PMS
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_resavail_unique ON resource_availability(organization_id, resource_id, date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar resource_availability', e); }
  // Verticais & gating de módulos: a vertical escolhida e a lista de módulos
  // opcionais habilitados (JSON). enabled_modules NULL = todos ligados (legado).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN vertical TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN enabled_modules TEXT`); } catch(e){}
  // Reservas por período: o recurso reservável é um products_services (type
  // 'reservation') com capacidade (unidades simultâneas) e unidade de tempo.
  try { db.exec(`ALTER TABLE products_services ADD COLUMN capacity INTEGER DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN reservation_unit TEXT DEFAULT 'night'`); } catch(e){} // night | hour | slot | day
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,          -- products_services.id (type reservation)
        contact_id TEXT,
        ticket_id TEXT,
        start_at DATETIME NOT NULL,
        end_at DATETIME NOT NULL,
        units INTEGER DEFAULT 1,            -- quantos quartos/mesas nesta reserva
        guests INTEGER,
        status TEXT DEFAULT 'pending',      -- pending | confirmed | cancelled | completed | no_show
        total_amount REAL DEFAULT 0,
        deposit_amount REAL DEFAULT 0,
        payment_status TEXT DEFAULT 'pending',
        order_id TEXT,
        google_event_id TEXT,
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_avail
        ON reservations(organization_id, resource_id, start_at, end_at, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar reservations', e); }
  // % de sinal cobrado ao reservar (0 = sem sinal; cobra o total ao confirmar).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN reservation_deposit_percent INTEGER DEFAULT 0`); } catch(e){}

  // Módulo Clínica (ADR-080, Fase A) — automações do pack Saúde 2.0. Flags em
  // organization_settings, no mesmo padrão das demais automações. Semeadas pelo
  // Quick-Start Saúde; a funcionalidade que as consome entra nas fases C–E.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_overrun_alert_enabled INTEGER DEFAULT 1`); } catch(e){}   // alerta de permanência (fim previsto)
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_overrun_warning_minutes INTEGER DEFAULT 15`); } catch(e){} // antecedência do alerta amarelo
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_authorization_enabled INTEGER DEFAULT 1`); } catch(e){}     // fluxo de autorização de convênio
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_authorization_followup_hours INTEGER DEFAULT 24`); } catch(e){} // follow-up de protocolo pendente
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_print_agenda_enabled INTEGER DEFAULT 1`); } catch(e){}     // impressão da agenda do dia
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_professional_portal_enabled INTEGER DEFAULT 1`); } catch(e){} // portal do profissional por link

  // Retail Ops (ADR-083, Fase A) — flags de automação da operação de lojas, no
  // mesmo padrão das demais (colunas em organization_settings). Semeadas pelo
  // Quick-Start Comércio/Varejo; a funcionalidade que as consome entra nas
  // fases B–H (só têm efeito com o módulo `retail` e lojas cadastradas).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_daily_closing_enabled INTEGER DEFAULT 0`); } catch(e){}      // fechamento diário de loja
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_daily_closing_due_hour INTEGER DEFAULT 21`); } catch(e){}    // horário limite do fechamento
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_daily_closing_retry_minutes INTEGER DEFAULT 30`); } catch(e){} // intervalo de recobrança
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_malote_enabled INTEGER DEFAULT 0`); } catch(e){}            // cobrança de malote
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_scale_reminder_enabled INTEGER DEFAULT 0`); } catch(e){}    // cobrança de escala
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_quota_enabled INTEGER DEFAULT 0`); } catch(e){}            // cotas por loja
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_stock_negative_alert_enabled INTEGER DEFAULT 0`); } catch(e){} // alerta de estoque negativo
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_commission_enabled INTEGER DEFAULT 0`); } catch(e){}        // premiação/comissão
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_monthly_close_enabled INTEGER DEFAULT 0`); } catch(e){}     // fechamento mensal acumulado
  // ADR-084 D4: modo de estoque / fonte da verdade (native | supervised | hybrid).
  // Default 'native' = ZappFlow como sistema principal. Invariante: um único ledger
  // autoritativo por (loja, produto) — o modo decide quem manda.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_stock_source TEXT DEFAULT 'native'`); } catch(e){}
  // (o override por loja `retail_stores.stock_source` é criado junto da tabela, abaixo)

  // Retail Ops (ADR-083, Fase A) — CADASTRO DE LOJAS. Dimensão de loja física
  // (inexistente até aqui: estoque/pedidos eram só por organização). Cada loja
  // tem um identificador de WhatsApp para casar o fechamento recebido ao
  // remetente, e um responsável (usuário e/ou contato). Camada ADITIVA — não
  // toca orders/inventory do core (ADR-083 D1).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_stores (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        code TEXT,
        whatsapp_identifier TEXT,        -- número/id do WhatsApp da loja (casa o remetente do fechamento)
        manager_user_id TEXT,
        manager_contact_id TEXT,
        active INTEGER DEFAULT 1,
        stock_source TEXT,               -- ADR-084 D4: modo de estoque da loja (null = herda da org)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // ADR-084 D4: garante a coluna em DBs que já tinham retail_stores sem ela.
    try { db.exec(`ALTER TABLE retail_stores ADD COLUMN stock_source TEXT`); } catch(e){}
    // ADR-083 Fase G (Fase 3): geografia da loja — endereço + coordenadas para
    // sugerir a transferência entre as lojas MAIS PRÓXIMAS (distância haversine).
    try { db.exec(`ALTER TABLE retail_stores ADD COLUMN address TEXT`); } catch(e){}
    try { db.exec(`ALTER TABLE retail_stores ADD COLUMN city TEXT`); } catch(e){}
    try { db.exec(`ALTER TABLE retail_stores ADD COLUMN latitude REAL`); } catch(e){}
    try { db.exec(`ALTER TABLE retail_stores ADD COLUMN longitude REAL`); } catch(e){}
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_retail_stores_org ON retail_stores (organization_id);
      CREATE INDEX IF NOT EXISTS idx_retail_stores_wa ON retail_stores (organization_id, whatsapp_identifier);
    `);
    // ADR-108 (Bloco B / pedido TOULON): responsáveis por loja — quem recebe a
    // cobranca de cada tipo de pendencia (fechamento/malote/escala) e pode dar
    // baixa respondendo no WhatsApp. task_types = 'all' ou CSV dos tipos.
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_store_responsibles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        name TEXT,
        whatsapp_identifier TEXT NOT NULL,
        task_types TEXT DEFAULT 'all',          -- 'all' ou CSV: fechamento,malote,escala
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retail_resp_store ON retail_store_responsibles (organization_id, store_id);
      CREATE INDEX IF NOT EXISTS idx_retail_resp_wa ON retail_store_responsibles (organization_id, whatsapp_identifier);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_stores', e); }

  // Retail Ops (ADR-086) — recebimento de mercadoria (pré-estoque): documento
  // aberto onde a equipe BIPA o que chega, confere contra o esperado e, ao
  // CONFIRMAR, libera para o estoque (no ledger autoritativo do modo).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_goods_receipts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT,
        status TEXT DEFAULT 'open',      -- open | confirmed | cancelled
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS retail_goods_receipt_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        ean TEXT,
        expected_qty INTEGER DEFAULT 0,
        received_qty INTEGER DEFAULT 0,
        UNIQUE(receipt_id, product_service_id)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_receipts_org ON retail_goods_receipts (organization_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_goods_receipts', e); }

  // Retail Ops (ADR-085) — baseline do dia 0: retrato do estado no momento em
  // que o Retail Ops foi ativado, para mostrar o "antes → depois". Um por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_baseline (
        organization_id TEXT PRIMARY KEY,
        captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        stock_capital REAL DEFAULT 0,
        slow_mover_capital REAL DEFAULT 0,
        open_stock_alerts INTEGER DEFAULT 0,
        adoption_percent INTEGER DEFAULT 0
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_baseline', e); }

  // Retail Ops (ADR-085) — snapshot diário do painel de valor/adoção, para a
  // série histórica (tendência). Idempotente por (org, dia).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_impact_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        snapshot_date DATE NOT NULL,
        proven_brl REAL DEFAULT 0,
        stock_capital REAL DEFAULT 0,
        slow_mover_capital REAL DEFAULT 0,
        adoption_percent INTEGER DEFAULT 0,
        ai_messages INTEGER DEFAULT 0,
        closings_checked INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, snapshot_date)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_impact_snapshots', e); }

  // Retail Ops (ADR-083, Fase B) — cotas, fechamentos e checklist diário por
  // loja. Espinha operacional: o Scheduler gera as pendências do dia; o
  // fechamento por WhatsApp/IA (Fase C) preenche informed_total e calcula desvio.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_store_quotas (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        quota_date DATE NOT NULL,
        quota_amount REAL NOT NULL DEFAULT 0,
        source TEXT DEFAULT 'manual',            -- manual | imported | integration
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, store_id, quota_date)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_quotas_date ON retail_store_quotas (organization_id, quota_date);

      CREATE TABLE IF NOT EXISTS retail_daily_closings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        closing_date DATE NOT NULL,
        status TEXT DEFAULT 'pending',           -- pending|received|extracted|needs_review|reconciled|divergent|approved|rejected
        source TEXT DEFAULT 'whatsapp',          -- whatsapp | manual | image_ocr | integration
        submitted_by_contact_id TEXT,
        submitted_by_identifier TEXT,
        submitted_at DATETIME,
        raw_text TEXT,
        image_url TEXT,
        extracted_json TEXT,
        informed_total REAL DEFAULT 0,
        system_total REAL DEFAULT 0,
        quota_amount REAL DEFAULT 0,
        variance_amount REAL DEFAULT 0,          -- realizado - cota
        variance_percent REAL DEFAULT 0,
        divergence_status TEXT DEFAULT 'not_checked', -- not_checked | ok | divergent
        reviewed_by TEXT,
        reviewed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, store_id, closing_date)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_closings_date ON retail_daily_closings (organization_id, closing_date);

      CREATE TABLE IF NOT EXISTS retail_daily_closing_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        closing_id TEXT NOT NULL,
        payment_method TEXT,                     -- dinheiro|pix|credito|debito|voucher|troca|outros
        informed_amount REAL DEFAULT 0,
        system_amount REAL DEFAULT 0,
        difference_amount REAL DEFAULT 0,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_retail_closing_items ON retail_daily_closing_items (closing_id);

      CREATE TABLE IF NOT EXISTS retail_store_daily_tasks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        task_date DATE NOT NULL,
        task_type TEXT NOT NULL,                 -- fechamento | malote | escala
        status TEXT DEFAULT 'pending',           -- pending | submitted | done | late
        due_at DATETIME,
        last_reminder_at DATETIME,
        reminder_count INTEGER DEFAULT 0,
        submitted_by_contact_id TEXT,
        submitted_at DATETIME,
        attachment_url TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, store_id, task_date, task_type)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_tasks_due ON retail_store_daily_tasks (organization_id, status, task_date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas Retail Ops Fase B', e); }

  // Retail Ops (ADR-083, Fase F) — ESTOQUE POR LOJA + alertas de negativo. A
  // camada por loja PERMITE quantidade < 0 (sem o MAX(0,…) do core), justamente
  // para EXPOR a divergência (venda sem baixa, transferência não lançada, etc.)
  // → retail_stock_alerts. O estoque core (inventory_items) segue clampado e
  // intocado (ADR-083 D6).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_store_inventory (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT,
        quantity_available INTEGER DEFAULT 0,    -- PODE ser negativo (detecção)
        quantity_reserved INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, store_id, product_service_id, variant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_store_inv ON retail_store_inventory (organization_id, store_id);
      CREATE INDEX IF NOT EXISTS idx_retail_store_inv_neg ON retail_store_inventory (organization_id, quantity_available);

      CREATE TABLE IF NOT EXISTS retail_stock_alerts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT,
        product_service_id TEXT,
        variant_id TEXT,
        alert_type TEXT DEFAULT 'negative_stock',
        quantity INTEGER,
        status TEXT DEFAULT 'open',              -- open | resolved
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolution_note TEXT,
        UNIQUE(organization_id, store_id, product_service_id, variant_id, alert_type)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_stock_alerts ON retail_stock_alerts (organization_id, status);

      -- Política de estoque por loja/produto/variante (PRD Moda/TOULON, INV-004).
      -- Define mínimo e ALVO — é o que dá sentido a "quanto falta" (shortage). Sem
      -- política, a falta NÃO é inventada (a tela mostra "Meta não configurada").
      -- store_id/variant_id = '' (sentinel) quando a política é da organização/do
      -- produto inteiro. Precedência na resolução (mais específica primeiro):
      -- loja+variante > loja+produto > org+variante > org+produto.
      CREATE TABLE IF NOT EXISTS retail_stock_policies (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT DEFAULT '',                 -- '' = todas as lojas (org)
        product_id TEXT NOT NULL,
        variant_id TEXT DEFAULT '',               -- '' = todas as variantes do produto
        min_qty REAL NOT NULL DEFAULT 0,
        target_qty REAL NOT NULL DEFAULT 0,       -- alvo (>= mínimo)
        source TEXT DEFAULT 'manual',             -- manual | erp | recommendation
        effective_from DATETIME,
        effective_to DATETIME,
        active INTEGER DEFAULT 1,
        created_by TEXT,
        updated_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );
      -- Uma política ATIVA por escopo (org, loja, produto, variante).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_stock_policies_scope
        ON retail_stock_policies (organization_id, store_id, product_id, variant_id) WHERE active = 1;

      -- Transferência de estoque ENTRE LOJAS (ADR-083, Fase G — Reposição da
      -- grade). Ao despachar, dá baixa na loja de ORIGEM e a transferência fica
      -- 'in_transit' (peças "na estrada"); na RECEPÇÃO, dá entrada na loja de
      -- DESTINO. Cancelar em trânsito estorna a baixa da origem. signal_id/
      -- decision_action_id ligam à sugestão da IA (Fase 2, ainda nulos).
      CREATE TABLE IF NOT EXISTS retail_stock_transfers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        origin_store_id TEXT NOT NULL,
        dest_store_id TEXT NOT NULL,
        status TEXT DEFAULT 'in_transit',   -- in_transit | received | cancelled
        source TEXT DEFAULT 'manual',       -- manual | ai_suggested (Fase 2)
        signal_id TEXT,                     -- vínculo com a sugestão da IA (Fase 2)
        decision_action_id TEXT,            -- vínculo com propor/aprovar (Fase 2)
        note TEXT,
        created_by TEXT,
        dispatched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        received_by TEXT,
        received_at DATETIME,
        cancelled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retail_transfers ON retail_stock_transfers (organization_id, status);

      CREATE TABLE IF NOT EXISTS retail_stock_transfer_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        transfer_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT,
        quantity_sent INTEGER NOT NULL DEFAULT 0,
        quantity_received INTEGER              -- null enquanto não recebido
      );
      CREATE INDEX IF NOT EXISTS idx_retail_transfer_items ON retail_stock_transfer_items (organization_id, transfer_id);

      -- Vendas do PDV (conector Alterdata Fase 4): venda a venda do caixa, com
      -- a MATRÍCULA do vendedor — base da comissão por vendedor e dos rankings
      -- reais da rede. Upsert pela chave natural (filial+boleta+dia).
      CREATE TABLE IF NOT EXISTS retail_pdv_sales (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        filial TEXT NOT NULL,
        boleta TEXT NOT NULL,
        sale_date TEXT NOT NULL,
        sale_time TEXT,
        vendedor TEXT,                           -- matrícula no caixa (OPERADOR de caixa — não é o vendedor)
        usuario TEXT,                            -- CAI_USUARIO (id de pessoa no caixa; base do vendedor)
        vendedor_codigo TEXT,                    -- CÓDIGO DO VENDEDOR (CAI_USUARIO → VENDEDORES.VEN_CODIGO); base da comissão individual
        valor REAL DEFAULT 0,
        pecas REAL DEFAULT 0,
        status TEXT,                             -- 'N' normal (contrato ModaUp)
        payments_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, filial, boleta, sale_date)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_pdv_sales ON retail_pdv_sales (organization_id, sale_date);
      -- Homologação Toulon (ADR-105): o vendedor da comissão é o CAI_USUARIO
      -- (relação com VENDEDORES por VEN_CODIGO = CAI_CODIGO), não a matrícula do
      -- operador de caixa. Coluna aditiva para bases já existentes.
      -- @ts-migration vendedor_codigo

      -- Itens de venda do PDV (linhas do array vendas[] de cada VendaMalote):
      -- produto, quantidade, valor e o VENDEDOR POR LINHA — base dos
      -- mais-vendidos por produto e da comissão por vendedor correta (a
      -- matricula do caixa é o operador, não o vendedor).
      CREATE TABLE IF NOT EXISTS retail_pdv_sale_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        filial TEXT NOT NULL,
        boleta TEXT NOT NULL,
        sale_date TEXT NOT NULL,
        item_seq INTEGER,
        produto TEXT,                            -- código de produto do ERP
        quantidade REAL DEFAULT 0,
        valor REAL DEFAULT 0,
        comissao REAL DEFAULT 0,
        vendedor TEXT,                           -- vendedor POR LINHA (quando existir)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, filial, boleta, sale_date, item_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_pdv_sale_items ON retail_pdv_sale_items (organization_id, sale_date);
      CREATE INDEX IF NOT EXISTS idx_retail_pdv_sale_items_prod ON retail_pdv_sale_items (organization_id, produto);

      -- Clientes do PDV (ClienteMalote — Fase 3, opt-in por LGPD): base
      -- SEPARADA dos contatos do WhatsApp; alimenta campanhas/aniversariantes
      -- sem poluir o inbox nem acionar a IA. Chave: codigoN (código do ERP).
      CREATE TABLE IF NOT EXISTS retail_pdv_customers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        codigo_n TEXT NOT NULL,                  -- código do cliente no ERP
        nome TEXT,
        cpf TEXT,
        celular TEXT,
        email TEXT,
        nascimento TEXT,                         -- YYYY-MM-DD (aniversário)
        filial TEXT,
        cidade TEXT,
        bairro TEXT,
        primeira_compra TEXT,
        ultima_compra TEXT,
        inativo INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE(organization_id, codigo_n)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_pdv_customers ON retail_pdv_customers (organization_id);
      CREATE INDEX IF NOT EXISTS idx_retail_pdv_customers_agg ON retail_pdv_customers (organization_id, nascimento);

      -- Recebíveis de cartão (parcelasCartao de cada VendaMalote): valor bruto,
      -- líquido (após taxa), taxa e vencimento por parcela — base da
      -- conciliação de cartão (quanto entra, quando, quanto a adquirente reteve).
      CREATE TABLE IF NOT EXISTS retail_pdv_card_installments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        filial TEXT NOT NULL,
        boleta TEXT,
        sale_date TEXT,
        numero TEXT,                             -- nº da transação do cartão
        parcela TEXT,
        seq INTEGER,
        codigo_cartao TEXT,                      -- bandeira/adquirente (código ERP)
        valor REAL DEFAULT 0,                    -- bruto da parcela
        liquido REAL DEFAULT 0,                  -- líquido (após taxa)
        taxa REAL DEFAULT 0,                     -- % da taxa
        vencimento TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, filial, numero, parcela, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_card_inst ON retail_pdv_card_installments (organization_id, vencimento);

      -- Mapeamento matrícula (ERP) → vendedor com nome (Fase 4): dá identidade
      -- às matrículas do PDV e permite comissão OFICIAL por vendedor.
      CREATE TABLE IF NOT EXISTS retail_sellers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        matricula TEXT NOT NULL,
        name TEXT,
        user_id TEXT,                            -- usuário do ZappFlow (opcional)
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE(organization_id, matricula)
      );

      -- Vendas por VENDEDOR lançadas manualmente / lidas por FOTO (Cenário B):
      -- quando o vendedor por venda NÃO vem do ERP, a loja anota as vendas de
      -- cada vendedor no papel e o gestor lança aqui (digitando ou enviando a
      -- foto da folha p/ a IA ler). É a base da comissão por vendedor quando não
      -- há atribuição individual no PDV. seller_name é o texto da folha;
      -- matricula liga ao mapeamento retail_sellers quando existir.
      CREATE TABLE IF NOT EXISTS retail_seller_sales (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT,                           -- loja (retail_stores.id) — opcional
        sale_date TEXT NOT NULL,                 -- YYYY-MM-DD
        seller_name TEXT NOT NULL,               -- nome escrito na folha
        matricula TEXT,                          -- liga ao retail_sellers quando existir
        valor REAL DEFAULT 0,                    -- total vendido em R$
        pecas REAL DEFAULT 0,                    -- nº de peças vendidas
        source TEXT DEFAULT 'manual',            -- manual | photo
        image_url TEXT,                          -- foto da folha (origem photo)
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_retail_seller_sales ON retail_seller_sales (organization_id, sale_date);

      -- Vendas por VENDEDOR vindas do ERP (Cenário A): quando o ERP calcula a
      -- comissão por vendedor (endpoint Venda/ComissaoVendasPorPeriodo), a gente
      -- guarda por vendedor DUAS coisas: o valor vendido (coluna valor) — base
      -- para as NOSSAS regras de comissão, igual ao manual/ZappFlow — e a comissão
      -- JÁ CALCULADA pelo ERP (coluna comissao_erp) — p/ exibir e conferir desvio.
      -- FUNDAÇÃO: a tabela e o merge existem; o SYNC real (AlterdataSyncRunner)
      -- só é ligado quando o formato do payload do ERP estiver confirmado.
      -- matricula liga ao mapeamento retail_sellers (nome/usuário do ZappFlow).
      CREATE TABLE IF NOT EXISTS retail_erp_seller_sales (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT,                           -- loja (retail_stores.id) quando resolvida
        filial TEXT,                             -- código da filial no ERP
        sale_date TEXT NOT NULL,                 -- YYYY-MM-DD (dia representativo)
        matricula TEXT,                          -- matrícula do vendedor no ERP
        seller_name TEXT,                        -- nome do vendedor (quando o ERP traz)
        valor REAL DEFAULT 0,                    -- valor vendido (base p/ nossas regras)
        pecas REAL DEFAULT 0,                    -- peças vendidas
        comissao_erp REAL DEFAULT 0,             -- comissão JÁ calculada pelo ERP (conferência)
        external_ref TEXT,                       -- idempotência do sync (chave determinística)
        synced_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, filial, matricula, sale_date)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_erp_seller_sales ON retail_erp_seller_sales (organization_id, sale_date);

      -- Memória de Padrões do Varejo (ADR-142 Fatia 1): padrões recorrentes
      -- observados numa loja (ou na rede). A confiança/status é calculada por
      -- REGRA (recorrência), não pelo LLM. store_id NULL = rede toda.
      CREATE TABLE IF NOT EXISTS retail_store_patterns (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT,
        pattern_type TEXT NOT NULL,             -- caixa_divergente_recorrente | estoque_negativo_recorrente | ...
        pattern_key TEXT NOT NULL,              -- chave normalizada p/ idempotência (upsert)
        description TEXT,
        evidence_json TEXT,
        confidence REAL DEFAULT 0,              -- 0..1 (regra de recorrência)
        status TEXT DEFAULT 'candidate',        -- candidate | validated | refuted | dormant
        occurrences INTEGER DEFAULT 0,          -- em quantos passes foi re-detectado
        first_seen_date DATE,
        last_seen_date DATE,
        created_by_type TEXT DEFAULT 'rule',    -- rule | ai | user
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_store_patterns_key
        ON retail_store_patterns (organization_id, COALESCE(store_id,''), pattern_type, pattern_key);
      CREATE INDEX IF NOT EXISTS idx_retail_store_patterns_org
        ON retail_store_patterns (organization_id, status);

      -- Eficácia por TIPO de padrão (ADR-142 Fatia 3): fecha o loop com o
      -- resultado. Quando o gestor age sobre um padrão e mede o desfecho, a
      -- eficácia do tipo se ajusta — o sistema aprende O QUE FUNCIONA na loja.
      CREATE TABLE IF NOT EXISTS retail_pattern_type_stats (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        pattern_type TEXT NOT NULL,
        acted INTEGER DEFAULT 0,
        worked INTEGER DEFAULT 0,
        no_effect INTEGER DEFAULT 0,
        backfired INTEGER DEFAULT 0,
        net_impact REAL DEFAULT 0,
        effectiveness REAL DEFAULT 0.5,        -- 0..1 (prior neutro 0,5 sem dado)
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_pattern_type_stats
        ON retail_pattern_type_stats (organization_id, pattern_type);

      -- Memória de Padrões GENÉRICA (ADR-142 generalizada): o mesmo loop de
      -- aprendizado do varejo, agora para QUALQUER domínio. A confiança/status é
      -- calculada por REGRA (recorrência); o LLM só narra. scope_id = dimensão
      -- opcional do domínio (produto, fornecedor, conta…); NULL = org toda.
      CREATE TABLE IF NOT EXISTS business_patterns (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        domain TEXT NOT NULL,                   -- production | procurement | finance | ...
        scope_id TEXT,
        pattern_type TEXT NOT NULL,
        pattern_key TEXT NOT NULL,
        description TEXT,
        evidence_json TEXT,
        confidence REAL DEFAULT 0,              -- 0..1 (regra de recorrência)
        status TEXT DEFAULT 'candidate',        -- candidate | validated | refuted | dormant
        occurrences INTEGER DEFAULT 0,
        first_seen_date DATE,
        last_seen_date DATE,
        created_by_type TEXT DEFAULT 'rule',    -- rule | ai | user
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_business_patterns_key
        ON business_patterns (organization_id, domain, COALESCE(scope_id,''), pattern_type, pattern_key);
      CREATE INDEX IF NOT EXISTS idx_business_patterns_org
        ON business_patterns (organization_id, domain, status);

      -- Eficácia por TIPO de padrão (genérica): fecha o loop com o desfecho medido.
      CREATE TABLE IF NOT EXISTS business_pattern_type_stats (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        pattern_type TEXT NOT NULL,
        acted INTEGER DEFAULT 0,
        worked INTEGER DEFAULT 0,
        no_effect INTEGER DEFAULT 0,
        backfired INTEGER DEFAULT 0,
        net_impact REAL DEFAULT 0,
        effectiveness REAL DEFAULT 0.5,        -- 0..1 (prior neutro 0,5 sem dado)
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_business_pattern_type_stats
        ON business_pattern_type_stats (organization_id, domain, pattern_type);

      -- CONTROLER (PRD-E-007, Fatia 1a): fundação de Departamentos e Centros de
      -- Custo. Aditivo e opt-in — não altera nenhum fluxo existente. Todo o
      -- consumo/custo futuro pendura nessas dimensões. Isolado por organização.
      CREATE TABLE IF NOT EXISTS business_departments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        code TEXT,                              -- código curto opcional (único por org quando informado)
        manager_user_id TEXT,                   -- gestor responsável (users.id)
        parent_department_id TEXT,              -- hierarquia (NULL = raiz)
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_business_departments_org ON business_departments(organization_id, active);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_business_departments_code ON business_departments(organization_id, code) WHERE code IS NOT NULL;

      CREATE TABLE IF NOT EXISTS cost_centers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        code TEXT,                              -- código curto opcional (único por org quando informado)
        department_id TEXT,                     -- vínculo opcional a um departamento
        store_id TEXT,                          -- unidade/loja opcional
        budget_owner_user_id TEXT,              -- dono do orçamento (users.id)
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cost_centers_org ON cost_centers(organization_id, active);
      CREATE INDEX IF NOT EXISTS idx_cost_centers_dept ON cost_centers(organization_id, department_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_centers_code ON cost_centers(organization_id, code) WHERE code IS NOT NULL;

      -- CONTROLER (PRD-E-007, Fatia 1b): LOCALIZAÇÕES de estoque. Onde o material
      -- fisicamente está (almoxarifado, filial, sala, veículo, máquina, custódia
      -- do colaborador, manutenção, limpeza…). Aditivo; o agregado legado
      -- inventory_items permanece intocado. Isolado por organização.
      CREATE TABLE IF NOT EXISTS inventory_locations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'almoxarifado',  -- almoxarifado|filial|sala|veiculo|maquina|custodia_colaborador|manutencao|limpeza|outro
        code TEXT,                                   -- código curto opcional (único por org quando informado)
        store_id TEXT,                               -- unidade/loja opcional
        department_id TEXT,                          -- departamento opcional
        responsible_user_id TEXT,                    -- responsável pela custódia (users.id)
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_locations_org ON inventory_locations(organization_id, active);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_locations_code ON inventory_locations(organization_id, code) WHERE code IS NOT NULL;

      -- Saldo por LOCAL × produto × variação. Tabela nova (não substitui o
      -- agregado atual); a reconciliação com inventory_items entra na fatia de
      -- consumo. O saldo aqui muda só por primitivas governadas (receber/transferir).
      CREATE TABLE IF NOT EXISTS inventory_location_balances (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT,
        quantity REAL NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_loc_balances_key
        ON inventory_location_balances(organization_id, location_id, product_service_id, COALESCE(variant_id,''));
      CREATE INDEX IF NOT EXISTS idx_inv_loc_balances_prod
        ON inventory_location_balances(organization_id, product_service_id);

      -- CONTROLER (PRD-E-007, Fatia 2): REQUISIÇÃO interna → aprovação → retirada →
      -- confirmação → devolução, e o LEDGER de consumo. Nada de editar saldo: a
      -- retirada debita o saldo do local e registra um evento de consumo; a
      -- devolução credita de volta. Isolado por organização. §11/§14.
      CREATE TABLE IF NOT EXISTS material_requests (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        requester_user_id TEXT,
        department_id TEXT,
        cost_center_id TEXT,
        purpose TEXT,                            -- finalidade
        priority TEXT NOT NULL DEFAULT 'normal', -- baixa|normal|alta|urgente
        status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|issued|acknowledged|returned|rejected|cancelled
        from_location_id TEXT,                   -- almoxarifado de origem (definido na retirada)
        approved_by TEXT,
        approved_at DATETIME,
        issued_by TEXT,
        issued_at DATETIME,
        acknowledged_at DATETIME,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_material_requests_org ON material_requests(organization_id, status, created_at);
      CREATE TABLE IF NOT EXISTS material_request_items (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        uom TEXT,                                -- unidade de consumo (snapshot)
        qty_requested REAL NOT NULL DEFAULT 0,
        qty_approved REAL NOT NULL DEFAULT 0,
        qty_issued REAL NOT NULL DEFAULT 0,
        qty_returned REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_material_request_items_req ON material_request_items(organization_id, request_id);

      -- Ledger de CONSUMO (fatos). Cada retirada/devolução vira um evento; o
      -- consumo líquido, médias e cobertura são derivados daqui (nunca de saldo).
      CREATE TABLE IF NOT EXISTS consumption_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        location_id TEXT,
        cost_center_id TEXT,
        department_id TEXT,
        direction TEXT NOT NULL DEFAULT 'out',   -- out (consumo) | in (devolução/estorno)
        quantity REAL NOT NULL DEFAULT 0,        -- sempre positiva; direction define o sinal
        uom TEXT,
        source_type TEXT NOT NULL DEFAULT 'issue', -- issue|return|manual
        source_id TEXT,
        actor_user_id TEXT,
        occurred_at DATE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_consumption_events_prod ON consumption_events(organization_id, product_service_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_consumption_events_cc ON consumption_events(organization_id, cost_center_id, occurred_at);

      -- Loja Virtual → PDV (ADR-143 Fase 0). Reserva e-commerce por loja/produto:
      -- a loja virtual vende SÓ desta reserva (Saldo Alterdata − buffer) → nunca
      -- vende o que não tem (sem oversell). Absoluto por (org, loja, produto, variante).
      CREATE TABLE IF NOT EXISTS retail_online_reserve (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT NOT NULL DEFAULT '',
        qty_reserved INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_online_reserve
        ON retail_online_reserve (organization_id, store_id, product_service_id, variant_id);

      -- Baixa pendente (ADR-143 Fase 0/D3): cada item de venda online vira uma
      -- baixa a lançar no PDV. A reconciliação re-aplica as pendentes na
      -- sobrescrita do Saldo (a venda online para de sumir). status: pending →
      -- (Fase 1) sent → confirmed | failed. Idempotente por (org, order, item).
      CREATE TABLE IF NOT EXISTS retail_online_writeback (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,
        variant_id TEXT NOT NULL DEFAULT '',
        qty INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',         -- pending | sent | confirmed | failed
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_online_writeback_item
        ON retail_online_writeback (organization_id, order_id, product_service_id, variant_id);
      CREATE INDEX IF NOT EXISTS idx_retail_online_writeback_pending
        ON retail_online_writeback (organization_id, store_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas Retail Ops Fase F', e); }

  // Retail Ops (ADR-083, Fase G) — PREMIAÇÃO/COMISSÃO. Regras por loja/vendedor/
  // produto/global; a apuração (run) gera uma PRÉVIA (draft) a partir dos
  // fechamentos do período; a aprovação é sempre HUMANA (D7) — nunca paga sozinha.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_commission_rules (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scope TEXT DEFAULT 'store',              -- store | seller | product | global
        period TEXT DEFAULT 'monthly',           -- daily | weekly | monthly
        calculation_type TEXT NOT NULL,          -- percent_sales | quota_bonus | tiered | fixed
        config_json TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retail_comm_rules ON retail_commission_rules (organization_id, active);

      CREATE TABLE IF NOT EXISTS retail_commission_runs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        status TEXT DEFAULT 'draft',             -- draft | approved | rejected
        total_sales REAL DEFAULT 0,
        total_commission REAL DEFAULT 0,
        divergence_count INTEGER DEFAULT 0,
        created_by TEXT,
        approved_by TEXT,
        approved_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retail_comm_runs ON retail_commission_runs (organization_id, period_start);

      CREATE TABLE IF NOT EXISTS retail_commission_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        store_id TEXT,
        seller_user_id TEXT,
        seller_name TEXT,
        product_service_id TEXT,
        base_amount REAL DEFAULT 0,
        commission_amount REAL DEFAULT 0,
        expected_amount REAL,                    -- premiação informada manualmente (p/ comparar)
        divergence_amount REAL DEFAULT 0,
        rule_id TEXT,
        calculation_details_json TEXT,
        status TEXT DEFAULT 'calculated'
      );
      CREATE INDEX IF NOT EXISTS idx_retail_comm_items ON retail_commission_items (run_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas Retail Ops Fase G', e); }

  // Módulo Clínica (ADR-080, Fase B) — Ficha do Paciente. Tabela satélite 1:1
  // com contacts (dado sensível de saúde separado do CRM). Editar plano NUNCA
  // apaga o paciente nem o agendamento; a troca fica registrada no histórico.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS patient_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        full_name TEXT,
        cpf TEXT,
        birth_date DATETIME,
        insurance_name TEXT,          -- convênio/operadora
        current_plan_name TEXT,       -- plano dentro do convênio
        insurance_card_number TEXT,   -- carteirinha
        insurance_valid_until DATETIME,
        administrative_notes TEXT,    -- observações administrativas (não clínicas)
        status TEXT DEFAULT 'active', -- active | inactive
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_patient_profiles_org ON patient_profiles (organization_id, status);

      CREATE TABLE IF NOT EXISTS patient_plan_history (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        old_insurance_name TEXT,
        new_insurance_name TEXT,
        old_plan_name TEXT,
        new_plan_name TEXT,
        old_card_number TEXT,
        new_card_number TEXT,
        reason TEXT,
        changed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_patient_plan_history ON patient_plan_history (organization_id, contact_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar Ficha do Paciente (Clínica)', e); }

  // Módulo Escola (ADR-144, Fatia 1) — a camada que conecta a escola à família.
  // Aluno é ENTIDADE PRÓPRIA (menor, sem telefone; molde de clinic_professionals,
  // ADR-080 D2): não vira contato do CRM. O responsável é um `contacts` (tem
  // WhatsApp). O vínculo student_guardians carrega o CONSENTIMENTO-DE-MENOR
  // (porta: sem ele nada é enviado) e o dedupe do envio diário. student_agenda_items
  // é a "nossa agenda" da Fatia 1 (sem depender de conector) — fonte determinística
  // do resumo diário.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS student_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        birth_date TEXT,
        turma TEXT,                 -- classe/série (ex.: "3º ano B")
        enrollment_code TEXT,       -- matrícula
        status TEXT DEFAULT 'active', -- active, inactive
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_student_profiles_org ON student_profiles (organization_id, status);

      CREATE TABLE IF NOT EXISTS student_guardians (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        student_id TEXT NOT NULL,           -- -> student_profiles.id
        guardian_contact_id TEXT NOT NULL,  -- -> contacts.id (tem WhatsApp)
        relationship TEXT,                  -- mãe/pai/responsável
        is_primary INTEGER DEFAULT 0,
        digest_consent INTEGER DEFAULT 0,   -- PORTA: só envia se 1 (consentimento-de-menor)
        digest_consent_at DATETIME,
        digest_consent_by TEXT,             -- quem registrou o consentimento
        last_digest_date TEXT,              -- dedupe por dia SP do resumo diário
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, student_id, guardian_contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_student_guardians_student ON student_guardians (organization_id, student_id);

      CREATE TABLE IF NOT EXISTS student_agenda_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        student_id TEXT NOT NULL,           -- -> student_profiles.id
        date TEXT NOT NULL,                 -- YYYY-MM-DD (dia SP)
        kind TEXT DEFAULT 'notice',         -- class, activity, notice, pickup
        title TEXT NOT NULL,
        time_label TEXT,                    -- ex.: "16h" (livre, sem parsing)
        status TEXT,                        -- ex.: "pending" para avisos que aguardam ação
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_student_agenda_day ON student_agenda_items (organization_id, student_id, date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar Módulo Escola (ADR-144)', e); }

  // Módulo Escola (ADR-144, Fatia 2) — Agenda do professor (ADAPTA a Agenda
  // Clínica, ADR-080). O professor é ENTIDADE PRÓPRIA (molde de clinic_professionals,
  // D2) — desacoplado de `users` (link opcional para portal futuro). Diferente do
  // aluno, o professor RECEBE mensagens (o "resumo antes da aula"), então tem
  // telefone próprio + opt-in como PORTA (D6). A grade é recorrente por turma
  // (weekday+horário) e a confirmação pós-aula alimenta a coordenação (sinal).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS teacher_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        subject TEXT,               -- disciplina principal (ex.: "Matemática")
        phone TEXT,                 -- WhatsApp do professor (recebe o resumo)
        color TEXT,                 -- cor na grade
        user_id TEXT,               -- link OPCIONAL para users (portal futuro)
        status TEXT DEFAULT 'active', -- active, inactive
        notify_opt_in INTEGER DEFAULT 0, -- PORTA do resumo antes da aula (opt-in, D6)
        last_agenda_date TEXT,      -- dedupe por dia SP do resumo antes da aula
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_teacher_profiles_org ON teacher_profiles (organization_id, status);

      CREATE TABLE IF NOT EXISTS class_schedule_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,           -- -> teacher_profiles.id
        turma TEXT NOT NULL,                -- classe/série (ex.: "3º ano B")
        weekday INTEGER NOT NULL,           -- 0=domingo .. 6=sábado (getUTCDay)
        time_label TEXT,                    -- ex.: "7h30" (livre, sem parsing)
        subject TEXT,                       -- disciplina/título da aula
        status TEXT DEFAULT 'active',       -- active, inactive
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_class_schedule_teacher ON class_schedule_items (organization_id, teacher_id, weekday);
      CREATE INDEX IF NOT EXISTS idx_class_schedule_turma ON class_schedule_items (organization_id, turma, weekday);

      CREATE TABLE IF NOT EXISTS class_confirmations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        schedule_item_id TEXT NOT NULL,     -- -> class_schedule_items.id
        date TEXT NOT NULL,                 -- YYYY-MM-DD (dia SP da ocorrência)
        status TEXT NOT NULL,               -- held | not_held
        note TEXT,
        confirmed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, schedule_item_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_class_confirmations_day ON class_confirmations (organization_id, schedule_item_id, date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar Agenda do Professor (ADR-144 Fatia 2)', e); }

  // Módulo Escola (ADR-144, Fatia 3) — Extracurriculares (ADAPTA o padrão de
  // reservations: capacidade/vagas + matrícula ATÔMICA anti-overbooking + lista
  // de espera), mas em tabelas próprias da escola (o aluno é entidade própria,
  // não um contato/período de hotel — D8). A atividade tem `capacity` vagas; a
  // matrícula vira `enrolled` enquanto houver vaga, senão `waitlisted` com
  // `position`; cancelar uma vaga promove o 1º da espera. A presença é por
  // sessão (data). O "aviso ao responsável" reusa a porta de consentimento da
  // Fatia 1 (student_guardians.digest_consent).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS extracurricular_activities (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        capacity INTEGER DEFAULT 1,         -- vagas simultâneas
        day_label TEXT,                     -- ex.: "Terça e Quinta" (livre)
        time_label TEXT,                    -- ex.: "16h" (livre)
        location TEXT,
        teacher_id TEXT,                    -- -> teacher_profiles.id (opcional)
        status TEXT DEFAULT 'active',       -- active, inactive
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_extracur_activities_org ON extracurricular_activities (organization_id, status);

      CREATE TABLE IF NOT EXISTS extracurricular_enrollments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,          -- -> extracurricular_activities.id
        student_id TEXT NOT NULL,           -- -> student_profiles.id
        status TEXT NOT NULL DEFAULT 'enrolled', -- enrolled | waitlisted | cancelled
        position INTEGER,                   -- ordem na lista de espera (só waitlisted)
        enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, activity_id, student_id)
      );
      CREATE INDEX IF NOT EXISTS idx_extracur_enroll_activity ON extracurricular_enrollments (organization_id, activity_id, status);

      CREATE TABLE IF NOT EXISTS extracurricular_attendance (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,          -- -> extracurricular_activities.id
        student_id TEXT NOT NULL,           -- -> student_profiles.id
        date TEXT NOT NULL,                 -- YYYY-MM-DD (dia SP da sessão)
        status TEXT NOT NULL,               -- present | absent
        note TEXT,
        recorded_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, activity_id, student_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_extracur_attendance_day ON extracurricular_attendance (organization_id, activity_id, date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar Extracurriculares (ADR-144 Fatia 3)', e); }

  // Módulo Clínica (ADR-080, Fase C) — Agenda Clínica. Profissionais como
  // entidade própria (D2, desacoplada de login, link opcional para user) e
  // salas. Duração por consulta (sem teto de 150 min), check-in/início/saída e
  // status de permanência — NUNCA excluir por tempo excedido (D3).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_professionals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        specialty TEXT,
        color TEXT,                 -- cor na grade da agenda
        user_id TEXT,               -- link OPCIONAL para users (portal do profissional)
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_org ON clinic_professionals (organization_id, active);

      CREATE TABLE IF NOT EXISTS clinic_rooms (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_rooms_org ON clinic_rooms (organization_id, active);
    `);
  } catch(e){ console.error('[DB] Falha ao criar profissionais/salas (Clínica)', e); }

  // Notificação de addendum ao paciente (ADR-080 Fase 24). Quando o
  // profissional adiciona addendum ao prontuário assinado (Fase 20), o
  // paciente recebe WhatsApp curto avisando que o prontuário foi atualizado
  // + link do portal (Fase L) pra ler a evolução. Fecha o loop: sem esta
  // fatia o paciente só descobre no próximo atendimento. Dedup por
  // (addendum, status IN sent|queued) — mesma nota não é enviada 2x sem
  // `force:true`. Config por org: `clinic_addendum_notification_enabled`
  // (default 1) — permite desligar em clínicas que preferem contato manual.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_addendum_notifications (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        addendum_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel_id TEXT,
        to_identifier TEXT,
        status TEXT NOT NULL,             -- queued | sent | failed | skipped
        provider_message_id TEXT,
        error TEXT,
        portal_token_id TEXT,             -- token curto gerado só pra esta notificação
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_addendum_notif ON clinical_addendum_notifications (organization_id, addendum_id, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_addendum_notif_contact ON clinical_addendum_notifications (organization_id, contact_id, sent_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_addendum_notifications', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_addendum_notification_enabled INTEGER DEFAULT 1`); } catch(e){}

  // Notificação automática de retorno (ADR-080 Fase 26). Complementa a fila
  // da Fase I: em vez de esperar a recepção olhar a fila, o Scheduler
  // varre encounters signed com follow_up_recommended_days e avisa o
  // paciente N dias ANTES da data sugerida ("é hora do retorno") com link
  // do portal pra escolher horário. Dedup por (encounter, status IN
  // sent|queued) — 1 lembrete por retorno recomendado; force:true bypassa.
  // Encounters cujo retorno JÁ foi agendado (parent_appointment_id ativo)
  // não entram — a Fase M cuida do lembrete de consulta agendada.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_follow_up_notifications (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        source_appointment_id TEXT,
        recommended_days INTEGER,          -- snapshot do valor no momento do envio
        suggested_at DATETIME,             -- data-alvo do retorno (rastro)
        channel_id TEXT,
        to_identifier TEXT,
        status TEXT NOT NULL,              -- queued | sent | failed | skipped
        provider_message_id TEXT,
        error TEXT,
        portal_token_id TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_followup_notif ON clinical_follow_up_notifications (organization_id, encounter_id, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_followup_notif_contact ON clinical_follow_up_notifications (organization_id, contact_id, sent_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_follow_up_notifications', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_followup_notification_enabled INTEGER DEFAULT 1`); } catch(e){}
  // Antecedência default: aviso vai 3 dias antes da data sugerida do retorno.
  // Faixa razoável 1..30 dias (o service clipa).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_followup_notification_lead_days INTEGER DEFAULT 3`); } catch(e){}

  // Envio automático do relatório mensal (ADR-080 Fase 33). Complementa a
  // Fatia 17 (rota manual do PDF) — o Scheduler decide se está no dia certo
  // do mês e dispara sozinho pra um destinatário configurado (owner/sócio/
  // contador). Dedup por (org, month, status IN sent|queued) — mesmo relatório
  // do mesmo mês só sai UMA vez, mesmo com o Scheduler rodando várias vezes
  // dentro do dia; `force:true` bypassa (re-envio manual do painel).
  // Config `enabled` default 0 (OPT-IN): envio automático de PDF financeiro
  // exige decisão consciente do gestor — sem opt-in explícito, nada dispara.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_monthly_report_deliveries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        month TEXT NOT NULL,                -- 'YYYY-MM' (mês do relatório)
        contact_id TEXT,                    -- destinatário
        channel_id TEXT,
        to_identifier TEXT,
        status TEXT NOT NULL,               -- queued | sent | failed | skipped
        provider_message_id TEXT,
        error TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_monthly_report_dedup ON clinical_monthly_report_deliveries (organization_id, month, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_monthly_report_recent ON clinical_monthly_report_deliveries (organization_id, sent_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_monthly_report_deliveries', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_monthly_report_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_monthly_report_day INTEGER DEFAULT 5`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_monthly_report_recipient_contact_id TEXT`); } catch(e){}

  // Especialidades normalizadas + vínculo N:N com profissional (ADR-145 Fase 1,
  // Fatia 35). Substitui o uso EXCLUSIVO do texto livre `clinic_professionals
  // .specialty` para decisões de negócio (listar profissionais qualificados
  // pra uma especialidade, configurar duração/ciclo default por área). O texto
  // legado permanece durante transição (padrão fases 25/29 — coluna nunca
  // apagada; backfill idempotente cria specialty + vínculo a partir dele).
  // `default_duration_minutes` alimenta `AddSpecialtyWizard` (Fatia 37);
  // `default_cycle_sessions` alimenta a Fatia 38 (default 10, mas cliente
  // pode configurar 6 pra Fono e 20 pra Fisio, por exemplo). Unique parcial
  // por (org, name) protege contra duplicata; case-sensitive intencional
  // (o operador vê o nome que digitou). Isolamento por organization_id.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_specialties (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        code TEXT,
        color TEXT,
        default_duration_minutes INTEGER DEFAULT 60,
        default_cycle_sessions INTEGER DEFAULT 10,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_specialty_name
        ON clinic_specialties (organization_id, name);
      CREATE INDEX IF NOT EXISTS idx_clinic_specialty_active
        ON clinic_specialties (organization_id, active);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_specialties', e); }

  // Vínculo N:N profissional↔especialidade. `is_primary=1` marca a
  // especialidade principal do profissional (usada quando a Fatia 37
  // sugerir default pro AddSpecialtyWizard). `active=0` desativa vínculo
  // sem apagar (o profissional pode voltar a atender aquela área depois).
  // UNIQUE evita vincular 2× o mesmo par.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_professional_specialties (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        specialty_id TEXT NOT NULL,
        is_primary INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, professional_id, specialty_id)
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_spec_by_prof
        ON clinic_professional_specialties (organization_id, professional_id, active);
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_spec_by_spec
        ON clinic_professional_specialties (organization_id, specialty_id, active);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_professional_specialties', e); }

  // Episódio de cuidado / tratamento longitudinal (ADR-145 D1, Fatia 36).
  // Entidade CENTRAL da Jornada de Tratamento — sem ela, "profissional
  // fixo", "multi-especialidades sem recadastro", "10 sessões renováveis"
  // e "alta explícita" viram combinações frágeis de appointments soltos.
  // Amarra paciente + especialidade + profissional responsável + estado.
  //
  // Unique parcial WHERE status IN ('active','on_hold') garante 1 episódio
  // ativo por (org, paciente, especialidade) — o paciente pode ter Psico
  // ATIVO e Fono ATIVO ao mesmo tempo (multi-especialidade), mas não pode
  // ter 2 episódios de Psico ativos ao mesmo tempo. `discharged` e
  // `cancelled` NÃO entram no índice — permite reabrir depois com novo
  // episódio (histórico preservado, retenção CFM 20 anos).
  //
  // Colunas de alta (discharge_*) já entram aqui na Fatia 36 (evita ALTER
  // na Fatia 39 — padrão ADR-145 D9), mas ficam NULL até Fatia 39 plugar
  // o fluxo com PIN. Isolamento por organization_id.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_care_episodes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        specialty_id TEXT NOT NULL,
        primary_professional_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at DATETIME NOT NULL,
        on_hold_at DATETIME,
        on_hold_reason TEXT,
        discharged_at DATETIME,
        discharge_type TEXT,
        discharge_summary TEXT,
        discharged_by_professional_id TEXT,
        discharge_signed_with_pin INTEGER DEFAULT 0,
        reopened_at DATETIME,
        reopen_reason TEXT,
        cancelled_at DATETIME,
        cancelled_reason TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_care_episode_patient
        ON clinic_care_episodes (organization_id, contact_id, status);
      CREATE INDEX IF NOT EXISTS idx_care_episode_prof
        ON clinic_care_episodes (organization_id, primary_professional_id, status);
      CREATE INDEX IF NOT EXISTS idx_care_episode_specialty
        ON clinic_care_episodes (organization_id, specialty_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_care_episode_active_specialty
        ON clinic_care_episodes (organization_id, contact_id, specialty_id)
        WHERE status IN ('active','on_hold');
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_care_episodes', e); }

  // Histórico de transferências do profissional responsável. Cada
  // transfer é uma linha imutável (append-only) — permite auditoria
  // completa de "quem passou a atender o paciente e por quê". O snapshot
  // do episódio (primary_professional_id atual) fica em clinic_care_
  // episodes; esta tabela é o log. Regra: transfer só entre profissionais
  // da MESMA especialidade do episódio (service valida).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_care_episode_transfers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        from_professional_id TEXT NOT NULL,
        to_professional_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        effective_at DATETIME NOT NULL,
        changed_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_care_episode_transfers_episode
        ON clinic_care_episode_transfers (organization_id, episode_id, effective_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_care_episode_transfers', e); }

  // Ciclos de sessões renováveis (ADR-145 D4, Fatia 38). Um episódio ativo
  // tem N ciclos ao longo do tempo (10 sessões → renova → mais 10 → …
  // até alta). Cada ciclo é um bloco administrativo/assistencial fechado.
  //
  // UNIQUE (org, episode_id, cycle_number) garante numeração sequencial
  // sem duplicata. previous_cycle_id encadeia (ciclo 2 aponta pro 1,
  // ciclo 3 pro 2). planned_sessions é imutável após create (mudanças
  // vira novo ciclo com renew). no_show_consumes_session default 0 —
  // regra clínica varia por org/convênio (RN-004: derivado por query,
  // NÃO contador mutável).
  //
  // Estados: draft (rascunho antes de autorizar), pending_authorization
  // (aguardando OK do convênio), active (em uso), renewal_due (esgotado
  // mas não renovado — episódio continua active), exhausted (equivalente
  // a renewal_due, semântica opcional), renewed (fechado por renovação —
  // imutável), cancelled (aberto por engano), expired (venceu antes de
  // consumir tudo).
  //
  // authorization_id / guide_id ficam NULL até Fatias 44-46 (guia da
  // recepção) — colunas já entram aqui pra evitar ALTER futuro (D9).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_treatment_cycles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        cycle_number INTEGER NOT NULL,
        previous_cycle_id TEXT,
        planned_sessions INTEGER NOT NULL DEFAULT 10,
        no_show_consumes_session INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        authorization_id TEXT,
        guide_id TEXT,
        starts_at DATETIME,
        expires_at DATETIME,
        renewal_requested_at DATETIME,
        renewed_at DATETIME,
        cancelled_at DATETIME,
        cancelled_reason TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, episode_id, cycle_number)
      );
      CREATE INDEX IF NOT EXISTS idx_treatment_cycle_episode
        ON clinic_treatment_cycles (organization_id, episode_id, status);
      CREATE INDEX IF NOT EXISTS idx_treatment_cycle_status
        ON clinic_treatment_cycles (organization_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_treatment_cycle_active
        ON clinic_treatment_cycles (organization_id, episode_id)
        WHERE status IN ('active','renewal_due','pending_authorization');
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_treatment_cycles', e); }

  // Aditivos p/ appointments ligarem a ciclo (ADR-145 Fatia 38).
  // treatment_cycle_id opcional (compat legado). cycle_sequence_number
  // grava "esta é a 3ª sessão do ciclo" (contador local ao ciclo, útil
  // pra exibir "3/10" no card do appointment).
  try { db.exec(`ALTER TABLE appointments ADD COLUMN treatment_cycle_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN cycle_sequence_number INTEGER`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_appointments_cycle ON appointments (organization_id, treatment_cycle_id) WHERE treatment_cycle_id IS NOT NULL`); } catch(e){}

  // Sessões de agenda compartilhadas (ADR-145 D6, Fatia 41). Habilita
  // "vários pacientes no mesmo horário" (dor #3 do cliente, áudio 1)
  // como PRIMEIRA CLASSE — não gambiarra com force=true. Cada participante
  // continua tendo appointment PRÓPRIO (prontuário/lembrete/presença
  // individuais); todos apontam pra mesma schedule_session_id.
  //
  // session_type ENUM('individual','group'): apenas grupo por ora
  // (cliente confirmou 2026-07 — "parallel" fica pra futuro se aparecer
  // necessidade, aditivo sem breaking). 'individual' entra pra permitir
  // reusar essa tabela como wrapper opcional em consulta 1:1 no futuro.
  //
  // capacity 1..100 valida no service. Estados: scheduled|in_care|
  // completed|cancelled — controla ciclo de vida do BLOCO (não dos
  // participantes individuais).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_schedule_sessions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        specialty_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        room_id TEXT,
        procedure_id TEXT,
        session_type TEXT NOT NULL DEFAULT 'group',
        title TEXT,
        scheduled_start DATETIME NOT NULL,
        scheduled_end DATETIME NOT NULL,
        duration_minutes INTEGER NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'scheduled',
        cancelled_at DATETIME,
        cancelled_reason TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_session_prof
        ON clinic_schedule_sessions
        (organization_id, professional_id, scheduled_start, scheduled_end, status);
      CREATE INDEX IF NOT EXISTS idx_schedule_session_specialty
        ON clinic_schedule_sessions
        (organization_id, specialty_id, scheduled_start, status);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_schedule_sessions', e); }

  // Aditivo: appointment liga à sessão. NULL = appointment individual
  // legado (compat 100%). Índice parcial pra query "quem está no grupo".
  try { db.exec(`ALTER TABLE appointments ADD COLUMN schedule_session_id TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_appointments_schedule_session ON appointments (organization_id, schedule_session_id) WHERE schedule_session_id IS NOT NULL`); } catch(e){}

  // Aditivo: sala tem limite de pessoas (RF-040 §5). Default 1 preserva
  // comportamento legado (sala pra consulta 1:1). O service da Fatia 42
  // (refactor conflict) usa isso pra bloquear grupo maior que a sala.
  try { db.exec(`ALTER TABLE clinic_rooms ADD COLUMN capacity INTEGER DEFAULT 1`); } catch(e){}

  // Guia da recepção (ADR-145 D7, Fatia 44). Documento administrativo
  // polimorfo emitido pela recepção — cliente confirmou 2026-07: 3 tipos
  // suportados na mesma tabela:
  //   - tiss_authorization: guia TISS de autorização de procedimento
  //     (operadora, TUSS, total_sessions, autorização, validade).
  //   - referral: encaminhamento pra outro especialista (specialty destino,
  //     CRM médico solicitante, motivo).
  //   - medical_order: pedido médico de exames/procedimentos (items,
  //     justificativa clínica, CID via Fatia 23, validade).
  //
  // Campos específicos por tipo vão em snapshot_json (hidratados/validados
  // pelo service). Estados: draft→issued→(submitted→approved|denied)|
  // expired|cancelled. Emitida vira imutável (snapshot congelado +
  // document_hash canônico da Fase 29).
  //
  // Numeração: internal_number UNIQUE(org, guide_type) — cada tipo tem
  // sua própria série sequencial (ex.: TISS-000123, REF-000045, PM-000078).
  // Fatia 45 adiciona PDF (pdf_storage_key) + envio HMAC. Fatia 46
  // liga com procedure_authorization_requests + treatment_cycles.
  //
  // connector_type reservado pra ADR-081 (evolução XML TISS por conector
  // sem breaking change nesta tabela).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_guides (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        internal_number TEXT NOT NULL,
        guide_type TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        episode_id TEXT,
        cycle_id TEXT,
        authorization_id TEXT,
        operator_id TEXT,
        procedure_id TEXT,
        professional_id TEXT,
        total_sessions INTEGER,
        valid_from DATETIME,
        valid_until DATETIME,
        status TEXT NOT NULL DEFAULT 'draft',
        snapshot_json TEXT,
        pdf_storage_key TEXT,
        document_hash TEXT,
        connector_type TEXT,
        cancelled_reason TEXT,
        cancelled_at DATETIME,
        issued_by TEXT,
        issued_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, internal_number)
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_guides_patient
        ON clinical_guides (organization_id, contact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_guides_cycle
        ON clinical_guides (organization_id, cycle_id, status);
      CREATE INDEX IF NOT EXISTS idx_clinical_guides_type_status
        ON clinical_guides (organization_id, guide_type, status);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_guides', e); }

  // Config: ciclo exige guia pra ativar (ADR-145 D7 / RN-005 §8, Fatia 46).
  // Opt-in (default 0). Quando ligada, todo novo ciclo nasce pending_
  // authorization até uma guia emitida ser amarrada. Passar `requiresGuide=
  // true` na criação também força independente da config.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_cycle_requires_guide INTEGER DEFAULT 0`); } catch(e){}

  // Envios da guia por canal (ADR-145 Fatia 45). Cada tentativa vira row
  // — histórico completo. Mesmo padrão de clinical_document_deliveries
  // (Fase K). Sem retry automático nesta fatia (KISS); Scheduler futuro
  // pode reprocessar 'failed' se surgir necessidade operacional.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_guide_deliveries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        guide_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel_id TEXT,
        to_identifier TEXT,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        error TEXT,
        sent_by TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_guide_deliveries_guide
        ON clinical_guide_deliveries (organization_id, guide_id, sent_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_guide_deliveries', e); }

  // Alergias do paciente (ADR-080 Fase 25). Registro clínico de alergia a
  // droga/substância/alimento/latex/outros — insumo direto pra travar receita
  // que contenha item cruzado com alergia grave. Dado sensível (LGPD Art.11):
  // ler/gravar exige consent `dados_sensiveis`. `active=0` funciona como soft
  // delete (retenção CFM: histórico de alergia é dado clínico, não some do
  // banco, só perde a força de bloqueio); `deactivated_at`/`deactivated_by`
  // preservam autoria da baixa.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_patient_allergies (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        substance TEXT NOT NULL,                     -- forma normalizada (lower, trim)
        substance_display TEXT NOT NULL,             -- forma original digitada (mostrar na UI)
        kind TEXT NOT NULL DEFAULT 'drug',           -- drug | food | latex | other
        severity TEXT NOT NULL DEFAULT 'moderate',   -- mild | moderate | severe
        reaction TEXT,                               -- descrição da reação (urticária, anafilaxia)
        notes TEXT,                                  -- observação livre
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deactivated_by TEXT,
        deactivated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_allergies_patient_active ON clinical_patient_allergies (organization_id, contact_id, active);
      CREATE INDEX IF NOT EXISTS idx_clinic_allergies_substance ON clinical_patient_allergies (organization_id, contact_id, substance);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_patient_allergies', e); }
  // Nota: ALTER TABLE clinical_prescriptions ADD COLUMN allergy_warnings/
  // allergy_alert_forced ficam DEPOIS do CREATE de clinical_prescriptions
  // (padrão pego nas Fases L/T/U — ALTER antes de CREATE em banco novo
  // falha silenciosamente e a coluna não existe).

  // Catálogo CID-10 (ADR-080 Fase 23). Ajuda o atestado (Fase H) a padronizar
  // o CID: campo hoje é texto livre, então a mesma condição vira "H10.9",
  // "H10", "H109", "conjuntivite" — impossível auditar/agregar. Catálogo é
  // GLOBAL (não por org): CID-10 é padrão OMS/DATASUS, mesmo pra todas as
  // clínicas. Não é policy — atestado ainda aceita CID fora do catálogo (não
  // travar quem já tem seus códigos memorizados); catálogo é ajuda pra
  // autocomplete e auto-preenchimento da descrição.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cid10_codes (
        code TEXT PRIMARY KEY,       -- código no formato normalizado (uppercase, sem espaço)
        description TEXT NOT NULL,
        chapter TEXT,                -- rótulo opcional do capítulo (ex: "Doenças do olho")
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cid10_desc ON cid10_codes (description);
    `);
  } catch (e) { console.error('[DB] Falha ao criar cid10_codes', e); }

  // Bloqueio de agenda por indisponibilidade do profissional (ADR-080 Fase 22).
  // Férias / congresso / atestado / outro. `createAppointment` do
  // ClinicAgendaService recusa slot que se sobrepõe (a menos que `force:true`,
  // padrão dos demais gates). Timezone: as datas são armazenadas ISO no fuso
  // que a UI enviar; comparação é lexicográfica (ISO 8601 ordena
  // corretamente). Nunca APAGA appointments existentes — se o profissional
  // marca ausência com consultas já agendadas, aquelas ficam (gestor decide
  // cancelar/reagendar manualmente); só bloqueia CRIAÇÃO nova.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_professional_absences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        starts_at DATETIME NOT NULL,
        ends_at DATETIME NOT NULL,
        reason TEXT NOT NULL,       -- vacation | conference | sick_leave | other
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_absences_prof ON clinic_professional_absences (organization_id, professional_id, starts_at, ends_at);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinic_professional_absences', e); }

  // Colunas clínicas em appointments (aditivas). professional_id substitui o
  // assigned_to morto; snapshots preservam nome mesmo se o cadastro mudar.
  try { db.exec(`ALTER TABLE appointments ADD COLUMN professional_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN professional_name_snapshot TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN room_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN room_name_snapshot TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN expected_duration_minutes INTEGER`); } catch(e){} // duração por consulta (null = usa slot da org)
  try { db.exec(`ALTER TABLE appointments ADD COLUMN checkin_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN care_started_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN checkout_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN continuation_status TEXT`); } catch(e){} // pending | continue | finish | reschedule
  // Snapshot imutável do plano/convênio do paciente no momento do startCare
  // (ADR-080 Fase 29). Congela {plan, insurance, planNumber, planValidUntil,
  // snapshotAt} lendo do patient_profiles — se o gestor mudar o plano do
  // paciente DEPOIS, appts em andamento e visões do dia continuam mostrando
  // o plano que valia quando o atendimento começou (auditoria do que foi
  // cobrado / autorizado). NULL em appts pré-Fatia-29 e em appts que ainda
  // não iniciaram atendimento (agendaForDay cai no plano atual).
  try { db.exec(`ALTER TABLE appointments ADD COLUMN patient_plan_snapshot_json TEXT`); } catch(e){}
  // Aviso de vaga na fila (ADR-080 Fase Q). Quando alguém cancela, guarda a
  // oferta de vaga enviada pra 1 candidato (o mais antigo signed encounter
  // com retorno recomendado pendente do MESMO profissional). Se o candidato
  // não responde OU declina, o Scheduler expira e tenta o próximo. Uma oferta
  // ativa por vez POR VAGA — não bombardeia N pacientes ao mesmo tempo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_vacancy_offers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        source_appointment_id TEXT NOT NULL,           -- appt cancelado que abriu a vaga
        candidate_contact_id TEXT NOT NULL,
        candidate_encounter_id TEXT NOT NULL,          -- encounter signed que gerou a candidatura
        professional_id TEXT,
        slot_start DATETIME NOT NULL,
        slot_duration_minutes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',        -- pending | accepted | declined | expired | superseded
        new_appointment_id TEXT,
        provider_message_id TEXT,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_vacancy_pending_contact ON clinical_vacancy_offers (organization_id, candidate_contact_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_vacancy_source ON clinical_vacancy_offers (organization_id, source_appointment_id, status);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_vacancy_offers', e); }

  // Reagendamento em 1 clique via WhatsApp (ADR-080 Fase P). Guarda os
  // slots oferecidos ao paciente entre "REMARCAR" e "1/2/3". Sem esta row,
  // a segunda mensagem do paciente (o número) não teria contexto — o parser
  // de intent não sabe distinguir "1" de resposta genérica. `expires_at` de
  // curto prazo (ex.: 30 min) evita que "1" fique válido por horas.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_reschedule_offers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        source_appointment_id TEXT NOT NULL,
        offered_slots_json TEXT NOT NULL,  -- [{startISO, durationMinutes}, ...]
        status TEXT NOT NULL DEFAULT 'pending', -- pending | chosen | expired | abandoned
        chosen_index INTEGER,
        new_appointment_id TEXT,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_reschedule_pending ON clinical_reschedule_offers (organization_id, contact_id, status, expires_at);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_reschedule_offers', e); }

  // Confirmação pelo paciente (ADR-080 Fase N). `patient_confirmed_at` é
  // setado quando o paciente responde SIM ao lembrete; `cancelled_at`/`_by`/
  // `_reason` rastreiam quem cancelou (patient|staff|system) e por que. Sem
  // relação com o status='cancelled' que já existia — os campos apenas
  // enriquecem a trilha (o status continua sendo a fonte de verdade).
  try { db.exec(`ALTER TABLE appointments ADD COLUMN patient_confirmed_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN cancelled_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN cancelled_by TEXT`); } catch(e){} // patient | staff | system
  try { db.exec(`ALTER TABLE appointments ADD COLUMN cancellation_reason TEXT`); } catch(e){}
  // Retorno em 1 clique (ADR-080 Fase I): rastreia a série de consultas do
  // paciente com o mesmo profissional. Aditivo, opcional (consulta avulsa
  // fica sem parent). Índice pra achar rápido "retornos desta consulta".
  try { db.exec(`ALTER TABLE appointments ADD COLUMN parent_appointment_id TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_appointments_parent ON appointments (organization_id, parent_appointment_id)`); } catch(e){}
  // Race protection (ADR-080 Fase 30). scheduleFollowUp já é idempotente
  // via SELECT prévio, mas duas secretárias clicando "Agendar retorno"
  // no mesmo encounter simultaneamente contornariam o check (2 SELECTs
  // ambos vazios → 2 INSERTs). Unique index parcial garante que, na
  // corrida, o 2º INSERT falha com UNIQUE constraint — o service catch
  // devolve o existente e loga o conflito. Escopo: só retornos ATIVOS
  // (cancelled/no_show liberam re-agendamento). Só rows com parent
  // preenchido (partial WHERE) — appt sem parent não é retorno.
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_parent_unique
         ON appointments (organization_id, parent_appointment_id)
         WHERE parent_appointment_id IS NOT NULL
           AND status NOT IN ('cancelled','no_show')`
    );
  } catch(e){ console.error('[DB] Falha ao criar idx_appointments_parent_unique', e); }

  // Registro do conselho (CRM/COREN/CREFITO/…) do profissional — usado no
  // rodapé de receita/atestado. Aditivo, opcional (profissional pode ser
  // não-prescritor). Snapshot separado nos documentos garante que uma
  // alteração aqui não muda um doc já emitido.
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN registration_number TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN council TEXT`); } catch(e){} // "CRM/SP", "COREN/RJ", …
  // Assinatura eletrônica com PIN (ADR-080 Fase T). Não é ICP-Brasil (não
  // tem valor jurídico de assinatura digital), mas é PROVA DE AUTORIA
  // INTERNA: sem o PIN do profissional, ninguém emite receita/atestado
  // em nome dele. Guardamos hash SHA-256 com salt UUID — nunca o PIN
  // cru. `pin_updated_at` pra fila de "reset PIN após N dias" no futuro.
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN pin_salt TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN pin_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN pin_updated_at DATETIME`); } catch(e){}
  // Lockout de PIN (ADR-080 Fase 28). Contador de tentativas erradas e
  // timestamp de destravamento — evita brute-force de PIN 4-8 dígitos (max
  // 10^8 = 100M combinações, mas com lockout 5-em-15min o custo cresce pra
  // ~30 anos pra 1M tentativas). timingSafeEqual no service fecha o
  // side-channel de tempo (medir latência da comparação byte-a-byte).
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN pin_failed_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE clinic_professionals ADD COLUMN pin_locked_until DATETIME`); } catch(e){}
  // Nota: ALTER TABLE clinical_prescriptions/certificates ADD COLUMN
  // signed_with_pin fica DEPOIS dos CREATEs dessas tabelas (linhas 2865/2893).

  // Prontuário/SOAP por consulta (ADR-080 Fase G). Uma linha por consulta
  // (UNIQUE(org, appointment)) — evita duas anotações concorrentes na mesma
  // sessão. Campos SOAP são colunas explícitas (Subjetivo/Objetivo/Avaliação/
  // Plano), `form_data JSON` acomoda campos customizados por especialidade
  // sem migração nova (Fatia 1b vai definir schemas por ficha). Encounter
  // nasce 'draft' e vira 'signed' quando o profissional finaliza — depois
  // disso, updates ficam bloqueados no service (só append em `addendum`, se
  // preciso, numa próxima fatia). LGPD Art.11 (dado sensível de saúde) é
  // exigido no service, não no DB.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_encounters (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        professional_id TEXT,
        professional_name_snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'draft',    -- draft | signed
        subjective TEXT,                          -- S: queixa/história do paciente
        objective TEXT,                           -- O: exame físico/mensurações
        assessment TEXT,                          -- A: hipótese diagnóstica
        plan TEXT,                                -- P: conduta/receita/retorno
        form_data TEXT,                           -- JSON extensível (Fatia 1b: ficha por especialidade)
        created_by TEXT,
        signed_by TEXT,
        signed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, appointment_id)
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_encounters_patient ON clinical_encounters (organization_id, contact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_encounters_prof ON clinical_encounters (organization_id, professional_id, created_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_encounters', e); }

  // Histórico versionado do prontuário (padrão product_edit_history).
  // Cada UPDATE registra o diff, mesmo depois de signed (addendum),
  // pra auditoria clínica ficar rastreável.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_encounter_history (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        changed_by TEXT,
        changed_fields_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_encounter_history ON clinical_encounter_history (organization_id, encounter_id, created_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_encounter_history', e); }

  // Addendum ao prontuário assinado (ADR-080 Fase 20). CFM 1.821/2007 exige
  // que o prontuário original NÃO seja modificado após finalizado — mas o
  // profissional precisa poder acrescentar informação relevante que apareceu
  // depois (resultado de exame, correção de erro material, evolução tardia).
  // Solução: encounter `signed` continua imutável; addendum é APPEND-ONLY,
  // sempre com autoria e timestamp próprios. Nunca UPDATE nem DELETE de row.
  // Só permitido em encounter `signed` (draft o profissional edita direto).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_encounter_addendums (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        author_id TEXT,
        author_name_snapshot TEXT,
        note TEXT NOT NULL,
        signed_with_pin INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_addendums_encounter ON clinical_encounter_addendums (organization_id, encounter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_addendums_patient ON clinical_encounter_addendums (organization_id, contact_id, created_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_encounter_addendums', e); }

  // Recomendação de retorno (ADR-080 Fase I) — profissional marca "voltar em
  // X dias" no plano; a secretaria confirma o agendamento depois. Aditivo,
  // opcional (encounter sem recomendação = alta / caso encerrado).
  try { db.exec(`ALTER TABLE clinical_encounters ADD COLUMN follow_up_recommended_days INTEGER`); } catch(e){}

  // Lembrete automático de consulta (ADR-080 Fase M). Dedup por
  // (org, appointment, template_key): mesmo lembrete de 24h só sai UMA vez
  // por consulta, mesmo que o Scheduler rode várias vezes na janela. Não
  // usa UNIQUE INDEX pra permitir tentativas failed serem reenviadas — a
  // dedup é no service (skip se já existe row `sent` com mesmo template).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_appointment_reminders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        appointment_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        to_identifier TEXT NOT NULL,
        template_key TEXT NOT NULL DEFAULT '24h',
        status TEXT NOT NULL,             -- queued | sent | failed
        provider_message_id TEXT,
        error TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_reminders_appt ON clinical_appointment_reminders (organization_id, appointment_id, template_key, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_reminders_patient ON clinical_appointment_reminders (organization_id, contact_id, sent_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_appointment_reminders', e); }
  // Config por org — quantas horas antes o lembrete deve sair (default 24).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_reminder_hours INTEGER DEFAULT 24`); } catch(e){}
  // Segundo lembrete "H-2" (ADR-080 Fase S) — só sai se paciente NÃO
  // confirmou o primeiro. Escalada em H-1: se ainda não respondeu, marca
  // a consulta pra recepção ligar (needs_manual_confirmation=1).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_second_reminder_hours INTEGER DEFAULT 2`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_second_reminder_enabled INTEGER DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN needs_manual_confirmation INTEGER DEFAULT 0`); } catch(e){}
  // Retenção LGPD (ADR-080 Fase U). LGPD Art.16 exige eliminar dado quando
  // cumprida a finalidade. Apagamos ARQUIVOS derivados (PDFs de WhatsApp são
  // cache — paciente já tem cópia; anexos velhos após 2 anos). Nunca DELETE
  // de row clínica (prontuário/receita/atestado ficam por 20 anos conforme
  // resolução CFM); só marcamos `purged_at` pra rastreio.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_retention_days_deliveries INTEGER DEFAULT 30`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_retention_days_attachments INTEGER DEFAULT 730`); } catch(e){} // 2 anos
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_retention_enabled INTEGER DEFAULT 1`); } catch(e){}
  // Nota: ALTER TABLE clinical_document_deliveries ADD COLUMN file_purged_at
  // e clinical_encounter_attachments ADD COLUMN purged_at ficam DEPOIS dos
  // CREATEs dessas tabelas (padrão pego nas Fases L/T — ver mais abaixo).

  // Portal do Paciente (ADR-080 Fase L) — molde do portal do profissional
  // (professional_portal_tokens): token opaco de 32 bytes, no banco só o hash
  // SHA-256 + expiração. Um paciente pode ter múltiplos tokens ativos (ex.:
  // gerou pra celular, gerou pra tablet do familiar); revogação individual.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS patient_portal_tokens (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        expires_at DATETIME,
        last_access_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_patient_portal_hash ON patient_portal_tokens (token_hash);
      CREATE INDEX IF NOT EXISTS idx_patient_portal_contact ON patient_portal_tokens (organization_id, contact_id, active);
    `);
  } catch (e) { console.error('[DB] Falha ao criar patient_portal_tokens', e); }

  // Envio de docs clínicos por canal (ADR-080 Fase K). Histórico de tentativas
  // — dado sensível transita por WhatsApp com URL assinada (HMAC + exp curto).
  // status: queued | sent | failed. `provider_message_id` quando o provider
  // devolve id (útil pra rastrear entrega no BSP). `to_identifier` snapshot
  // do número (paciente pode trocar de telefone; o histórico congela).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_document_deliveries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        doc_kind TEXT NOT NULL,           -- prescription | certificate
        doc_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        to_identifier TEXT NOT NULL,
        status TEXT NOT NULL,             -- queued | sent | failed
        provider_message_id TEXT,
        error TEXT,
        sent_by TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_deliveries_doc ON clinical_document_deliveries (organization_id, doc_kind, doc_id, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_deliveries_patient ON clinical_document_deliveries (organization_id, contact_id, sent_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_document_deliveries', e); }
  // Retenção LGPD (ADR-080 Fase U). Marca quando o PDF derivado foi apagado
  // do disco. Sempre depois do CREATE — mesmo padrão pego nas Fases L/T.
  try { db.exec(`ALTER TABLE clinical_document_deliveries ADD COLUMN file_purged_at DATETIME`); } catch(e){}

  // Anexos ao prontuário (ADR-080 Fase J). Dado sensível de saúde (LGPD
  // Art.11) — arquivo físico fica em PRIVATE_MEDIA_DIR (fora do
  // /media estático), acessível só via rota autenticada com streaming.
  // storage_key é o basename do arquivo (uuid+ext), evita path traversal.
  // Bloqueio de delete pós-signed é policy do service; o DB não impõe pra
  // permitir purge de retenção sem knowing do status.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_encounter_attachments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        appointment_id TEXT,
        contact_id TEXT NOT NULL,
        label TEXT,                       -- rótulo curto ("Ferida antes", "Raio-X esquerdo")
        kind TEXT NOT NULL,               -- image | pdf | other (derivado do mime)
        mime_type TEXT NOT NULL,
        original_filename TEXT,
        storage_key TEXT NOT NULL,        -- basename do arquivo em PRIVATE_MEDIA_DIR
        size_bytes INTEGER NOT NULL,
        uploaded_by TEXT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_attach_encounter ON clinical_encounter_attachments (organization_id, encounter_id, uploaded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_attach_patient ON clinical_encounter_attachments (organization_id, contact_id, uploaded_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_encounter_attachments', e); }
  // Compartilhar anexo com paciente (ADR-080 Fase L) — default: NÃO compartilha.
  // Profissional marca por anexo o que o paciente vê no portal (exames que ele
  // trouxe, imagens de evolução compartilháveis). Foto de tratamento interno
  // (ex.: procedimento estético em progresso) fica invisível por default.
  try { db.exec(`ALTER TABLE clinical_encounter_attachments ADD COLUMN share_with_patient INTEGER DEFAULT 0`); } catch(e){}
  // Retenção LGPD (ADR-080 Fase U). Marca quando o arquivo foi apagado.
  try { db.exec(`ALTER TABLE clinical_encounter_attachments ADD COLUMN purged_at DATETIME`); } catch(e){}

  // Receita + Atestado (ADR-080 Fase H) — documentos clínicos emitidos a partir
  // de um encounter. Ciclo draft → issued (imutável após issued). Snapshots
  // próprios do profissional (nome + registro + conselho) — não puxa do
  // encounter porque encounter não guarda registro; e mesmo se guardasse,
  // documento emitido tem que congelar seu próprio estado.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_prescriptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        appointment_id TEXT,
        contact_id TEXT NOT NULL,
        professional_id TEXT,
        professional_name_snapshot TEXT,
        professional_registration_snapshot TEXT,
        professional_council_snapshot TEXT,
        header_notes TEXT,                          -- observações no topo (opcional)
        items_json TEXT NOT NULL,                   -- [{drug,dosage,quantity,instructions,tarja?}]
        repeats_allowed INTEGER NOT NULL DEFAULT 0, -- 0 = uso único
        valid_until DATE,                           -- opcional (receita controle vale 30 dias etc.)
        status TEXT NOT NULL DEFAULT 'draft',       -- draft | issued
        issued_by TEXT,
        issued_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_prescriptions_encounter ON clinical_prescriptions (organization_id, encounter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_prescriptions_patient ON clinical_prescriptions (organization_id, contact_id, created_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_prescriptions', e); }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_medical_certificates (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        appointment_id TEXT,
        contact_id TEXT NOT NULL,
        professional_id TEXT,
        professional_name_snapshot TEXT,
        professional_registration_snapshot TEXT,
        professional_council_snapshot TEXT,
        cid TEXT,                                    -- CID-10 (opcional — atestado sem CID é comum)
        cid_description TEXT,
        days INTEGER NOT NULL DEFAULT 1,             -- dias de afastamento (mínimo 1)
        purpose TEXT NOT NULL DEFAULT 'rest',        -- rest | comparecimento | other
        notes TEXT,                                  -- corpo livre
        status TEXT NOT NULL DEFAULT 'draft',        -- draft | issued
        issued_by TEXT,
        issued_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_certificates_encounter ON clinical_medical_certificates (organization_id, encounter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_certificates_patient ON clinical_medical_certificates (organization_id, contact_id, created_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_medical_certificates', e); }
  // Rastro de emissão assistida por PIN (ADR-080 Fase T). Sempre depois
  // dos CREATEs acima — em banco novo o CREATE roda primeiro; em banco
  // existente o ALTER adiciona a coluna (idempotente pelo try/catch).
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN signed_with_pin INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_medical_certificates ADD COLUMN signed_with_pin INTEGER DEFAULT 0`); } catch(e){}

  // Assinatura visível no PDF (ADR-080 Fase 16). Hash SHA-256 do conteúdo
  // canônico congelado no momento da emissão + timestamp em ISO. Aparecem
  // no rodapé do PDF pra permitir que fiscalização/paciente confira a
  // integridade sem depender do backend. Timestamp separado do issued_at
  // pra permitir renderização em qualquer timezone sem reler o DB.
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN signature_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN signature_timestamp DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_medical_certificates ADD COLUMN signature_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_medical_certificates ADD COLUMN signature_timestamp DATETIME`); } catch(e){}

  // Alerta de alergia gravado na receita (ADR-080 Fase 25). JSON com
  // {alerts: [{substance, severity, matchedItem}]}; mild/moderate passam mas
  // ficam na row (rastro pro auditor); severe só entra com force:true (nesse
  // caso `allergy_alert_forced=1` também é gravado). NULL quando checagem
  // devolveu vazio. SEMPRE depois do CREATE de clinical_prescriptions.
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN allergy_warnings TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN allergy_alert_forced INTEGER DEFAULT 0`); } catch(e){}

  // Snapshots imutáveis de nome do paciente e nome do negócio (ADR-080 Fase 29).
  // Fecha bug documentado: `computeDocumentHash` incluía `patientName` derivado
  // de lookup live no PDF. Se o gestor renomeasse o contato depois, o PDF
  // renderizava com o nome novo mas o hash não recomputava — quebrava
  // conferência de integridade. Snapshot no issue → PDF re-lê snapshot → hash
  // bate. Prescription + Certificate ganham as duas colunas; Receipt já tem
  // `patient_name_snapshot` e `business_name_snapshot` desde a Fase 27.
  // ALTER SEMPRE depois do CREATE das tabelas (padrão L/T/U).
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN patient_name_snapshot TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_prescriptions ADD COLUMN business_name_snapshot TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_medical_certificates ADD COLUMN patient_name_snapshot TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE clinical_medical_certificates ADD COLUMN business_name_snapshot TEXT`); } catch(e){}

  // Recibo particular (ADR-080 Fase 27). Consulta particular (fora de convênio)
  // gera recibo PDF do valor pago. Molde de `clinical_prescriptions` — mesmo
  // ciclo draft → issued imutável, mesmos snapshots do profissional, mesma
  // assinatura visível (hash SHA-256 + timestamp da Fase 16) quando PIN. Valor
  // em CENTAVOS (INTEGER) — nunca float, evita erro de arredondamento clássico
  // em dinheiro. `payment_method` whitelist: pix|debit|credit|cash|transfer|
  // other. Dados fiscais opcionais (paciente/negócio) — recibo simples sem
  // esses campos é o caso comum; MEI/PJ preenche pra usar em contabilidade.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinical_receipts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        encounter_id TEXT NOT NULL,
        appointment_id TEXT,
        contact_id TEXT NOT NULL,
        professional_id TEXT,
        professional_name_snapshot TEXT,
        professional_registration_snapshot TEXT,
        professional_council_snapshot TEXT,
        business_name_snapshot TEXT,                 -- congelado no issue
        business_document_snapshot TEXT,             -- CNPJ/CPF do prestador
        business_document_type_snapshot TEXT,        -- 'cnpj' | 'cpf'
        patient_name_snapshot TEXT,                  -- congelado no issue
        patient_document TEXT,                       -- CPF do paciente (opcional)
        patient_document_type TEXT,                  -- 'cpf' (por ora só cpf)
        amount_cents INTEGER NOT NULL,               -- SEMPRE em centavos
        payment_method TEXT NOT NULL,                -- pix|debit|credit|cash|transfer|other
        description TEXT,                            -- ex.: "Consulta clínica particular"
        notes TEXT,                                  -- observação livre
        status TEXT NOT NULL DEFAULT 'draft',        -- draft | issued
        signed_with_pin INTEGER NOT NULL DEFAULT 0,
        signature_hash TEXT,
        signature_timestamp DATETIME,
        issued_by TEXT,
        issued_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinical_receipts_encounter ON clinical_receipts (organization_id, encounter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clinical_receipts_patient ON clinical_receipts (organization_id, contact_id, created_at DESC);
    `);
  } catch (e) { console.error('[DB] Falha ao criar clinical_receipts', e); }
  // Pré-preenchimento do documento do negócio no recibo — evita a clínica
  // digitar o CNPJ toda vez. Só o TIPO e o NÚMERO (default do fluxo); o
  // `businessName` do recibo puxa do `organization_settings.business_name`
  // que já existe. Ambos opcionais — clínica que não quer emitir com CNPJ
  // (ex.: profissional pessoa física) deixa em branco e o campo fica NULL
  // no recibo.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_receipt_business_document TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN clinic_receipt_business_document_type TEXT`); } catch(e){}

  // Módulo Clínica (ADR-080, Fase D) — Portal do Profissional por link seguro.
  // Molde do Radar público: token aleatório forte, guardado só como hash
  // SHA-256, com expiração. O link dá acesso SOMENTE à agenda do próprio
  // profissional (sem financeiro, configurações ou outros profissionais).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS professional_portal_tokens (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        expires_at DATETIME,
        last_access_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_portal_tokens_hash ON professional_portal_tokens (token_hash);
      CREATE INDEX IF NOT EXISTS idx_portal_tokens_prof ON professional_portal_tokens (organization_id, professional_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tokens do portal (Clínica)', e); }

  // Módulo Clínica (ADR-080, Fase E) — Convênios e Autorização assistida.
  // MVP manual: registro + máquina de status + checklist + protocolo. TISS
  // XML/WebService/API fica para a Fase F (ADR próprio). Credenciais da
  // operadora cifradas com EncryptionService.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_plan_operators (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        ans_registry TEXT,
        connector_type TEXT DEFAULT 'manual', -- manual | tiss_xml | tiss_webservice | api (só 'manual' no MVP)
        portal_url TEXT,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_health_operators_org ON health_plan_operators (organization_id, active);

      CREATE TABLE IF NOT EXISTS health_plan_credentials (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        provider_code TEXT,
        username_encrypted TEXT,   -- EncryptionService.encrypt
        password_encrypted TEXT,   -- EncryptionService.encrypt
        certificate_ref TEXT,      -- referência ao certificado (armazenado fora), Fase F
        config_json TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, operator_id)
      );

      CREATE TABLE IF NOT EXISTS clinic_procedures (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        tuss_code TEXT,
        default_duration_minutes INTEGER DEFAULT 60,
        requires_authorization INTEGER DEFAULT 0,
        requires_medical_request INTEGER DEFAULT 0,
        preparation_instructions TEXT,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_procedures_org ON clinic_procedures (organization_id, active);

      CREATE TABLE IF NOT EXISTS procedure_authorization_requests (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        appointment_id TEXT,
        operator_id TEXT,
        procedure_id TEXT,
        tuss_code TEXT,
        requested_by TEXT,
        status TEXT DEFAULT 'draft', -- draft|ready_to_submit|submitted|pending_documents|pending_operator|approved|denied|expired|cancelled|manual_required
        protocol_number TEXT,
        authorization_number TEXT,
        denial_reason TEXT,
        pending_requirements TEXT,   -- checklist do que falta (texto/JSON)
        plan_snapshot TEXT,          -- plano do paciente CONGELADO no momento (D6)
        submitted_at DATETIME,
        approved_at DATETIME,
        denied_at DATETIME,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_auth_requests_org ON procedure_authorization_requests (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_auth_requests_contact ON procedure_authorization_requests (organization_id, contact_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar Convênios/Autorização (Clínica)', e); }
  // Vínculo do agendamento com autorização/procedimento + snapshot do plano (D6).
  try { db.exec(`ALTER TABLE appointments ADD COLUMN authorization_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN procedure_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN patient_plan_snapshot TEXT`); } catch(e){}

  // Aditivos p/ Jornada de Tratamento (ADR-145 D1/D3, Fatia 37). Amarram
  // o appointment ao episódio de cuidado e à especialidade — quando o
  // appointment nasce a partir de um episódio (fluxo Adicionar Especialidade),
  // essas colunas preenchem automaticamente e o gate EPISODE_PROFESSIONAL_
  // MISMATCH garante que o profissional agendado é o mesmo do episódio.
  // Nullable: appointments legados (sem episódio) continuam operando
  // normalmente — compat 100%. professional_override_reason só entra
  // quando force=true bypassa o gate (padrão Fase 31), preservando motivo
  // pra auditoria.
  try { db.exec(`ALTER TABLE appointments ADD COLUMN care_episode_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN specialty_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE appointments ADD COLUMN professional_override_reason TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_appointments_episode ON appointments (organization_id, care_episode_id) WHERE care_episode_id IS NOT NULL`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_appointments_specialty ON appointments (organization_id, specialty_id) WHERE specialty_id IS NOT NULL`); } catch(e){}

  // Módulo Clínica (ADR-081, Fase F0) — Onboarding de Conexão TISS. A clínica
  // preenche o questionário no próprio sistema (self-service); o backend valida
  // os itens BLOQUEANTES e calcula a prontidão por operadora. Perfil no nível da
  // organização (1:1); prontidão por operadora nas colunas de health_plan_operators.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_connection_profile (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL UNIQUE,
        legal_name TEXT,
        cnpj TEXT,
        cnes TEXT,
        certificate_type TEXT DEFAULT 'unknown', -- unknown | none | a1 | a3
        certificate_valid_until DATETIME,
        responsible_name TEXT,
        responsible_registry TEXT,   -- conselho + número + UF (ex.: CRM 12345/RJ)
        monthly_authorizations INTEGER,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar perfil de conexão (Clínica)', e); }
  // Prontidão por operadora (respostas do questionário, nível operadora).
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN credentialed INTEGER DEFAULT 0`); } catch(e){}          // clínica credenciada
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN provider_code TEXT`); } catch(e){}                     // código do prestador
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN has_homolog_access INTEGER DEFAULT 0`); } catch(e){}   // acesso ao ambiente de homologação
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN tiss_version TEXT`); } catch(e){}                      // versão TISS aceita
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN accepts_webservice INTEGER DEFAULT 0`); } catch(e){}   // aceita WebService (Nível 3) vs só portal (Nível 2)
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN monthly_volume INTEGER`); } catch(e){}                 // volume mensal nessa operadora
  try { db.exec(`ALTER TABLE health_plan_operators ADD COLUMN unimed_singular TEXT`); } catch(e){}                   // qual singular (Unimed é federada)
  // Hotelaria — captura estruturada da reserva (adultos/crianças/pet/orçamento/pedidos).
  try { db.exec(`ALTER TABLE reservations ADD COLUMN adults INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE reservations ADD COLUMN children INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE reservations ADD COLUMN pets INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE reservations ADD COLUMN special_requests TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE reservations ADD COLUMN budget REAL`); } catch(e){}
  // Assinaturas / cobrança recorrente (mensalidade, plano, clube).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        amount REAL DEFAULT 0,
        interval TEXT DEFAULT 'monthly',      -- monthly | weekly | yearly
        interval_count INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        status TEXT DEFAULT 'active',          -- active | paused | past_due | cancelled
        amount REAL DEFAULT 0,
        interval TEXT DEFAULT 'monthly',
        interval_count INTEGER DEFAULT 1,
        start_date DATETIME,
        next_charge_at DATETIME,
        last_charge_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_due
        ON subscriptions(organization_id, status, next_charge_at);
      CREATE TABLE IF NOT EXISTS subscription_invoices (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        contact_id TEXT,
        amount REAL DEFAULT 0,
        due_date DATETIME,
        period_start DATETIME,
        period_end DATETIME,
        status TEXT DEFAULT 'pending',         -- pending | paid | overdue | cancelled
        charge_ref TEXT,
        paid_at DATETIME,
        reminder_status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sub_invoices
        ON subscription_invoices(organization_id, subscription_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de assinaturas', e); }
  // Conhecimento (RAG) por área de atendimento (null = geral, todas as áreas).
  try { db.exec(`ALTER TABLE knowledge_documents ADD COLUMN area_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE knowledge_chunks ADD COLUMN area_id TEXT`); } catch(e){}
  // Coleções manuais: lista ordenada de IDs de produto escolhidos a dedo.
  try { db.exec(`ALTER TABLE storefront_collections ADD COLUMN items_json TEXT`); } catch(e){}
  // Itens de pedido guardam a opção escolhida (tamanho/peso) para histórico.
  try { db.exec(`ALTER TABLE order_items ADD COLUMN variant_label TEXT`); } catch(e){}

  // Agenda — disponibilidade/regra de marcação (defaults: Seg–Sex 08–18, slots
  // de 60min, 1 atendimento por horário). A IA só oferece horários livres e o
  // servidor nunca permite dois clientes no mesmo dia+horário.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN agenda_open_hour INTEGER DEFAULT 8`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN agenda_close_hour INTEGER DEFAULT 18`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN agenda_slot_minutes INTEGER DEFAULT 60`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN agenda_days TEXT DEFAULT '1,2,3,4,5'`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN agenda_capacity INTEGER DEFAULT 1`); } catch(e){}

  // ===== Revenue Intelligence Center (RIC) =====
  // Configuração por organização da engine de Perda Estimada e dos pesos do IQR.
  // Defaults conservadores: melhor subestimar do que inflar — número inflado mata
  // a credibilidade da auditoria com a diretoria.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revenue_intelligence_config (
        organization_id TEXT PRIMARY KEY,
        -- Probabilidades de PERDA por fonte (0.0 a 1.0).
        prob_lead_slow_response REAL DEFAULT 0.35,   -- lead novo sem resposta rápida
        prob_quote_no_response REAL DEFAULT 0.50,    -- orçamento enviado sem retorno
        prob_abandoned REAL DEFAULT 0.60,            -- carrinho/conversa abandonada
        prob_inactive REAL DEFAULT 0.40,             -- cliente inativo (+60d) com histórico
        -- Janela (horas) que define cada fonte.
        slow_response_seconds INTEGER DEFAULT 300,   -- 1ª resposta acima disto = lento
        quote_stale_hours INTEGER DEFAULT 72,        -- orçamento sem retorno > X horas
        inactive_days INTEGER DEFAULT 60,            -- cliente inativo > X dias
        -- Janela de atribuição do RRI (dias).
        attribution_window_days INTEGER DEFAULT 14,
        -- Ticket médio fixo (R$) p/ override. NULL = usa AOV histórico do tenant.
        custom_ticket_amount REAL,
        -- Pesos do IQR (somam 100). Padrão equilibrado.
        weight_atendimento INTEGER DEFAULT 40,
        weight_comercial INTEGER DEFAULT 40,
        weight_operacional INTEGER DEFAULT 20,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar revenue_intelligence_config', e); }

  // RIC — ações de recuperação (loop fechado): cada ação dispara uma campanha
  // de recuperação (rascunho) para os contatos de uma fonte de perda e, depois,
  // recebe a atribuição da receita recuperada (pedidos pagos na janela).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ric_recovery_actions (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        source_key TEXT,              -- slow_response | stale_quotes | abandoned | inactive
        label TEXT,
        contacts_count INTEGER DEFAULT 0,
        campaign_id TEXT,
        action_type TEXT DEFAULT 'campaign',
        status TEXT DEFAULT 'created', -- created | sent | converted | dismissed
        recovered_orders INTEGER DEFAULT 0,
        recovered_amount REAL DEFAULT 0,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ric_actions_org ON ric_recovery_actions (organization_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar ric_recovery_actions', e); }

  // Execution Intelligence v1 — tarefas internas (delegação à equipe) + trilha
  // de acompanhamento. Núcleo da camada de execução (Coordenador IA na Fase 2).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to TEXT,                 -- user responsável (NULL = sem dono)
        created_by TEXT,
        priority TEXT DEFAULT 'media',    -- baixa | media | alta
        status TEXT DEFAULT 'a_fazer',    -- a_fazer | fazendo | feito | cancelada
        due_at DATETIME,
        source TEXT DEFAULT 'manual',     -- manual | ric | ia
        contact_id TEXT,                  -- vínculo opcional a um cliente
        ticket_id TEXT,                   -- vínculo opcional a uma conversa
        ref_label TEXT,                   -- rótulo livre (ex.: "Orçamento #41")
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_org_status ON tasks (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee ON tasks (organization_id, assigned_to);

      CREATE TABLE IF NOT EXISTS task_updates (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        organization_id TEXT,
        author_user_id TEXT,
        kind TEXT DEFAULT 'note',         -- note | status_change | assign
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_task_updates_task ON task_updates (task_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tasks', e); }

  // Coordenador IA (Fase 2) — marca um canal como INTERNO (número da equipe).
  // 'client' (padrão) = atendimento ao cliente; 'internal' = voz interna.
  try { db.exec(`ALTER TABLE channels ADD COLUMN kind TEXT DEFAULT 'client'`); } catch(e){}

  // Execution Intelligence (Fase 3) — alocação de recursos por tarefa + Maestro.
  try { db.exec(`ALTER TABLE tasks ADD COLUMN budget_amount REAL DEFAULT 0`); } catch(e){}
  // Tarefa com RESULTADO medido + EVIDÊNCIA (ADR-134): problema (baseline) →
  // resultado (final) e a foto/relatório que comprova a execução.
  try { db.exec(`ALTER TABLE tasks ADD COLUMN result_label TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN result_baseline REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN result_final REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN evidence_url TEXT`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_resources (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        organization_id TEXT,
        kind TEXT,             -- material | financeiro
        product_id TEXT,       -- opcional (quando material referencia um produto)
        label TEXT,
        quantity REAL DEFAULT 1,
        amount REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_task_resources_task ON task_resources (task_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar task_resources', e); }
  // Maestro: criar tarefa automática quando um atendimento é repassado p/ humano (opt-in).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_task_on_handoff INTEGER DEFAULT 0`); } catch(e){}
  // Maestro: criar tarefa automática quando um evento Vision VMS de severidade
  // alta/crítica é detectado (opt-in, mesmo padrão de auto_task_on_handoff).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN vision_auto_task_enabled INTEGER DEFAULT 0`); } catch(e){}

  // Prospect AI (Fase 0) — Inteligência de Prospecção B2B. Fundação: ICP +
  // campanhas em rascunho. Contas/contatos/evidências/score/outreach entram nos
  // PRs seguintes. Tudo aditivo, atrás do módulo opcional 'prospect'.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_icp_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        name TEXT NOT NULL,
        vertical TEXT,
        criteria_json TEXT,       -- JSON: região, porte, sinais, exclusões, dores, oferta, CTA...
        status TEXT DEFAULT 'active',  -- active | archived
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_icp_org ON prospect_icp_profiles (organization_id, status);

      CREATE TABLE IF NOT EXISTS prospect_campaigns (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        icp_id TEXT,
        name TEXT NOT NULL,
        objective TEXT,           -- reuniao | diagnostico | evento | proposta
        status TEXT DEFAULT 'draft',   -- draft | active | paused | completed | archived
        budget_limit_brl REAL DEFAULT 0,
        daily_contact_limit INTEGER DEFAULT 0,
        approval_mode TEXT DEFAULT 'manual',  -- manual | manager | auto_rules
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_campaigns_org ON prospect_campaigns (organization_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas do Prospect AI', e); }

  // Prospect AI (Fase 1) — contas/contatos B2B + registro de fonte (origem +
  // política). Camada PARALELA ao CRM (contato-cêntrico): promove para o CRM
  // só ao qualificar, sem mexer no atendimento atual.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_data_sources (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        provider TEXT,            -- csv_import | user_input | licensed_provider | places_live ...
        source_reference TEXT,    -- nome do arquivo / URL / id
        terms_profile TEXT,       -- user_provided | licensed | public ...
        collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        retention_policy TEXT,
        confidence REAL DEFAULT 1.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS prospect_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        campaign_id TEXT,
        crm_contact_id TEXT,      -- preenchido ao promover para o CRM
        display_name TEXT,
        legal_name TEXT,
        domain TEXT,
        website_url TEXT,
        industry TEXT,
        city TEXT,
        state TEXT,
        country TEXT,
        cnpj TEXT,
        source_id TEXT,
        source TEXT,              -- csv_import | user_input ...
        account_status TEXT DEFAULT 'discovered',  -- discovered|researching|qualified|disqualified|contacted|converted
        dedupe_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_accounts_org ON prospect_accounts (organization_id, account_status);
      CREATE INDEX IF NOT EXISTS idx_prospect_accounts_dedupe ON prospect_accounts (organization_id, dedupe_key);

      CREATE TABLE IF NOT EXISTS prospect_contacts (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        prospect_account_id TEXT,
        crm_contact_id TEXT,
        full_name TEXT,
        role_title TEXT,
        email TEXT,
        email_status TEXT DEFAULT 'unknown',  -- unknown|publicly_listed|pattern_generated|provider_verified|invalid|suppressed|opted_out
        phone TEXT,
        linkedin_url TEXT,
        source_id TEXT,
        confidence REAL DEFAULT 0.5,
        opt_out_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_contacts_acc ON prospect_contacts (organization_id, prospect_account_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar contas/contatos do Prospect AI', e); }

  // Prospect AI (Fase 1, item 2) — ledger de evidências, hipóteses de dor e
  // snapshots de score. Evidência ≠ hipótese (princípio do PRD).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_signals (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        prospect_account_id TEXT,
        signal_type TEXT,          -- cobertura_digital | complexidade_operacional | oferta | crescimento | conteudo_proprio | resposta_comercial | outro
        observation TEXT,          -- dado observado
        evidence_reference TEXT,   -- URL / origem / nota
        confidence REAL DEFAULT 0.6,
        source_kind TEXT DEFAULT 'user',  -- user | connector | ai
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_signals_acc ON prospect_signals (organization_id, prospect_account_id);

      CREATE TABLE IF NOT EXISTS prospect_hypotheses (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        prospect_account_id TEXT,
        hypothesis TEXT,           -- em linguagem probabilística
        evidence_refs TEXT,        -- JSON com as observações usadas
        recommended_question TEXT,
        related_capability TEXT,   -- RIC, CRM, Copiloto...
        confidence TEXT DEFAULT 'media',  -- baixa | media | alta
        status TEXT DEFAULT 'draft',      -- draft | approved | rejected
        created_by_type TEXT DEFAULT 'ai',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_hyp_acc ON prospect_hypotheses (organization_id, prospect_account_id);

      CREATE TABLE IF NOT EXISTS prospect_score_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        prospect_account_id TEXT,
        account_fit REAL, pain_evidence REAL, reachability REAL,
        data_confidence REAL, compliance REAL, priority REAL,
        explanation_json TEXT,
        calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_scores_acc ON prospect_score_snapshots (organization_id, prospect_account_id, calculated_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar evidências/hipóteses/score do Prospect AI', e); }

  // Prospect AI (Fase 1, item 3) — abordagens (outreach) + fila de aprovação.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_outreach (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        campaign_id TEXT,
        prospect_account_id TEXT,
        contact_id TEXT,
        channel TEXT DEFAULT 'email',   -- email | whatsapp | call | linkedin_manual
        subject TEXT,
        body TEXT,
        evidence_snapshot TEXT,         -- JSON: evidências/hipóteses usadas
        status TEXT DEFAULT 'draft',    -- draft | pending_approval | approved | rejected | sent
        created_by TEXT,
        approved_by TEXT,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_outreach_org ON prospect_outreach (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_prospect_outreach_acc ON prospect_outreach (organization_id, prospect_account_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar outreach do Prospect AI', e); }

  // Prospect AI (Fase 1, item 4) — atribuição de receita originada pela
  // prospecção. Valor REAL informado pelo SDR ao fechar a conta (não mexe na
  // estimativa do RIC). 'won_*' = ganho; 'lost_reason' = motivo da perda.
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN won_value REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN won_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN lost_reason TEXT`); } catch(e){}

  // Prospect AI (Fase 2) — DESCOBERTA AUTOMÁTICA por região (fontes públicas:
  // OpenStreetMap/Overpass + geocodificação Nominatim). Configurada por campanha:
  // ponto de referência (endereço/CEP → lat/lon) + raio. Varredura noturna.
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_address TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_lat REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_lon REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_radius_km REAL DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_categories TEXT`); } catch(e){} // CSV de categorias OSM (vazio = amplo)
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_last_run DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_source TEXT DEFAULT 'osm'`); } catch(e){} // osm | google_places
  // Maestro fecha o ciclo (OPT-IN, desligado por padrão): após descobrir, já
  // prepara um rascunho de abordagem por conta com contato e o envia para a fila.
  try { db.exec(`ALTER TABLE prospect_campaigns ADD COLUMN discovery_autodraft INTEGER DEFAULT 0`); } catch(e){}
  // Chave da Google Places API (New) por organização (premium: telefone + avaliações).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN prospect_places_api_key TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN external_ref TEXT`); } catch(e){} // ex.: osm:node/123 (dedup da descoberta)
  // Prospect AI (ADR-079, Fase A — conformidade/LGPD): bloqueio de contato no
  // nível da EMPRESA. Conta bloqueada não recebe abordagem nova nem envio.
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN blocked_at DATETIME`); } catch(e){}

  // Prospect AI (ADR-079, Fase B — execução e medição): envio real, resposta,
  // reunião e conversão para o CRM. `prospect_events` é a fonte das métricas
  // dos experimentos (Fase C) — sem medição não há Research Engine.
  try { db.exec(`ALTER TABLE prospect_outreach ADD COLUMN sent_via TEXT`); } catch(e){}              // manual | whatsapp | email
  try { db.exec(`ALTER TABLE prospect_outreach ADD COLUMN provider_message_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_outreach ADD COLUMN replied_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN meeting_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_accounts ADD COLUMN crm_ticket_id TEXT`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        event_type TEXT NOT NULL,       -- message.sent | lead.replied | meeting.created | lead.converted
        campaign_id TEXT,
        prospect_account_id TEXT,
        contact_id TEXT,
        outreach_id TEXT,
        payload_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_events_org_type ON prospect_events (organization_id, event_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_prospect_events_acc ON prospect_events (organization_id, prospect_account_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar prospect_events', e); }

  // Prospect AI (ADR-079, Fase C — Research Engine): variantes de mensagem,
  // experimentos com ORÇAMENTO FIXO pré-declarado (amostra + janela, decisão
  // só no fim — sem "espiar") e snapshot de resultados. Champion/challenger:
  // a variante vencedora vigente da campanha carrega is_champion = 1.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_message_variants (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        campaign_id TEXT,
        experiment_id TEXT,
        name TEXT NOT NULL,
        hypothesis TEXT,
        channel TEXT DEFAULT 'whatsapp',  -- whatsapp | email
        subject TEXT,
        message_body TEXT NOT NULL,
        tone TEXT,
        cta TEXT,
        is_champion INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',     -- active | retired
        created_by_ai INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_variants_org ON prospect_message_variants (organization_id, campaign_id, status);

      CREATE TABLE IF NOT EXISTS prospect_experiments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        campaign_id TEXT,
        name TEXT NOT NULL,
        hypothesis TEXT,
        variable_under_test TEXT DEFAULT 'message', -- message | channel | niche | timing (UMA por experimento)
        success_metric TEXT DEFAULT 'response_rate', -- response_rate | meeting_rate | conversion_rate
        sample_size INTEGER NOT NULL,                -- orçamento por variante, fixado ANTES de começar
        window_days INTEGER DEFAULT 14,              -- janela de medição
        confidence_z REAL DEFAULT 1.96,              -- limiar do teste de duas proporções (95%)
        status TEXT DEFAULT 'draft',                 -- draft | running | completed
        decision TEXT,                               -- keep | discard | inconclusive
        winner_variant_id TEXT,
        decision_reason TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_experiments_org ON prospect_experiments (organization_id, status);

      CREATE TABLE IF NOT EXISTS prospect_experiment_results (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        experiment_id TEXT NOT NULL,
        variant_id TEXT NOT NULL,
        messages_sent INTEGER DEFAULT 0,
        responses_count INTEGER DEFAULT 0,
        meetings_count INTEGER DEFAULT 0,
        converted_count INTEGER DEFAULT 0,
        response_rate REAL DEFAULT 0,
        meeting_rate REAL DEFAULT 0,
        conversion_rate REAL DEFAULT 0,
        result_status TEXT,               -- keep | discard | inconclusive
        analysis_summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_exp_results ON prospect_experiment_results (organization_id, experiment_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas do Research Engine', e); }
  try { db.exec(`ALTER TABLE prospect_outreach ADD COLUMN variant_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE prospect_outreach ADD COLUMN experiment_id TEXT`); } catch(e){}

  // Prospect AI (ADR-079, Fase D) — memória de aprendizados. ESTRITAMENTE por
  // tenant (D4: sem scope global no MVP). Aprendizado novo do mesmo tipo na
  // mesma campanha SUPERSEDE o anterior (status deprecated) — memória não
  // vira dogma quando um experimento novo contradiz o antigo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_learning_memory (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        scope TEXT DEFAULT 'campaign',        -- campaign | segment | product
        campaign_id TEXT,
        segment TEXT,
        region TEXT,
        channel TEXT,
        learning_type TEXT DEFAULT 'message', -- message | niche | timing | objection | offer
        insight TEXT NOT NULL,
        confidence_score REAL DEFAULT 0.5,
        evidence_json TEXT,
        source_experiment_id TEXT,
        status TEXT DEFAULT 'active',         -- active | deprecated
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_learning_org ON prospect_learning_memory (organization_id, status, learning_type);
    `);
  } catch(e){ console.error('[DB] Falha ao criar prospect_learning_memory', e); }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prospect_discovery_runs (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        campaign_id TEXT,
        area TEXT,                 -- descrição da área (endereço + raio)
        status TEXT DEFAULT 'running',  -- running | done | error
        found_count INTEGER DEFAULT 0,
        created_count INTEGER DEFAULT 0,
        skipped_count INTEGER DEFAULT 0,
        summary TEXT,              -- resumo (IA) do que foi encontrado
        error TEXT,
        trigger TEXT DEFAULT 'scheduler',  -- scheduler | manual
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_discovery_runs_org ON prospect_discovery_runs (organization_id, campaign_id, started_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar discovery runs do Prospect AI', e); }

  // ===== ZappFlow Radar de Execução IA (Fase 1 — fundação) =====
  // Módulo de diagnóstico de maturidade/vazamentos operacionais, atrás do
  // módulo opcional 'radar' (opt-in, ver verticals.ts — mesmo padrão do 'vms':
  // nenhuma vertical liga sozinha). Score é 100% determinístico (motor em
  // RadarService, ver PRD_ZappFlow_Radar_de_Execucao_IA); IA generativa (Fase 4,
  // RadarNarrativeService.ts) nunca decide score/prioridade.
  //
  // organization_id é NULLABLE em radar_sessions/radar_answers/radar_pillar_scores/
  // radar_recommendations/radar_consent_records de propósito: sessões públicas
  // pré-conversão (visitante anônimo, Fase 2 — RadarPublicService.ts) não têm
  // tenant até virarem lead. É a ÚNICA família de tabelas do projeto com essa
  // exceção ao padrão "organization_id NOT NULL" — todo código que lê estas
  // tabelas deve tratar organization_id nulo como "ainda não é de nenhum tenant"
  // e NUNCA usar isso para pular o filtro de tenant quando ele existir.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS radar_templates (
        id TEXT PRIMARY KEY,
        organization_id TEXT,              -- NULL = template global (padrão ZappFlow)
        name TEXT NOT NULL,
        description TEXT,
        segment TEXT,
        session_type TEXT NOT NULL DEFAULT 'quick', -- quick | executive
        is_active INTEGER DEFAULT 1,
        version INTEGER DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_templates_org ON radar_templates(organization_id, is_active);

      CREATE TABLE IF NOT EXISTS radar_questions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        code TEXT NOT NULL,
        pillar TEXT NOT NULL,              -- estrategia|receita|processos|dados|pessoas|governanca|metricas
        title TEXT NOT NULL,
        help_text TEXT,
        answer_type TEXT NOT NULL DEFAULT 'scale', -- scale (0-4, via options_json) | boolean | text
        is_required INTEGER DEFAULT 1,
        display_order INTEGER DEFAULT 0,
        weight REAL DEFAULT 1,
        options_json TEXT,                 -- [{ value, label, score(0-4) }] para answer_type='scale'
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_questions_code ON radar_questions(template_id, code);
      CREATE INDEX IF NOT EXISTS idx_radar_questions_template ON radar_questions(template_id, pillar, display_order);

      CREATE TABLE IF NOT EXISTS radar_sessions (
        id TEXT PRIMARY KEY,
        organization_id TEXT,              -- NULL até virar lead (ver nota acima)
        template_id TEXT NOT NULL,
        session_type TEXT NOT NULL DEFAULT 'quick', -- quick | executive | reassessment
        status TEXT NOT NULL DEFAULT 'draft', -- draft|in_progress|awaiting_review|needs_information|approved|published|archived|expired
        source TEXT DEFAULT 'consultant',  -- landing|consultant|tenant|campaign|api
        company_name TEXT,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        segment TEXT,
        company_size TEXT,
        city TEXT,
        state TEXT,
        primary_goal TEXT,
        consultant_user_id TEXT,
        owner_user_id TEXT,
        consent_version TEXT,
        consent_at DATETIME,
        started_at DATETIME,
        completed_at DATETIME,
        scoring_version INTEGER DEFAULT 1,
        overall_maturity_score REAL,
        execution_gap_index REAL,          -- calculado só a partir da Fase 3 (radar_processes)
        confidence_score REAL,
        maturity_level TEXT,
        next_action TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_sessions_org ON radar_sessions(organization_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS radar_respondents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        organization_id TEXT,
        user_id TEXT,
        name TEXT,
        email TEXT,
        role_title TEXT,
        area TEXT,
        status TEXT DEFAULT 'invited',     -- invited|active|completed|revoked
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_respondents_session ON radar_respondents(session_id);

      -- Anexo de evidência a uma resposta já dada (PRD §7.4 -- reservado desde a
      -- Fase 1, ver comentário em RadarService.saveAnswer). Anexar evidência
      -- sobe a confiança daquela resposta de 0,60/0,75 (declarada) para 0,90
      -- (declarada + evidência) -- RadarService.addEvidence. O nível 1,00
      -- ("baseline medido") continua reservado para quando um pilar for
      -- preenchido a partir de dado medido (ex.: RevenueIntelligenceService),
      -- não implementado aqui.
      CREATE TABLE IF NOT EXISTS radar_evidence (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        organization_id TEXT,
        answer_id TEXT NOT NULL,
        file_url TEXT NOT NULL,
        file_name TEXT,
        mime_type TEXT,
        uploaded_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_evidence_answer ON radar_evidence(answer_id);
      CREATE INDEX IF NOT EXISTS idx_radar_evidence_session ON radar_evidence(session_id);

      CREATE TABLE IF NOT EXISTS radar_answers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        organization_id TEXT,
        question_id TEXT NOT NULL,
        respondent_id TEXT,
        answer_json TEXT NOT NULL,
        score_raw REAL,
        score_normalized REAL,
        confidence_multiplier REAL DEFAULT 0.6,
        is_not_known INTEGER DEFAULT 0,
        comment TEXT,
        answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_answers_session ON radar_answers(session_id, question_id);

      CREATE TABLE IF NOT EXISTS radar_pillar_scores (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        organization_id TEXT,
        pillar TEXT NOT NULL,
        score REAL,
        confidence_score REAL,
        evidence_count INTEGER DEFAULT 0,
        calculation_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_pillar_scores_session ON radar_pillar_scores(session_id, pillar);

      CREATE TABLE IF NOT EXISTS radar_use_case_catalog (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        applicable_segments_json TEXT,
        applicable_areas_json TEXT,
        prerequisites_json TEXT,
        integrations_json TEXT,
        risk_profile TEXT DEFAULT 'medium', -- low|medium|high
        human_review_required INTEGER DEFAULT 1,
        complexity TEXT DEFAULT 'medium',   -- low|medium|high
        duration_days_min INTEGER,
        duration_days_max INTEGER,
        metrics_json TEXT,
        quick_win_steps_json TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_use_case_code ON radar_use_case_catalog(code);

      CREATE TABLE IF NOT EXISTS radar_recommendations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        organization_id TEXT,
        use_case_id TEXT NOT NULL,
        priority_score REAL,
        priority_band TEXT,                -- alta|media|baixa
        impact_score REAL,
        effort_score REAL,
        risk_score REAL,
        readiness_score REAL,
        confidence_score REAL,
        recommendation_status TEXT DEFAULT 'generated', -- generated|reviewed|approved|rejected|implemented|deferred
        rationale_json TEXT,
        prerequisites_json TEXT,
        owner_user_id TEXT,
        target_date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_recommendations_session ON radar_recommendations(session_id, priority_score);

      CREATE TABLE IF NOT EXISTS radar_consent_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        organization_id TEXT,
        consent_type TEXT NOT NULL,        -- diagnostico|contato_comercial|comunicacoes
        legal_basis_label TEXT,
        version TEXT,
        granted INTEGER DEFAULT 1,
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_consent_session ON radar_consent_records(session_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas do Radar de Execução IA', e); }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS radar_consultation_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        contact_name TEXT NOT NULL,
        contact_email TEXT,
        contact_phone TEXT,
        message TEXT,
        overall_score REAL,
        maturity_level TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_consultation_session ON radar_consultation_requests(session_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar radar_consultation_requests', e); }
  // Ligação com o CRM/consultor: quando há uma organização de destino
  // (RADAR_LEADS_ORGANIZATION_ID), a solicitação de consultoria vira uma tarefa
  // de follow-up e passa a ser listável/tratável por essa organização — deixa
  // de ser uma linha morta que ninguém lê. `status` transiciona pending →
  // contacted → closed pelo consultor.
  try { db.exec(`ALTER TABLE radar_consultation_requests ADD COLUMN organization_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE radar_consultation_requests ADD COLUMN task_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE radar_consultation_requests ADD COLUMN handled_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE radar_consultation_requests ADD COLUMN handled_by TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_radar_consultation_org ON radar_consultation_requests(organization_id, status)`); } catch(e){}

  // Seed idempotente do template padrão "Diagnóstico Rápido ZappFlow" (PRD §10,
  // adaptado a perguntas de escala 0-4 diretamente pontuáveis) + catálogo inicial
  // de 12 casos de uso (PRD §12). IDs fixos (não randomUUID) para o INSERT OR
  // IGNORE ser estável entre reinícios — sem isso, cada boot criaria duplicatas.
  try {
    const TEMPLATE_ID = "radar_tpl_diagnostico_rapido_v1";
    db.prepare(
      `INSERT OR IGNORE INTO radar_templates (id, organization_id, name, description, session_type, version)
       VALUES (?, NULL, ?, ?, 'quick', 1)`
    ).run(TEMPLATE_ID, "Diagnóstico Rápido ZappFlow", "Template padrão de 18 perguntas cobrindo os 7 pilares de maturidade (PRD Radar de Execução IA §6/§10).");

    // Rótulos padrão da escala 0-4 (PRD §7): reaproveitados quando a pergunta
    // não precisa de um enunciado mais específico por opção.
    const scale = (labels: [string, string, string, string, string]) =>
      labels.map((label, score) => ({ value: String(score), label, score }));

    type QuestionSeed = { code: string; pillar: string; title: string; helpText: string; order: number; options: { value: string; label: string; score: number }[] };
    const questions: QuestionSeed[] = [
      { code: "q_estrategia_responsavel", pillar: "estrategia", order: 1,
        title: "Existe um responsável claro por liderar as iniciativas de melhoria/IA na empresa?",
        helpText: "Pense em quem toca esse assunto no dia a dia, não só quem 'apoia'.",
        options: scale(["Não há responsável definido", "O dono cuida disso quando sobra tempo", "Há responsável, mas sem tempo/orçamento dedicado", "Há responsável com prioridade e acompanhamento periódico", "Há responsável, meta mensurável e orçamento aprovado"]) },
      { code: "q_estrategia_meta", pillar: "estrategia", order: 2,
        title: "A empresa tem uma meta clara para os próximos 90 dias (vendas, atendimento, organização etc.)?",
        helpText: "Vale qualquer meta de negócio, não precisa ser sobre IA.",
        options: scale(["Não há meta definida", "Existe uma ideia geral, não escrita", "Existe meta, mas sem prazo/indicador claro", "Meta definida com prazo e indicador", "Meta definida, acompanhada e revisada periodicamente"]) },

      { code: "q_receita_tempo_resposta", pillar: "receita", order: 3,
        title: "A empresa mede o tempo de resposta a um novo contato/lead?",
        helpText: "Tempo entre o cliente mandar mensagem e alguém responder.",
        options: scale(["Não mede", "Sabe informalmente, sem números", "Mede às vezes, sem processo formal", "Mede regularmente com um indicador", "Mede em tempo real, com meta e alerta quando atrasa"]) },
      { code: "q_receita_followup", pillar: "receita", order: 4,
        title: "Todo lead recebe follow-up com prazo definido?",
        helpText: "Follow-up = retomar contato com quem ainda não decidiu comprar.",
        options: scale(["Não há follow-up estruturado", "Depende de quem atendeu lembrar", "Existe orientação, mas nem sempre é seguida", "Existe processo com responsável e prazo", "Processo automatizado com lembrete e cobrança de prazo"]) },
      { code: "q_receita_conversas_centralizadas", pillar: "receita", order: 5,
        title: "As conversas com clientes ficam organizadas em um único lugar?",
        helpText: "Ao contrário de espalhadas em vários celulares/pessoas sem histórico.",
        options: scale(["Espalhadas, sem controle", "Parcialmente centralizadas", "Centralizadas na maior parte dos canais", "Totalmente centralizadas, com histórico", "Centralizadas, com histórico e busca, integradas a outros sistemas"]) },
      { code: "q_receita_conversao", pillar: "receita", order: 6,
        title: "A empresa acompanha a taxa de conversão (quantos contatos viram venda)?",
        helpText: "Não precisa ser um número exato, mas precisa ser acompanhado.",
        options: scale(["Não acompanha", "Tem uma ideia aproximada", "Acompanha ocasionalmente", "Acompanha com indicador por canal/etapa", "Acompanha, com meta e ação corretiva quando cai"]) },

      { code: "q_processos_padronizacao", pillar: "processos", order: 7,
        title: "As tarefas mais repetitivas da equipe têm um jeito padronizado de serem feitas?",
        helpText: "Pense nas 3-5 tarefas que mais se repetem no dia a dia.",
        options: scale(["Cada um faz do seu jeito", "Existe um jeito 'certo', mas não está escrito", "Está escrito, mas pouca gente segue", "Está documentado e a maioria segue", "Documentado, seguido e revisado periodicamente"]) },
      { code: "q_processos_responsavel_prazo", pillar: "processos", order: 8,
        title: "Tarefas e aprovações têm responsável, prazo e acompanhamento?",
        helpText: "",
        options: scale(["Não há dono nem prazo", "Às vezes há um responsável informal", "Há responsável, mas sem prazo cobrado", "Responsável e prazo definidos, com cobrança", "Responsável, prazo, cobrança automática e indicador de atraso"]) },
      { code: "q_processos_manual", pillar: "processos", order: 9,
        title: "Quantas etapas manuais (planilha, papel, mensagem solta) são necessárias para concluir uma venda/pedido/agendamento?",
        helpText: "",
        options: scale(["Muitas etapas manuais, alto risco de erro", "Bastante manual, com algum controle", "Parcialmente sistematizado", "Maior parte sistematizada, pouco manual", "Quase tudo sistematizado, manual é exceção"]) },

      { code: "q_dados_sistemas_integrados", pillar: "dados", order: 10,
        title: "Os sistemas usados (CRM, agenda, estoque, financeiro) conversam entre si ou cada um vive isolado?",
        helpText: "",
        options: scale(["Totalmente isolados", "Isolados, com exportação manual ocasional", "Alguma integração pontual", "Integração parcial entre os principais", "Integrados, dados sincronizados automaticamente"]) },
      { code: "q_dados_qualidade", pillar: "dados", order: 11,
        title: "Os dados de clientes/produtos estão atualizados e sem duplicidade?",
        helpText: "",
        options: scale(["Desatualizados e duplicados", "Parcialmente atualizados", "Razoavelmente atualizados, duplicidade ocasional", "Atualizados, duplicidade rara", "Atualizados, únicos e com dono responsável pela qualidade"]) },

      { code: "q_pessoas_uso_ia", pillar: "pessoas", order: 12,
        title: "Colaboradores já usam ferramentas de IA no trabalho?",
        helpText: "",
        options: scale(["Ninguém usa", "Uso isolado, sem padrão", "Vários usam, sem orientação", "Uso orientado pela empresa", "Uso orientado, treinado e medido"]) },
      { code: "q_pessoas_treinamento", pillar: "pessoas", order: 13,
        title: "Existe treinamento ou política para o uso de IA/ferramentas digitais?",
        helpText: "",
        options: scale(["Não existe", "Orientação verbal informal", "Existe material, pouco divulgado", "Treinamento formal realizado", "Treinamento contínuo, atualizado e obrigatório"]) },
      { code: "q_pessoas_revisao_humana", pillar: "pessoas", order: 14,
        title: "A equipe revisa/confere respostas e decisões geradas por IA antes de valerem para o cliente?",
        helpText: "",
        options: scale(["Não há revisão", "Revisão ocasional, sem regra", "Revisão informal na maioria dos casos", "Revisão obrigatória definida", "Revisão obrigatória, registrada e auditável"]) },

      { code: "q_governanca_dados_externos", pillar: "governanca", order: 15,
        title: "Dados de clientes são enviados para ferramentas externas com alguma regra clara de controle?",
        helpText: "",
        options: scale(["Enviados sem nenhuma regra", "Envio informal, sem controle", "Alguma orientação, pouco seguida", "Regra clara, seguida na maioria dos casos", "Regra clara, seguida e auditada"]) },
      { code: "q_governanca_acesso", pillar: "governanca", order: 16,
        title: "Existe alguma política (mesmo simples) de acesso a sistemas e dados da empresa?",
        helpText: "",
        options: scale(["Qualquer um acessa tudo", "Controle informal", "Algum controle de acesso por função", "Controle de acesso definido e revisado", "Controle de acesso definido, revisado e com log de auditoria"]) },

      { code: "q_metricas_baseline", pillar: "metricas", order: 17,
        title: "A empresa tem algum número de referência (baseline) para medir se uma mudança deu resultado?",
        helpText: "",
        options: scale(["Não tem nenhum número de referência", "Tem uma ideia aproximada", "Tem números, mas desatualizados", "Tem baseline atualizado", "Tem baseline atualizado e usado para decisão"]) },
      { code: "q_metricas_acompanhamento", pillar: "metricas", order: 18,
        title: "Os indicadores da empresa são acompanhados com que frequência?",
        helpText: "",
        options: scale(["Nunca são olhados", "Olhados raramente, sem rotina", "Olhados mensalmente, de forma informal", "Olhados em rotina definida (reunião/relatório)", "Olhados em rotina definida, com plano de ação por indicador"]) },
    ];

    const insertQuestion = db.prepare(
      `INSERT OR IGNORE INTO radar_questions (id, template_id, code, pillar, title, help_text, answer_type, is_required, display_order, weight, options_json)
       VALUES (?, ?, ?, ?, ?, ?, 'scale', 1, ?, 1, ?)`
    );
    for (const q of questions) {
      insertQuestion.run(`${TEMPLATE_ID}_${q.code}`, TEMPLATE_ID, q.code, q.pillar, q.title, q.helpText || null, q.order, JSON.stringify(q.options));
    }

    // Catálogo inicial de 12 casos de uso (PRD §12). `metrics_json.primaryPillar`
    // é o pilar usado pelo motor de priorização (RadarService.generateRecommendations)
    // como proxy de "impacto de negócio" enquanto radar_processes (Fase 3) não existe.
    type UseCaseSeed = {
      code: string; name: string; description: string; primaryPillar: string;
      areas: string[]; risk: "low" | "medium" | "high"; complexity: "low" | "medium" | "high";
      humanReview: 0 | 1; durationMin: number; durationMax: number;
      prerequisites: string[]; integrations: string[]; quickWinSteps: string[];
    };
    const useCases: UseCaseSeed[] = [
      { code: "atendimento_triagem_whatsapp", name: "Atendimento e triagem no WhatsApp",
        description: "IA recebe, classifica e encaminha conversas por área/urgência antes do humano assumir.",
        primaryPillar: "receita", areas: ["atendimento"], risk: "medium", complexity: "low", humanReview: 1,
        durationMin: 15, durationMax: 30, prerequisites: ["Canal de WhatsApp conectado"], integrations: ["whatsapp"],
        quickWinSteps: ["Mapear as 5 dúvidas mais frequentes", "Configurar triagem automática por área", "Medir tempo de resposta antes/depois"] },
      { code: "qualificacao_leads", name: "Qualificação de leads",
        description: "IA faz perguntas de qualificação e pontua o lead antes de repassar ao time comercial.",
        primaryPillar: "receita", areas: ["vendas"], risk: "low", complexity: "low", humanReview: 1,
        durationMin: 15, durationMax: 30, prerequisites: ["Critérios de qualificação definidos"], integrations: ["whatsapp", "crm"],
        quickWinSteps: ["Definir 3-5 perguntas de qualificação", "Configurar pontuação automática", "Acompanhar taxa de leads qualificados"] },
      { code: "followup_comercial_automatico", name: "Follow-up comercial automático",
        description: "Sequência automática de mensagens para leads que não respondem ou não fecham.",
        primaryPillar: "receita", areas: ["vendas"], risk: "low", complexity: "medium", humanReview: 1,
        durationMin: 15, durationMax: 30, prerequisites: ["Estágios do funil definidos"], integrations: ["whatsapp"],
        quickWinSteps: ["Escolher o estágio com mais leads parados", "Criar sequência de 3 mensagens", "Medir taxa de retomada"] },
      { code: "crm_assistido", name: "CRM assistido e criação automática de tarefas",
        description: "IA registra informações da conversa no CRM e cria tarefas de acompanhamento automaticamente.",
        primaryPillar: "processos", areas: ["vendas", "atendimento"], risk: "low", complexity: "medium", humanReview: 1,
        durationMin: 30, durationMax: 45, prerequisites: ["CRM em uso"], integrations: ["crm"],
        quickWinSteps: ["Definir quais campos a IA preenche", "Configurar criação de tarefa por gatilho", "Auditar 10 registros criados pela IA"] },
      { code: "agendamento_confirmacao", name: "Agendamento e confirmação inteligente",
        description: "IA oferece horários disponíveis, agenda e envia lembrete/confirmação automaticamente.",
        primaryPillar: "processos", areas: ["atendimento", "operacao"], risk: "medium", complexity: "medium", humanReview: 1,
        durationMin: 30, durationMax: 45, prerequisites: ["Agenda com horários definidos"], integrations: ["agenda", "whatsapp"],
        quickWinSteps: ["Definir regras de disponibilidade", "Ativar confirmação automática", "Medir taxa de não comparecimento"] },
      { code: "base_conhecimento_rag", name: "Base de conhecimento interna com RAG governado",
        description: "IA responde dúvidas de clientes/equipe a partir de documentos internos aprovados, com controle de acesso.",
        primaryPillar: "dados", areas: ["atendimento", "operacao"], risk: "medium", complexity: "high", humanReview: 1,
        durationMin: 45, durationMax: 90, prerequisites: ["Documentos internos organizados", "Dono do conteúdo definido"], integrations: ["rag"],
        quickWinSteps: ["Selecionar 5-10 documentos mais consultados", "Definir quem aprova o conteúdo", "Testar respostas com casos reais antes de publicar"] },
      { code: "orcamentos_propostas_assistidas", name: "Orçamentos e propostas assistidas",
        description: "IA monta rascunho de orçamento/proposta a partir da conversa, para revisão humana antes do envio.",
        primaryPillar: "receita", areas: ["vendas"], risk: "medium", complexity: "medium", humanReview: 1,
        durationMin: 30, durationMax: 45, prerequisites: ["Tabela de preços atualizada"], integrations: ["crm"],
        quickWinSteps: ["Padronizar itens/preços mais usados", "Configurar rascunho automático", "Medir tempo de envio antes/depois"] },
      { code: "atendimento_pos_venda", name: "Atendimento pós-venda",
        description: "IA acompanha o cliente após a venda (dúvidas, suporte, satisfação) e escala casos sensíveis.",
        primaryPillar: "receita", areas: ["atendimento"], risk: "medium", complexity: "low", humanReview: 1,
        durationMin: 15, durationMax: 30, prerequisites: ["Critério de escalonamento definido"], integrations: ["whatsapp"],
        quickWinSteps: ["Mapear dúvidas pós-venda mais comuns", "Configurar resposta + escalonamento", "Medir satisfação (CSAT)"] },
      { code: "alerta_estoque_reposicao", name: "Alerta de estoque e reposição",
        description: "Alerta automático quando um item cai abaixo do mínimo, com sugestão de quantidade de reposição.",
        primaryPillar: "processos", areas: ["operacao"], risk: "low", complexity: "low", humanReview: 0,
        durationMin: 15, durationMax: 30, prerequisites: ["Estoque com quantidade mínima definida"], integrations: ["estoque"],
        quickWinSteps: ["Definir estoque mínimo dos itens críticos", "Ativar alerta automático", "Revisar 1 mês de alertas gerados"] },
      { code: "processamento_documentos_email", name: "Processamento de e-mails e documentos",
        description: "IA extrai dados-chave de e-mails/documentos recebidos (pedidos, notas, cobranças) e organiza para a equipe.",
        primaryPillar: "processos", areas: ["operacao", "financeiro"], risk: "medium", complexity: "medium", humanReview: 1,
        durationMin: 30, durationMax: 60, prerequisites: ["Volume mínimo de documentos recorrentes"], integrations: ["email"],
        quickWinSteps: ["Escolher o tipo de documento mais repetitivo", "Definir os campos a extrair", "Validar extração em uma amostra"] },
      { code: "resumo_reunioes_tarefas", name: "Resumo de reuniões e criação de tarefas",
        description: "IA resume reuniões internas e cria tarefas com responsável e prazo a partir do que foi decidido.",
        primaryPillar: "pessoas", areas: ["operacao"], risk: "low", complexity: "medium", humanReview: 1,
        durationMin: 15, durationMax: 30, prerequisites: ["Reuniões gravadas ou com ata"], integrations: [],
        quickWinSteps: ["Escolher a reunião recorrente mais importante", "Testar resumo automático por 2 semanas", "Comparar tarefas geradas com o combinado"] },
      { code: "treinamento_interno_funcao", name: "Treinamento interno por função",
        description: "Assistente de IA treina/orienta cada função (vendas, atendimento etc.) com base nos processos da empresa.",
        primaryPillar: "pessoas", areas: ["rh", "operacao"], risk: "low", complexity: "high", humanReview: 1,
        durationMin: 45, durationMax: 90, prerequisites: ["Processos documentados por função"], integrations: [],
        quickWinSteps: ["Escolher a função com maior rotatividade", "Montar roteiro de treinamento a partir do processo atual", "Medir tempo de rampa de um novo colaborador"] },
    ];

    const insertUseCase = db.prepare(
      `INSERT OR IGNORE INTO radar_use_case_catalog (
        id, code, name, description, applicable_segments_json, applicable_areas_json,
        prerequisites_json, integrations_json, risk_profile, human_review_required,
        complexity, duration_days_min, duration_days_max, metrics_json, quick_win_steps_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const uc of useCases) {
      insertUseCase.run(
        uc.code, uc.code, uc.name, uc.description, JSON.stringify(["*"]), JSON.stringify(uc.areas),
        JSON.stringify(uc.prerequisites), JSON.stringify(uc.integrations), uc.risk, uc.humanReview,
        uc.complexity, uc.durationMin, uc.durationMax, JSON.stringify({ primaryPillar: uc.primaryPillar }), JSON.stringify(uc.quickWinSteps)
      );
    }
  } catch(e){ console.error('[DB] Falha ao popular seed do Radar de Execução IA', e); }

  // ZappFlow Radar — Índice de Velocidade de Conversão (IVC). Complementar ao
  // score de maturidade (autodeclarado via questionário): este índice é MEDIDO
  // a partir de dados reais de tickets/mensagens da própria organização — só
  // faz sentido para quem já é cliente ativo do ZappFlow (tem conversas no
  // banco). Motor determinístico em ConversionVelocityService — ver
  // docs/adr/ADR-010-radar-velocidade-conversao.md.
  //
  // session_id é opcional (nullable): dá para calcular o IVC avulso a qualquer
  // momento para a organização (produto de entrada leve, sem precisar abrir um
  // diagnóstico completo), ou anexado a uma radar_sessions quando o consultor
  // quiser empacotar os dois números no mesmo relatório.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS radar_velocity_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        session_id TEXT,
        period_start DATETIME NOT NULL,
        period_end DATETIME NOT NULL,
        ivc_score REAL,
        ivc_band TEXT,                        -- critica|reativa|em_organizacao|controlada|otimizada
        sla_threshold_seconds INTEGER,        -- limiar usado neste cálculo (rastreável se a config mudar depois)
        sla_compliance_rate REAL,             -- 0-1
        first_response_p50_seconds INTEGER,
        first_response_p90_seconds INTEGER,
        first_response_p95_seconds INTEGER,
        out_of_hours_messages_total INTEGER,
        out_of_hours_covered_total INTEGER,
        out_of_hours_coverage_rate REAL,      -- 0-1, null quando não houve mensagem fora do horário no período
        followup_at_risk_total INTEGER,
        followup_compliant_total INTEGER,
        followup_compliance_rate REAL,        -- 0-1, null quando não houve ticket em risco no período
        conversion_closed_total INTEGER,
        conversion_traceable_total INTEGER,
        conversion_traceability_rate REAL,    -- 0-1, null quando não houve ticket fechado no período
        tickets_analyzed INTEGER,
        tickets_never_responded INTEGER,
        scoring_version INTEGER DEFAULT 1,
        calculation_json TEXT,                -- detalhamento completo (pesos aplicados, componentes excluídos etc.)
        calculated_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_radar_velocity_org ON radar_velocity_snapshots(organization_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_radar_velocity_session ON radar_velocity_snapshots(session_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar radar_velocity_snapshots', e); }

  // Fila de jobs em segundo plano (JobQueueService). Padrão já usado ad-hoc
  // pelo backup (backup_jobs + setImmediate em routes/integrations.ts) —
  // generalizado aqui para qualquer trabalho pesado que hoje roda preso ao
  // ciclo da própria requisição (ex.: geração de PDF dentro do processamento
  // de webhook). Não é uma fila distribuída (ainda é um único processo) — ver
  // docs/adr/ADR-011-hardening-rbac-auditoria-fila-storage.md para o porquê de
  // NÃO ser Redis/BullMQ nesta fase.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|completed|failed
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        last_error TEXT,
        result_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_background_jobs_org ON background_jobs(organization_id, created_at DESC);
    `);
  } catch(e){ console.error('[DB] Falha ao criar background_jobs', e); }

  // Radar — Fase 2 (landing pública). Colunas de token público em
  // radar_sessions, aditivas via ALTER TABLE (mesmo padrão do resto do
  // arquivo). Reaproveita o padrão de org_invitations: token opaco só existe
  // em texto plano no momento da criação (devolvido uma vez à resposta da
  // API); o banco guarda só o hash. Ver src/server/RadarPublicService.ts e
  // docs/adr/ADR-012-radar-fase2-landing-publica.md.
  try { db.exec(`ALTER TABLE radar_sessions ADD COLUMN contact_role TEXT`); } catch(e){} // "cargo" — campo do onboarding público (PRD §5) que faltou na Fase 1
  try { db.exec(`ALTER TABLE radar_sessions ADD COLUMN public_token_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE radar_sessions ADD COLUMN public_token_expires_at DATETIME`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_sessions_public_token ON radar_sessions(public_token_hash) WHERE public_token_hash IS NOT NULL`); } catch(e){}

  // Convite de respondente por link próprio (ADR-018): mesmo padrão de
  // public_token_hash acima — token opaco só existe em texto plano no
  // momento da criação, o banco guarda só o hash. Ver RadarRespondentService.ts.
  try { db.exec(`ALTER TABLE radar_respondents ADD COLUMN invite_token_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE radar_respondents ADD COLUMN invite_token_expires_at DATETIME`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_respondents_invite_token ON radar_respondents(invite_token_hash) WHERE invite_token_hash IS NOT NULL`); } catch(e){}

  // SLA por canal (backlog ADR-026, deixado de fora na ADR-010): JSON
  // { channel_id: segundos } — canal sem entrada herda o limiar único da
  // organização (slow_response_seconds).
  try { db.exec(`ALTER TABLE revenue_intelligence_config ADD COLUMN sla_by_channel_json TEXT`); } catch(e){}

  // Integridade de radar_answers (backlog ADR-026): sem índice único, duas
  // escritas simultâneas da mesma resposta podiam duplicar a linha (o
  // SELECT-depois-INSERT antigo de saveAnswer não era atômico). Dedupe antes
  // (mantém a linha mais recente) e trava com índices únicos parciais —
  // parciais porque respondent_id NULL (fluxo autenticado) precisa de
  // unicidade própria, e UNIQUE normal em SQLite trata NULLs como distintos.
  try {
    db.exec(`
      DELETE FROM radar_answers WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM radar_answers
        GROUP BY session_id, question_id, COALESCE(respondent_id, '')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_answers_unique_null
        ON radar_answers(session_id, question_id) WHERE respondent_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_answers_unique_resp
        ON radar_answers(session_id, question_id, respondent_id) WHERE respondent_id IS NOT NULL;
    `);
  } catch(e){ console.error('[DB] Falha ao deduplicar/indexar radar_answers', e); }

  try { db.exec(`ALTER TABLE radar_answers ADD COLUMN source TEXT DEFAULT 'declared'`); } catch(e){}

  // Slug por PRODUTO (backlog ADR-028, itens 32+33 — antes só a LOJA tinha
  // slug): URL própria por produto na vitrine + meta tags para SEO. Backfill
  // idempotente para produtos existentes; produtos novos ganham slug na
  // criação (routes/products.ts) com fallback preguiçoso na vitrine pública.
  try { db.exec(`ALTER TABLE products_services ADD COLUMN slug TEXT`); } catch(e){}
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_org_slug ON products_services(organization_id, slug) WHERE slug IS NOT NULL`);
    const slugifyLocal = (s: string) => String(s || "")
      .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    const pending = db.prepare(`SELECT id, organization_id, name FROM products_services WHERE slug IS NULL AND type = 'product'`).all() as any[];
    const setSlug = db.prepare(`UPDATE products_services SET slug = ? WHERE id = ?`);
    const exists = db.prepare(`SELECT 1 FROM products_services WHERE organization_id = ? AND slug = ? LIMIT 1`);
    for (const p of pending) {
      const base = slugifyLocal(p.name) || "produto";
      let candidate = base;
      let n = 2;
      while (exists.get(p.organization_id, candidate)) candidate = `${base}-${n++}`;
      try { setSlug.run(candidate, p.id); } catch { /* corrida improvável no boot: ignora, fallback preguiçoso cobre */ }
    }
  } catch(e){ console.error('[DB] Falha no backfill de slug de produtos', e); }

  // Backfill idempotente do módulo 'rie' (Revenue Intelligence). O RIC era
  // sempre visível; ao torná-lo um módulo opcional (para poder cobrar à parte),
  // garantimos que NENHUMA org existente perca o acesso — só passa a ser
  // desligável pelo admin. Orgs sem lista explícita (legado) não são tocadas.
  try {
    const orgs = db.prepare("SELECT organization_id, enabled_modules FROM organization_settings WHERE enabled_modules IS NOT NULL AND enabled_modules != ''").all() as any[];
    const upd = db.prepare("UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?");
    for (const o of orgs) {
      try {
        const arr = JSON.parse(o.enabled_modules);
        if (Array.isArray(arr) && !arr.includes('rie')) { arr.push('rie'); upd.run(JSON.stringify(arr), o.organization_id); }
      } catch { /* lista inválida: ignora */ }
    }
  } catch(e){ /* coluna pode não existir ainda */ }

  // Cadastro por foto direto no WhatsApp (backlog: "IA do negócio" separada da
  // IA de atendimento, canal do gestor autorizado — ver ManagerInventoryIntake).
  // Histórico de custo/margem/preço informado pelo lojista na conversa: não é
  // aprendizado de modelo (sem treino/fine-tuning) — é um registro estruturado
  // que cresce a cada cadastro e pode alimentar sugestões futuras (ex.: margem
  // típica por categoria) sem depender de o produto ainda existir no catálogo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_price_history (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT NOT NULL,
        category TEXT,
        cost_price REAL,
        margin_percent REAL,
        sale_price REAL NOT NULL,
        source TEXT NOT NULL, -- 'whatsapp_manager' | outros no futuro
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_price_history_org_category ON product_price_history(organization_id, category);
    `);
  } catch(e){ console.error('[DB] Falha ao criar product_price_history', e); }

  // Regras novas do cadastro por WhatsApp (Fase B): a IA nunca publica sem o
  // humano ter decidido o preço de venda — margin_percent é o registro
  // explícito de QUAL margem foi praticada (para reaproveitar numa reposição
  // e avisar o dono, em vez de perguntar de novo); pricing_declined_at marca
  // quando o lojista recusou informar preço/margem (produto fica só no
  // controle de estoque, nunca na vitrine, até alguém completar o cadastro).
  try { db.exec(`ALTER TABLE products_services ADD COLUMN margin_percent REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN pricing_declined_at DATETIME`); } catch(e){}
  // Foto de catálogo gerada pela IA do Estúdio (fundo trocado, identidade
  // visual da loja) — separada da foto crua enviada pelo lojista
  // (product_images) para o orquestrador saber se já existe uma versão
  // profissional pronta e reaproveitar, sem gastar IA de novo no mesmo produto.
  try { db.exec(`ALTER TABLE products_services ADD COLUMN studio_image_url TEXT`); } catch(e){}
  // Opt-in por loja (decisão do produto: custa uma chamada de IA extra por
  // produto novo, nem toda loja vai querer o custo/estilo por padrão).
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN ai_catalog_photos_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN catalog_photo_style TEXT DEFAULT 'marketplace'`); } catch(e){}
  // Rate-limit do aviso proativo de produtos sem preço/margem (só quando o
  // gestor já está conversando — nunca dispara mensagem nova só para isso).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pending_pricing_nudge_at DATETIME`); } catch(e){}

  // ADR-033: ocultar automaticamente da vitrine quando o estoque zera, e
  // restaurar ao repor — opt-in por loja ("conforme configuração do
  // lojista"). out_of_stock_hidden distingue "escondido pelo sistema por
  // falta de estoque" de "escondido manualmente pelo lojista" — só o próprio
  // mecanismo restaura a visibilidade que ele mesmo tirou; uma escolha manual
  // do lojista nunca é desfeita por uma mudança de estoque.
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN auto_hide_out_of_stock INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN out_of_stock_hidden INTEGER DEFAULT 0`); } catch(e){}

  // ADR-033: histórico versionado de edições pós-criação (nome/descrição/
  // preço/categoria/visibilidade/destaque) — complementa a auditoria de
  // eventos (auth_audit_logs) com o DIFF de cada alteração manual.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_edit_history (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        changed_by TEXT,
        changed_fields_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_product_edit_history_product ON product_edit_history(organization_id, product_id, created_at DESC);
    `);
  } catch(e){ console.error('[DB] Falha ao criar product_edit_history', e); }

  // ===== Fashion AI Studio — FAS-0, fundação (ADR-034 / PRD-E-006) =====
  // Flag por loja (desligada por padrão; o próprio toggle é o kill switch do
  // RF-035) e limite diário de gerações (RF-031, padrão 3 — só será consumido
  // a partir do FAS-3; criado agora para o contrato de configuração nascer
  // completo). Nenhuma tabela abaixo tem caminho de escrita público ainda —
  // o schema nasce na fundação para as fases seguintes não precisarem de
  // migration coordenada com código em produção.
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN fashion_studio_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN fashion_daily_generation_limit INTEGER DEFAULT 3`); } catch(e){}
  // ADR-041: o provador só pode conter roupa/acessório VESTÍVEL — a loja pode
  // vender outras coisas (caneca, eletrônico...). NULL = ainda não classificado;
  // 1/0 gravado pela heurística, pela IA ou pelo lojista (source registra quem).
  try { db.exec(`ALTER TABLE products_services ADD COLUMN fashion_wearable INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE products_services ADD COLUMN fashion_wearable_source TEXT`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fashion_customer_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,            -- conta de cliente do provador (FAS-1); vira lead (contacts) no cadastro
        personalization_enabled INTEGER DEFAULT 0, -- 0 até consentimento explícito (RF-002)
        preference_version INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_profiles_org_customer ON fashion_customer_profiles(organization_id, customer_id);

      CREATE TABLE IF NOT EXISTS fashion_preferences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        preference_type TEXT NOT NULL,        -- color_like | color_avoid | style_like | fit_avoid | budget_range | occasion ...
        value_json TEXT,
        source TEXT NOT NULL,                 -- explicit | observed | purchase | feedback
        confidence REAL,                      -- só para sinal observado; dado explícito não tem
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_prefs_profile ON fashion_preferences(organization_id, profile_id);

      CREATE TABLE IF NOT EXISTS fashion_avatar_assets (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        storage_key TEXT,                     -- NUNCA um caminho público /media (storage privado nasce no FAS-1)
        status TEXT DEFAULT 'quarantined',    -- quarantined | approved | rejected | expired | deleted
        safety_report_json TEXT,              -- sem imagem bruta (RNF-004)
        consent_id TEXT,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_avatars_org_customer ON fashion_avatar_assets(organization_id, customer_id);

      CREATE TABLE IF NOT EXISTS fashion_look_requests (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        avatar_id TEXT,
        occasion TEXT,
        answers_json TEXT,
        generation_window TEXT,               -- ex.: '2026-07-04'
        credits_reserved INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',          -- draft | submitted | completed | failed | cancelled
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_requests_org_customer ON fashion_look_requests(organization_id, customer_id);

      CREATE TABLE IF NOT EXISTS fashion_looks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        explanation TEXT,
        source TEXT DEFAULT 'ai_recommended', -- customer_selected | ai_recommended
        status TEXT DEFAULT 'candidate',      -- candidate | selected | generated | failed | archived
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_looks_request ON fashion_looks(organization_id, request_id);

      CREATE TABLE IF NOT EXISTS fashion_look_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        look_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,     -- FK do catálogo real (products_services) — nunca duplicar catálogo
        variant_id TEXT,
        role TEXT DEFAULT 'main',             -- main | bottom | outerwear | shoes | accessory
        quantity INTEGER DEFAULT 1,
        price_snapshot REAL                   -- para a explicação; o checkout SEMPRE revalida preço/estoque
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_look_items_look ON fashion_look_items(organization_id, look_id);

      -- LOOKS DE VITRINE (ADR-104 Bloco 2): looks de MERCHANDISING da loja,
      -- montados pela IA vitrinista a partir das peças novas + curados pelo
      -- lojista num Kanban. Distintos dos fashion_looks (que são da CLIENTE,
      -- com consentimento/memória): aqui não há customer_id nem quiz — é
      -- conteúdo da loja. A imagem do avatar vestindo é gerada no Bloco 3.
      CREATE TABLE IF NOT EXISTS storefront_looks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        title TEXT,
        explanation TEXT,
        origin TEXT DEFAULT 'ai',              -- ai | manual
        status TEXT DEFAULT 'suggested',       -- suggested | approved | published | archived
        preset_avatar_id TEXT,                 -- avatar escolhido (Bloco 3); NULL = IA escolhe
        published_image_url TEXT,              -- imagem do avatar vestindo, publicada (Bloco 3)
        tryon_job_id TEXT,                     -- job da geração (Bloco 3)
        position INTEGER DEFAULT 0,            -- ordem dentro da coluna do Kanban
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_looks_org_status ON storefront_looks(organization_id, status);

      CREATE TABLE IF NOT EXISTS storefront_look_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        look_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,      -- FK do catálogo real; nunca duplica catálogo
        role TEXT DEFAULT 'main',              -- main | bottom | outerwear | shoes | accessory
        position INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_look_items_look ON storefront_look_items(organization_id, look_id);

      -- Imagens do avatar vestindo o look (ADR-104 Bloco 3): 2 poses por look
      -- aprovado, geradas em fila. Públicas em /media (foto de catálogo, sem
      -- consentimento). A 1ª vira a capa (published_image_url) ao publicar.
      CREATE TABLE IF NOT EXISTS storefront_look_images (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        look_id TEXT NOT NULL,
        url TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_storefront_look_images_look ON storefront_look_images(organization_id, look_id);

      -- INTEGRAÇÃO ALTERDATA/ModaUp (ADR-105): config por organização. Segredos
      -- (auth_config, access_token) ficam CIFRADOS (EncryptionService). URLs não
      -- são segredo. Flag enabled desligada por padrao -- nada roda sem config.
      CREATE TABLE IF NOT EXISTS alterdata_integration_settings (
        organization_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        environment TEXT DEFAULT 'homolog',   -- homolog | prod
        rede TEXT,                            -- rede da loja no ERP
        filiais_json TEXT,                    -- JSON array de filiais
        base_pattern TEXT,                    -- ex.: 'toulon-{module}.apimodaup.com.br'
        module_base_urls_json TEXT,           -- override por módulo (JSON), opcional
        auth_config_enc TEXT,                 -- CIFRADO: client_id/secret ou api key (shape a confirmar)
        access_token_enc TEXT,                -- CIFRADO: token corrente
        token_expires_at DATETIME,
        sync_interval_minutes INTEGER DEFAULT 15,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Cursor do delta-sync por versão (ADR-105): guarda a última "versão" vista
      -- por (org, módulo, recurso, filial) — a memória do sync incremental.
      CREATE TABLE IF NOT EXISTS alterdata_sync_cursors (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        module TEXT NOT NULL,                 -- supply | price | crm | sales | ecommerce | ...
        resource TEXT NOT NULL,               -- ex.: 'Saldo', 'Referencia', 'TabelaPreco'
        filial TEXT DEFAULT '',               -- '' quando o recurso não é por filial
        version TEXT DEFAULT '0',             -- cursor (opaco; a Alterdata define o tipo)
        last_synced_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alterdata_cursor_uniq
        ON alterdata_sync_cursors(organization_id, module, resource, filial);
    `);
    // ADR-105 Fase 1b: referência externa (ERP) para upsert idempotente do
    // catálogo importado. products_services.external_ref = Referencia.referenciaId;
    // product_variants.external_ref = EAN (ou codigo:cor:tamanho) da variante.
    try { db.exec(`ALTER TABLE products_services ADD COLUMN external_ref TEXT`); } catch(e){}
    try { db.exec(`ALTER TABLE product_variants ADD COLUMN external_ref TEXT`); } catch(e){}
    // ADR-105 Fase 1d: tabela de preço da rede a sincronizar (módulo Price).
    try { db.exec(`ALTER TABLE alterdata_integration_settings ADD COLUMN price_table TEXT`); } catch(e){}
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_products_external_ref ON products_services(organization_id, external_ref);
      CREATE INDEX IF NOT EXISTS idx_variants_external_ref ON product_variants(organization_id, external_ref);

      -- PERFORMANCE (auditoria 2026): índices nas tabelas mais quentes que
      -- estavam sem cobertura. Puramente ADITIVOS (não mudam resultado de query);
      -- SQLite constrói sem lock relevante nesta escala. Ver docs/PERFORMANCE-AUDIT.md.
      -- messages: carga do histórico do chat + last-message do inbox (mais quente)
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_created ON messages (ticket_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_org_sender ON messages (organization_id, sender_type, ticket_id);
      -- tickets: lista do inbox + "último ticket do contato" (caminho de toda msg recebida)
      CREATE INDEX IF NOT EXISTS idx_tickets_org_status_updated ON tickets (organization_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_org_contact_created ON tickets (organization_id, contact_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tickets_org_assignee ON tickets (organization_id, assigned_to);
      -- contacts: lookup por identifier a cada mensagem recebida
      CREATE INDEX IF NOT EXISTS idx_contacts_org_identifier ON contacts (organization_id, identifier);
      -- products_services: leitura do catálogo (type='product' AND active=1)
      CREATE INDEX IF NOT EXISTS idx_products_org_type_active ON products_services (organization_id, type, active);
      -- inventory_items: JOIN por produto + varredura de estoque baixo
      CREATE INDEX IF NOT EXISTS idx_inventory_org_product ON inventory_items (organization_id, product_service_id);
      -- appointments: agenda/conflito + histórico do contato
      CREATE INDEX IF NOT EXISTS idx_appointments_org_status_start ON appointments (organization_id, status, scheduled_start);
      CREATE INDEX IF NOT EXISTS idx_appointments_org_contact ON appointments (organization_id, contact_id);
      -- audit_logs: tabela de crescimento ilimitado
      CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs (organization_id, created_at);
      -- order_items: agregação de mais vendidos por org
      CREATE INDEX IF NOT EXISTS idx_order_items_org ON order_items (organization_id);

      CREATE TABLE IF NOT EXISTS fashion_tryon_jobs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        look_id TEXT NOT NULL,
        provider_key TEXT,                    -- provedor plugável (ADR candidata A do PRD) — decidido no FAS-3
        provider_job_id TEXT,
        status TEXT DEFAULT 'CREATED',        -- CREATED..DELETED (seção 9.4 do PRD)
        input_hash TEXT,                      -- idempotência
        output_storage_key TEXT,              -- privado; nunca /media público
        error_code TEXT,
        error_message_safe TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_jobs_org_customer ON fashion_tryon_jobs(organization_id, customer_id);

      CREATE TABLE IF NOT EXISTS fashion_usage_credits (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        window_start DATETIME NOT NULL,
        window_end DATETIME NOT NULL,
        limit_total INTEGER NOT NULL,
        used_count INTEGER DEFAULT 0,
        reserved_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_credits_org_customer ON fashion_usage_credits(organization_id, customer_id, window_start);

      CREATE TABLE IF NOT EXISTS fashion_consents (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        consent_type TEXT NOT NULL,           -- avatar_processing | personalization | whatsapp_notification | guardian_approval (menor via conta do responsável)
        policy_version TEXT,
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_consents_org_customer ON fashion_consents(organization_id, customer_id);

      CREATE TABLE IF NOT EXISTS fashion_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        customer_id TEXT,
        event_type TEXT NOT NULL,             -- FashionLookRequested, FashionTryOnSucceeded... (seção 17 do PRD)
        payload_json TEXT,                    -- nunca conteúdo visual/base64 (RNF-004)
        correlation_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_events_org_type ON fashion_events(organization_id, event_type, created_at DESC);

      -- Avatares PRESET da loja (ADR-103, item #13): modelos curados pelo
      -- lojista (por tipo de corpo) que o cliente ESCOLHE em vez de subir a
      -- própria foto. Por organização, sem customer_id/consentimento/quarentena
      -- (não é dado pessoal do cliente); imagem pública em /media (curada).
      CREATE TABLE IF NOT EXISTS fashion_preset_avatars (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        label TEXT,                           -- ex.: "Modelo atlético", "Corpo médio"
        body_type TEXT,                       -- magro | atletico | medio | plus | outro
        image_url TEXT NOT NULL,              -- /media/<uuid>.ext (público, curado pela loja)
        active INTEGER DEFAULT 1,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fashion_preset_avatars_org ON fashion_preset_avatars(organization_id, active, position);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas do Fashion AI Studio', e); }
  // Origem da imagem-modelo do try-on: NULL = foto do cliente (fluxo original);
  // preenchido = avatar preset da loja escolhido pelo cliente (ADR-103).
  try { db.exec(`ALTER TABLE fashion_tryon_jobs ADD COLUMN preset_avatar_id TEXT`); } catch(e){}

  // ===== Fashion AI Studio — FAS-1: conta de cliente + avatar seguro (ADR-035) =====
  // Conta de cliente do provador — decisão explícita do usuário (ADR-034):
  // a vitrine continua 100% anônima para navegar/comprar; a conta só existe
  // para quem usa o provador, e o cadastro vira LEAD no CRM (contact_id).
  // birth_date sustenta o gate de 18+ (menor só via conta do responsável).
  // O JWT desta conta usa segredo DERIVADO (ver FashionCustomerService) —
  // NUNCA passa no requireAuth do painel do staff.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS storefront_customers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        password_hash TEXT NOT NULL,
        birth_date TEXT NOT NULL,             -- ISO yyyy-mm-dd; gate 18+ no registro
        contact_id TEXT,                      -- lead criado no CRM (best-effort)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME,
        deleted_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_storefront_customers_org_email
        ON storefront_customers(organization_id, email) WHERE deleted_at IS NULL;
    `);
  } catch(e){ console.error('[DB] Falha ao criar storefront_customers', e); }
  // Retenção do avatar (RF-032/19.4): padrão 30 dias, configurável por loja.
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN fashion_avatar_retention_days INTEGER DEFAULT 30`); } catch(e){}
  // Vitrinista IA (ADR-104 Bloco 2): marca a última curadoria de vitrine — peças
  // cadastradas DEPOIS dela são as "novas" que a IA usa como base do lote.
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN vitrine_curated_at DATETIME`); } catch(e){}
  // Bloco 3: publicar a foto do look direto ao gerar (1) ou esperar o OK do
  // gerente (0, padrão) — o lojista decide (aprovar-antes × publicar-direto).
  try { db.exec(`ALTER TABLE storefront_settings ADD COLUMN vitrine_auto_publish INTEGER DEFAULT 0`); } catch(e){}
  // Estado da geração da imagem do look (Bloco 3): idle | queued | processing | done | failed.
  try { db.exec(`ALTER TABLE storefront_looks ADD COLUMN generation_status TEXT DEFAULT 'idle'`); } catch(e){}
  // Tom de pele do avatar preset (Bloco 3): a IA escolhe o modelo (clara/media/
  // escura) que melhor combina com as cores da roupa. clara | media | escura.
  try { db.exec(`ALTER TABLE fashion_preset_avatars ADD COLUMN skin_tone TEXT DEFAULT 'media'`); } catch(e){}
  // FAS-4 (ADR-038): atribuição comercial pedido<->look (RF-027) — permite
  // medir look->pedido/ticket sem tabela de junção; NULL para pedidos comuns.
  try { db.exec(`ALTER TABLE orders ADD COLUMN fashion_look_id TEXT`); } catch(e){}
  // Inteligência comercial da IA (ADR-043): a IA de atendimento avalia cada
  // interação e alimenta o CRM com sinais complementares ao lead_score
  // comportamental (CustomerProfileService). Colunas aditivas, seguras.
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ai_purchase_probability INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ai_objection_type TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ai_funnel_stage TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ai_primary_pain TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ai_next_step TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ai_sales_updated_at DATETIME`); } catch(e){}
  // Lembrete de recompra via WhatsApp (opt-in por organização).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN repurchase_reminder_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN repurchase_reminder_days INTEGER DEFAULT 30`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN repurchase_reminder_message TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN repurchase_reminder_last_run DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN repurchase_reminded_at DATETIME`); } catch(e){}

  // Item 1: Radar auto-send report on session completion
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_auto_send_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_auto_send_channel TEXT DEFAULT 'whatsapp'`); } catch(e){}

  // Item 4: Default landing page per org
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN default_landing_view TEXT DEFAULT 'kanban'`); } catch(e){}

  // Item 3: RIC daily snapshots for trend time series
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ric_daily_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        snapshot_date TEXT NOT NULL,
        iqr_score REAL DEFAULT 0,
        estimated_loss REAL DEFAULT 0,
        recoverable REAL DEFAULT 0,
        recovered REAL DEFAULT 0,
        atendimento_score REAL DEFAULT 0,
        comercial_score REAL DEFAULT 0,
        operacional_score REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ric_snap_org_date ON ric_daily_snapshots (organization_id, snapshot_date);
      CREATE INDEX IF NOT EXISTS idx_ric_snap_date ON ric_daily_snapshots (snapshot_date);
    `);
  } catch(e){}

  // Item 5: Cleanup TTL for background_jobs
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_bg_jobs_completed ON background_jobs (status, completed_at)`); } catch(e){}

  // LGPD: hash columns for secret lookup (hash-for-lookup + cipher-for-display)
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN pay_webhook_secret_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN integration_token_hash TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_org_webhook_hash ON organization_settings (pay_webhook_secret_hash)`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_org_token_hash ON organization_settings (integration_token_hash)`); } catch(e){}

  // LGPD: granular consent tracking per contact
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_consents (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        consent_type TEXT NOT NULL,
        legal_basis TEXT,
        policy_version TEXT DEFAULT '1.0',
        granted INTEGER DEFAULT 1,
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        channel TEXT,
        actor_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_contact_consents_org_contact ON contact_consents (organization_id, contact_id);
      CREATE INDEX IF NOT EXISTS idx_contact_consents_type ON contact_consents (organization_id, consent_type);
    `);
  } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN consent_categories TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN consent_banner_text TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN consent_policy_version TEXT DEFAULT '1.0'`); } catch(e){}

  // NPS: structured follow-up comments for detractors
  try { db.exec(`ALTER TABLE satisfaction_surveys ADD COLUMN follow_up_status TEXT DEFAULT 'none'`); } catch(e){}

  // Abandoned cart: pre-proposal intent detection
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN abandoned_cart_intent_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN abandoned_cart_intent_threshold INTEGER DEFAULT 60`); } catch(e){}

  // Reativação por sequência progressiva: 3 mensagens em vez de 1.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_reactivation_message_2 TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN auto_reactivation_message_3 TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN reactivation_step INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE contacts ADD COLUMN reactivation_last_sent_at DATETIME`); } catch(e){}

  // Console de diagnóstico de webhooks Meta: registra TODO hit que bate em
  // /api/webhooks/meta ANTES de qualquer validação/parse, para conseguirmos
  // enxergar (via UI) o que a Meta está mandando quando algo dá silêncio
  // suspeito (ex.: DM do Instagram que "não chega"). Sem organization_id de
  // propósito — é diagnóstico técnico do canal Meta, não dado tenant.
  // Retenção curta (últimos ~500 hits ou ~48h, o que vier primeiro) para não
  // encher o disco com payload de webhook em produção.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta_webhook_hits (
        id TEXT PRIMARY KEY,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        method TEXT NOT NULL,
        source_ip TEXT,
        user_agent TEXT,
        object TEXT,             -- payload.object (whatsapp_business_account | instagram | page | ...)
        payload_json TEXT,       -- corpo cru (limitado a 10KB)
        headers_json TEXT,       -- só cabeçalhos relevantes
        processed INTEGER DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_meta_hits_received ON meta_webhook_hits(received_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar meta_webhook_hits', e); }

  // Manifesto do Negócio (Tier 1 filosófico, ADR-045): o "Por Quê" do Sinek +
  // história fundadora (StorySelling) + promessa de transformação + tom de voz.
  // É o TOPO de todo prompt de IA — a constituição da marca. 1 linha por org.
  //
  // Colunas separadas em vez de JSON blob porque cada campo é editado
  // independentemente na UI e injetado em contextos diferentes (why_statement
  // vai em todo prompt; founder_story só entra em conteúdo/campanhas; tone_voice
  // regula a linguagem de todas as respostas). Fica mais fácil migrar depois se
  // algum campo virar tabela própria (ex.: histórico de versões).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_manifesto (
        organization_id TEXT PRIMARY KEY,
        why_statement TEXT,           -- 1-2 frases; o Por Quê declarado (Sinek)
        how_principles TEXT,          -- JSON array de princípios (o Como)
        what_summary TEXT,            -- 1 frase resumindo o Que é ofertado
        founder_story TEXT,           -- história fundadora (StorySelling / narrativa)
        transformation_promise TEXT,  -- resultado que a marca promete transformar na vida do cliente
        tone_voice TEXT,              -- registro (formal/casual/próximo/técnico) + palavras-âncora
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar business_manifesto', e); }

  // Radar de Oportunidades Disfarçadas (Tier 2, Carlos Domingos, ADR-046):
  // varre reclamações, cancelamentos, faltas de estoque e "buscas por produto
  // ausente" e agrupa em oportunidades acionáveis para o dono. Cada linha é
  // uma oportunidade DETECTADA (não implementada) — o dono decide reconhecer,
  // implementar ou descartar.
  //
  // category: cancellation_reason | product_gap | stock_out | service_complaint | delay_pattern
  // status: new | acknowledged | in_progress | implemented | dismissed
  // sample_evidences_json: até 5 exemplos concretos (mensagem, contato, data) que sustentam a oportunidade
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS disguised_opportunities (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        suggested_action TEXT,
        evidence_count INTEGER DEFAULT 0,
        sample_evidences_json TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        first_seen_at DATETIME,
        last_seen_at DATETIME,
        acknowledged_at DATETIME,
        acknowledged_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_opps_org ON disguised_opportunities(organization_id, status, category);
    `);
  } catch(e){ console.error('[DB] Falha ao criar disguised_opportunities', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN opportunity_radar_last_run DATETIME`); } catch(e){}

  // Backup automático (ADR-097): backup programado por org (destino Drive do
  // dono) + redundância da plataforma (nossa infra, independente do cliente).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN backup_auto_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN backup_frequency TEXT DEFAULT 'daily'`); } catch(e){}      // daily | 2x_week | weekly
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN backup_retention INTEGER DEFAULT 30`); } catch(e){}        // nº de backups do cliente a manter
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN backup_to_drive INTEGER DEFAULT 1`); } catch(e){}          // envia ao Google Drive do dono
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN backup_auto_last_run DATETIME`); } catch(e){}              // trava do backup do cliente
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN backup_platform_last_run DATETIME`); } catch(e){}          // trava da redundância semanal do operador
  // Id do arquivo no Drive (para expurgar da nuvem do dono ao aplicar retenção).
  try { db.exec(`ALTER TABLE backup_jobs ADD COLUMN drive_file_id TEXT`); } catch(e){}

  // Journal de Frustrações do Dono (Tier 2, Carlos Domingos, ADR-046):
  // captura irritações do dono no dia a dia — matéria-bruta de oportunidades
  // que ele mesmo esqueceria antes de aproveitar. Categorização por IA (best-
  // effort) agrupa padrões mensais. Um dos "cases" do livro é literalmente
  // o dono do Nike (Bowerman) irritado com a sola dos tênis; sem esse hábito
  // de registrar, muitos negócios nunca saem do papel.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_frustrations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT,
        text TEXT NOT NULL,
        category TEXT,               -- classificação IA: operacional | ferramenta | pessoas | processo | financeiro | cliente | outro
        source TEXT DEFAULT 'text',  -- text | voice_transcribed
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_frust_org ON owner_frustrations(organization_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar owner_frustrations', e); }

  // Radar de Recuperação (Tier 2 Disney — "O Jeito Disney de Encantar Clientes",
  // ADR-047). Quando algo dá errado (cancelamento, PIX expirado, reclamação
  // detectada), a plataforma detecta e propõe um playbook Disney de recuperação
  // em 4 passos: (1) reconhecer o problema com empatia real, (2) assumir
  // responsabilidade, (3) resolver rápido, (4) oferecer algo pessoal (não
  // desconto — mimo, prioridade, mensagem escrita). O objetivo é MEDIR
  // "recovery events" — a métrica que os grandes negócios têm e a maioria não.
  //
  // trigger_type: order_cancelled | pix_expired | complaint_detected | delay_detected | delivery_delayed
  // status: triggered | playbook_sent | resolved_positive | resolved_neutral | escalated_human | dismissed
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        ticket_id TEXT,
        order_id TEXT,
        trigger_type TEXT NOT NULL,
        trigger_context_json TEXT,
        playbook_text TEXT,
        status TEXT NOT NULL DEFAULT 'triggered',
        playbook_sent_at DATETIME,
        resolved_at DATETIME,
        resolution_notes TEXT,
        handled_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_org_status ON recovery_events(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_recovery_org_created ON recovery_events(organization_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar recovery_events', e); }

  // Big Idea Bar (Tier 2, Cole Nussbaumer Knaflic — "Storytelling com Dados",
  // ADR-048). Cache de "e daí?" gerado por IA para cada painel: uma frase que
  // resume o dado + a ação recomendada, no lugar do gráfico frio.
  //
  // panel_key: identificador do painel (executive_dashboard | rie_dashboard |
  // sales_analytics | fashion_dashboard | etc.)
  // data_hash: hash SHA1 do dado bruto — regenera só quando o dado muda
  // significativamente (evita chamar LLM a cada refresh do painel).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS big_ideas (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        panel_key TEXT NOT NULL,
        data_hash TEXT NOT NULL,
        headline TEXT NOT NULL,
        recommended_action TEXT,
        confidence INTEGER DEFAULT 80,
        raw_data_snapshot TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_big_ideas_hit ON big_ideas(organization_id, panel_key, data_hash);
      CREATE INDEX IF NOT EXISTS idx_big_ideas_org_panel ON big_ideas(organization_id, panel_key, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar big_ideas', e); }

  // Notas de Reconhecimento (Tier 2, Hunter — "O Monge e o Executivo",
  // liderança-servidora, ADR-049).
  //
  // O Diretor IA detecta esforço/momento notável (CSAT nota máxima,
  // recompra fiel, ticket alto, cliente recuperado, mensagem carinhosa)
  // e SUGERE ao dono uma nota curta de reconhecimento. O dono revê e
  // decide se envia. Automatizar isso 100% mata o valor — o reconhecimento
  // vale porque VEM DO DONO, não da IA. A IA só puxa a memória do dono.
  //
  // target_type: customer | employee | partner (por enquanto só customer)
  // status: suggested | dismissed | sent (fecha o loop pra métrica)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recognition_notes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'customer',
        target_id TEXT,
        target_name TEXT,
        trigger_type TEXT NOT NULL,
        trigger_context_json TEXT,
        suggested_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'suggested',
        sent_at DATETIME,
        dismissed_at DATETIME,
        handled_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_recognition_org_status ON recognition_notes(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_recognition_org_created ON recognition_notes(organization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recognition_dedupe ON recognition_notes(organization_id, target_type, target_id, trigger_type, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar recognition_notes', e); }

  // ==== Trio de auditoria filosófica (Tier 2, ADR-050) ====

  // Celery Test (Sinek, "Comece pelo Porquê"). Pergunta semanal do Diretor:
  // "Se você tivesse que colocar tudo num carrinho, essa nova prática/produto
  // ficaria com o resto ou pareceria fora de lugar?" Ajuda o dono a decidir
  // se algo reforça ou dilui o Manifesto.
  // status: pending (aguardando resposta) | answered
  // decision: keeps (mantém, coerente) | drops (descartar, dilui)
  //           | needs_review (na dúvida, revisar depois)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS celery_tests (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        decision TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        week_of TEXT NOT NULL,
        answered_at DATETIME,
        handled_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_celery_org_status ON celery_tests(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_celery_org_week ON celery_tests(organization_id, week_of);
    `);
  } catch(e){ console.error('[DB] Falha ao criar celery_tests', e); }

  // Radar de Manipulação (Sinek). Detecta táticas de venda que descem para
  // desconto/urgência/pressão em vez de vender pelo Por Quê. Escaneia
  // mensagens outbound e sugere reformulação ancorada no Manifesto.
  // tactics_json: ["discount"|"urgency"|"pressure"|"scarcity"]
  // status: open (para revisar) | dismissed (dono viu e ignorou)
  //         | reformulated (dono ajustou a copy)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS manipulation_alerts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        message_source TEXT NOT NULL,
        message_ref TEXT,
        sample_text TEXT NOT NULL,
        tactics_json TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        suggestion TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        handled_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_manip_org_status ON manipulation_alerts(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_manip_org_created ON manipulation_alerts(organization_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar manipulation_alerts', e); }

  // Checklist de Fundamentos (Carlos Domingos — "problema é sinal, não fim").
  // Antes de subir uma campanha, checa se os fundamentos estão no lugar
  // (entrega, atendimento, estoque, CSAT, sem reclamações abertas). Se algum
  // item estiver ruim, a campanha só amplifica o problema — o Diretor
  // recomenda ARRUMAR primeiro, campanha depois.
  // items_json: [{ key, label, status: 'ok'|'attention'|'critical', evidence }]
  // status: passed (tudo ok) | passed_with_warnings | blocked
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fundamentals_checks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        campaign_ref TEXT,
        items_json TEXT NOT NULL,
        score INTEGER,
        status TEXT NOT NULL,
        recommendation TEXT,
        handled_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_fund_org_created ON fundamentals_checks(organization_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar fundamentals_checks', e); }

  // RBAC granular (ADR-095): perfis de acesso por organização com nível por
  // módulo. Aditivo e não-quebra — enquanto users.role_profile_id for nulo, o
  // PermissionService cai no fallback dos papéis legados (owner/admin/agent).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS role_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        system_key TEXT,           -- owner|gerente|vendedor|estoquista|financeiro|atendente (NULL = perfil custom do dono)
        is_system INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_role_profiles_org ON role_profiles(organization_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_role_profiles_org_system ON role_profiles(organization_id, system_key) WHERE system_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS role_permissions (
        role_profile_id TEXT NOT NULL,
        module TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'none',   -- none|read|write|full
        PRIMARY KEY (role_profile_id, module)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de RBAC', e); }
  try { db.exec(`ALTER TABLE users ADD COLUMN role_profile_id TEXT`); } catch(e){}
  // SEC-F3 (SEC-03) — papel de PLATAFORMA persistido (cross-tenant). A autorização master
  // deixa de confiar só no claim de e-mail do JWT e passa a revalidar esta coluna no DB por
  // userId. Backfill: ensureMasterAdmin marca o usuário do MASTER_ADMIN_EMAIL como 'master_admin'.
  try { db.exec(`ALTER TABLE users ADD COLUMN platform_role TEXT`); } catch(e){}
  // SEC-F7 (SEC-08) — versão de credencial. O JWT carrega `sv`; um token com `sv` divergente
  // da coluna foi revogado. Incrementada em troca/reset de senha, desativar MFA, mudar papel,
  // bloquear (bumpSecurityVersion). Default 1; tokens antigos sem `sv` não são barrados.
  try { db.exec(`ALTER TABLE users ADD COLUMN security_version INTEGER DEFAULT 1`); } catch(e){}

  // ZappFlow Comigo — módulo `copiloto` do plano Autônomo (ADR-111/112/113).
  // Balcão PDV por toque + motor de precificação (ficha técnica viva) + fiado
  // com limite, lista negra e caderneta. Tudo isolado por organization_id.
  try {
    db.exec(`
      -- Ficha técnica viva (ADR-111 D2): custo unitário nasce do tipo do item.
      CREATE TABLE IF NOT EXISTS comigo_recipes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_id TEXT,                       -- vínculo opcional com o catálogo
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'revenda',  -- revenda|fabricacao|servico
        yield_qty REAL,                        -- rendimento (fabricação): denominador
        labor_minutes REAL,                    -- tempo do atendimento (serviço)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_recipes_org ON comigo_recipes(organization_id);

      -- Itens de custo da ficha (incl. os "custos que se esquece": gás, energia,
      -- embalagem, transporte, taxa Pix/PSP, aluguel da cadeira).
      CREATE TABLE IF NOT EXISTS comigo_recipe_costs (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'insumo',   -- insumo|indireto|tempo
        amount REAL NOT NULL DEFAULT 0,
        is_estimate INTEGER DEFAULT 1,         -- 1=chute, 0=realidade
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_recipe_costs_recipe ON comigo_recipe_costs(recipe_id);

      -- Loop estimativa->realidade (ADR-088 D6): cada fechamento recalibra
      -- rendimento/custo real e registra merma/perda.
      CREATE TABLE IF NOT EXISTS comigo_calibrations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        expected_yield REAL,
        actual_yield REAL,
        waste_qty REAL DEFAULT 0,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_calibrations_recipe ON comigo_calibrations(recipe_id);

      -- Fila do Balcão (ADR-111 D4). paid_via='fiado' = recebível em aberto
      -- (ADR-112 D3: conta como venda, NÃO como caixa até quitar).
      CREATE TABLE IF NOT EXISTS comigo_orders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,                       -- obrigatório quando paid_via='fiado'
        session_alias TEXT,                    -- apelido do cliente (venda à vista, sem login)
        status TEXT NOT NULL DEFAULT 'open',   -- open|paid|done|canceled
        consumo TEXT DEFAULT 'local',          -- local|viagem
        total REAL NOT NULL DEFAULT 0,
        paid_via TEXT,                         -- pix_manual|pix_dyn|card|cash|fiado
        over_limit INTEGER DEFAULT 0,          -- 1 = fiado liberado acima do limite (ADR-112 D2)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_orders_org ON comigo_orders(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_comigo_orders_contact ON comigo_orders(organization_id, contact_id);

      CREATE TABLE IF NOT EXISTS comigo_order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        product_id TEXT,
        name TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        unit_cost_snapshot REAL DEFAULT 0,     -- custo no momento da venda (lucro real depois)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_order_items_order ON comigo_order_items(order_id);

      -- Ficha de crédito do cliente (ADR-112 + ADR-113): limite de fiado + lista
      -- negra. 1:1 com um contato (contacts) por organização.
      CREATE TABLE IF NOT EXISTS comigo_customer_credit (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        credit_limit REAL NOT NULL DEFAULT 0,
        blacklisted INTEGER DEFAULT 0,
        blacklisted_at DATETIME,
        blacklisted_reason TEXT,
        blacklist_source TEXT,                 -- manual|suggested
        block_all_sales INTEGER DEFAULT 0,     -- 1 = suspende até venda à vista (ADR-113 D2)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_credit_org ON comigo_customer_credit(organization_id);

      -- Razão do fiado (ADR-112 D4): saldo do cliente = Σ debt − Σ payment.
      CREATE TABLE IF NOT EXISTS comigo_fiado_ledger (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        order_id TEXT,
        kind TEXT NOT NULL,                    -- debt|payment
        amount REAL NOT NULL DEFAULT 0,
        over_limit INTEGER DEFAULT 0,          -- 1 = dívida liberada acima do limite
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_fiado_ledger_contact ON comigo_fiado_ledger(organization_id, contact_id);

      -- Cobrança amigável e cortês (ADR-113 D3): registro de lembretes enviados.
      CREATE TABLE IF NOT EXISTS comigo_fiado_reminders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        order_id TEXT,
        level INTEGER DEFAULT 1,
        channel TEXT DEFAULT 'whatsapp',
        template_key TEXT,
        body TEXT,
        status TEXT DEFAULT 'sent',            -- sent|failed
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_fiado_reminders_contact ON comigo_fiado_reminders(organization_id, contact_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas do Comigo (copiloto)', e); }
  // Configurações do Comigo em organization_settings (ADR-111/112/113).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_hour_value REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_default_indirects TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_fiado_default_limit REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_fiado_reminder_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_fiado_reminder_cadence TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_blacklist_suggest_days INTEGER DEFAULT 20`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_fixed_costs_monthly REAL DEFAULT 0`); } catch(e){}
  // Cobranças Pix dinâmico do Comigo (ADR-118): txid único, conciliado por webhook.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS comigo_pix_charges (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        txid TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending|paid|expired|canceled
        provider TEXT DEFAULT 'mock',
        qr_payload TEXT,
        e2e_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME,
        UNIQUE(organization_id, txid)
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_pix_order ON comigo_pix_charges(organization_id, order_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar comigo_pix_charges', e); }
  // Mesa/QR pay-first (ADR-119): origem do pedido + marca de entrega + token do QR.
  try { db.exec(`ALTER TABLE comigo_orders ADD COLUMN source TEXT DEFAULT 'balcao'`); } catch(e){}
  try { db.exec(`ALTER TABLE comigo_orders ADD COLUMN fulfilled_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_mesa_token TEXT`); } catch(e){}
  // Onboarding por arquétipo (ADR-120): molda o Comigo pelo tipo de negócio.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_archetype TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_mode TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_mobile INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_mesa_enabled INTEGER DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_default_recipe_kind TEXT`); } catch(e){}
  // Graduação MEI + nota fiscal (ADR-122): estado de formalização do autônomo.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_formalization TEXT DEFAULT 'informal'`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_cnpj TEXT`); } catch(e){}
  // Boosts de divulgação (ADR-123): log de uso (base do paywall futuro).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS comigo_boost_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        boost_key TEXT NOT NULL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_comigo_boost_org ON comigo_boost_log(organization_id, boost_key);
    `);
  } catch(e){ console.error('[DB] Falha ao criar comigo_boost_log', e); }
  // Fiado autorizado na Mesa/QR (ADR-124): o dono libera o cliente a fiar na loja.
  try { db.exec(`ALTER TABLE comigo_customer_credit ADD COLUMN store_fiado_enabled INTEGER DEFAULT 0`); } catch(e){}

  // Margem de perda aceitável (ADR-114): indicador GLOBAL de perdas por driver.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN acceptable_loss_pct REAL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN acceptable_loss_basis TEXT DEFAULT 'faturamento'`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS loss_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        period TEXT NOT NULL,              -- YYYY-MM
        driver TEXT NOT NULL,              -- merma|quebra|vencimento|furto|desconto|calote|divergencia|retrabalho|no_show|outro
        amount REAL NOT NULL DEFAULT 0,
        source TEXT DEFAULT 'manual',
        is_estimate INTEGER DEFAULT 0,
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_loss_events_org_period ON loss_events(organization_id, period);

      CREATE TABLE IF NOT EXISTS loss_monthly_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        period TEXT NOT NULL,
        loss_amount REAL DEFAULT 0,
        base_amount REAL DEFAULT 0,
        loss_pct REAL DEFAULT 0,
        acceptable_pct REAL DEFAULT 0,
        status TEXT,
        by_driver TEXT,                    -- JSON
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, period)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de margem de perda', e); }

  // Consultora Jurídica (ADR-115): auditoria das consultas ancoradas no CDC.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS legal_consultations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        actor_user_id TEXT,
        question TEXT NOT NULL,
        articles TEXT,                     -- números dos artigos citados, separados por vírgula
        grounded INTEGER DEFAULT 0,        -- 1 se houve amparo na base; 0 se foi recusa honesta
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_legal_consultations_org ON legal_consultations(organization_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela de consultas jurídicas', e); }

  // Enterprise Intelligence Kernel (ADR-136, Epic 2 — C1): ledger de SINAIS
  // empresariais tipados. Contrato comum para qualquer módulo publicar um sinal,
  // deduplicado por (org, dedupe_key). Determinístico, isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_signals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        domain TEXT NOT NULL,               -- finance|sales|procurement|inventory|retail_ops|tasks|...
        signal_type TEXT NOT NULL,
        severity TEXT NOT NULL,             -- info|attention|risk|critical
        basis TEXT NOT NULL,                -- fact|estimate
        confidence REAL NOT NULL,           -- 0..1
        impact_amount REAL,
        impact_unit TEXT,                   -- BRL|hours|units|percent|score
        occurred_at DATETIME,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        source_service TEXT NOT NULL,
        source_entity_type TEXT,
        source_entity_id TEXT,
        evidence_json TEXT NOT NULL,
        premises_json TEXT,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',  -- open|acknowledged|resolved|dismissed|expired (PRD2 F2.2)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_business_signals_org ON business_signals(organization_id, status, domain);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela business_signals', e); }

  // Epic 3 (Fatia 4, ADR-139) — preferências de briefing por (org, usuário) +
  // entregas deduplicadas (o reenvio do Scheduler não duplica a mensagem).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS briefing_preferences (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        channel TEXT NOT NULL DEFAULT 'whatsapp',
        morning_time TEXT NOT NULL DEFAULT '08:00',   -- HH:MM
        days_json TEXT,                                -- [1..7] (1=segunda); nulo = todos os dias
        domains_json TEXT,                             -- domínios permitidos; nulo = todos
        mode TEXT NOT NULL DEFAULT 'gestor',           -- gestor|tutor
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS briefing_delivery (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        slot TEXT NOT NULL,                            -- morning|midday|evening
        ref_date TEXT NOT NULL,                        -- YYYY-MM-DD
        dedupe_key TEXT NOT NULL,
        text_snapshot TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_briefing_delivery_org ON briefing_delivery(organization_id, user_id, ref_date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de briefing', e); }

  // Epic 7 (People Intelligence / RH IA — fatia 1, ADR-140): cadastro funcional.
  // Só registro (função/gestor/unidade/jornada/status) — nada de dado sensível,
  // nenhuma pontuação de "qualidade humana", decisões trabalhistas são humanas.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS employee_roles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, name)
      );
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT,                       -- vínculo opcional a users (quando tem acesso ao sistema)
        name TEXT NOT NULL,
        role_id TEXT,                       -- employee_roles
        manager_user_id TEXT,               -- gestor (users.id)
        unit TEXT,                          -- unidade/loja
        work_schedule TEXT,                 -- jornada (texto livre: "seg-sex 9-18")
        status TEXT NOT NULL DEFAULT 'active', -- active|inactive|leave
        hired_at TEXT,                      -- YYYY-MM-DD
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_employees_org ON employees(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_employee_roles_org ON employee_roles(organization_id, active);
      -- Epic 7 (fatia 3): disponibilidade DECLARADA (ausência/reduzida) — insumo
      -- do cálculo de sobrecarga. Sem inferência: só o que o gestor/colaborador
      -- declara.
      CREATE TABLE IF NOT EXISTS employee_availability_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'absence',  -- absence|reduced|available
        start_date TEXT NOT NULL,              -- YYYY-MM-DD
        end_date TEXT,                         -- YYYY-MM-DD (nulo = em aberto)
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_emp_avail_org ON employee_availability_events(organization_id, employee_id);
      -- Epic 7 (fatia 2): competências e trilhas de treinamento. "Orientação e
      -- treinamento aplicável à função" — capacidade/desenvolvimento, não folha.
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, name)
      );
      CREATE TABLE IF NOT EXISTS employee_skills (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'basic',  -- none|basic|intermediate|advanced
        assessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, employee_id, skill_id)
      );
      CREATE TABLE IF NOT EXISTS training_paths (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        role_id TEXT,                         -- função alvo (nulo = geral)
        required_skills_json TEXT,            -- ids de skills que a trilha desenvolve
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS training_assignments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        path_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'assigned', -- assigned|in_progress|completed
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        UNIQUE(organization_id, employee_id, path_id)
      );
      CREATE INDEX IF NOT EXISTS idx_employee_skills_emp ON employee_skills(organization_id, employee_id);
      CREATE INDEX IF NOT EXISTS idx_training_paths_org ON training_paths(organization_id, active);
      CREATE INDEX IF NOT EXISTS idx_training_assign_emp ON training_assignments(organization_id, employee_id);
      -- Epic 7 (fatia 4): check-ins e reconhecimento/feedback DOCUMENTADO.
      -- Texto humano; sem pontuar "qualidade humana"; recomendações não são
      -- executáveis. Decisões trabalhistas seguem humanas e registradas.
      CREATE TABLE IF NOT EXISTS performance_checkins (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        author_user_id TEXT,
        kind TEXT NOT NULL DEFAULT 'checkin',  -- checkin|recognition|feedback
        period TEXT,                           -- YYYY-MM (opcional)
        summary TEXT NOT NULL,
        strengths TEXT,
        next_steps TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_checkins_emp ON performance_checkins(organization_id, employee_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de RH (employees)', e); }

  // Produção (Supervisor de Produção IA — fatia 1, ADR-141): produto fabricado
  // + lista de materiais (BOM). Reusa catálogo/estoque (products_services /
  // inventory_items) para materiais. Determinístico, isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS manufactured_products (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        product_service_id TEXT NOT NULL,   -- produto acabado no catálogo
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, product_service_id)
      );
      CREATE TABLE IF NOT EXISTS bill_of_materials (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        manufactured_product_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Padrão',  -- versão/rótulo da BOM
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bom_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        bom_id TEXT NOT NULL,
        material_product_service_id TEXT NOT NULL,  -- material no catálogo
        quantity REAL NOT NULL DEFAULT 0,           -- por 1 unidade do acabado
        unit TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, bom_id, material_product_service_id)
      );
      CREATE INDEX IF NOT EXISTS idx_manuf_prod_org ON manufactured_products(organization_id, active);
      CREATE INDEX IF NOT EXISTS idx_bom_mp ON bill_of_materials(organization_id, manufactured_product_id);
      CREATE INDEX IF NOT EXISTS idx_bom_items_bom ON bom_items(organization_id, bom_id);
      -- Produção (fatia 2, ADR-141): ORDEM DE PRODUÇÃO + etapas + apontamentos.
      CREATE TABLE IF NOT EXISTS production_orders (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        manufactured_product_id TEXT NOT NULL,
        bom_id TEXT,
        qty_planned REAL NOT NULL DEFAULT 0,
        qty_produced REAL NOT NULL DEFAULT 0,   -- unidades boas produzidas
        qty_scrapped REAL NOT NULL DEFAULT 0,   -- refugo
        status TEXT NOT NULL DEFAULT 'draft',   -- draft|released|in_progress|done|cancelled
        promised_date TEXT,                      -- YYYY-MM-DD prometida
        expected_date TEXT,                      -- YYYY-MM-DD prevista
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS production_steps (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        assigned_to TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|done
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS production_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        step_id TEXT,
        kind TEXT NOT NULL,                      -- release|start|progress|scrap|complete|cancel|note
        qty REAL,
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prod_orders_org ON production_orders(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_prod_steps_order ON production_steps(organization_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_prod_events_order ON production_events(organization_id, order_id);
      -- Produção (fatia 3, ADR-141): consumo real de materiais (baixa estoque),
      -- checklist de qualidade e motivos de parada.
      CREATE TABLE IF NOT EXISTS material_consumptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        material_product_service_id TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 0,
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS quality_checks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        step_id TEXT,
        name TEXT NOT NULL,
        passed INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS downtime_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        minutes INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mat_consum_order ON material_consumptions(organization_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_quality_order ON quality_checks(organization_id, order_id);
      CREATE INDEX IF NOT EXISTS idx_downtime_order ON downtime_events(organization_id, order_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de Produção', e); }

  // Decision & Action Ledger (ADR-136, Epic 2 — C2): ação proposta → aprovação
  // → conclusão, com política de autonomia por (domínio, tipo). A IA propõe; a
  // política decide se exige aprovação. Nada executa sozinho. Isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS decision_actions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        signal_id TEXT,
        domain TEXT NOT NULL,
        action_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        priority_score REAL DEFAULT 0,
        expected_impact REAL,
        impact_unit TEXT,
        basis TEXT DEFAULT 'estimate',
        confidence REAL DEFAULT 0.7,
        status TEXT NOT NULL DEFAULT 'proposed',   -- proposed|awaiting_approval|approved|rejected|cancelled|done
        approval_policy TEXT NOT NULL DEFAULT 'single', -- none|single|role|two_step
        approval_role TEXT,
        assigned_to TEXT,
        due_at DATETIME,
        command_type TEXT,
        command_payload_json TEXT,
        baseline_json TEXT,
        result_amount REAL,
        created_by TEXT NOT NULL DEFAULT 'rule',   -- rule|ai|user|integration
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME,
        executed_at DATETIME,
        completed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_decision_actions_org ON decision_actions(organization_id, status, domain);
      CREATE TABLE IF NOT EXISTS action_approvals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        required_role TEXT,
        approver_user_id TEXT,
        decision TEXT NOT NULL,                    -- approved|rejected
        reason TEXT,
        decided_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_action_approvals_action ON action_approvals(organization_id, action_id);
      CREATE TABLE IF NOT EXISTS agent_policies (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        action_type TEXT NOT NULL,
        autonomy_level TEXT NOT NULL DEFAULT 'suggest', -- observe|suggest|prepare|execute
        approval_role TEXT,
        max_auto_amount REAL,
        active INTEGER DEFAULT 1,
        config_json TEXT,
        UNIQUE(organization_id, domain, action_type)
      );
      -- Outcomes: esperado × realizado por ação (ADR-136 C2b, PRD §7.5). O elo
      -- que fecha o Impact Ledger unificado — cada ação concluída registra o
      -- valor realizado ancorado numa evidência, separando fato de estimativa.
      CREATE TABLE IF NOT EXISTS action_outcomes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        expected_value REAL,
        realized_value REAL,
        basis TEXT DEFAULT 'estimate',              -- fact|estimate
        measurement_method TEXT NOT NULL,           -- self_reported|manual|attributed|derived
        attribution_window_days INTEGER,
        evidence_json TEXT,
        measured_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_action_outcomes_action ON action_outcomes(organization_id, action_id);
      -- Trilha de execução do comando (ADR-136 C5, PRD §7.4). Cada tentativa de
      -- preparar/executar um comando tipado fica auditada aqui — nunca há baixa
      -- silenciosa. No MVP o executor governa até 'prepare' (rascunho), sem
      -- efeito externo automático.
      CREATE TABLE IF NOT EXISTS action_execution_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        handler TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'prepare',       -- prepare (MVP); execute é fatia futura
        request_json TEXT,
        response_json TEXT,
        status TEXT NOT NULL,                        -- executing|done|failed
        error_code TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_action_execution_log_action ON action_execution_log(organization_id, action_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas de decisão/ação', e); }

  // Governança de IA (ADR-130): auditoria de decisão para sugestões que afetam
  // pessoas — a IA sugere, o humano decide com MOTIVO registrado.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_decisions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        kind TEXT NOT NULL,                 -- fiado_blacklist | fiado_limit | fiado_block_all | prospect_targeting | ...
        subject_id TEXT,                    -- a quem/que a decisão se refere (ex.: contact_id)
        decision TEXT NOT NULL,             -- applied | dismissed
        suggested_by TEXT DEFAULT 'human',  -- ai (a IA sugeriu) | human
        actor_user_id TEXT,                 -- humano que decidiu
        reason TEXT,                        -- motivo (obrigatório em decisão que afeta pessoa)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ai_decisions_org ON ai_decisions(organization_id, kind, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela de decisões de IA', e); }

  // Motor de Caixa (ADR-125): livro-caixa global. Venda ≠ lucro ≠ caixa —
  // recebível NÃO entra no caixa até quitar. Isolado por organization_id.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cash_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'caixa',          -- caixa|banco|carteira_digital
        opening_balance REAL DEFAULT 0,
        current_balance REAL DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cash_accounts_org ON cash_accounts(organization_id, active);

      CREATE TABLE IF NOT EXISTS payables (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT,
        supplier_name TEXT,
        amount REAL NOT NULL DEFAULT 0,
        due_date TEXT NOT NULL,             -- YYYY-MM-DD
        recurrence TEXT DEFAULT 'none',     -- none|weekly|monthly
        status TEXT DEFAULT 'open',         -- open|paid|canceled
        paid_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_payables_org ON payables(organization_id, status, due_date);

      CREATE TABLE IF NOT EXISTS receivables (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        description TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        due_date TEXT NOT NULL,             -- YYYY-MM-DD
        probability REAL DEFAULT 1,         -- 0..1 (peso na projeção)
        status TEXT DEFAULT 'open',         -- open|received|canceled
        received_at DATETIME,
        source_type TEXT DEFAULT 'manual',  -- manual|fiado|order|subscription
        source_id TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_receivables_org ON receivables(organization_id, status, due_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_receivables_source ON receivables(organization_id, source_type, source_id);

      CREATE TABLE IF NOT EXISTS cash_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        direction TEXT NOT NULL,            -- in|out
        amount REAL NOT NULL DEFAULT 0,
        event_date TEXT NOT NULL,           -- YYYY-MM-DD
        account_id TEXT,
        source_type TEXT DEFAULT 'manual',  -- manual|order|comigo_order|payable|receivable
        source_id TEXT,
        confidence TEXT DEFAULT 'confirmed',-- confirmed|likely|estimated
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cash_events_org ON cash_events(organization_id, event_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_events_source ON cash_events(organization_id, source_type, source_id);

      CREATE TABLE IF NOT EXISTS cash_forecast_weeks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        week_start TEXT NOT NULL,           -- YYYY-MM-DD (segunda-feira)
        opening REAL DEFAULT 0,
        inflow REAL DEFAULT 0,
        outflow REAL DEFAULT 0,
        ending REAL DEFAULT 0,
        risk_level TEXT DEFAULT 'ok',       -- ok|tight|negative
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, week_start)
      );

      -- Impact Ledger (ADR-125 Fatia 3): alerta → ação (aprovação humana) → medição.
      CREATE TABLE IF NOT EXISTS cash_actions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        kind TEXT NOT NULL,                 -- cobrar_receber|postergar_pagar|reduzir_compra|campanha|outro
        title TEXT NOT NULL,
        rationale TEXT,
        expected_impact REAL DEFAULT 0,
        baseline_shortfall REAL DEFAULT 0,  -- rombo previsto no momento da criação
        status TEXT DEFAULT 'accepted',     -- accepted|done|dismissed
        result_amount REAL,                 -- impacto medido ao concluir
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        decision_action_id TEXT             -- ponte opcional p/ ledger unificado (ADR-136 C2b)
      );
      CREATE INDEX IF NOT EXISTS idx_cash_actions_org ON cash_actions(organization_id, status, created_at);

      -- Empresa × Proprietário (ADR-129): retiradas do dono, tipadas.
      CREATE TABLE IF NOT EXISTS owner_draws (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        kind TEXT NOT NULL,                 -- pro_labore|distribuicao|despesa_pessoal|emprestimo_socio|despesa_empresarial
        amount REAL NOT NULL DEFAULT 0,
        draw_date TEXT NOT NULL,            -- YYYY-MM-DD
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_owner_draws_org ON owner_draws(organization_id, draw_date);

      -- Índice de Sobrevivência (ADR-127): snapshot mensal para a tendência.
      CREATE TABLE IF NOT EXISTS survival_index_snapshots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        period TEXT NOT NULL,               -- YYYY-MM
        score REAL DEFAULT 0,
        faixa TEXT,
        confidence TEXT,
        components TEXT,                     -- JSON
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, period)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas do motor de caixa', e); }
  // Ponte opcional p/ o ledger unificado em DBs já existentes (ADR-136 C2b).
  // Nulo por padrão: nada dos fluxos atuais de caixa muda.
  try { db.exec(`ALTER TABLE cash_actions ADD COLUMN decision_action_id TEXT`); } catch(e){}
  // Epic 5 (E5.3) — vínculo conta a pagar → ordem de compra + idempotência
  // "não é criada duas vezes" (UNIQUE parcial). Nulo por padrão nas contas
  // manuais existentes.
  try { db.exec(`ALTER TABLE payables ADD COLUMN source_purchase_order_id TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_payables_po ON payables(organization_id, source_purchase_order_id) WHERE source_purchase_order_id IS NOT NULL`); } catch(e){}
  // ADR-185 F1 — apropriação da DESPESA a um centro de custo (a dimensão de rateio que a
  // Controladoria já tinha pro CONSUMO, mas não pra despesa financeira). Nullable/aditive: contas
  // existentes ficam `unallocated` (RN-CC-1/3, nunca chuta centro). Índice p/ o relatório por centro.
  try { db.exec(`ALTER TABLE payables ADD COLUMN cost_center_id TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_payables_cost_center ON payables(organization_id, cost_center_id)`); } catch(e){}
  // Conector Alterdata Fase 4 — 2º id de pessoa do caixa (investigação do
  // vendedor real; a tabela pode já existir sem a coluna).
  try { db.exec(`ALTER TABLE retail_pdv_sales ADD COLUMN usuario TEXT`); } catch(e){}
  // Homologação Toulon (ADR-105) — código do VENDEDOR (CAI_USUARIO → VENDEDORES),
  // base da comissão individual, distinto do operador de caixa (matrícula).
  try { db.exec(`ALTER TABLE retail_pdv_sales ADD COLUMN vendedor_codigo TEXT`); } catch(e){}
  // Toulon — comissão individualizada por loja: uma regra "por loja" pode mirar
  // UMA loja específica (percentual próprio); NULL = vale pra rede toda (default
  // retrocompatível — bases antigas continuam com o mesmo comportamento).
  try { db.exec(`ALTER TABLE retail_commission_rules ADD COLUMN store_id TEXT`); } catch(e){}
  // Toulon — anomalia do CAI_USUARIO: nem toda loja tem o vendedor individualizado
  // de verdade no PDV (às vezes é um código único/compartilhado pra loja inteira).
  // `seller_source` é uma decisão EXPLÍCITA do gestor (não uma inferência
  // automática por coincidência de data): NULL/'pdv' = comissão por vendedor
  // dessa loja continua vindo do PDV normalmente (default, retrocompatível);
  // 'manual' = o PDV dessa loja NÃO entra na atribuição por vendedor (só conta
  // pro total da loja via fechamento) — a fonte de verdade passa a ser o
  // lançamento manual/foto (retail_seller_sales) feito no fechamento de caixa.
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN seller_source TEXT`); } catch(e){}

  // Custos fixos POR LOJA (aluguel, luz, condomínio, água, internet, folha,
  // outros) — habilita o RESULTADO/LUCRO e o PONTO DE EQUILÍBRIO por filial.
  // Antes só existia custo fixo AGREGADO da organização inteira
  // (comigo_fixed_costs_monthly) e contas a pagar sem loja (payables), então o
  // lucro nunca era segmentável por loja. Uma linha por (loja, categoria); o
  // gestor lança na tela "Editar loja". Isolado por organização.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_store_fixed_costs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        category TEXT NOT NULL,          -- aluguel|energia|condominio|agua|internet|folha|outros
        amount REAL NOT NULL DEFAULT 0,  -- valor MENSAL do custo
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, store_id, category)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_store_costs ON retail_store_fixed_costs (organization_id, store_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_store_fixed_costs', e); }
  // Margem bruta média (%) por loja — premissa GERENCIAL para estimar o lucro
  // (faturamento − custo da mercadoria) e o ponto de equilíbrio. Nullable de
  // propósito: sem ela, o app mostra faturamento e custos mas NÃO inventa
  // lucro/PE (guardrail — faturamento menos custo fixo, sem o CMV, mentiria).
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN gross_margin_percent REAL`); } catch(e){}

  // Custos VARIÁVEIS por loja (ADR-083 E5) — o que sai proporcional à venda:
  // taxa de cartão/Pix, imposto sobre venda (Simples), embalagem por pedido,
  // frete. Duas naturezas por categoria: `percent` do faturamento e
  // `fixed_per_sale` (R$ por venda/ticket, ex.: embalagem). Sem isso, o
  // "lucro por loja" ignorava esses ralos e mentia pra cima. Isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_store_variable_costs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        category TEXT NOT NULL,             -- card_fee|pix_fee|tax_sale|packaging|freight|other
        percent REAL NOT NULL DEFAULT 0,    -- % do faturamento (0..100)
        fixed_per_sale REAL NOT NULL DEFAULT 0, -- R$ por venda/ticket
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, store_id, category)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_store_var_costs ON retail_store_variable_costs (organization_id, store_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_store_variable_costs', e); }

  // Balcão OFFLINE (Gap D do levantamento autônomos): idempotência ponta-a-ponta.
  // O cliente gera commandId (UUID) por operação (abrir pedido, adicionar item,
  // pagar); quando volta online e o outbox reenviar, o servidor DEDUPLICA por
  // (organization_id, command_id) em vez de duplicar venda/dívida. Mesmo padrão
  // do SEND_MESSAGE (ADR-082 / linha 557). Índice único parcial: NULL não
  // participa (pedidos criados online sem passar pelo outbox seguem sem chave).
  try { db.exec(`ALTER TABLE comigo_orders ADD COLUMN command_id TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comigo_orders_command ON comigo_orders (organization_id, command_id) WHERE command_id IS NOT NULL`); } catch(e){}
  try { db.exec(`ALTER TABLE comigo_order_items ADD COLUMN command_id TEXT`); } catch(e){}
  // Itens não têm organization_id direta — o commandId por si só é o suficiente
  // como identidade global (UUID). Índice único simples.
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comigo_order_items_command ON comigo_order_items (command_id) WHERE command_id IS NOT NULL`); } catch(e){}
  try { db.exec(`ALTER TABLE comigo_fiado_ledger ADD COLUMN command_id TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comigo_fiado_ledger_command ON comigo_fiado_ledger (organization_id, command_id) WHERE command_id IS NOT NULL`); } catch(e){}

  // Impact/Paywall do Comigo (Gap E do levantamento autônomos, ADR-088 D8): o
  // paywall não é banner — é o VALOR PROVADO. Guarda o dia-0 do módulo pra
  // computar "quanto o Comigo já entregou desde que você começou a usar" via
  // agregação (sem tabela de eventos própria — reusa comigo_orders + fiado
  // ledger, mesmo padrão do ComigoHealthService). Nullable; capturado na
  // primeira leitura do endpoint /impact.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_impact_baseline_at DATETIME`); } catch(e){}

  // Gap B (ADR-088 D5 nível 2): teto de chamadas LLM/dia pro /menu-suggest.
  // Frugalidade dura — ao estourar, o service cai pra busca literal (nunca 500).
  // Default 50/dia por org é folgado pra Balcão de bairro e ainda evita abuso.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_menu_suggest_daily_cap INTEGER DEFAULT 50`); } catch(e){}

  // Gap A (ADR-088 D2): teto de chamadas /catalog/parse-audio por org/dia.
  // Whisper é ~10x mais caro que chat (por minuto), então default menor (30/dia).
  // Ao estourar, a rota responde 429 — cadastro por áudio pausa até amanhã.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN comigo_audio_catalog_daily_cap INTEGER DEFAULT 30`); } catch(e){}

  // Gap G (ADR-088 D3 nível 2 real): Pix dinâmico com PSP real (Mercado Pago).
  // Colunas aditivas em comigo_pix_charges — o QR imagem base64 (pra UI mostrar
  // sem precisar de lib de QR) e o id externo do PSP (payment id do MP), pra
  // conciliação e auditoria. O mock (provider=mock) segue funcionando: ambas
  // as colunas ficam NULL.
  try { db.exec(`ALTER TABLE comigo_pix_charges ADD COLUMN qr_code_base64 TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE comigo_pix_charges ADD COLUMN external_id TEXT`); } catch(e){}

  // ============================================================
  // ADR-150 — Retail Floor: Atendimento de Loja / Lista da Vez (Fatia 1)
  // ============================================================
  // Config por org do módulo retail_floor. Uma linha por organização, criada
  // lazy no primeiro acesso. `queue_policy` round_robin por padrão (FIFO puro
  // pune quem pegou atendimento longo); `calibration_until` marca o período do
  // piloto em que indicadores NÃO alimentam cobrança/comissão (RN-150-011).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_settings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL UNIQUE,
        queue_policy TEXT NOT NULL DEFAULT 'round_robin',  -- round_robin|fifo
        auto_close_minutes INTEGER NOT NULL DEFAULT 90,    -- auto-encerra atendimento esquecido (outcome=unknown)
        anonymous_default INTEGER NOT NULL DEFAULT 1,      -- RN-150-008: atendimento anônimo por padrão
        calibration_until TEXT,                            -- YYYY-MM-DD; NULL = fora de calibração
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_settings', e); }

  // Turno da loja. O roster do turno É o vínculo vendedor↔loja do dia
  // (retail_sellers não tem store_id de propósito — vendedor pode cobrir outra
  // loja). Unique parcial: 1 turno aberto por loja — abrir de novo é erro, não
  // duplicata. Fechamento é UPDATE (retenção, RN-150-010).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_shifts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',               -- open|closed
        opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        opened_by TEXT,
        closed_at DATETIME,
        closed_by TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_floor_shift_open
        ON retail_floor_shifts (organization_id, store_id) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_retail_floor_shifts
        ON retail_floor_shifts (organization_id, store_id, opened_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_shifts', e); }

  // Estado do vendedor NA FILA de um turno. A POSIÇÃO na lista da vez é
  // DERIVADA por query (política + joined_at + atendimentos do turno) — nunca
  // coluna mutável de posição (RN-150-003, mesma lição do RN-004/ADR-145).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_queue_state (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,                           -- retail_sellers.id
        status TEXT NOT NULL DEFAULT 'waiting',            -- waiting|next|serving|closing|break|unavailable|skipped|offline
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status_changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (shift_id, seller_id)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_floor_queue
        ON retail_floor_queue_state (organization_id, shift_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_queue_state', e); }

  // Atendimento. Cronômetro é SEMPRE server-side (started_at/ended_at,
  // RN-150-002). Unique parcial: 1 atendimento ATIVO por vendedor (a transação
  // atômica da Fatia 3 conta antes de inserir; o índice é a última linha de
  // defesa contra race). `reconciliation_state` implementa a conversão em 2
  // tempos (RN-150-004): declarar convertido NUNCA é venda confirmada — só a
  // conciliação com o PDV (Fatia 6) promove pending→confirmed|unmatched.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_attendances (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        shift_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,                           -- retail_sellers.id
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        outcome TEXT,                                      -- converted|not_converted|walkout|unknown
        outcome_reason_json TEXT,                          -- taxonomia hierárquica (Fatia 4)
        reconciliation_state TEXT,                         -- pending|confirmed|unmatched (só converted)
        customer_contact_id TEXT,                          -- opt-in LGPD (RN-150-008); NULL = anônimo
        declared_value REAL,                               -- valor declarado na conversão (input do matching)
        declared_pieces INTEGER,                           -- peças declaradas (input do matching)
        created_by TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_floor_attendance_active
        ON retail_floor_attendances (organization_id, seller_id) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_retail_floor_attendances
        ON retail_floor_attendances (organization_id, store_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_retail_floor_attendances_recon
        ON retail_floor_attendances (organization_id, reconciliation_state)
        WHERE reconciliation_state IS NOT NULL;
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_attendances', e); }

  // Leituras de EAN/consultas DURANTE o atendimento — a timeline do que o
  // cliente procurou. Congela o estoque local/rede e o last_sync_at do cursor
  // Alterdata no momento da leitura (RN-150-007) — o dado histórico não muda
  // quando o estoque muda depois.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_attendance_scans (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        attendance_id TEXT NOT NULL,
        ean TEXT,
        product_id TEXT,                                   -- products_services.id quando resolvido
        product_name TEXT,
        local_stock REAL,
        network_stock REAL,
        stock_synced_at DATETIME,                          -- last_sync_at do cursor no momento da leitura
        action TEXT,                                       -- viewed|reserved|transfer_requested|sold
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retail_floor_scans
        ON retail_floor_attendance_scans (organization_id, attendance_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_attendance_scans', e); }

  // Demanda não atendida EVIDENCIADA: nasce de um scan/consulta registrado no
  // atendimento (RN-150-009) — nunca digitada solta. É o input do Comprador IA
  // (ADR-137) e dos sinais de ruptura (Fatia 8).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_unmet_demand (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        attendance_id TEXT NOT NULL,
        scan_id TEXT,                                      -- retail_floor_attendance_scans.id (evidência)
        product_id TEXT,
        ean TEXT,
        reason TEXT NOT NULL,                              -- no_assortment|no_local_stock|no_network_stock|missing_size|missing_color|missing_category
        detail_json TEXT,                                  -- tamanho/cor/categoria pedidos
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_retail_floor_unmet
        ON retail_floor_unmet_demand (organization_id, store_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_unmet_demand', e); }

  // ADR-150 Fatia 6 (preparado já na fundação): link venda-do-PDV ↔ atendimento
  // após a conciliação. Aditivo, NULL para todo o histórico existente.
  try { db.exec(`ALTER TABLE retail_erp_seller_sales ADD COLUMN attendance_id TEXT`); } catch(e){}

  // ============================================================
  // ADR-150 — Retail Floor Fatia 10 (pós-piloto): resumo diário WhatsApp
  // ============================================================
  // Opt-in por org (convenção #10): o resumo do dia da loja vai por WhatsApp
  // aos responsáveis (retail_store_responsibles/ADR-108, fallback no número da
  // loja) quando chega a hora configurada. Desligado por padrão.
  try { db.exec(`ALTER TABLE retail_floor_settings ADD COLUMN daily_digest_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE retail_floor_settings ADD COLUMN digest_hour INTEGER DEFAULT 20`); } catch(e){}
  // Dedupe do envio (convenção #7: best-effort + unique index): 1 resumo por
  // (org, loja, dia) — o passe horário do Scheduler pode rodar N vezes.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_floor_digest_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        digest_date TEXT NOT NULL,               -- YYYY-MM-DD
        sent_to TEXT,                            -- CSV dos destinos (auditoria leve)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, store_id, digest_date)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar retail_floor_digest_log', e); }

  // ============================================================
  // ADR-150 — Retail Floor Fatia 11 (UI/UX): foto do vendedor
  // ============================================================
  // O card do vendedor no Kanban mostra a foto (pedido do cliente TOULON).
  // Aditivo em retail_sellers — NULL cai no Avatar de iniciais da UI.
  try { db.exec(`ALTER TABLE retail_sellers ADD COLUMN photo_url TEXT`); } catch(e){}

  // ============================================================
  // ADR-150 — Retail Floor Fatia 12: PIN da gerência (modo quiosque)
  // ============================================================
  // O tablet da loja fica logado numa conta com poderes de gestão; o PIN
  // trava as funções de gerência (fechar turno, equipe, conciliação,
  // indicadores, troca de loja) pra equipe de salão não acessar. Mesmo
  // molde do PIN da Clínica (Fase 28): sha256(salt+pin) + lockout 5×/15min.
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN manager_pin_salt TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN manager_pin_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN manager_pin_failed_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN manager_pin_locked_until TEXT`); } catch(e){}

  // ============================================================
  // ADR-083 — Fase G2: Corrida de comissão (modelo CARIOCA) + escala semanal
  // ============================================================
  // A "corrida" da planilha do cliente: faixas NÃO cumulativas sobre o
  // atingimento da cota (bateu → 1%, +10% → 1,5%, +20% → 2%, +30% → 3%),
  // prêmio de P.A (peças/atendimento ≥ 2,50 com cota batida), corrida semanal
  // por ranking da loja (1º/2º com cota) e prêmio de desvio de cota da REDE.
  // O plano fica em config_json (store_id '*' = rede toda; loja específica tem
  // precedência). Nada aqui paga sozinho: a apuração vira RUN draft (Fase G) e
  // a aprovação continua humana (D7).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_commission_plans (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL DEFAULT '*',      -- '*' = rede; senão retail_stores.id
        config_json TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE (organization_id, store_id)
      );

      -- Cota individual do vendedor POR SEMANA da corrida (a planilha cadastra
      -- cota semanal por vendedor; a mensal é a soma das semanas). Sem linha
      -- aqui, a cota do vendedor é DERIVADA: cota diária da loja ÷ nº de
      -- escalados no dia (exatamente o "COTA ÷ 4" da folha de fechamento).
      CREATE TABLE IF NOT EXISTS retail_seller_quotas (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        seller_key TEXT NOT NULL,                -- mat:<matricula> | nom:<nome normalizado> | user:<id>
        seller_name TEXT,
        week_start TEXT NOT NULL,                -- YYYY-MM-DD (1º dia da semana da corrida)
        quota_amount REAL NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE (organization_id, store_id, seller_key, week_start)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_seller_quotas
        ON retail_seller_quotas (organization_id, store_id, week_start);

      -- Escala semanal da loja (o quadro dia × vendedor do cliente): 'work'
      -- trabalha, 'off' folga. É planejamento operacional — a linha pode ser
      -- regravada ao editar a semana (não é documento com retenção).
      CREATE TABLE IF NOT EXISTS retail_schedule_entries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        work_date TEXT NOT NULL,                 -- YYYY-MM-DD
        seller_key TEXT NOT NULL,
        seller_name TEXT,
        status TEXT NOT NULL DEFAULT 'work',     -- work | off
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE (organization_id, store_id, work_date, seller_key)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_schedule_entries
        ON retail_schedule_entries (organization_id, store_id, work_date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas ADR-083 Fase G2 (corrida/escala)', e); }
  // A folha de fechamento traz AT (atendimentos) por vendedor — é o denominador
  // do P.A (peças ÷ atendimentos). Aditivo no lançamento manual/foto.
  try { db.exec(`ALTER TABLE retail_seller_sales ADD COLUMN atendimentos REAL DEFAULT 0`); } catch(e){}

  // ============================================================
  // ADR-083 — Fase C2: fechamento noturno completo (padrão da folha da loja)
  // ============================================================
  // A folha real tem MUITO mais que totais por forma de pagamento: crédito e
  // débito POR BANDEIRA, despesas do dia, ranking por vendedor (valor/AT/peças),
  // cadastros, range de boletas, malote, prêmio do dia e a conferência com o
  // resumo do POS. Tudo vive em details_json (estrutura no header do
  // RetailClosingService.submitDetailed) — aditivo, NULL pros fechamentos
  // antigos, que continuam operando só com informed_total/items.
  try { db.exec(`ALTER TABLE retail_daily_closings ADD COLUMN details_json TEXT`); } catch(e){}
  // Bandeiras de cartão da loja (maquininhas variam por loja). NULL = default
  // da folha do cliente (Amex/Master/Visa/Elo no crédito; Redshop/Eletron/Elo
  // no débito).
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN card_brands_json TEXT`); } catch(e){}

  // ============================================================
  // ADR-083 — Fase C3: boletas em tempo real (hora real da venda)
  // ============================================================
  // A loja vende com boleta MANUSCRITA de talão sequencial e só lança no PDV
  // à noite — a hora real de cada venda se perdia. Agora: o gerente abre o
  // dia com o nº inicial do talão; a cada venda alguém CLICA no botão e o
  // servidor grava o próximo nº da sequência + o timestamp (a hora do clique
  // É a hora da venda). No fechamento, o range informado confere com os
  // cliques, e o nº da boleta casa com a venda do PDV (retail_pdv_sales.boleta)
  // quando o lançamento noturno sincroniza — clique (hora) × PDV (valor).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_boleta_days (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        day TEXT NOT NULL,                       -- YYYY-MM-DD (data local da loja)
        initial_number TEXT NOT NULL,            -- nº da 1ª boleta do dia, com zeros ("017752")
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE (organization_id, store_id, day)
      );

      -- Um clique = uma venda realizada AGORA. Nunca DELETE (convenção #9):
      -- desfazer é UPDATE status='cancelled' (só o último ativo, pra sequência
      -- não furar). seq é a posição do clique; o nº exibido deriva do inicial.
      CREATE TABLE IF NOT EXISTS retail_boleta_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        day TEXT NOT NULL,
        boleta_number TEXT NOT NULL,             -- nº formatado como no talão
        seq INTEGER NOT NULL,                    -- posição na sequência do dia (1..N)
        seller_name TEXT,                        -- opcional: quem vendeu
        status TEXT NOT NULL DEFAULT 'active',   -- active | cancelled
        clicked_by TEXT,
        clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        cancelled_by TEXT,
        cancelled_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_boleta_events_active
        ON retail_boleta_events (organization_id, store_id, day, boleta_number) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_retail_boleta_events_day
        ON retail_boleta_events (organization_id, store_id, day);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas ADR-083 Fase C3 (boletas)', e); }

  // ADR-083 Fase G2b — Template de FOLGA por vendedor (Rafaela sempre folga
  // segunda; Estefânio sempre terça). Uma linha por (loja, vendedor, dia da
  // semana 0-6=dom-sáb). O "Aplicar no mês" gera as linhas 'off' em
  // `retail_schedule_entries` pros dias-da-semana marcados, respeitando o que
  // já tá lançado (não sobrescreve; pula datas que já têm entrada).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_seller_off_pattern (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        seller_key TEXT NOT NULL,                -- mesmo formato de retail_schedule_entries
        seller_name TEXT,
        day_of_week INTEGER NOT NULL,            -- 0=domingo … 6=sábado (JS getUTCDay)
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, store_id, seller_key, day_of_week)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_seller_off_pattern
        ON retail_seller_off_pattern (organization_id, store_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela ADR-083 G2b (template de folga)', e); }

  // ADR-083 Fase R1 — Conferência de RECEBÍVEIS DE CARTÃO contra o adquirente
  // (Sicredi, no começo). O PDV/Alterdata já devolve o que a LOJA VIU
  // ('retail_pdv_card_installments'); aqui guardamos o que o ADQUIRENTE diz
  // que vai depositar/depositou. O cruzamento vira dashboard "match | diverge
  // | só PDV | só adquirente" — sem HTTP ainda (aguarda credenciais Sicredi);
  // enquanto isso, POST /card-acquirer/import aceita JSON manual pra teste.
  //
  // Chave de match: (source, numero_transacao, parcela). Fonte 'manual' é
  // válida (você envia o extrato exportado do internet banking).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_card_acquirer_installments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'sicredi',   -- 'sicredi' | 'manual' | (futuro: cielo, rede, stone)
        filial TEXT,                              -- opcional: id da filial do PDV pra amarrar
        merchant_id TEXT,                         -- código do estabelecimento (EC) no adquirente
        numero_transacao TEXT,                    -- NSU (Número Sequencial Único) — chave de match
        autorizacao TEXT,                         -- código de autorização
        bandeira TEXT,                            -- 'Visa' | 'Master' | 'Elo' | ...
        produto TEXT,                             -- 'crédito' | 'débito' | 'crédito parcelado'
        parcela TEXT,                             -- rótulo tipo '1/3'
        parcela_num INTEGER,
        parcelas_total INTEGER,
        data_venda TEXT,                          -- YYYY-MM-DD
        data_vencimento TEXT NOT NULL,            -- YYYY-MM-DD (quando cai)
        valor_bruto REAL DEFAULT 0,
        valor_liquido REAL DEFAULT 0,
        taxa REAL DEFAULT 0,                      -- % ou R$ (livre; a fonte informa)
        status TEXT DEFAULT 'previsto',           -- 'previsto' | 'pago' | 'cancelado' | 'chargeback'
        raw_json TEXT,                            -- payload original pra auditoria
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, source, numero_transacao, parcela)
      );
      CREATE INDEX IF NOT EXISTS idx_retail_card_acquirer_venc
        ON retail_card_acquirer_installments (organization_id, data_vencimento);
      CREATE INDEX IF NOT EXISTS idx_retail_card_acquirer_nsu
        ON retail_card_acquirer_installments (organization_id, numero_transacao);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela ADR-083 R1 (adquirente)', e); }

  // ADR-083 Fase G2c — CORTE variável das semanas do mês. Nem sempre a semana
  // fecha no domingo (padrão da planilha CARIOCA): o cliente pode querer sem1
  // 01→10, sem2 11→18, sem3 19→25, sem4 26→31 pra encaixar melhor com a
  // realidade da loja. Override é REDE-WIDE (mesma corrida cruza lojas —
  // cortes por loja quebrariam o ranking); sem override, o cálculo cai no
  // `weeksOfMonth` original (semana no domingo + fusão < 4 dias).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_month_weeks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        year_month TEXT NOT NULL,                -- 'YYYY-MM'
        weeks_json TEXT NOT NULL,                -- '[{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"},…]'
        created_by TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, year_month)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela ADR-083 G2c (corte das semanas)', e); }

  // ADR-151 — FalaTu (captura multimodal "Fala → Faz → Confere"). Fase 1:
  // exclusivo do Master Admin (gate na rota), mas TODAS as tabelas já nascem
  // com organization_id + user_id pra convenção nº 1 valer desde o dia 1 —
  // o rollout multi-tenant (Fatia 2) troca só o gate, não o schema.
  // Nunca DELETE (convenção nº 9): discard/desfazer é UPDATE de status.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS falatu_inbox_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'webapp',   -- 'webapp' | (futuro: 'whatsapp' via canal interno, Fatia 3)
        content TEXT,                            -- texto original digitado (ou legenda da mídia)
        media_type TEXT,                         -- 'audio' | 'image' | NULL (só texto)
        transcription TEXT,                      -- transcrição do áudio / texto extraído da imagem
        summary TEXT,
        intent TEXT,                             -- 'TASK' | 'EVENT' | 'LIST' | 'NOTE' | 'UNKNOWN'
        entities_json TEXT,                      -- {people[], projects[], actions[], listItems[], eventDate, eventTime}
        suggested_action TEXT,
        confidence REAL,                         -- 0..1 (RN-151: obrigatório na extração)
        status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'discarded'
        confirmed_kind TEXT,                     -- 'task' | 'event' | 'list' (o que a confirmação materializou)
        confirmed_ref_id TEXT,                   -- id da entidade criada na confirmação
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_falatu_inbox_user
        ON falatu_inbox_items (organization_id, user_id, status);

      CREATE TABLE IF NOT EXISTS falatu_tasks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        inbox_item_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_falatu_tasks_user
        ON falatu_tasks (organization_id, user_id, completed);

      CREATE TABLE IF NOT EXISTS falatu_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        event_date TEXT,                         -- YYYY-MM-DD; NULL quando a entrada não trouxe data (RN-151: nunca inventar)
        event_time TEXT,                         -- HH:MM
        inbox_item_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_falatu_events_user
        ON falatu_events (organization_id, user_id, event_date);

      CREATE TABLE IF NOT EXISTS falatu_lists (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        list_type TEXT NOT NULL DEFAULT 'general', -- 'general' | 'shopping' | 'meeting' | 'trip'
        status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'archived'
        inbox_item_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_falatu_lists_user
        ON falatu_lists (organization_id, user_id, status);

      -- organization_id repetido aqui de propósito (denormalizado): permite o
      -- toggle validar dono em uma query só, sem depender de JOIN correto em
      -- cada call-site — o IDOR da origem nasceu exatamente desse esquecimento.
      CREATE TABLE IF NOT EXISTS falatu_list_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        name TEXT NOT NULL,
        quantity TEXT,
        planned INTEGER NOT NULL DEFAULT 1,
        realized INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_falatu_list_items_list
        ON falatu_list_items (organization_id, list_id);

      -- name_norm (lower/trim) na unique: a origem duplicava "Carlos"/"carlos"
      -- a cada confirmação. Upsert atualiza só o contexto mais recente.
      CREATE TABLE IF NOT EXISTS falatu_entities (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,               -- 'PERSON' | 'COMPANY' | 'PROJECT'
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        UNIQUE (organization_id, user_id, entity_type, name_norm)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas ADR-151 (FalaTu)', e); }

  // ADR-151 Fatia 2 — rollout multi-tenant do FalaTu: flag opt-in por org
  // (convenção nº 10). O Master Admin segue com acesso independente da flag
  // (gate na rota); clientes só enxergam o módulo quando o operador liga aqui.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_enabled INTEGER DEFAULT 0`); } catch(e){}

  // ADR-151 Fatia 4 — compras com conferência: lista planejada × nota fiscal
  // fotografada. Cada conferência congela a LEITURA da nota (invoice_json,
  // snapshot — reler a foto depois pode dar outra leitura) e o MATCHING
  // sugerido (matching_json). O humano resolve (confirmed/discarded); nunca
  // DELETE (convenção nº 9). O que a confirmação marcou vive nos próprios
  // falatu_list_items (realized) — aqui fica o registro da conferência.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS falatu_purchase_checks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        supplier_name TEXT,
        invoice_json TEXT NOT NULL,               -- snapshot da leitura ADR-021 {supplierName, items[], confidence}
        matching_json TEXT NOT NULL,              -- {matched[], missing[], extras[]} sugeridos (o humano decide)
        confidence INTEGER,                       -- 0..100 geral da leitura da nota
        status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'confirmed' | 'discarded'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_falatu_purchase_checks_list
        ON falatu_purchase_checks (organization_id, list_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela ADR-151 F4 (conferência de compras)', e); }

  // ADR-151 Fatia 5 — memória com desambiguação ativa: a captura consulta a
  // memória (falatu_entities) e registra aqui o resultado por menção
  // ({mentions:[{mention,type,status,candidates[],resolvedEntityId,resolvedNew}]}).
  // 'ambiguous' (2+ candidatos) NUNCA é resolvido pela IA nem por auto-link:
  // fica pendente até o humano escolher ("qual Carlos?") — sem escolha, a
  // confirmação segue sem vincular nem criar a entidade daquela menção.
  try { db.exec(`ALTER TABLE falatu_inbox_items ADD COLUMN memory_json TEXT`); } catch(e){}

  // ADR-151 Fatia 6 — entrega do briefing diário por WhatsApp (consome os
  // sinais falatu_daily_briefing publicados na Fatia 5). Opt-in por org do
  // CANAL de saída (convenção nº 10): mandar mensagem proativa é outbound, então
  // é uma porta separada da flag falatu_enabled (que só liga o módulo). Default
  // 0. A entrega é deduplicada por (org, usuário, dia) numa tabela best-effort
  // (convenção nº 7/8: unique index + insert que ignora conflito) — mesmo papel
  // do teacher_profiles.last_agenda_date, mas o FalaTu não tem tabela de perfil.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_briefing_wa_enabled INTEGER DEFAULT 0`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS falatu_briefing_deliveries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        briefing_date TEXT NOT NULL,             -- YYYY-MM-DD no fuso de São Paulo
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, user_id, briefing_date)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar falatu_briefing_deliveries (ADR-151 F6)', e); }

  // PRD 1 Fase 8 (§42-47) — entrega proativa event-driven: opt-in por org +
  // dedup por (usuário, item) pra o alerta urgente disparar UMA vez (§44 não spam).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_proactive_alerts_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 2 F3.2 — opt-in: quando ligado, o attention() colapsa sinais correlatos
  // (mesma situação) num item-situação único em vez de N sinais soltos.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_attention_correlate_enabled INTEGER DEFAULT 0`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS falatu_proactive_deliveries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        item_key TEXT NOT NULL,                  -- {categoria}:{id} do item da Smart Inbox
        delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, user_id, item_key)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar falatu_proactive_deliveries (PRD 1 Fase 8)', e); }

  // PRD 1 Fase 7 (§80) — chat interno FUNDAÇÃO-SÓ: NÃO é um clone de Slack. São
  // NOTAS de equipe ancoradas a um CASO (correlation_id) — "deixa um recado pro
  // colega SOBRE esta decisão/aprovação". O valor é operar o ZapFlow, não bate-
  // papo. to_user_id NULL = nota do caso (visível a quem vê o caso).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS internal_messages (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT,                         -- NULL = nota do caso (broadcast p/ quem vê o caso)
        correlation_id TEXT,                     -- o caso a que a nota se ancora (espinha ADR-158)
        body TEXT NOT NULL,
        read_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_internal_messages_inbox ON internal_messages (organization_id, to_user_id, created_at);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_internal_messages_thread ON internal_messages (organization_id, correlation_id);`);
  } catch(e){ console.error('[DB] Falha ao criar internal_messages (PRD 1 Fase 7)', e); }

  // ADR-152 Fatia 1.1 — ZappFlow Execution Runtime (Process Fabric). O Runtime
  // é ADITIVO em cima do ADR-136 (decision_actions), não paralelo: `decision_
  // actions.process_instance_id` (nullable) amarra ação↔processo — ações
  // avulsas legadas continuam funcionando. Novo módulo RBAC "runtime" no
  // ADR-095. Feature flag `execution_runtime_enabled` default 0 mantém o
  // comportamento intacto em todas as orgs existentes.
  //
  // FSM do §11.4 (validada em ProcessRuntimeService.transition):
  //   detected → planned → awaiting_approval → authorized → queued →
  //   executing → waiting_external_response → completed | failed | escalated
  //   → measured (terminal), com cancelled como saída a qualquer momento e
  //   retry_scheduled/escalated como sub-estados de recuperação.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS process_definitions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        process_type TEXT NOT NULL,               -- ex.: 'retail_daily_closing_v1'
        name TEXT NOT NULL,
        description TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        trigger_type TEXT,                        -- signal | manual | schedule | webhook
        objective TEXT,
        autonomy_level_default TEXT NOT NULL DEFAULT 'suggest', -- observe|suggest|prepare|execute
        sla_definition_json TEXT,
        entry_conditions_json TEXT,
        success_conditions_json TEXT,
        failure_conditions_json TEXT,
        escalation_policy_json TEXT,
        steps_json TEXT NOT NULL,                 -- validado por PlaybookEngine no boot da definição
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, process_type, version)
      );
      CREATE INDEX IF NOT EXISTS idx_process_definitions_org_type
        ON process_definitions (organization_id, process_type, active);

      CREATE TABLE IF NOT EXISTS process_instances (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        process_definition_id TEXT NOT NULL,
        process_type TEXT NOT NULL,
        subject_type TEXT,                        -- ex.: 'invoice', 'opportunity', 'retail_store_day'
        subject_id TEXT,
        status TEXT NOT NULL DEFAULT 'detected',  -- FSM §11.4
        priority INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT,                          -- low|medium|high
        expected_value REAL,
        current_step TEXT,                        -- id do step no steps_json
        context_json TEXT NOT NULL DEFAULT '{}',  -- entradas + acúmulo de resultados por step
        result_json TEXT,                         -- resultado final ao concluir
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deadline_at DATETIME,
        completed_at DATETIME,
        failed_at DATETIME,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_process_instances_org_status
        ON process_instances (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_process_instances_org_type
        ON process_instances (organization_id, process_type, status);
      CREATE INDEX IF NOT EXISTS idx_process_instances_subject
        ON process_instances (organization_id, subject_type, subject_id);

      -- Toda transição relevante da FSM auditada (PRD §11.4).
      CREATE TABLE IF NOT EXISTS process_transitions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        process_instance_id TEXT NOT NULL,
        from_state TEXT,                          -- NULL na criação
        to_state TEXT NOT NULL,
        actor TEXT,                               -- userId | 'runtime' | 'system'
        reason TEXT,
        evidence_json TEXT,
        occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_process_transitions_instance
        ON process_transitions (organization_id, process_instance_id, occurred_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas ADR-152 F1.1 (Execution Runtime)', e); }

  // Aditivos em decision_actions (ADR-152 D2) — todos nullable, retrocompatíveis
  // com as ~30 rotas que já consomem a tabela (ADR-136 D5). Ação sem
  // process_instance_id continua sendo "ação avulsa" (comportamento atual).
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN process_instance_id TEXT`); } catch(e){}
  // PRD 2 F2.3 (§75, CA14) — fecha o furo da espinha: o processo iniciado pelo
  // router de sinais também carrega o correlation_id da cadeia (antes só
  // signals/decision_actions/action_outcomes/action_execution_log tinham). Aditivo.
  try { db.exec(`ALTER TABLE process_instances ADD COLUMN correlation_id TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_process_instances_corr ON process_instances (organization_id, correlation_id)`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN subject_type TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN subject_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN deadline_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN attempt_count INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN max_attempts INTEGER DEFAULT 3`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN success_condition_json TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN fallback_action_type TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN evidence_json TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_actions_process ON decision_actions (organization_id, process_instance_id)`); } catch(e){}

  // Gate geral do Runtime (ADR-152 D10) — sem flag, /api/runtime/* retorna 403.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN execution_runtime_enabled INTEGER DEFAULT 0`); } catch(e){}

  // ADR-152 Fatia 2.1 — fundação do modo `execute` governado e da confirmação
  // externa. Nenhum handler ainda executa efeito externo nesta fatia; isto
  // aqui é o schema/infra que a Fatia 2.2 (executor) e 2.3 (handlers reais)
  // vão usar. Todos os aditivos são retrocompatíveis (nullable/defaults).
  //
  // execution_mode (ADR-152 D7) na policy da org:
  //   shadow — playbook roda mas nenhum efeito externo (só grava o plano)
  //   assisted — comportamento atual, materializa em decision_actions
  //   approved_execution — executa após aprovação humana
  //   autonomous — executa dentro da política sem parar em aprovações
  try { db.exec(`ALTER TABLE agent_policies ADD COLUMN execution_mode TEXT DEFAULT 'assisted'`); } catch(e){}

  // Aditivos no JobQueue: backoff exponencial + classificação de erro. O
  // JobQueueService (ADR-073) já retenta até max_attempts; o que faltava era
  // (a) esperar backoff antes de re-executar; (b) classificar o erro pra
  // saber se retenta (retryable), escala (permission), aguarda serviço
  // (external_unavailable) ou desiste (non_retryable). Dead-letter formal já
  // existe como `status='failed'` — a UI da Fase 3 vai exibir.
  try { db.exec(`ALTER TABLE background_jobs ADD COLUMN backoff_seconds INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE background_jobs ADD COLUMN next_attempt_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE background_jobs ADD COLUMN error_class TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_background_jobs_next_attempt ON background_jobs(status, next_attempt_at)`); } catch(e){}

  // Confirmation Engine (PRD §11.10) — action → confirmação externa esperada.
  // UMA confirmação viva por ação (UNIQUE): se o executor manda 2 vezes, é
  // dedupado. `status pending → confirmed | timed_out | dismissed`. Terminal
  // por evento externo (webhook Asaas, reconciliação, resposta em canal); a
  // Fase 2.3 pluga os subscribers. `evidence_json` é a prova auditável.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_confirmations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        confirmation_method TEXT NOT NULL,        -- asaas_payment_webhook | retail_reconciliation | channel_reply | alterdata_sync | manual
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | timed_out | dismissed
        expected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deadline_at DATETIME,
        confirmed_at DATETIME,
        evidence_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, action_id)
      );
      CREATE INDEX IF NOT EXISTS idx_action_confirmations_pending
        ON action_confirmations (organization_id, status, deadline_at);
      CREATE INDEX IF NOT EXISTS idx_action_confirmations_method
        ON action_confirmations (organization_id, confirmation_method, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar action_confirmations (ADR-152 F2.1)', e); }

  // ADR-152 Fatia 2.3 — handlers concretos + webhook Asaas → Confirmation.
  // `external_ref` amarra a confirmação a um id EXTERNO do subscriber (payment
  // do Asaas, sync run do Alterdata, message id do WhatsApp, ...). Quando o
  // evento externo chega, o subscriber procura a confirmação por (org?,
  // method, external_ref) — sem `orgId` do lado do subscriber, o RESOLVE
  // recupera a org da própria linha (padrão do webhook Asaas: só o payment.id
  // chega, não a org). UNIQUE(org, method, external_ref) evita amarrar 2
  // confirmações à mesma ref (idempotência forte).
  try { db.exec(`ALTER TABLE action_confirmations ADD COLUMN external_ref TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_action_confirmations_extref ON action_confirmations (organization_id, confirmation_method, external_ref) WHERE external_ref IS NOT NULL`); } catch(e){}

  // ADR-152 Fatia 3.1 — Outcomes estendidos (PRD §11.11). O
  // `action_outcomes` (ADR-136 D6) já registra esperado × realizado com
  // basis fact/estimate SEPARADOS; a Fase 3 acrescenta 4 CATEGORIAS
  // explícitas pra alimentar o painel "Concluído hoje" da aba Operações
  // (Fatia 3.2): tempo devolvido ao gestor, custo evitado, receita
  // recuperada, perda evitada. Todos nullable e ADITIVOS — o ledger()
  // continua funcionando; quem já registrou outcome sem esses campos
  // continua correto (default null). NUNCA somar categorias diferentes
  // num número único enganoso (ADR-085 D4 — a separação é o que dá
  // credibilidade).
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN time_saved_minutes INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN cost_avoided REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN revenue_recovered REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN loss_prevented REAL`); } catch(e){}

  // ADR-152 Fatia 4b.3 — cadência multi-tentativa de cobrança + re-emissão
  // automática de PIX. Nova tabela `collection_followup_attempts` guarda
  // as tentativas 2 e 3 enviadas (a 1ª é implícita — sempre existe via
  // send_reminder do playbook). UNIQUE(org, action, attempt_number)
  // garante idempotência forte do Scheduler.collectionCadencePass (2
  // ticks concorrentes ou 2 workers não duplicam envio).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_followup_attempts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,       -- 2 (firme) | 3 (aviso de negativação)
        template_key TEXT,                     -- 'firm' | 'default_notice'
        message_id TEXT,                       -- wamid ou id do provedor
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_followup_unique
        ON collection_followup_attempts (organization_id, action_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_collection_followup_action
        ON collection_followup_attempts (organization_id, action_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar collection_followup_attempts (ADR-152 F4b.3)', e); }
  // Aditivos opt-in em organization_settings. `collection_cadence_enabled=0`
  // por default garante que orgs pré-existentes NÃO passam a receber
  // cobranças automáticas T2/T3 sem o dono ativar. Dias configuráveis via
  // CLI/API por org (padrão do PRD §13.5).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_cadence_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_reminder_2_days_after_due INTEGER DEFAULT 3`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_reminder_3_days_after_due INTEGER DEFAULT 7`); } catch(e){}

  // ADR-152 Fatia 4b.4 — re-check automático de promessa de pagamento.
  // Quando o intent classifier (F4b.2) detecta `promise` na resposta do
  // cliente, o CollectionReplyService cria uma linha aqui com a data
  // prometida (extraída pelo LLM ou fallback "hoje+3"). A cada tick do
  // Scheduler, `collectionPromiseCheckPass` percorre promises `pending`
  // cuja `promised_date` chegou e:
  //   - se receivable virou 'received' → marca `fulfilled` + resolve o
  //     sinal reply_promise (fecha o loop no painel);
  //   - se ainda `open` → marca `broken` + envia WhatsApp de follow-up +
  //     publica sinal severity=risk pro dono acompanhar.
  //
  // UNIQUE parcial (só `pending`) permite que uma nova promessa depois
  // de broken/fulfilled seja criada — cliente pode prometer 2× (adia).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_payment_promises (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        action_id TEXT NOT NULL,             -- decision_action collection_send_reminder amarrada
        receivable_id TEXT,
        contact_id TEXT,
        phone TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        amount REAL,                         -- valor prometido; default = amount original
        due_date TEXT NOT NULL,              -- YYYY-MM-DD vencimento do receivable
        promised_date TEXT NOT NULL,         -- YYYY-MM-DD quando cliente prometeu pagar
        promised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'pending',       -- pending | fulfilled | broken | escalated | cancelled
        checked_at DATETIME,                 -- último tick que passou por essa promessa
        signal_id TEXT,                      -- id do business_signal reply_promise (dedupe pra resolveByDedupe)
        source TEXT DEFAULT 'llm'            -- 'llm' | 'default' | 'manual'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_promise_action_pending
        ON collection_payment_promises (organization_id, action_id)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_collection_promise_check
        ON collection_payment_promises (organization_id, status, promised_date);
    `);
  } catch(e){ console.error('[DB] Falha ao criar collection_payment_promises (ADR-152 F4b.4)', e); }
  // Dias de graça pós-promessa antes de marcar broken (default 0 =
  // marca broken no MESMO dia da promessa que passou). Configurável por-org.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_promise_grace_days INTEGER DEFAULT 0`); } catch(e){}

  // ADR-152 Fatia 4c — Piloto Recuperação Comercial (MVP em modo
  // approved_execution — SEM autonomous, que exige LGPD signoff).
  // Runtime DETECTA deals parados (tickets no funil sem update recente)
  // e PROPÕE mensagem de reengajamento via LLM — mas NUNCA envia sem
  // aprovação humana (rota POST /api/runtime/sales-recovery/approve/:id).
  //
  // Opt-in por org: sem `sales_recovery_enabled=1`, o detector nunca
  // varre. `sales_recovery_stalled_days` = quantos dias sem update pra
  // um ticket ser considerado parado (default 10).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_stalled_days INTEGER DEFAULT 10`); } catch(e){}

  // ADR-152 Fatia 4c.2 — reply router de recuperação comercial.
  // Rastreia CADA envio aprovado (approve() da F4c MVP) pra o reply
  // router poder correlacionar respostas do cliente com o touch mais
  // recente. Também guarda a resposta interpretada (intent + signal)
  // pra o dono ver histórico completo.
  //
  // `contacts.marketing_opt_out` (já existente) é a fonte da verdade
  // LGPD — não criamos tabela dedicada de opt-out, só setamos essa
  // flag quando o cliente responde intent=`remove_me`.
  //
  // Janela de correlação: reply é considerada "sobre a recuperação"
  // se veio em até `sales_recovery_reply_window_days` (default 14).
  // Depois disso, cai no fluxo normal (IA).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_recovery_touches (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        proposed_signal_id TEXT,          -- ID do business_signal sales_recovery_proposed
        approved_by TEXT,                 -- user_id que aprovou
        message_id TEXT,                  -- wamid do provider
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reply_received_at DATETIME,       -- populado quando cliente responde
        reply_intent TEXT,                -- interested | meeting_request | not_now | objection | remove_me | already_bought | unknown
        reply_signal_id TEXT              -- ID do business_signal sales_recovery_reply_* criado
      );
      CREATE INDEX IF NOT EXISTS idx_sales_recovery_touches_contact
        ON sales_recovery_touches (organization_id, contact_id, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_recovery_touches_phone
        ON sales_recovery_touches (organization_id, phone, sent_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_recovery_touches_ticket
        ON sales_recovery_touches (organization_id, ticket_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar sales_recovery_touches (ADR-152 F4c.2)', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_reply_window_days INTEGER DEFAULT 14`); } catch(e){}

  // ADR-152 Fatia 4c.3 — cadência multi-tentativa de recuperação
  // comercial. AINDA em modo approved_execution — cada 2ª/3ª msg é
  // PROPOSTA (sinal + reply canned) mas o envio real continua exigindo
  // dono clicar "aprovar" (G-4c.3-1). Modo autonomous continua
  // BLOQUEADO na decisão #4 LGPD.
  //
  // Opt-in DENTRO do opt-in F4c — org pode ter recuperação MVP
  // (`sales_recovery_enabled=1`) sem follow-up automático. Gap entre
  // tentativas configurável (default 5 dias — mais suave que cobrança;
  // recuperação é conversa aberta).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_followup_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_followup_days_gap INTEGER DEFAULT 5`); } catch(e){}

  // ADR-152 Fatia 4c.4 — atribuição de revenue_recovered real. Quando
  // um ticket vira `stage=ganho` (via kanban manual, `POST /tickets/
  // :id/stage` — `routes/tickets.ts:153`) DEPOIS de uma proposta de
  // recuperação aprovada, o Runtime atribui o valor real da venda ao
  // outcome F3.1 (revenueRecovered).
  //
  // Precedente: ADR-136 RIC `ric_recovery_actions` já atribui revenue
  // por campanha; F4c.4 aplica a mesma lógica pra pilotos autônomos.
  //
  // UNIQUE(org, ticket_id, stage_change_at) — reversal edge (ganho →
  // aberto → ganho de novo) atribui 2× (eventos distintos).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sales_recovery_attributions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        touch_id TEXT,                        -- FK sales_recovery_touches (touch mais recente pré-ganho)
        action_id TEXT,                       -- FK decision_actions (mesma action do touch)
        stage_change_at DATETIME NOT NULL,    -- timestamp do ticket_stage_logs.created_at
        ticket_value REAL NOT NULL,           -- valor da venda calculado (soma orders / quotes / avg)
        revenue_recovered REAL NOT NULL,      -- = ticket_value (por ora idêntico; poderia aplicar attribution %)
        source TEXT NOT NULL,                 -- 'orders' | 'quotes' | 'contacts_avg_ticket' | 'zero'
        basis TEXT NOT NULL,                  -- 'fact' (source=orders) | 'estimate' (demais)
        outcome_id TEXT,                      -- action_outcomes.id gerado
        attributed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_recovery_attr_dedupe
        ON sales_recovery_attributions (organization_id, ticket_id, stage_change_at);
      CREATE INDEX IF NOT EXISTS idx_sales_recovery_attr_ticket
        ON sales_recovery_attributions (organization_id, ticket_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar sales_recovery_attributions (ADR-152 F4c.4)', e); }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_attribution_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_attribution_window_days INTEGER DEFAULT 30`); } catch(e){}

  // ADR-153 F3.1 — Vertical Blueprints (produtos por nicho versionados).
  //
  // Um Blueprint = SKU comercial vendido pra uma vertical/nicho específico:
  // moda_loja_unica_v1, moda_rede_lojas_v1, clinica_multiespecialidades_v1,
  // chaveiro_autonomo_v1, peixaria_balcao_peso_v1 (PRD §9/§10).
  //
  // Imutabilidade: uma vez `status='published'`, o `config_json` NÃO pode ser
  // alterado. Correção = nova versão (mesmo `key`, `version+1`). Enforcement
  // no VerticalBlueprintService (não em constraint SQL — flexível pra migração
  // manual). UNIQUE(key, version) impede duplicar acidentalmente.
  //
  // Ordem: SEMPRE aditivo. Nenhum service pré-existente lê essas tabelas até
  // F3.2 amarrar org→blueprint (F1.4 substitui HIDDEN_BY_VERTICAL estático).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vertical_blueprints (
        id TEXT PRIMARY KEY,                  -- randomUUID por versão
        key TEXT NOT NULL,                    -- 'clinica_multiespecialidades' (semver sem _v1)
        name TEXT NOT NULL,                   -- rótulo comercial ("ZappFlow Clínica")
        base_vertical TEXT NOT NULL,          -- 'saude' | 'varejo' | 'servicos' | etc.
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'published' | 'deprecated'
        minimum_plan_id TEXT,                 -- ex.: 'growth' (Blueprint Clínica)
        default_plan_id TEXT,                 -- default do onboarding
        default_bundle_key TEXT,              -- opcional: aponta pra PLAN_BUNDLES (ex.: 'growth_clinica')
        config_json TEXT NOT NULL,            -- {requiredModules, optionalModules, hiddenModules, commercialUpgrades, quickStartPack, runtimePlaybooks}
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        published_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vertical_blueprints_key_version
        ON vertical_blueprints (key, version);
      CREATE INDEX IF NOT EXISTS idx_vertical_blueprints_status
        ON vertical_blueprints (status, base_vertical);
    `);
  } catch(e){ console.error('[DB] Falha ao criar vertical_blueprints (ADR-153 F3.1)', e); }

  // organization_blueprints: 1 org → 1 blueprint aplicado (upgrade de versão via
  // rota admin — F3.3). overrides_json guarda personalizações do dono que não
  // devem sumir num upgrade de versão (branding, horário, mensagens — PRD §24.3).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS organization_blueprints (
        organization_id TEXT PRIMARY KEY,
        blueprint_id TEXT NOT NULL,           -- FK vertical_blueprints.id (versão específica)
        blueprint_key TEXT NOT NULL,          -- denormalizado (query rápida sem JOIN)
        blueprint_version INTEGER NOT NULL,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        assigned_by TEXT,                     -- user_id do master admin (audit)
        overrides_json TEXT,                  -- overrides do dono (opcional)
        status TEXT NOT NULL DEFAULT 'active' -- 'active' | 'migrating' | 'suspended'
      );
      CREATE INDEX IF NOT EXISTS idx_organization_blueprints_key
        ON organization_blueprints (blueprint_key, blueprint_version);
    `);
  } catch(e){ console.error('[DB] Falha ao criar organization_blueprints (ADR-153 F3.1)', e); }

  // ADR-153 F3.2 — Seed idempotente dos 5 blueprints iniciais (moda_loja_unica,
  // moda_rede_lojas, clinica_multiespecialidades, chaveiro_autonomo,
  // peixaria_balcao_peso), todos em versão 1 publicada. `BlueprintSeeder` checa
  // por (key, version) antes de criar — 2× não duplica. Import dinâmico pra
  // evitar ciclo (db.ts é importado por VerticalBlueprintService).
  try {
    // Só seedar quando as tabelas base existem (defensa contra ordem de init).
    const hasBp = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vertical_blueprints'").get();
    if (hasBp) {
      // Dynamic import; erros aqui NÃO devem quebrar a inicialização do app
      // (o seed é operacional, não crítico — se falhar, admin roda manual).
      import("./BlueprintSeeder.js").then((m) => {
        try { m.BlueprintSeeder.seedInitialBlueprints(); }
        catch (e) { console.error('[DB] Seed inicial de blueprints falhou (ADR-153 F3.2)', e); }
      }).catch((e) => {
        console.error('[DB] Falha ao importar BlueprintSeeder (ADR-153 F3.2)', e);
      });
    }
  } catch(e) { console.error('[DB] Falha ao seedar blueprints iniciais (ADR-153 F3.2)', e); }

  // ADR-153 F7.3 — Frequency control + histórico de recomendações de upgrade.
  //
  // PRD §14/§15 + Decisão #7: quando dono dispensa uma recomendação, ela não
  // pode ser re-oferecida no MESMO alvo (target_plan_id + target_module_key)
  // pelos próximos N dias. Escala 30d → 90d → 180d na sequência de rejeições
  // (RN-153-F7.3-002; 180d é o teto). Cooldown NÃO se aplica a severity=critical
  // — cliente já travado (uso ≥100%) precisa saber (RN-153-F7.3-003).
  //
  // Ao publicar um sinal `domain='plan'`, `PlanFitSignalPublisher` grava/atualiza
  // uma linha aqui apontando pro signal_id — histórico auditável separado do
  // ledger genérico de sinais. Ao dispensar via /api/signals/:id/dismiss OU
  // /api/billing/recommendations/:id/dismiss, incrementa rejection_count e
  // seta cooldown_until.
  //
  // status: 'pending' | 'accepted' | 'dismissed' | 'expired'. `expired` é
  // aplicado lazy — quando cooldown_until < now e alguém lista/varre.
  //
  // Isolamento multi-tenant: organization_id em toda query.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS upgrade_recommendations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        signal_id TEXT,                        -- FK business_signals.id (nullable — sinal pode ter sido purgado)
        signal_type TEXT NOT NULL,             -- plan_near_limit_ai | plan_module_gap | etc.
        target_plan_id TEXT,                   -- 'growth' | 'scale' | 'enterprise' | null
        target_module_key TEXT,                -- pra plan_module_gap; null pra near_limit
        score INTEGER NOT NULL DEFAULT 0,      -- 0-100
        impact_amount REAL,                    -- BRL/mês estimado
        impact_unit TEXT,                      -- 'BRL' | null
        evidence_json TEXT,                    -- snapshot do evidence do sinal
        status TEXT NOT NULL DEFAULT 'pending',-- pending | accepted | dismissed | expired
        rejection_count INTEGER NOT NULL DEFAULT 0,
        cooldown_until DATETIME,               -- se status=dismissed, próxima data em que pode re-oferecer
        actor TEXT,                            -- quem dispensou/aceitou (audit)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        dismissed_at DATETIME,
        accepted_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_upgrade_recommendations_org
        ON upgrade_recommendations (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_upgrade_recommendations_target
        ON upgrade_recommendations (organization_id, target_plan_id, target_module_key, cooldown_until);
      CREATE INDEX IF NOT EXISTS idx_upgrade_recommendations_signal
        ON upgrade_recommendations (organization_id, signal_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar upgrade_recommendations (ADR-153 F7.3)', e); }

  // PRD 6 F10 (ADR-163 §80-§84, RN-UX-7) — telemetria de UX MINIMIZADA (LGPD §84):
  // só sinais operacionais de experiência (que tela abriu, que ação clicou, TTFV),
  // NUNCA conteúdo. Sem texto livre, sem PII além do user_id interno (que já vive no
  // audit). event_type/surface/module_key são identificadores curtos sanitizados.
  // Isolado por org; opt-in por flag `ux_telemetry_enabled` (consentimento, §84).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ux_telemetry_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT,                          -- id interno (adoção/abandono); nunca PII de conteúdo
        event_type TEXT NOT NULL,              -- whitelist: view_opened|action_clicked|approval_completed|clarification_requested|first_value
        surface TEXT,                          -- id curto da superfície (hoje|executando|resultados|...)
        module_key TEXT,                       -- id curto do módulo, quando aplicável
        session_id TEXT,                       -- correlação de sessão (abandono/TTFV); opaco
        ttfv_ms INTEGER,                       -- só em first_value: time-to-first-value
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ux_telemetry_org_type
        ON ux_telemetry_events (organization_id, event_type, created_at);
      CREATE INDEX IF NOT EXISTS idx_ux_telemetry_org_session
        ON ux_telemetry_events (organization_id, session_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar ux_telemetry_events (ADR-163 F10)', e); }

  // PRD 7 F6 (ADR-164 §11/§33/§47) — "Platform Health Event": snapshots AGREGADOS de
  // saúde de plataforma pra baseline/anomalia. GLOBAL (sem organization_id — molde do
  // research_usage_log; dado de infra é do Admin Master, RN-PRC-4). §11 permite persistir
  // AGREGADO (nunca raw time-series). `dow`/`hour` são o seasonality bucket (§33). Retenção
  // aplicada pelo Scheduler (nunca infla o banco — §19).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_health_snapshots (
        id TEXT PRIMARY KEY,
        captured_at DATETIME NOT NULL,
        metric TEXT NOT NULL,                  -- app.p95 | app.error_rate | proc.rss | host.load1m | queue.pending | ...
        value REAL NOT NULL,
        dow INTEGER NOT NULL,                  -- 0-6 (seasonality bucket, hora SP)
        hour INTEGER NOT NULL,                 -- 0-23 (seasonality bucket, hora SP)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_platform_health_metric
        ON platform_health_snapshots (metric, captured_at);
      CREATE INDEX IF NOT EXISTS idx_platform_health_bucket
        ON platform_health_snapshots (metric, dow, hour);
    `);
  } catch(e){ console.error('[DB] Falha ao criar platform_health_snapshots (ADR-164 F6)', e); }

  // ADR-154 Fatia 1.1 — AI usage ledger estendido com atribuição por
  // USUÁRIO + MÓDULO + OPERAÇÃO + LATÊNCIA + custo em CENTAVOS (INTEGER, pra
  // queries determinísticas — cost_brl REAL fica pra compat com admin
  // dashboard existente). Aditivo puro no `ai_usage_log`: nenhuma coluna
  // renomeada, todas as queries antigas seguem funcionando. Grava default
  // module='legacy' quando o call site ainda não passou pelo setUsageContext
  // (backfill best-effort — ver usageContext.ts).
  try {
    const cols = db.prepare(`PRAGMA table_info(ai_usage_log)`).all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has("user_id"))     db.exec(`ALTER TABLE ai_usage_log ADD COLUMN user_id TEXT`);
    if (!has("module"))      db.exec(`ALTER TABLE ai_usage_log ADD COLUMN module TEXT DEFAULT 'legacy'`);
    if (!has("operation"))   db.exec(`ALTER TABLE ai_usage_log ADD COLUMN operation TEXT`);
    if (!has("latency_ms"))  db.exec(`ALTER TABLE ai_usage_log ADD COLUMN latency_ms INTEGER DEFAULT 0`);
    if (!has("cost_cents"))  db.exec(`ALTER TABLE ai_usage_log ADD COLUMN cost_cents INTEGER DEFAULT 0`);
    if (!has("request_id"))  db.exec(`ALTER TABLE ai_usage_log ADD COLUMN request_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_org_module_date ON ai_usage_log (organization_id, module, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_org_user_date   ON ai_usage_log (organization_id, user_id, created_at)`);
  } catch(e){ console.error('[DB] Falha ao estender ai_usage_log (ADR-154 F1.1)', e); }

  // ADR-154 Fatia 2.1 — `mode` no blueprint: 'suite' (default, comportamento
  // atual — org enxerga vários módulos) vs 'solo' (org enxerga UM módulo só —
  // assistente pessoal). Aditivo puro: blueprints existentes ficam 'suite'
  // automaticamente. F1.4 (hiddenModules) + este `mode` são o que faz o
  // blueprint solo esconder tudo mais que não o único módulo permitido.
  try {
    const cols = db.prepare(`PRAGMA table_info(vertical_blueprints)`).all() as any[];
    if (!cols.some((c: any) => c.name === "mode")) {
      db.exec(`ALTER TABLE vertical_blueprints ADD COLUMN mode TEXT NOT NULL DEFAULT 'suite'`);
    }
  } catch(e){ console.error('[DB] Falha ao adicionar mode em vertical_blueprints (ADR-154 F2.1)', e); }

  // ADR-154 Fatia 1.3 — cota mensal em CENTAVOS (INTEGER) por org, ajustável
  // pelo master admin (POST /api/admin/organizations/:id/ai-quota). É uma
  // dimensão SEPARADA do `ai_monthly_limit` do plano (que é count-based):
  // aqui é limite de CUSTO (R$/mês). NULL = sem teto de custo — o gate real
  // continua sendo PlanService.aiAllowed (por count). Esta coluna alimenta
  // o AiQuotaSignalService (80% attention / 100% critical).
  try {
    const cols = db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[];
    if (!cols.some((c: any) => c.name === "ai_monthly_limit_cents")) {
      db.exec(`ALTER TABLE organization_settings ADD COLUMN ai_monthly_limit_cents INTEGER`);
    }
  } catch(e){ console.error('[DB] Falha ao adicionar ai_monthly_limit_cents (ADR-154 F1.3)', e); }

  // ADR-154 Fatia 4.1 — kind da instância WhatsApp por org: 'shared' (default,
  // pool interno da plataforma — orgs suíte compartilham) vs 'dedicated' (org
  // Solo tem instância Evolution PRÓPRIA, com número do assinante conectado
  // via QR). Aditivo puro: orgs existentes seguem 'shared'. F4.2 vai plugar
  // `falatu_reply_mode` (always vs trigger_only) sobre este mesmo flag.
  try {
    const cols = db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[];
    if (!cols.some((c: any) => c.name === "whatsapp_instance_kind")) {
      db.exec(`ALTER TABLE organization_settings ADD COLUMN whatsapp_instance_kind TEXT NOT NULL DEFAULT 'shared'`);
    }
  } catch(e){ console.error('[DB] Falha ao adicionar whatsapp_instance_kind (ADR-154 F4.1)', e); }

  // ADR-154 Fatia 4.2 — modo de resposta do FalaTu no canal interno:
  // 'always' (default, retrocompat — Controller/Coordenador seguem rodando
  // quando FalaTu não capturou) vs 'trigger_only' (Solo com Evolution
  // dedicado — SILÊNCIO absoluto se não bater gatilho FalaTu). O default
  // MUST ser 'always' pra não regredir suíte; o provision da Fase 4.1 seta
  // 'trigger_only' explicitamente pra Solo. Guardrail RN-154: "assistente
  // pessoal, não intervém na vida do dono do número".
  try {
    const cols = db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[];
    if (!cols.some((c: any) => c.name === "falatu_reply_mode")) {
      db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_reply_mode TEXT NOT NULL DEFAULT 'always'`);
    }
  } catch(e){ console.error('[DB] Falha ao adicionar falatu_reply_mode (ADR-154 F4.2)', e); }

  // ADR-154 Fatia 5.1 — flag opt-in do RAG do FalaTu. Default 0 (off) porque:
  // (a) gera custo de embedding no ai_usage_log, (b) a Fase 5.2 vai injetar
  // <memoria_relevante> no prompt e a org deve ligar conscientemente, (c) a
  // captura hoje já funciona sem RAG. Ligar = a partir do próximo confirm(),
  // entidades/notas materializadas geram embeddings assíncronos (JobQueue).
  try {
    const cols = db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[];
    if (!cols.some((c: any) => c.name === "falatu_rag_enabled")) {
      db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_rag_enabled INTEGER NOT NULL DEFAULT 0`);
    }
  } catch(e){ console.error('[DB] Falha ao adicionar falatu_rag_enabled (ADR-154 F5.1)', e); }

  // ADR-154 Fatia 5.1 — tabela de embeddings da memória do FalaTu (RAG).
  // Aditiva; alimentada assíncronamente no confirm(). RN-151 preservado:
  // só grava sobre conteúdo já CONFIRMADO (pending nunca gera embedding —
  // o gate é `falatu_inbox_items.status='confirmed'` conferido pelo service).
  // Isolamento multi-tenant OBRIGATÓRIO em toda query: filtro por
  // (organization_id, user_id) — guardrail RN-154 §7. LGPD Art.18: se a
  // entidade/nota é apagada, o embedding correspondente também vai (a Fase
  // 5.3 vai plugar isso; F5.1 se limita a criar+gerar).
  //
  // Schema conforme ADR (linhas 114-120):
  //   embedding BLOB — vetor 1536-dim serializado como Float32Array bytes
  //     (nunca como JSON de doubles — 6x mais espaço + drift de arredondamento).
  //   model TEXT — 'text-embedding-3-small' default (mesma dim que a F5.2 espera).
  //   source_type — 'entity' | 'note': o que o embedding representa (entidade
  //     mem+contexto, ou item de inbox confirmado como nota/tarefa/etc).
  //   source_id — id da linha em falatu_entities OU falatu_inbox_items.
  //   content_snippet — texto usado pra gerar o embedding (pra debugging e
  //     futuros re-embeddings quando trocarmos de modelo).
  db.exec(`
    CREATE TABLE IF NOT EXISTS falatu_memory_embeddings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content_snippet TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (organization_id, user_id, source_type, source_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_falatu_memory_embeddings_user
      ON falatu_memory_embeddings(organization_id, user_id, source_type);
  `);

  // ADR-154 F8.4 — tokens pessoais de captura (API aberta write-only da
  // Fase 8: Atalho Siri, Share Target, NFC, Zapier/n8n). Guarda-se APENAS o
  // sha256 do token (nunca o claro): dump do banco não vira credencial. O
  // escopo write-only não mora aqui — mora no fato de o router de ingestão
  // expor uma única rota (capture); a tabela só liga hash → (org, user).
  // Revogação é UPDATE de revoked_at (convenção nº 9, nunca DELETE — a
  // linha revogada é trilha de auditoria de que a credencial existiu).
  db.exec(`
    CREATE TABLE IF NOT EXISTS falatu_capture_tokens (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      revoked_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_falatu_capture_tokens_user
      ON falatu_capture_tokens(organization_id, user_id);
  `);

  // ADR-154 F8.2 — idempotência de reenvio da fila offline (outbox ADR-082):
  // o cliente manda um commandId e o capture deduplica por
  // (org, user, client_command_id) — reenvio após queda de rede nunca duplica
  // item nem paga extração de IA duas vezes. Unique PARCIAL: capturas sem
  // commandId (fluxo online normal, WhatsApp) seguem ilimitadas com NULL.
  try {
    const cols = db.prepare(`PRAGMA table_info(falatu_inbox_items)`).all() as any[];
    if (!cols.some((c: any) => c.name === "client_command_id")) {
      db.exec(`ALTER TABLE falatu_inbox_items ADD COLUMN client_command_id TEXT`);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_falatu_inbox_client_command
        ON falatu_inbox_items(organization_id, user_id, client_command_id)
        WHERE client_command_id IS NOT NULL;
    `);
  } catch(e){ console.error('[DB] Falha ao adicionar client_command_id (ADR-154 F8.2)', e); }

  // ADR-154 F8.3 — briefing por Web Push (porta de entrega sem mensageiro).
  //
  // falatu_push_vapid: keypair VAPID ÚNICO da plataforma (linha id=1). As
  //   subscriptions dos browsers ficam amarradas à chave pública — trocar a
  //   chave invalida todas; por isso persistimos em DB (gerada no 1º uso) em
  //   vez de derivar de env que pode mudar.
  // falatu_push_subscriptions: endpoint é UNIQUE global — um endpoint pertence
  //   a UM perfil de browser; se outra conta assina no mesmo browser, a linha
  //   muda de dono (upsert) em vez de duplicar. Revogação/endpoint morto é
  //   UPDATE de revoked_at (convenção nº 9).
  // falatu_push_deliveries: dedupe por (org, user, dia) SEPARADO do canal WA
  //   (falatu_briefing_deliveries) — as portas são opt-ins independentes e o
  //   unique existente do WA não pode ganhar coluna sem quebrar o aditivo.
  db.exec(`
    CREATE TABLE IF NOT EXISTS falatu_push_vapid (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS falatu_push_subscriptions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_success_at DATETIME,
      revoked_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_falatu_push_subs_user
      ON falatu_push_subscriptions(organization_id, user_id);
    CREATE TABLE IF NOT EXISTS falatu_push_deliveries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      briefing_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (organization_id, user_id, briefing_date)
    );
  `);

  // ADR-154 F8.6 — briefing por e-mail (terceira porta do digest).
  // falatu_email_optins: opt-in POR USUÁRIO (destino é o e-mail de login
  //   dele — não há canal de org a proteger como no WA). Desligar é UPDATE
  //   enabled=0 (convenção nº 9: a linha fica como trilha do opt-in).
  // falatu_email_deliveries: dedupe por (org, user, dia) SEPARADO das outras
  //   portas (WA/push) — opt-ins independentes, o dono pode receber nas três.
  db.exec(`
    CREATE TABLE IF NOT EXISTS falatu_email_optins (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (organization_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS falatu_email_deliveries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      briefing_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (organization_id, user_id, briefing_date)
    );
  `);

  // ADR-154 F8.7 — Protocolos (tarefas pré-autorizadas ativáveis por voz).
  // falatu_protocols: config HUMANA (a IA nunca escreve aqui). phone_e164 só
  //   vale com phone_verified_at (código falado em ligação, molde PIN F28 —
  //   verify_* são o estado transitório dessa verificação). Remoção é
  //   deleted_at (convenção nº 9). name_norm = régua de normalização da F5.
  // falatu_protocol_activations: 1 linha por ativação, para sempre —
  //   cancelamento/falha é UPDATE de status (scheduled|firing|fired|
  //   cancelled|failed), nunca DELETE. provider_call_id rastreia o custo de
  //   telefonia (fora do ledger de IA).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_protocols_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-154 F2.2 Fatia D — aceite dos Termos/Privacidade no checkout B2C
  // (prova de consentimento contratual + versão do documento aceita).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_terms_version TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_terms_accepted_at DATETIME`); } catch(e){}
  db.exec(`
    CREATE TABLE IF NOT EXISTS falatu_protocols (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      action_kind TEXT NOT NULL DEFAULT 'call_me',
      delay_minutes INTEGER NOT NULL DEFAULT 5,
      phone_e164 TEXT NOT NULL,
      phone_verified_at DATETIME,
      verify_code_hash TEXT,
      verify_expires_at DATETIME,
      verify_attempts INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_falatu_protocols_user
      ON falatu_protocols(organization_id, user_id);
    CREATE TABLE IF NOT EXISTS falatu_protocol_activations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      protocol_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'webapp',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      scheduled_for DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      provider_call_id TEXT,
      fired_at DATETIME,
      fail_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_falatu_protocol_act_due
      ON falatu_protocol_activations(status, scheduled_for);
  `);
  // ADR-155 F1.3 — camada por-org do grimoire de copy. brand_voice_context é o
  // texto livre de voz/marca da org que o redator injeta JUNTO da rubrica
  // global roteada. brand_voice_enabled é o opt-in (convenção nº 10): 0 (default
  // de toda org existente) => GrimoireService.promptForOrg NÃO injeta nada (zero
  // mudança em prod); 1 => rubrica global + <contexto_marca> desta org.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN brand_voice_context TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN brand_voice_enabled INTEGER NOT NULL DEFAULT 0`); } catch(e){}
  // ADR-155 F2.1 — A/B da copy de cobrança. collection_copy_variant escolhe a
  // variante (control|calibrated) que o CollectionCopy usa; 'control' (default
  // de toda org) = copy atual byte-idêntica ⇒ zero mudança em prod. A coluna
  // `variant` em collection_followup_attempts REGISTRA qual variante foi enviada
  // em cada follow-up, pra a medição A/B da F2.3 correlacionar com revenue.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_copy_variant TEXT DEFAULT 'control'`); } catch(e){}
  try { db.exec(`ALTER TABLE collection_followup_attempts ADD COLUMN variant TEXT`); } catch(e){}
  // ADR-155 F2.2 — retry diferenciado soft/hard decline. collection_hard_decline
  // _days é o limiar (dias após o vencimento) a partir do qual a via é tratada
  // como provavelmente expirada (hard → copy oferece 2ª via); abaixo é soft
  // (re-nudge do PIX). Só a variante calibrated ramifica. decline_type registra
  // qual ramo foi usado em cada follow-up (insumo do A/B da F2.3).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_hard_decline_days INTEGER DEFAULT 7`); } catch(e){}
  try { db.exec(`ALTER TABLE collection_followup_attempts ADD COLUMN decline_type TEXT`); } catch(e){}
  // ADR-155 F1.4 — lições pós-mortem do grimoire (padrão 4: "o erro de ontem vira
  // regra de amanhã"). São DADOS dinâmicos por-org (não markdown estático): um
  // sinal ruim (ex.: A/B da copy de cobrança com a variante calibrada perdendo)
  // grava uma lição na rubrica correspondente (rubric_id), que o GrimoireService
  // passa a injetar como bloco <licoes> junto da rubrica. active=0 aposenta a
  // lição quando a condição some. dedupe_key evita duplicar a mesma lição.
  db.exec(`
    CREATE TABLE IF NOT EXISTS grimoire_lessons (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      rubric_id TEXT NOT NULL,
      lesson TEXT NOT NULL,
      source TEXT,
      evidence_json TEXT,
      dedupe_key TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grimoire_lessons_dedupe
      ON grimoire_lessons(organization_id, rubric_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_grimoire_lessons_rubric
      ON grimoire_lessons(organization_id, rubric_id, active);
  `);
  // ADR-155 F4.1 — ChurnRiskDetector opt-in por org (convenção nº 10). Quando
  // 1, o detector publica sinais churn_risk_high em business_signals (nunca
  // tabela própria — convenção nº 12). Default 0: zero mudança pras orgs atuais.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN churn_detector_enabled INTEGER DEFAULT 0`); } catch(e){}
  // Decision Intelligence DI-1 (aditivo sobre ADR-135/136 — ver
  // docs/decision-intelligence/). Evidence Package v1: CACHE opt-in por org
  // (convenção nº 10). Off (default) = zero mudança (build computa fresco e não
  // persiste). On = reusa o pacote enquanto fresco (janela L2 "Organization
  // Intelligence", PRD §25). É cache DERIVADO do Business Snapshot V2.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN evidence_layer_enabled INTEGER DEFAULT 0`); } catch(e){}
  // evidence_packages: 1 pacote vivo por (org, subject). package_json guarda o
  // pacote canônico (interno + slots externo/histórico vazios na v1). expires_at
  // define o TTL/freshness. UNIQUE(org, subject) → upsert, nunca duplica.
  // Isolado por organization_id (convenção nº 1).
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_packages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      vertical TEXT,
      package_json TEXT NOT NULL,
      confidence REAL,
      generated_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_packages_subject
      ON evidence_packages(organization_id, subject);
  `);
  // Decision Intelligence DI-2 — riscos previstos pelas estratégias Pre-Mortem/
  // Red Team (aditivo sobre ADR-136). NÃO é tabela de alerta própria (convenção
  // nº 12): cada risco monitorável PUBLICA em business_signals (domain
  // 'decision'). Esta tabela guarda a PREVISÃO (probabilidade, indicador líder,
  // limiar, mitigação) e o ciclo predicted→materialized→resolved, ligada
  // opcionalmente a uma decision_actions (decision_id nullable). Isolado por
  // organization_id (convenção nº 1). UNIQUE(org, dedupe_key) → não duplica.
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_risks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      decision_id TEXT,
      source TEXT NOT NULL DEFAULT 'premortem',
      description TEXT NOT NULL,
      probability TEXT,
      severity TEXT,
      impact_amount REAL,
      impact_unit TEXT,
      leading_indicator TEXT,
      threshold TEXT,
      mitigation TEXT,
      status TEXT NOT NULL DEFAULT 'predicted',
      dedupe_key TEXT NOT NULL,
      signal_id TEXT,
      predicted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      materialized_at DATETIME,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_risks_dedupe
      ON decision_risks(organization_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_decision_risks_decision
      ON decision_risks(organization_id, decision_id, status);
  `);
  // ADR-155 F5.1 — save offers no cancel/refund do FalaTu. Registra a INTENÇÃO de
  // cancelamento com o motivo capturado e o degrau do ladder ofertado (grimoire
  // save-offer-ladder). outcome: pending → retained (aceitou a oferta) | refunded
  // | cancelled. A garantia de 7 dias (CDC Art. 49) NUNCA é bloqueada por isto —
  // a oferta é opt-out, não fricção (RN-E da ADR-154). Insumo da medição F5.3.
  db.exec(`
    CREATE TABLE IF NOT EXISTS falatu_cancellation_intents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT,
      reason TEXT NOT NULL,
      free_text TEXT,
      offered_type TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_falatu_cancel_intents_org
      ON falatu_cancellation_intents(organization_id, outcome, created_at);
  `);
  // Decision Intelligence DI-3 — log append-only de acertos/erros do cache do
  // Evidence Layer (DI-1). Existe para o `cache_hit_rate` ser DERIVADO por query
  // (COUNT) — não um contador mutável (anti-padrão do CLAUDE.md). hit=1 acerto,
  // hit=0 recomputou. Só grava quando o cache está ligado (opt-in). Isolado por
  // organization_id. Volume baixo (chamadas de dashboard/Diretor), sem TTL.
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_cache_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      hit INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_cache_events_org
      ON evidence_cache_events(organization_id, created_at);
  `);
  // Decision Intelligence DI-4.1 (ADR-156) — External Intelligence de vertical
  // COMPARTILHADA e anonimizada.
  //
  // `vertical_intelligence` é a camada COMPARTILHADA: **NÃO tem organization_id**
  // por design (RN-156-1). Guarda só pesquisa do mundo externo (mercado/
  // tendências) por (vertical, topic, region, timeframe), dedup por `fingerprint`
  // (UNIQUE). Escrita SÓ pelo admin master / scheduler (D5). `valid_until` = TTL/
  // freshness. Zero dado por-org/pessoal (filtro de anonimização antes de gravar).
  db.exec(`
    CREATE TABLE IF NOT EXISTS vertical_intelligence (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      vertical TEXT NOT NULL,
      topic TEXT NOT NULL,
      region TEXT,
      timeframe TEXT,
      content_json TEXT NOT NULL,
      sources_json TEXT,
      confidence REAL,
      provider TEXT,
      created_by TEXT,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      valid_until DATETIME NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vertical_intelligence_fp
      ON vertical_intelligence(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_vertical_intelligence_vertical
      ON vertical_intelligence(vertical, valid_until);
  `);
  // `organization_contextualization` é a camada POR-ORG: isolada por
  // organization_id (RN-156-1). Liga uma org a uma entrada compartilhada com o
  // enquadramento específico dela. UNIQUE(org, fingerprint) → 1 contextualização
  // viva por (org, pesquisa). NUNCA é escrita de volta no compartilhado.
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_contextualization (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      vertical_intelligence_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      vertical TEXT NOT NULL,
      topic TEXT,
      context_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_contextualization_key
      ON organization_contextualization(organization_id, fingerprint);
  `);
  // Opt-in por org para CONSUMIR inteligência externa (convenção nº 10 / RN-156).
  // Default 0: nenhuma org recebe até optar. NÃO habilita a org a DISPARAR
  // pesquisa (isso é só do admin master, D5).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN external_intelligence_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-155 F3.1 — A/B da copy de Recuperação Comercial. Espelha o
  // collection_copy_variant (F2.1): 'control' (default) = copy legada
  // byte-idêntica ⇒ zero mudança em prod; 'calibrated' = copy afinada pela
  // rubrica compose/sales-recovery.md. Opt-in por org; a atribuição/rollout do
  // A/B e a medição são a F3.2.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_copy_variant TEXT DEFAULT 'control'`); } catch(e){}
  // ADR-155 F3.2 — carimba no touch a variante de copy usada no envio, pra a
  // medição do A/B (SalesRecoveryAbMeasurementService) correlacionar variante ×
  // recuperação real (sales_recovery_attributions). Espelha o
  // collection_followup_attempts.variant (F2.1/F2.3). Aditivo à tabela viva
  // sales_recovery_touches ⇒ ALTER no fim (touches legados ficam 'control',
  // coerente com o default da F3.1).
  try { db.exec(`ALTER TABLE sales_recovery_touches ADD COLUMN variant TEXT DEFAULT 'control'`); } catch(e){}
  // Decision Intelligence DI-4.2 (ADR-156 D6) — orçamento de pesquisa de
  // PLATAFORMA (não por-org: quem dispara é o admin master).
  //
  // `research_usage_log`: ledger append-only do custo de cada chamada ao provider
  // (SEM organization_id — é gasto de plataforma). O gasto do mês é DERIVADO por
  // SUM(cost_cents) (RN-004, sem contador mutável).
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_usage_log (
      id TEXT PRIMARY KEY,
      fingerprint TEXT,
      vertical TEXT,
      topic TEXT,
      provider TEXT,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_research_usage_log_created
      ON research_usage_log(created_at);
  `);
  // `platform_settings`: KV de configuração de PLATAFORMA (fora do tenant).
  // Guarda p.ex. research_monthly_budget_cents (0 = ilimitado). Ajustável só
  // pelo admin master.
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // ADR-155 — snapshot diário do A/B (control × calibrada) por org/tipo, pra o
  // GRÁFICO TEMPORAL na aba Operações. A taxa cumulativa de um dia passado NÃO é
  // derivável do estado atual (precisaria das contagens daquele dia), então o
  // histórico é gravado (append-only, 1 linha por org/kind/dia via upsert) — não
  // é contador mutável (RN-004), é log de fato histórico (padrão do ai_usage_ledger).
  db.exec(`
    CREATE TABLE IF NOT EXISTS ab_trend_snapshots (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      kind TEXT NOT NULL,               -- 'collection' | 'sales_recovery'
      captured_on TEXT NOT NULL,        -- YYYY-MM-DD
      control_rate REAL DEFAULT 0,
      control_sent INTEGER DEFAULT 0,
      calibrated_rate REAL DEFAULT 0,
      calibrated_sent INTEGER DEFAULT 0,
      winner TEXT,                      -- control | calibrated | tie | null
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ab_trend_snap_dedupe
      ON ab_trend_snapshots(organization_id, kind, captured_on);
    CREATE INDEX IF NOT EXISTS idx_ab_trend_snap_org
      ON ab_trend_snapshots(organization_id, kind, captured_on DESC);
  `);
  // ADR-155 — snapshot também da CONVERSÃO da indicação (kind='referral'), que é
  // uma linha só (não control×calibrada). Aditivo à tabela viva ab_trend_snapshots
  // ⇒ ALTER no fim; pros kinds de A/B esses campos ficam 0.
  try { db.exec(`ALTER TABLE ab_trend_snapshots ADD COLUMN referred INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE ab_trend_snapshots ADD COLUMN qualified INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE ab_trend_snapshots ADD COLUMN conversion_rate REAL DEFAULT 0`); } catch(e){}
  // Decision Intelligence DI-5.2 (ADR-157 D4) — base LONGITUDINAL da inteligência
  // de nicho. `vertical_intelligence` guarda só a "cabeça" (versão fresca); este
  // histórico versiona cada publicação por `fingerprint` para virar MEMÓRIA de
  // mercado: a cada nova pesquisa, o `delta_json` registra o que mudou vs a
  // versão anterior (novo/saiu/cresceu/retraiu + tendência de confiança).
  // COMPARTILHADA (RN-157-1): **sem organization_id**, sem PII (grava o mesmo
  // conteúdo já anonimizado do head). Append-only (nunca DELETE — espírito da
  // convenção nº 9); UNIQUE(fingerprint, version) impede versão duplicada.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vertical_intelligence_history (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      vertical TEXT NOT NULL,
      topic TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      sources_json TEXT,
      confidence REAL,
      delta_json TEXT,
      provider TEXT,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_history_fp_version
      ON vertical_intelligence_history(fingerprint, version);
    CREATE INDEX IF NOT EXISTS idx_vi_history_fp
      ON vertical_intelligence_history(fingerprint, version DESC);
  `);
  // Decision Intelligence DI-5.4 (ADR-157 D1/D5) — AGENDA de nichos automatizados.
  // Cada linha = 1 nicho que o Scheduler pesquisa sozinho na cadência
  // `interval_days`. COMPARTILHADA (é plataforma, RN-157-1): **sem
  // organization_id**. `last_run_at` marca o último disparo (dedup por intervalo).
  // Um nicho com agenda ENABLED é mutuamente exclusivo com o lembrete manual da
  // DI-4.5 (RN-157-4). Registrado só pelo admin master.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vertical_intelligence_schedule (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      vertical TEXT NOT NULL,
      topic TEXT NOT NULL,
      region TEXT,
      timeframe TEXT,
      interval_days INTEGER NOT NULL DEFAULT 7,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_schedule_fp
      ON vertical_intelligence_schedule(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_vi_schedule_enabled
      ON vertical_intelligence_schedule(enabled, vertical);
  `);

  // ADR-158 (Espinha Única / Onda 0 F1) — RASTREABILIDADE ponta-a-ponta do ciclo
  // universal. `correlation_id` amarra sinal → decisão → outcome num único fio
  // (PRD 0 §50: "Por que o ZapFlow fez isso?"). Aditivo PURO e reversível: linhas
  // legadas ficam com correlation_id NULL (só não aparecem no trace) e o fluxo
  // pré-existente não muda. `schema_version` versiona o contrato de cada registro
  // para evoluções futuras sem quebrar leitores antigos. Índice por (org,
  // correlation_id) pra o trace ser barato. NÃO reordenar — append no fim.
  try { db.exec(`ALTER TABLE business_signals ADD COLUMN correlation_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE business_signals ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN correlation_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE decision_actions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`); } catch(e){}
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN correlation_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_business_signals_corr ON business_signals(organization_id, correlation_id)`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_actions_corr ON decision_actions(organization_id, correlation_id)`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_action_outcomes_corr ON action_outcomes(organization_id, correlation_id)`); } catch(e){}

  // ADR-158 F2 (Espinha Única — unificação da PERCEPÇÃO) — o contrato de sinal
  // ganha `subject_type` de 1ª classe (o "sobre o quê" — sku/contato/oportunidade)
  // e `expires_at` (TTL: sinais que perdem validade sozinhos). Aditivos PUROS:
  // linhas legadas ficam NULL. `radar_signals_unified_enabled` (opt-in, convenção
  // nº 10) liga a publicação dos detectores fora-do-contrato (Opportunity/Recovery/
  // Manipulation) em `business_signals`, aposentando as tabelas de alerta paralelas
  // sem quebrar consumidores (a tabela antiga vira PROJEÇÃO — escrita na mesma
  // computação). NÃO reordenar — append no fim.
  try { db.exec(`ALTER TABLE business_signals ADD COLUMN subject_type TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE business_signals ADD COLUMN expires_at DATETIME`); } catch(e){}
  // PRD 2 F2.1 — `subject_id`: o "sobre qual" de 1ª classe (sku-123, contactId,
  // opportunityId). Antes só existia subject_type (a CLASSE); o id ficava em
  // source_entity_id (source-scoped). Aditivo; sinais antigos ficam NULL.
  try { db.exec(`ALTER TABLE business_signals ADD COLUMN subject_id TEXT`); } catch(e){}
  // PRD 2 F11 (§65) — motivo do descarte: expected|irrelevant|incorrect|duplicate|
  // already_resolved. Alimenta a calibração/false-positive rate por detector (§66).
  try { db.exec(`ALTER TABLE business_signals ADD COLUMN dismiss_reason TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_business_signals_subject ON business_signals (organization_id, subject_type, subject_id)`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_business_signals_expires ON business_signals(organization_id, expires_at)`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_signals_unified_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-158 F4 (D6) — auto-disparo genérico sinal→process_instance. Opt-in
  // (convenção nº 10) EM CIMA de `execution_runtime_enabled` (cascade): o
  // SignalProcessRouterService só roteia sinais mapeados pra processo quando as
  // DUAS flags estão ligadas. Auto-INICIAR não é efeito externo — a instância
  // nasce em `detected` e qualquer ação externa segue governada pelo
  // CommandExecutor (RN-159-4). Aditivo PURO: legado fica 0. NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN signal_auto_trigger_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-159 F1 (D2 — segurança) — two-step de verdade. UNIQUE PARCIAL: um mesmo
  // usuário não pode ter duas linhas 'approved' pra mesma ação (fecha o double-
  // vote no nível de storage). NULL é excluído do índice (o service já rejeita
  // aprovação sem identidade) — e como NULLs são distintos no SQLite, um índice
  // cheio não barraria os nulos de qualquer forma; por isso o WHERE explícito.
  // Aditivo PURO: linhas legadas seguem válidas. NÃO reordenar.
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_action_approvals_unique_approver ON action_approvals(action_id, approver_user_id) WHERE decision = 'approved' AND approver_user_id IS NOT NULL`); } catch(e){}
  // ADR-159 F2 (D1 — choke-point) — RN-159-3: todo efeito externo auditado COM
  // correlationId. O `action_execution_log` (o audit do choke-point) ganha
  // `correlation_id` (fio do ciclo ADR-158), populado a partir de
  // `decision_actions.correlation_id` em cada tentativa (execute/prepare/rejeição).
  // Aditivo PURO: linhas legadas ficam NULL. NÃO reordenar.
  try { db.exec(`ALTER TABLE action_execution_log ADD COLUMN correlation_id TEXT`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_action_execution_log_corr ON action_execution_log(organization_id, correlation_id)`); } catch(e){}
  // ADR-159 F2.2/F2.3 (D1) — reencaminha os envios de dunning da FAMÍLIA COBRANÇA
  // (hoje efeito externo DIRETO) PELO choke-point (CommandExecutorService). Uma
  // flag governa toda a família: cadência T2/T3 (F2.2), follow-up de promessa
  // quebrada e reenvio de PIX (F2.3). Opt-in (convenção nº 10) EM CIMA de
  // `collection_cadence_enabled`: com a flag, cada envio vira uma ação governada
  // (whatsapp_send) auditada em action_execution_log com correlationId + guardas.
  // Default 0 → orgs existentes seguem no envio direto (0 regressão). Rotear NÃO
  // amplia autonomia (o dunning já envia autonomamente hoje) — só adiciona audit/
  // idempotência/governança. NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN collection_cadence_via_executor_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-159 F2.4 (D1) — reencaminha o envio de recuperação comercial
  // (SalesRecoveryPlaybook.approve, hoje MessageProviderService.sendMessage
  // direto) PELO choke-point via `CommandExecutorService.sendGovernedMessage`.
  // Opt-in (convenção nº 10); default 0 = envio direto (0 regressão). Herda o
  // correlationId da ação âncora (evidence.actionId, quando existe). Os guards
  // (opt-out LGPD, ticket-state) e side-effects (touch/recordTouch/outcome/audit)
  // ficam INTACTOS em volta — só o sink muda. NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN sales_recovery_via_executor_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-159 F2.5 (D1) — reencaminha os 2 sinks de prospecção
  // (ProspectExecutionService.sendOutreach: WhatsApp + Gmail, hoje diretos) PELO
  // choke-point. WhatsApp reusa `sendGovernedMessage`; e-mail usa o handler NOVO
  // `gmail_send` via `dispatchGoverned`. Sem âncora → correlationId nova raiz.
  // Opt-in (nº 10); default 0 = envio direto (0 regressão). NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN prospect_via_executor_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-159 F4 (D3) — RBAC default-deny FASEADO. Com a flag, usuários SEM perfil
  // resolvido são NEGADOS em módulos sensíveis (financeiro/admin/execução/destrutivo)
  // em vez de cair no fallback do papel legado (privilégio-por-omissão). O DONO
  // nunca é negado. Opt-in por org (nº 10, default 0 = comportamento pré-F4);
  // `PermissionService.defaultDenyImpact` dá o relatório de impacto ANTES de virar
  // a chave (quem perde acesso). NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN rbac_default_deny_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-159 F5 (D5) — progressive autonomy. Com a flag, o ProgressiveAutonomy
  // Service varre o histórico e PROPÕE (nunca aplica) elevar a autonomia quando a
  // evidência é forte (alta aprovação + 0 reversões). Opt-in (nº 10, default 0).
  // NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN progressive_autonomy_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-159 F6 (D6) — step-up MFA + detector de anomalia.
  //  - `step_up_mfa_enabled` (opt-in): exige um TOTP fresco pra EXECUTAR ação
  //    financeira/destrutiva acima de `step_up_mfa_threshold_cents` (só no ponto
  //    HUMANO POST /actions/:id/execute; os fluxos de sistema F2 não passam lá).
  //  - `anomaly_detector_enabled` (opt-in): varre execuções falhas por janela e
  //    publica `security/anomalous_behavior` em business_signals (nº 12).
  // Default 0 = comportamento pré-F6 (0 regressão). NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN step_up_mfa_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN step_up_mfa_threshold_cents INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN anomaly_detector_enabled INTEGER DEFAULT 0`); } catch(e){}

  // ADR-160 F4 (Onda A / D4) — modelo de objetivos/metas do negócio.
  // Metas DEFINIDAS PELO DONO, por métrica (revenue/appointments/...), 1 meta
  // vigente por métrica (UNIQUE org+metric, upsert). Guarda SÓ o alvo (intenção
  // do dono) — a distância à meta (valor atual) é SEMPRE derivada por query do
  // snapshot/analytics (RN-004), NUNCA um contador de progresso mutável aqui.
  // Prior art avaliado (§54): `retail_store_quotas`/`retail_seller_quotas` são
  // do varejo (loja/vendedor), assunto diferente de meta org-wide → tabela nova
  // justificada. Inerte até o dono definir meta (tabela vazia = 0 regressão).
  // NÃO reordenar (CREATE-then-ALTER estrito).
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_goals (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      target_amount REAL NOT NULL,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, metric)
    );
  `);

  // ADR-160 F5 (Onda A) — Fala Tu vira PORTA I/O: ao confirmar um item de intent
  // TASK, sob opt-in `falatu_bridge_tasks_enabled`, o Fala Tu ESPELHA a tarefa no
  // domínio CANÔNICO (`TaskService`/`tasks`) em vez de viver só no silo paralelo
  // `falatu_tasks` (estado-final §3.B/§4.2). `bridged_task_id` registra o vínculo
  // (silo→canônico). Aditivo/reversível: flag default 0 = comportamento de hoje
  // (só silo, 0 regressão); silo `falatu_tasks` preservado. NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_bridge_tasks_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE falatu_tasks ADD COLUMN bridged_task_id TEXT`); } catch(e){}

  // ADR-160 F6 (Onda A) — porta I/O, 2ª fatia: EVENT vira agendamento CANÔNICO.
  // Diferente do bridge de tarefas (F5), a agenda é contact-anchored (appointments.
  // contact_id é NOT NULL) — então o espelho SÓ acontece quando o humano vincula um
  // contato REAL na confirmação e o evento tem data+hora (RN-151: nunca inventa
  // contato/horário). Sem isso, fica só no silo `falatu_events` (lembrete pessoal).
  // `bridged_appointment_id` registra o vínculo silo→canônico. Flag default 0 =
  // comportamento de hoje (0 regressão). NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_bridge_events_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE falatu_events ADD COLUMN bridged_appointment_id TEXT`); } catch(e){}

  // ADR-160 F7 (Onda A) — porta I/O, 3ª fatia: LISTA de COMPRAS vira requisição
  // de compra CANÔNICA. É a fatia mais seletiva das três: só listas do tipo
  // 'shopping' têm equivalente canônico (as outras — general/meeting/trip — não
  // são domínio de negócio e ficam só no silo). E dentro da lista, só os itens
  // que CASAM com um produto do catálogo (product_service_id é NOT NULL; nunca
  // inventa produto — RN-151) viram linhas da requisição (draft, humano aprova
  // depois). `bridged_requisition_id` registra o vínculo silo→canônico. Flag
  // default 0 = comportamento de hoje (0 regressão). NÃO reordenar.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN falatu_bridge_lists_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE falatu_lists ADD COLUMN bridged_requisition_id TEXT`); } catch(e){}

  // PRD 6 F2 (ADR-163 §7/§96-97, D2) — navegação por NECESSIDADE (Hoje/Fala Tu/
  // Executando/Resultados/Empresa/Explorar), derivada por papel+entitlement. Flag
  // opt-in (default 0): o backend sempre computa o manifesto; a flag diz ao frontend
  // se renderiza a nav simplificada. Aditiva, reversível, sem tocar rotas legadas.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN simplified_navigation_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 6 F3 (ADR-163 §11-§13, D1) — "Hoje" por exceção: enriquece a Home do Fala Tu
  // (framing por exceção + resolvido-desde-ontem + metas). Flag opt-in (default 0) só
  // diz ao frontend se renderiza o framing novo; os campos são aditivos (0 regressão).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN invisible_ux_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 6 F5 (ADR-163 §17-§25, D4/RN-UX-6) — onboarding adaptativo: autodiscovery do
  // perfil da empresa com fonte+confiança, confirmation-first, perguntar só as lacunas.
  // Flag opt-in (default 0) só diz ao frontend se roda o fluxo adaptativo; o discover
  // NUNCA inventa (declara "ainda não sei"), a confirmação só grava campo descritivo.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN adaptive_onboarding_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 6 F6 (ADR-163 §26/§101, D4/RN-UX-3) — inferred settings: observa→infere→
  // SUGERE regra de autonomia; NUNCA auto-aplica política material. A aplicação só
  // acontece por confirmação explícita (reusa ApprovalPolicyService.setBands). Flag
  // opt-in (default 0) só diz ao frontend se mostra as sugestões.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN inferred_settings_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 6 F9 (ADR-163 §55-§57, D3) — contextual upgrades: surfacear upgrade SÓ
  // quando há recomendação situacional E o módulo é genuinamente fora-do-plano
  // (Entitlement `available_to_buy`+visível). NUNCA catálogo de cadeados. Flag
  // opt-in (default 0) só diz ao frontend se mostra a recomendação contextual.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN contextual_upgrade_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 6 F10 (ADR-163 §80-§84, RN-UX-7) — telemetria de UX opt-in (consentimento
  // LGPD §84). Flag default 0: sem ela, `record` é no-op (não coleta nada). Só
  // eventos minimizados (sem conteúdo) quando o dono liga.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN ux_telemetry_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 6 F13 (ADR-163 §53/§68, D7) — preferências de janela "acordado" (quiet-hours)
  // + limiar de alerta. Único gap de PERSISTÊNCIA genuíno do F0 (item 10): hoje a
  // janela é constante de código (AWAKE_START=7/END=22 no FalaTuProactiveService). As
  // colunas guardam a JANELA ACORDADO [start,end) em hora SP 0-23; fora dela é quiet
  // hours. Opt-in, NULL = default do sistema (0 regressão). Limiar em R$ (>=0).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN proactive_awake_start INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN proactive_awake_end INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN alert_min_amount REAL`); } catch(e){}

  // PRD 1 (Fala Tu Universal Interaction Layer) — Fatia de fundação: o
  // `falatu_inbox_items` É o envelope canônico de interação (§9); estas colunas
  // fecham os campos que faltavam pra rastrear "de onde veio → o que entendemos
  // → o que fizemos" em QUALQUER canal, sem tabela nova:
  //   channel         — canal canônico da entrada (falatu_web|whatsapp|share_target|api|...)
  //   input_type      — tipo físico da entrada (text|audio|image|document|...)
  //   attachments_json— descritores dos anexos enviados (fundação p/ artefatos, Fase 2)
  //   correlation_id  — espinha de rastreabilidade (ADR-158); raiz da cadeia da
  //                     interação, propagada ao metering (ai_usage_log.request_id)
  //                     e reutilizável por sinais/ações do processo iniciado aqui.
  // Aditivo/retrocompatível: itens legados ficam com NULL e seguem operando.
  // NÃO reordenar.
  try { db.exec(`ALTER TABLE falatu_inbox_items ADD COLUMN channel TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE falatu_inbox_items ADD COLUMN input_type TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE falatu_inbox_items ADD COLUMN attachments_json TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE falatu_inbox_items ADD COLUMN correlation_id TEXT`); } catch(e){}

  // PRD 1 (Fala Tu) — Fase 2 (artefatos): tabela CANÔNICA de artefato (§15). Hoje
  // cada módulo guardava anexo/PDF do seu jeito (clinical_encounter_attachments,
  // /media/reports) sem um registro único com hash/expiry/classificação/permissão.
  // Esta é a fonte de verdade dos artefatos entregáveis (relatório, export,
  // recibo, documento) — arquivo no disco privado, metadados aqui. `correlation_id`
  // liga o artefato à interação que o produziu (fundação PRD 1). `purged_at` é a
  // retenção LGPD (soft). NÃO retornar path interno — só id + URL assinada.
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      created_by TEXT,
      kind TEXT NOT NULL,                              -- report|export|receipt|document|image|other
      title TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_key TEXT NOT NULL,                       -- {orgId}/{uuid}.{ext} sob private_media/artifacts
      origin TEXT,                                     -- falatu|report|intake|...
      classification TEXT NOT NULL DEFAULT 'internal', -- internal|sensitive|public
      sha256 TEXT,
      correlation_id TEXT,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      purged_at DATETIME
    );
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_org ON artifacts (organization_id, created_at)`); } catch(e){}

  // PRD 2 F9 (§45-46, CA2) — Human signals: uma observação estruturada do humano
  // (via Fala Tu ou UI) vira um `business_signal` normalizado, com ACÚMULO DE
  // EVIDÊNCIA (várias observações do mesmo assunto sobem confiança/severidade,
  // §46). Opt-in; sem tabela nova (CA1/§5) — as observações moram no evidence_json
  // do próprio sinal. Nunca é `fact` (§13). Aditivo; default OFF.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_human_signals_enabled INTEGER DEFAULT 0`); } catch(e){}

  // PRD 2 F10 (§48-51, §10C, CA2) — External signal contract (molde): a origem
  // EXTERNA da percepção (review/reclamação/menção de mercado SOBRE esta org) vira
  // um `business_signal` normalizado, com PROVENIÊNCIA obrigatória (source +
  // externalId → dedupe idempotente por origem) e SEM promover a fato não
  // verificado (§13). Só o CONTRATO de ingestão — os conectores (Reclame AQUI,
  // etc.) são PRDs próprios (§50). Opt-in; sem tabela nova (CA1) — proveniência
  // no evidence_json do sinal. Aditivo; default OFF.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_external_signals_enabled INTEGER DEFAULT 0`); } catch(e){}

  // PRD 5 F2 (ADR-162 §83, D7) — flags opt-in do Customer Recovery & Reputation.
  // `reputation_engine_enabled` = guarda-chuva do módulo; `reclame_aqui_connector_enabled`
  // = liga o conector Reclame AQUI. A INGESTÃO em si ainda exige o contrato externo
  // (radar_external_signals_enabled). Todas aditivas, default OFF (convenção #10).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN reputation_engine_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN reclame_aqui_connector_enabled INTEGER DEFAULT 0`); } catch(e){}
  // PRD 5 F11 (§39-41, D7) — detector de RISCO DE ESCALADA PÚBLICA (prevenção): opt-in,
  // default OFF. Publica `reputational_escalation_risk` em business_signals (advisory).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN reputation_prevention_enabled INTEGER DEFAULT 0`); } catch(e){}

  // PRD 5 F2 — config + estado por-org de um conector de reputação. Credenciais
  // CIFRADAS (EncryptionService, ADR-054) em `config_enc`; nunca em texto/log.
  // `cursor`/`last_synced_at` = leitura incremental (§70); `health_*` = saúde do
  // conector (§67). UNIQUE(org, provider). Aditivo; sem tocar tabela existente.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reputation_connectors (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        config_enc TEXT,
        cursor TEXT,
        last_synced_at DATETIME,
        health_status TEXT DEFAULT 'unknown',
        health_detail TEXT,
        enabled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, provider)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela reputation_connectors', e); }

  // PRD 2 F12.2 (§84, CA17) — teto DIÁRIO de investigações profundas (LLM) POR
  // DETECTOR: hoje só há teto por-org + budget de plataforma; um detector
  // barulhento (storm) podia consumir toda a verba de IA sozinho. Override
  // opcional por org (>0 vale; 0/NULL → default embutido). Aditivo; default 0.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN radar_detector_daily_budget INTEGER DEFAULT 0`); } catch(e){}

  // PRD 3 F4 (§14) — BusinessGoal RICO. Aditivos sobre `business_goals` (que na
  // ADR-160 F4 guardava só metric→target). São METADADOS do objetivo (intenção do
  // dono) — o realizado segue derivado por query (RN-004, nunca contador aqui):
  //   title    — rótulo humano ("Bater R$100k em agosto");
  //   baseline — ponto de partida (de onde se mede o avanço; NULL = de 0);
  //   deadline — prazo-alvo YYYY-MM-DD (NULL = ritmo mensal default);
  //   priority — low|medium|high|critical (ordena a atenção; NULL = sem);
  //   owner    — responsável (user id ou nome livre);
  //   status   — active|achieved|paused|abandoned (ciclo de vida; DEFAULT active
  //              → linhas antigas viram 'active' na migração, 0 regressão).
  // Aditivo/opt-in: nenhum campo obrigatório; `set()` preserva os não informados.
  // NÃO reordenar (CREATE-then-ALTER estrito, convenção nº2).
  try { db.exec(`ALTER TABLE business_goals ADD COLUMN title TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE business_goals ADD COLUMN baseline REAL`); } catch(e){}
  try { db.exec(`ALTER TABLE business_goals ADD COLUMN deadline TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE business_goals ADD COLUMN priority TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE business_goals ADD COLUMN owner TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE business_goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch(e){}

  // PRD 3 F4 (§15) — BusinessConstraint de 1ª classe. Até aqui as restrições do
  // negócio viviam soltas (`organization_settings.negotiator_max_discount`, bands
  // do ApprovalPolicy, `budget_limit_brl` por campanha). Esta tabela dá um MODELO
  // único: um LIMITE/POLÍTICA que as decisões devem respeitar. O Context Engine só
  // LÊ e ANEXA ao pacote (§90, READ+DERIVE) — NÃO faz enforcement (o gate segue no
  // RBAC/ApprovalPolicy). Isolada por org; inerte até o dono declarar (0 regressão).
  //   kind       — discount_ceiling|budget_limit|margin_floor|payment_term_max|
  //                policy|custom (classe da restrição);
  //   scope_type/scope_ref — a que se aplica (global|product|category|store|…);
  //   operator   — lte|gte|eq|max|min (como o valor limita);
  //   value_num/value_unit — o limite numérico (percent|BRL|days|…);
  //   value_text — restrição textual/política (quando não é numérica);
  //   source     — origem (owner_declared|policy|imported) — proveniência (§24);
  //   active     — 1 vigente. NUNCA inventa: só existe o que o dono declarou (§25).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_constraints (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        scope_type TEXT,
        scope_ref TEXT,
        operator TEXT NOT NULL DEFAULT 'lte',
        value_num REAL,
        value_unit TEXT,
        value_text TEXT,
        source TEXT NOT NULL DEFAULT 'owner_declared',
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_business_constraints_org ON business_constraints(organization_id, active, kind);
      CREATE INDEX IF NOT EXISTS idx_business_constraints_scope ON business_constraints(organization_id, scope_type, scope_ref);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela business_constraints', e); }

  // PRD 3 F6 (§36/§37) — CONTEXT CANDIDATES: um candidato de CONTEXTO/REGRA
  // (não de ação) capturado do Fala Tu / de um detector, que só afeta o contexto
  // depois de CONFIRMADO por um humano — NUNCA em silêncio (§36). É o contrato de
  // estados DETECTED→PENDING→CONFIRMED/REJECTED/EXPIRED formalizado como 1ª classe.
  //   kind         — constraint|fact (o que o candidato viraria ao confirmar);
  //   status       — detected|pending|confirmed|rejected|expired;
  //   proposed_json— o payload que MUDARIA o contexto (nunca aplicado até confirmar);
  //   scope_type/scope_ref — a que a mudança se aplica (customer|product|global|…);
  //   source/source_ref — proveniência (falatu|signal|detector|manual + id de origem);
  //   promoted_kind/promoted_ref_id — o que virou ao confirmar (constraint|signal + id).
  // NÃO inventa: o promovido é EXATAMENTE o proposed (§25). Isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_candidates (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'detected',
        title TEXT NOT NULL,
        summary TEXT,
        scope_type TEXT,
        scope_ref TEXT,
        proposed_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        confidence REAL,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_reason TEXT,
        promoted_kind TEXT,
        promoted_ref_id TEXT,
        correlation_id TEXT,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_context_candidates_org ON context_candidates(organization_id, status, kind);
      CREATE INDEX IF NOT EXISTS idx_context_candidates_scope ON context_candidates(organization_id, scope_type, scope_ref);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela context_candidates', e); }

  // PRD 4 F2 (SkillOS) — CATÁLOGO de Capabilities e Skills. Tabelas de PLATAFORMA
  // (universais, SEM organization_id — §49 "Capability universal"): o catálogo é o
  // mesmo pra todos os tenants; o que varia por tenant é entitlement (plano) e
  // vertical, checados na resolução. Prefixo `skillos_` (Decisão D1 — o termo
  // "skill" já é RH). Inertes até algo registrar (0 regressão). Espelham o contrato
  // puro de `skillosModel.ts` (F1); a validação de forma vive lá.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skillos_capabilities (
        capability_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL,
        risk_level TEXT NOT NULL DEFAULT 'low',
        input_schema_json TEXT,
        output_schema_json TEXT,
        required_context TEXT,
        supported_verticals_json TEXT,     -- null/[] = universal (§88-90)
        entitlement_key TEXT,              -- gate de plano (EntitlementService)
        default_timeout_ms INTEGER,
        default_budget_class TEXT,
        fallback_policy TEXT,
        status TEXT NOT NULL DEFAULT 'active',   -- draft|active|deprecated|disabled
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_skillos_capabilities_status ON skillos_capabilities(status, category);

      CREATE TABLE IF NOT EXISTS skillos_skills (
        skill_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        capability_id TEXT NOT NULL,
        description TEXT,
        input_schema_json TEXT,
        output_schema_json TEXT,
        risk_level TEXT NOT NULL DEFAULT 'low',
        allowed_tools_json TEXT NOT NULL DEFAULT '[]',
        forbidden_tools_json TEXT,
        required_permissions_json TEXT,
        required_entitlements_json TEXT,
        required_context_profile TEXT,
        model_requirements_json TEXT,
        max_execution_time_ms INTEGER,
        max_attempts INTEGER,
        budget_class TEXT,
        supports_fallback INTEGER NOT NULL DEFAULT 0,
        fallback_skills_json TEXT,
        success_criteria_json TEXT,
        failure_criteria_json TEXT,
        supported_verticals_json TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_skillos_skills_capability ON skillos_skills(capability_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas skillos_*', e); }

  // PRD 4 F4 (SkillOS Reliability Core, Decisão D4) — AI RUN estende `ai_usage_log`
  // (NÃO cria tabela de tracing paralela). Colunas ADITIVAS, todas NULL por padrão:
  // o `recordUsage()` legado (llm.ts) segue gravando sem elas (0 regressão); o
  // AI Reliability Kernel grava a linha rica. `run_id` correlaciona uma execução
  // de skill; `correlation_id` é o fio ADR-158.
  try {
    const cols = db.prepare(`PRAGMA table_info(ai_usage_log)`).all() as any[];
    const has = (n: string) => cols.some((c: any) => c.name === n);
    if (!has("run_id"))            db.exec(`ALTER TABLE ai_usage_log ADD COLUMN run_id TEXT`);
    if (!has("skill_id"))          db.exec(`ALTER TABLE ai_usage_log ADD COLUMN skill_id TEXT`);
    if (!has("capability_id"))     db.exec(`ALTER TABLE ai_usage_log ADD COLUMN capability_id TEXT`);
    if (!has("prompt_version"))    db.exec(`ALTER TABLE ai_usage_log ADD COLUMN prompt_version TEXT`);
    if (!has("context_hash"))      db.exec(`ALTER TABLE ai_usage_log ADD COLUMN context_hash TEXT`);
    if (!has("context_profile"))   db.exec(`ALTER TABLE ai_usage_log ADD COLUMN context_profile TEXT`);
    if (!has("provider"))          db.exec(`ALTER TABLE ai_usage_log ADD COLUMN provider TEXT`);
    if (!has("validation_status")) db.exec(`ALTER TABLE ai_usage_log ADD COLUMN validation_status TEXT`);
    if (!has("grounding_status"))  db.exec(`ALTER TABLE ai_usage_log ADD COLUMN grounding_status TEXT`);
    if (!has("confidence"))        db.exec(`ALTER TABLE ai_usage_log ADD COLUMN confidence REAL`);
    if (!has("failure_class"))     db.exec(`ALTER TABLE ai_usage_log ADD COLUMN failure_class TEXT`);
    if (!has("retry_count"))       db.exec(`ALTER TABLE ai_usage_log ADD COLUMN retry_count INTEGER DEFAULT 0`);
    if (!has("fallback_used"))     db.exec(`ALTER TABLE ai_usage_log ADD COLUMN fallback_used INTEGER DEFAULT 0`);
    if (!has("run_status"))        db.exec(`ALTER TABLE ai_usage_log ADD COLUMN run_status TEXT`);
    if (!has("correlation_id"))    db.exec(`ALTER TABLE ai_usage_log ADD COLUMN correlation_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_run ON ai_usage_log (organization_id, run_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_skill ON ai_usage_log (organization_id, skill_id, created_at)`);
  } catch(e){ console.error('[DB] Falha ao estender ai_usage_log (AI Run, PRD4 F4)', e); }

  // PRD 4 F5 (SkillOS Model Router) — CATÁLOGO de modelos. Tabela de PLATAFORMA
  // (universal, sem organization_id — §49): "quais modelos existem e o que fazem" é
  // config de plataforma, não de tenant. O Router casa `ModelRequirements` (F1) com
  // as capacidades daqui + a saúde do provider (derivada de ai_usage_log). A saúde
  // do circuit breaker NÃO fica aqui — é derivada por query (RN-004), sem contador.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skillos_model_profiles (
        model TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',   -- reasoning|structured_output|vision|tool_call|long_context|fast|cheap|high_accuracy
        context_tokens INTEGER,
        typical_latency_ms INTEGER,
        budget_class TEXT,                               -- free|low|standard|high
        status TEXT NOT NULL DEFAULT 'active',           -- draft|active|deprecated|disabled
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_skillos_models_provider ON skillos_model_profiles(provider, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela skillos_model_profiles', e); }

  // PRD 4 F11 (SkillOS Evals + Shadow) — CASOS de eval + histórico de RUNS. Tabelas de
  // PLATAFORMA (sem organization_id — §49): "o que é uma boa saída da skill X" é config
  // da plataforma/skill, não de tenant (skills são globais desde a F2). O scorer é
  // DETERMINÍSTICO (P7) — roda na CI sem chave de IA. `skillos_eval_runs.regressed`
  // é o gate de regressão (simples, sem ML): passRate caiu ou caso que passava falhou.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skillos_eval_cases (
        case_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scorer TEXT NOT NULL,                 -- exact|json_subset|field_equals|grounded|non_empty|predicate
        input_json TEXT NOT NULL DEFAULT 'null',
        expected_json TEXT,
        field_path TEXT,
        recorded_output_json TEXT,            -- candidato gravado (replay determinístico)
        weight REAL NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',-- active|disabled
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_skillos_eval_cases_skill ON skillos_eval_cases(skill_id, status);
      CREATE TABLE IF NOT EXISTS skillos_eval_runs (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        prompt_version TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        pass_rate REAL NOT NULL DEFAULT 0,
        regressed INTEGER NOT NULL DEFAULT 0,
        passed_case_ids_json TEXT NOT NULL DEFAULT '[]',
        mode TEXT NOT NULL DEFAULT 'eval',    -- eval|shadow
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_skillos_eval_runs_skill ON skillos_eval_runs(skill_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabelas skillos_eval_cases/runs', e); }

  // PRD 4 F12 (SkillOS Canary + Production Readiness) — ESTADO de rollout por skill na
  // escada §68 + kill switch. Tabela de PLATAFORMA (sem organization_id — §49: onde a
  // skill está na esteira é config da skill global). A linha reservada
  // skill_id='__global__' guarda o KILL SWITCH de plataforma (killed=1 → tudo off) —
  // um único ponto de corte, sem executor/flag paralelos. O gate de execução real
  // segue no CommandExecutor (ADR-159); aqui só se decide exposição + execution_mode.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skillos_rollout (
        skill_id TEXT PRIMARY KEY,            -- ou '__global__' (kill switch de plataforma)
        stage TEXT NOT NULL DEFAULT 'development', -- development|shadow|pilot|assisted|approved_execution|broader
        canary_percent INTEGER NOT NULL DEFAULT 0, -- 0..100 (cohort estável por hash)
        killed INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela skillos_rollout', e); }

  // Markers de PLATAFORMA do SkillOS — flags one-time (sem organization_id) pra migrações
  // operacionais idempotentes que devem rodar UMA vez e nunca re-disparar (ex.: promoção
  // §68 dos pilotos). Tabela aditiva; a chave é o nome do marker.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skillos_platform_markers (
        marker TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar tabela skillos_platform_markers', e); }

  // PRD 4 — Onboarding dos 3 pilotos §61 (Collection Intent Classifier, Sales Recovery
  // Message, Signal Investigation) + PROMOÇÃO §68 pra `pilot`, CANÁRIO @100% (10→25→50→100)
  // e AVANÇO de estágio pra `approved_execution` → `broader` (último degrau).
  // `seedPilots` semeia definições + estágio inicial `shadow` (não-clobber, RN-RO-5);
  // `promotePilotsToPilot`/`raisePilotsCanary` aplicam as decisões do operador de subir a
  // esteira/cohort — cada uma UMA vez (marker), sem brigar com rollback. Import dinâmico
  // (o seeder importa services que importam db — evita ciclo). Erro aqui NÃO quebra o
  // boot (operacional; admin re-roda pelas rotas /skillos/*).
  try {
    const hasSkillos = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skillos_capabilities'").get();
    if (hasSkillos) {
      import("./SkillOsPilotSeeder.js").then((m) => {
        try { m.SkillOsPilotSeeder.seedPilots(); m.SkillOsPilotSeeder.promotePilotsToPilot(10); m.SkillOsPilotSeeder.raisePilotsCanary(25); m.SkillOsPilotSeeder.raisePilotsCanary(50); m.SkillOsPilotSeeder.raisePilotsCanary(100); m.SkillOsPilotSeeder.advancePilotsToStage("approved_execution"); m.SkillOsPilotSeeder.advancePilotsToStage("broader"); }
        catch (e) { console.error('[DB] Seed/promoção dos pilotos SkillOS falhou', e); }
      }).catch((e) => { console.error('[DB] Falha ao importar SkillOsPilotSeeder', e); });
    }
  } catch(e) { console.error('[DB] Falha ao seedar pilotos SkillOS', e); }

  // ADR-164 F12 — Platform Health Events: alertas de PLATAFORMA (Admin Master), o
  // "Platform Health Event separado de business_signals per-tenant" (RN-PRC). GLOBAL,
  // sem organization_id (molde do research_usage_log/platform_health_snapshots). Anti-spam
  // por dedupe_key: um evento aberto por chave; reincidência bumpa occurrences/last_seen_at
  // em vez de duplicar. `notified_at` guarda a última notificação pra janela anti-spam.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_health_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,              -- anomaly | capacity_forecast | protection_mode | dependency | ...
        severity TEXT NOT NULL,                -- info | warning | critical
        dedupe_key TEXT NOT NULL UNIQUE,       -- anti-spam: 1 evento aberto por chave
        title TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open',   -- open | resolved
        occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        notified_at DATETIME,                  -- última notificação enviada (janela anti-spam)
        resolved_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_platform_health_events_status
        ON platform_health_events (status, severity, last_seen_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar platform_health_events (ADR-164 F12)', e); }

  // ADR-165 F5 — anti-dupla-contagem em action_outcomes (achado (c) da auditoria PRD 8).
  // `event_key` opcional identifica o EVENTO de medição; o índice UNIQUE PARCIAL só
  // constrange linhas que optam por uma chave (WHERE event_key IS NOT NULL) — linhas
  // legadas (null) nunca conflitam, então a criação jamais falha em dado existente
  // (mesmo padrão do idx_action_confirmations_extref). Com a chave, medir 2× o mesmo
  // evento vira no-op idempotente em vez de gravar dois outcomes (dupla contagem).
  try { db.exec(`ALTER TABLE action_outcomes ADD COLUMN event_key TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_action_outcomes_event_key ON action_outcomes (organization_id, event_key) WHERE event_key IS NOT NULL`); } catch(e){}

  // ADR-166 F1 (PRD 9) — ledger por-evento do aprendizado: idempotência de recordOutcome
  // + PROCEDÊNCIA. Hoje `recordOutcome` só muta agregados (`business_pattern_type_stats.acted`
  // e `business_patterns.confidence`) sem registro por-evento — chamar 2× dobra a contagem
  // (achado (a) da auditoria F0). Este ledger dá (1) idempotência via `event_key` (mesmo
  // padrão do `action_outcomes.event_key` da F5/PRD 8 — índice UNIQUE PARCIAL que nunca
  // constrange linha legada NULL, então a criação jamais falha em dado existente) e (2) a
  // `source` do desfecho: 'assured' quando vem da escada do PRD 8 (OutcomeAssurance), 'manual'
  // caso contrário — base do `assuredEffectiveness` da F2 (DONE ≠ EXEMPLO DE SUCESSO). Isolado
  // por organization_id. Aditivo; nenhum motor novo (§184) — é o registro que faltava ao motor único.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS business_pattern_outcomes (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        pattern_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        pattern_type TEXT NOT NULL,
        outcome TEXT NOT NULL,                  -- worked | no_effect | backfired
        realized_impact REAL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',  -- assured (escada PRD 8) | manual
        event_key TEXT,                         -- idempotência opcional (NULL = legado, nunca conflita)
        correlation_id TEXT,
        action_id TEXT,
        note TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_business_pattern_outcomes_pattern
        ON business_pattern_outcomes (organization_id, pattern_id);
      CREATE INDEX IF NOT EXISTS idx_business_pattern_outcomes_type
        ON business_pattern_outcomes (organization_id, domain, pattern_type, source);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_business_pattern_outcomes_event_key
        ON business_pattern_outcomes (organization_id, event_key) WHERE event_key IS NOT NULL;
    `);
  } catch(e){ console.error('[DB] Falha ao criar business_pattern_outcomes (ADR-166 F1)', e); }

  // PRD 10 / ADR-167 F2 — Social Connection Hub. ESTADO por-org de uma conexão de
  // CANAL SOCIAL (Instagram/Facebook/TikTok/…): credenciais CIFRADAS (`config_enc`,
  // AES-GCM via EncryptionService — nunca cru numa rota, RN-SI-05), estado de conexão
  // observável (§5 — token vencido nunca "connected"), capacidades DESCOBERTAS e
  // cacheadas (RN-SI-06), escopos concedidos e saúde. Espelha `reputation_connectors`
  // (ADR-162); aditivo, opt-in (`enabled` DEFAULT 0). UNIQUE(org,channel) — 1 conexão
  // por canal por org (convenção #1). NÃO é tabela de alerta paralela nem 2º Estúdio (§42).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'stub',
        config_enc TEXT,
        capabilities_json TEXT,
        scopes_json TEXT,
        connection_state TEXT DEFAULT 'not_connected',
        state_detail TEXT,
        health_checked_at DATETIME,
        enabled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_social_connections_org
        ON social_connections (organization_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar social_connections (ADR-167 F2)', e); }

  // PRD 10 / ADR-167 F4 — Social Analytics Ingestion. Snapshot por-org de POSTS
  // PRÓPRIOS + analytics lidos do provider (getPosts/getPostAnalytics). Uma linha por
  // post por canal por org; UNIQUE(org,channel,post_external_id) torna a ingestão
  // IDEMPOTENTE (upsert). Métricas NULL quando o provedor não fornece (null≠0, RN-SI-12)
  // — nunca inventa 0. Aditivo, opt-in (alimentado só por conexão habilitada). Fonte do
  // closed-loop de conteúdo (Outcome Assurance/Creative Learning nas fatias finais).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS social_post_metrics (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        post_external_id TEXT NOT NULL,
        kind TEXT,
        caption TEXT,
        permalink TEXT,
        published_at DATETIME,
        impressions INTEGER,
        reach INTEGER,
        likes INTEGER,
        comments INTEGER,
        shares INTEGER,
        saves INTEGER,
        clicks INTEGER,
        analytics_available INTEGER DEFAULT 0,
        fetched_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, channel, post_external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_social_post_metrics_org
        ON social_post_metrics (organization_id, channel);
    `);
  } catch(e){ console.error('[DB] Falha ao criar social_post_metrics (ADR-167 F4)', e); }

  // PRD 10 / ADR-167 F10 — Calendário editorial. ESTENDE `scheduled_posts` (§42 — sem 2º
  // calendário): estágio `draft` (rascunho no calendário, NÃO publica — o passe só pega
  // `status='scheduled'`, então drafts ficam de fora até aprovados; 0-regressão) + o fio
  // da oportunidade→variante (F7/F9) pra atribuição futura (F12). Aditivos, nunca reordenar.
  try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN channel TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN correlation_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE scheduled_posts ADD COLUMN variant_key TEXT`); } catch(e){}

  // PRD 11 / ADR-168 F1 — Brand DNA 2.0. ESTENDE `brand_profiles` (§37 — sem 2º store de
  // marca) com identidade ESTRUTURADA (persona/público/posicionamento/proibições/do-don't),
  // além do palette/tone/style/summary já existentes. A VOZ continua sendo o
  // `organization_settings.brand_voice_context` da ADR-155 (fonte única, unificada pelo
  // `BrandDnaService`) — não duplicamos voz aqui. `dna_version` versiona; o histórico vai
  // pra `brand_dna_versions`. Aditivos, nunca reordenar (convenção nº 2).
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN persona TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN audience TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN positioning TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN forbidden_json TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN do_examples_json TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN dont_examples_json TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN dna_version INTEGER NOT NULL DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN dna_updated_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE brand_profiles ADD COLUMN dna_updated_by TEXT`); } catch(e){}
  // Histórico versionado do Brand DNA — snapshot canônico por versão (rollback/auditoria).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS brand_dna_versions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_brand_dna_versions_org
        ON brand_dna_versions (organization_id, version DESC);
    `);
  } catch(e){ console.error('[DB] Falha ao criar brand_dna_versions (ADR-168 F1)', e); }

  // PRD 11 / ADR-168 F2 — Campaign Objective Contract. Liga um OBJETIVO de campanha
  // (do `CAMPAIGN_OBJECTIVES` do Estúdio) a uma MÉTRICA DE META de negócio
  // (`BusinessGoalService`, ex.: revenue/appointments), com um `correlation_id` que o
  // conteúdo produzido sob o contrato carrega (fio ADR-158 → atribuição F9/F12). É AQUI
  // que ENGAGEMENT≠BUSINESS VALUE começa: objetivos de vaidade (engajamento/alcance) ligam
  // a `goal_metric = NULL` (honesto — não fingem métrica de negócio). Sem tabela de meta
  // paralela (§37 — a meta segue em `business_goals`). Aditiva, opt-in de uso.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_objective_contracts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        objective_id TEXT NOT NULL,          -- id em CAMPAIGN_OBJECTIVES (vendas|agendamento|...)
        goal_metric TEXT,                    -- métrica em BusinessGoalService (revenue|appointments) ou NULL (vaidade)
        correlation_id TEXT NOT NULL,        -- fio que o conteúdo do contrato carrega (ADR-158)
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active', -- active | canceled | achieved
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, correlation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_obj_contracts_org
        ON campaign_objective_contracts (organization_id, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar campaign_objective_contracts (ADR-168 F2)', e); }

  // PRD 11 / ADR-168 F6 — Creative Experiment Engine. Generaliza o motor de experimento de
  // prospecção (`ProspectResearchService`, §37 — REUSA `twoProportionZ`, NÃO cria 2º motor)
  // sobre VARIANTES DE CONTEÚDO: mede a taxa de ENGAJAMENTO de cada variante e declara o
  // campeão com rigor estatístico. `variant_key` na `social_post_metrics` liga a métrica do
  // post à variante testada (aditivo; null = fora de experimento). O vencedor por RESULTADO
  // DE NEGÓCIO é a F9 (engajamento aqui é PROXY — RN-CG-01). Aditivas, opt-in.
  try { db.exec(`ALTER TABLE social_post_metrics ADD COLUMN variant_key TEXT`); } catch(e){}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS creative_experiments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        objective_id TEXT,                   -- objetivo de campanha (opcional)
        correlation_id TEXT,                 -- fio ADR-158 (opcional)
        metric TEXT NOT NULL DEFAULT 'engagement',
        min_sample INTEGER NOT NULL DEFAULT 100,  -- impressões mínimas por variante (anti-ruído)
        confidence_z REAL NOT NULL DEFAULT 1.96,
        status TEXT NOT NULL DEFAULT 'running',    -- running | completed
        decision TEXT,                       -- winner | inconclusive | insufficient_data
        winner_variant_key TEXT,
        decision_reason TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS creative_experiment_variants (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        experiment_id TEXT NOT NULL,
        variant_key TEXT NOT NULL,
        label TEXT,
        is_champion INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, experiment_id, variant_key)
      );
      CREATE INDEX IF NOT EXISTS idx_creative_experiments_org
        ON creative_experiments (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_creative_exp_variants_exp
        ON creative_experiment_variants (organization_id, experiment_id);
      CREATE INDEX IF NOT EXISTS idx_social_post_metrics_variant
        ON social_post_metrics (organization_id, variant_key);
    `);
  } catch(e){ console.error('[DB] Falha ao criar creative_experiments (ADR-168 F6)', e); }

  // PRD 11 / ADR-168 F7 — Content→Lead Attribution. Liga o CONTEÚDO publicado (pelo
  // `correlation_id` da ação `social_publish`) a um LEAD (`contacts`), fechando o 1º elo do
  // fio conteúdo→lead→venda→receita→margem. É o system-of-record que o `ContentOutcomeResolver`
  // (registry do PRD 8, §37 — register-a-resolver) consulta. Espelha `sales_recovery_attributions`.
  // Um lead é MAIS que engajamento (RN-CG-01) — é o 1º sinal de valor de negócio do conteúdo.
  // Aditiva; UNIQUE evita dupla contagem do mesmo lead pro mesmo conteúdo (RN-CG-03).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_lead_attributions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,        -- fio da campanha/conteúdo (ADR-158)
        contact_id TEXT NOT NULL,            -- o lead (contacts)
        action_id TEXT,                      -- ação social_publish de origem (opcional)
        source TEXT,                         -- como o lead chegou (link/utm/whatsapp_ref/manual)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, correlation_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_content_lead_attr_corr
        ON content_lead_attributions (organization_id, correlation_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar content_lead_attributions (ADR-168 F7)', e); }

  // PRD 11 / ADR-168 F8 — Lead→Sale→Revenue→Margin. Estende o fio da F7 até o DINHEIRO:
  // pra cada lead atribuído a um conteúdo, resolve o valor da venda por PRECEDÊNCIA (orders
  // pago→fact > quotes aceito→estimate > contacts.avg_ticket→estimate > nenhum→não atribui),
  // espelhando `SalesRecoveryAttributionService`. Margem = unit_price − unit_cost (só fact
  // quando TODO custo é conhecido; senão null — RN-CG-03 não inventa dinheiro). `revenue_basis`
  // e `margin_basis` separam fact de estimate (nunca somados). UNIQUE(org,corr,contact) evita
  // dupla contagem. Aditiva; dinheiro role-gated na rota (RN-CG-06).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_sale_attributions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        order_id TEXT,                       -- venda de origem (quando source='orders')
        revenue REAL,                        -- valor atribuído
        revenue_basis TEXT,                  -- 'fact' | 'estimate'
        margin REAL,                         -- lucro (null quando custo desconhecido)
        margin_basis TEXT,                   -- 'fact' | null
        source TEXT,                         -- 'orders' | 'quotes' | 'contacts_avg_ticket'
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, correlation_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_content_sale_attr_corr
        ON content_sale_attributions (organization_id, correlation_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar content_sale_attributions (ADR-168 F8)', e); }

  // PRD 11 / ADR-168 F9 — Objective-aware Winner. Cada variante do experimento ganha um
  // `correlation_id` que liga a variante ao seu conteúdo publicado → às atribuições de
  // negócio (F7/F8). Assim o vencedor pode ser escolhido pelo RESULTADO DE NEGÓCIO (receita/
  // leads), não só pelo engajamento (RN-CG-01). Aditivo.
  try { db.exec(`ALTER TABLE creative_experiment_variants ADD COLUMN correlation_id TEXT`); } catch(e){}

  // SEC-F6 (SEC-05 / achado A7) — proteção de REPLAY para webhooks inbound. Um evento legítimo
  // capturado e reenviado N vezes deve executar UMA vez só. `UNIQUE(provider, event_id)` é a trava:
  // a 1ª inserção vence; as repetições batem no índice e são ignoradas. Aditiva; nunca rejeita a
  // 1ª entrega (só dedup). GLOBAL (não é por-org — o webhook chega antes de resolver o tenant).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_inbound_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_inbound_recv ON webhook_inbound_events (received_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar webhook_inbound_events (SEC-F6)', e); }

  // PRD 11 / ADR-168 F15 — Growth Autopilot. Postura SHADOW-first (RN-CG-10): 'off' (default,
  // opt-in convenção nº 10) | 'shadow' (propõe, mas NUNCA executa — RN-CG-08). NÃO existe
  // 'auto' aqui: crescimento autônomo nunca vai direto pra execução. Aditivo.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN growth_autopilot_mode TEXT DEFAULT 'off'`); } catch(e){}

  // ADR-169 F4 (BEAUTY-004) — vínculo N:N profissional↔serviço da vertical
  // Beleza & Salões. Decisão D6 do ADR-169: tabela nova (opção "a") em vez de
  // mapear cada serviço como especialidade (opção "b" — `clinic_professional_
  // specialties`) — evita ambiguidade "corte é especialidade ou serviço?" e
  // libera comissão por serviço nativamente. `service_id` referencia
  // `products_services.id` (a tabela canônica de produto+serviço). `is_primary`
  // marca o serviço-signature do profissional (útil para UI/recomendação).
  // `commission_percent` fica 0.0 default — cobrado por fatia futura de
  // comissão; nunca inventa valor. `active=0` "desliga" o vínculo sem apagar
  // (o profissional pode voltar a atender o serviço). UNIQUE evita duplicar.
  // A tabela é agnóstica à vertical — nada impede outras verticais reusarem
  // (é aditiva sobre `products_services`); só a Beleza a preenche por padrão.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS professional_services (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        is_primary INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        commission_percent REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, professional_id, service_id)
      );
      CREATE INDEX IF NOT EXISTS idx_professional_services_by_prof
        ON professional_services (organization_id, professional_id, active);
      CREATE INDEX IF NOT EXISTS idx_professional_services_by_service
        ON professional_services (organization_id, service_id, active);
    `);
  } catch(e){ console.error('[DB] Falha ao criar professional_services (ADR-169 F4)', e); }

  // ADR-169 F5 (BEAUTY-005) — Fundação da Beauty AI. 4 tabelas novas, todas
  // aditivas (CREATE-then-ALTER estrito, convenção nº 2). Espelham o padrão
  // do Fashion Studio (`fashion_*`) mas usam `contact_id` (CRM canônico) em
  // vez de `customer_id` (storefront). Foto de cliente é dado pessoal
  // sensível (LGPD Art.5 II) — RN-BS-04 exige consent tipado; RN-BS-05
  // proíbe log de foto/prompt.
  //
  // (a) beauty_consents — consent TIPADO por contato+escopo. Escopos:
  //     hair_simulation (upload+processamento da foto pro Simulador),
  //     use_in_marketing (publicar antes/depois no Instagram),
  //     whatsapp_notification, guardian_approval (menor). Revogar apaga
  //     assets do escopo (LGPD Art.18). NUNCA delete — soft-off com
  //     revoked_at preserva prova documental.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_consents (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        consent_type TEXT NOT NULL,
        policy_version TEXT DEFAULT 'v1',
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_consents_org_contact
        ON beauty_consents (organization_id, contact_id, consent_type);
      CREATE INDEX IF NOT EXISTS idx_beauty_consents_active
        ON beauty_consents (organization_id, contact_id, consent_type, revoked_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_consents (ADR-169 F5)', e); }

  // (b) beauty_visual_consultations — sessão da cliente na jornada
  //     Descobrir→Experimentar→Decidir→Agendar. Uma consulta = 1 objetivo
  //     (cor/corte/mechas/estilo/completo) + intensidade + fotos + escolha.
  //     status: draft → ready (foto aprovada) → selected (simulação escolhida)
  //     → scheduled (virou agendamento — F10) | abandoned (TTL vencido).
  //     expires_at: TTL configurável (default 30d — PRD §26/27). Anti-orfã:
  //     scheduled_appointment_id só é preenchido quando F10 amarrar.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_visual_consultations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT,
        status TEXT DEFAULT 'draft',
        goal TEXT,
        intensity TEXT,
        reference_photo_key TEXT,
        consent_id TEXT,
        selected_simulation_id TEXT,
        selected_at DATETIME,
        scheduled_appointment_id TEXT,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_consult_org_status
        ON beauty_visual_consultations (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_beauty_consult_contact
        ON beauty_visual_consultations (organization_id, contact_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_visual_consultations (ADR-169 F5)', e); }

  // (c) beauty_avatar_assets — a FOTO em si (dado pessoal sensível).
  //     storage_key: caminho no private_media (NUNCA /media público).
  //     status: quarantined → approved | rejected → deleted (soft) | expired.
  //     safety_report_json: apenas flags booleanas (RN-BS-05 — nunca imagem
  //     bruta no log/JSON). Retenção: expires_at = agora + beauty_avatar_
  //     retention_days (default 30). Purga preguiçosa no acesso + Scheduler.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_avatar_assets (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        consultation_id TEXT,
        storage_key TEXT,
        status TEXT DEFAULT 'quarantined',
        safety_report_json TEXT,
        consent_id TEXT,
        expires_at DATETIME,
        deleted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_avatar_org_contact
        ON beauty_avatar_assets (organization_id, contact_id, status);
      CREATE INDEX IF NOT EXISTS idx_beauty_avatar_consultation
        ON beauty_avatar_assets (organization_id, consultation_id);
      CREATE INDEX IF NOT EXISTS idx_beauty_avatar_expires
        ON beauty_avatar_assets (status, expires_at)
        WHERE status != 'deleted' AND expires_at IS NOT NULL;
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_avatar_assets (ADR-169 F5)', e); }

  // (d) beauty_reference_looks — referências CURADAS pelo salão (fotos de
  //     antes/depois do próprio Studio, presets do salão). É a "biblioteca
  //     de looks" que o Simulador (F6) usa como referência de cor/corte —
  //     e o `LookServiceRecommendationService` (F9) casa com o catálogo.
  //     `suggested_services_json` = ["service_id_1", ...] só do próprio
  //     tenant (RN-BS-02: IA nunca sugere serviço fora do catálogo).
  //     `hair_type`/`length`/`tone`/`cut_style` são TAGS descritivas
  //     estruturadas (nunca ranking).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_reference_looks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        image_storage_key TEXT,
        hair_type TEXT,
        length TEXT,
        tone TEXT,
        cut_style TEXT,
        suggested_services_json TEXT,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_ref_looks_org
        ON beauty_reference_looks (organization_id, active);
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_reference_looks (ADR-169 F5)', e); }

  // ADR-169 F5 — colunas opt-in em organization_settings (convenção nº 10):
  //   beauty_hair_simulator_enabled (default 0) — flag master do Simulador
  //     de Cabelo, checada em F6+.
  //   beauty_avatar_retention_days (default 30, clamp 1..365) — janela de
  //     purga automática dos avatares (RN-BS-04).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN beauty_hair_simulator_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN beauty_avatar_retention_days INTEGER DEFAULT 30`); } catch(e){}

  // ADR-169 F6 (BEAUTY-006) — Simulador de Cabelo REAL. Espelha o padrão
  // `fashion_tryon_jobs` da ADR-037, adaptado à Beleza:
  //  - `consultation_id` amarra à `beauty_visual_consultations` (F5); a
  //    foto de referência (aprovada) vem via `avatar_id` (F5).
  //  - `simulation_type`: 'color' | 'cut' | 'combined' (ambos).
  //  - `parameters_json`: {color?: 'morena_iluminada', cut?: 'chanel',
  //    reference_look_id?: id de `beauty_reference_looks`}.
  //  - `provider_key`: entra no `input_hash` de idempotência (trocar de
  //    provedor NÃO reaproveita output antigo).
  //  - `input_hash = sha256(avatarKey:params:providerKey)` — mesmo pedido
  //    já SUCCEEDED devolve pronto SEM chamar provider (economia).
  //  - `status`: CREATED → QUEUED → PROCESSING → SUCCEEDED | FAILED_FINAL
  //    | DELETED | EXPIRED. Fluxo idêntico ao `fashion_tryon_jobs`.
  //  - `output_storage_key`: caminho no `private_media/beauty/` (nunca
  //    /media público — RN-BS-04); URL assinada via `fileSigning` do F5.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_visual_simulations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        consultation_id TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        simulation_type TEXT NOT NULL,
        parameters_json TEXT,
        reference_look_id TEXT,
        provider_key TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT DEFAULT 'CREATED',
        output_storage_key TEXT,
        error_code TEXT,
        error_message_safe TEXT,
        started_at DATETIME,
        completed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_sim_org_consult
        ON beauty_visual_simulations (organization_id, consultation_id, status);
      CREATE INDEX IF NOT EXISTS idx_beauty_sim_hash
        ON beauty_visual_simulations (organization_id, input_hash, status);
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_visual_simulations (ADR-169 F6)', e); }

  // ADR-169 F8 (BEAUTY-008) — Análise de Harmonia Visual.
  // Uma linha por CHAMADA de análise (nunca substitui — histórico completo
  // por consulta, ADR/LGPD auditável). `dimensions_json` é fixo em VOCAB
  // controlado (contraste/equilíbrio/destaque/volume/intensidade) — nunca
  // texto livre. `narrative` é DESCRITIVA (nunca julga aparência, nunca
  // ranking — RN-BS-03). `disclaimer_shown=1` obrigatório (PRD §31).
  // `simulation_id` opcional: análise pode ser sobre a consulta como um
  // todo (só reference photo + parâmetros do objetivo) OU sobre uma
  // simulação específica escolhida.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_visual_analyses (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        consultation_id TEXT NOT NULL,
        simulation_id TEXT,
        dimensions_json TEXT NOT NULL,
        narrative TEXT NOT NULL,
        disclaimer_shown INTEGER DEFAULT 1,
        actor_user_id TEXT,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_analyses_consult
        ON beauty_visual_analyses (organization_id, consultation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_beauty_analyses_sim
        ON beauty_visual_analyses (organization_id, simulation_id);
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_visual_analyses (ADR-169 F8)', e); }

  // ADR-169 F24 — Visagismo: subtom de pele → cores que harmonizam +
  // formato do rosto → cortes que equilibram (feminino/masculino/neutro).
  // Recomendação TÉCNICA (RN-BS-03 — nunca julga a pessoa). Histórico por
  // consulta pra auditoria LGPD. `source`: manual (profissional avaliou),
  // ai (Gemini classificou da foto) ou pending (indeterminado — não inventa).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_visagism_analyses (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        consultation_id TEXT NOT NULL,
        undertone TEXT NOT NULL,
        face_shape TEXT NOT NULL,
        profile TEXT NOT NULL,
        source TEXT NOT NULL,
        recommended_colors_json TEXT NOT NULL,
        recommended_cuts_json TEXT NOT NULL,
        narrative TEXT NOT NULL,
        disclaimer_shown INTEGER DEFAULT 1,
        actor_user_id TEXT,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_beauty_visagism_consult
        ON beauty_visagism_analyses (organization_id, consultation_id, created_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_visagism_analyses (ADR-169 F24)', e); }

  // ADR-169 F25 — Ficha técnica capilar do cliente do salão (cadastro de
  // balcão/lead). SÓ campos que ajudam de verdade na recomendação/simulação:
  // tipo/espessura/comprimento do cabelo, histórico químico (afeta a
  // VIABILIDADE de descoloração — a profissional precisa saber), preferência
  // de manutenção e origem do lead. Peso/altura/idade ficam FORA por
  // minimização LGPD (não mudam recomendação de cor/corte).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS beauty_client_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        hair_type TEXT,
        hair_thickness TEXT,
        hair_length TEXT,
        chemical_history TEXT,
        maintenance_pref TEXT,
        lead_source TEXT,
        lead_source_other TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (organization_id, contact_id)
      );
    `);
  } catch(e){ console.error('[DB] Falha ao criar beauty_client_profiles (ADR-169 F25)', e); }
  // ADR-169 F33 — detalhe do "Outro" da origem do lead (texto livre quando
  // lead_source='outro'). Aditivo pra bancos existentes.
  try { db.exec(`ALTER TABLE beauty_client_profiles ADD COLUMN lead_source_other TEXT`); } catch(e){}

  // ADR-169 F5-transversal-A — Consent transversal de comunicações outbound.
  // Flag opt-in por org: quando ativa, `MessageProviderService.sendMessage`
  // consulta `contact_consents.comunicacoes` do contato-destino antes de
  // disparar. Sem flag (default), 0-regressão. Aditivo puro.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN outbound_consent_required INTEGER DEFAULT 0`); } catch(e){}

  // ADR-169 F5-transversal-B — Quiet-hours CLIENTE transversal.
  // Flag opt-in por org: quando ativa, `MessageProviderService.sendMessage`
  // recusa envio em hora SP dentro da janela silenciosa configurada (default
  // 22h→8h). NULL nos horários = usa defaults (22, 8). Sem flag (default 0),
  // 0-regressão. Aditivo puro. NÃO confundir com `proactive_awake_start/end`
  // (UxPreferences ADR-163 F13) — aquele é a janela do DONO pra receber push;
  // este é a janela em que o SISTEMA silencia mensagens pra CLIENTE.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN client_quiet_hours_enforced INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN client_quiet_hours_start_hour INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN client_quiet_hours_end_hour INTEGER`); } catch(e){}

  // ADR-169 F5-transversal-C — Frequency cap por contato.
  // Flag opt-in por org: quando ativa, `MessageProviderService.sendMessage`
  // recusa envio a um contato que já recebeu N ou mais mensagens do sistema
  // na última janela de H horas (defaults 3 mensagens / 24h). Registra
  // TENTATIVAS bem-sucedidas em `outbound_send_log` (tabela dedicada
  // isolada de `messages` — a guard não depende do padrão de escrita dos
  // callers). Sem flag (default 0), 0-regressão.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN client_frequency_cap_enforced INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN client_frequency_cap_max_per_window INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN client_frequency_cap_window_hours INTEGER`); } catch(e){}

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_send_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_send_log_org_contact_time
        ON outbound_send_log (organization_id, contact_id, sent_at);
    `);
  } catch(e){ console.error('[DB] Falha ao criar outbound_send_log (ADR-169 F5-C)', e); }

  // ADR-169 F11 — Detector de simulação abandonada (Beauty Autopilot em SHADOW).
  // Flag opt-in por org: quando ativa, o Scheduler passa periodicamente varrendo
  // consultas 'ready' com simulação SUCCEEDED que não avançaram pra 'selected'
  // dentro de X horas (default 24h) e publica sinal na espinha canônica
  // (`business_signals` com dedupe `beauty:abandoned_simulation:{consultationId}` —
  // D6, sem tabela paralela). RN-BS-12: NÃO agenda por IA — o autopilot só
  // PROPÕE follow-up (fatia futura via DecisionAction+ApprovalPolicy).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN beauty_abandoned_detector_enabled INTEGER DEFAULT 0`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN beauty_abandoned_after_hours INTEGER`); } catch(e){}

  // ADR-169 F12 — Detector de manutenção. Coluna aditiva em products_services
  // (NULL = sem manutenção; INTEGER >0 = dias entre um serviço e o retorno
  // sugerido, ex.: coloração = 30d, escova progressiva = 90d). Flag opt-in por
  // org: quando ativa, o Scheduler varre appointments passados e publica sinal
  // pra contatos cuja janela do serviço venceu SEM haver próximo appointment
  // já marcado. Sinal na espinha canônica com dedupe
  // `beauty:maintenance_due:{contactId}:{serviceId}` — D6, sem tabela paralela.
  try { db.exec(`ALTER TABLE products_services ADD COLUMN maintenance_days INTEGER`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN beauty_maintenance_detector_enabled INTEGER DEFAULT 0`); } catch(e){}

  // ADR-169 F14 — Detector de vaga (horário ocioso + cliente elegível). Flag
  // opt-in por org: quando ativa, o Scheduler varre gaps futuros na agenda por
  // profissional dentro do horário de funcionamento e publica sinal quando há
  // ≥1 cliente ELEGÍVEL pra oferta (atendimento com o mesmo pro em <=90d,
  // sem appt futuro). Sinal `beauty:vacancy_opportunity:{professionalId}:{slotStartISO}`
  // no `business_signals` — D6, sem tabela paralela.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN beauty_vacancy_detector_enabled INTEGER DEFAULT 0`); } catch(e){}

  // Tarefas recorrentes (PRD Moda/TOULON, frente TASK; ADR-171). A REGRA é um
  // template; cada disparo do Scheduler MATERIALIZA uma tarefa normal em `tasks`.
  // next_run_at é guardado em UTC; local_time + timezone (IANA) definem a hora
  // local. Idempotência por occurrence_dedupe_key nas tarefas materializadas.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_recurrence_rules (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to TEXT,
        store_id TEXT,
        priority TEXT DEFAULT 'media',
        frequency TEXT NOT NULL,               -- daily | weekly | monthly
        interval INTEGER NOT NULL DEFAULT 1,   -- a cada N (dias/semanas/meses)
        by_weekday TEXT,                       -- JSON [0..6] (0=domingo) p/ weekly
        day_of_month INTEGER,                  -- 1..31 p/ monthly (clampa no fim do mês)
        local_time TEXT NOT NULL DEFAULT '09:00', -- HH:MM na timezone da regra
        timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
        starts_on TEXT NOT NULL,               -- YYYY-MM-DD (data local de início)
        ends_on TEXT,                          -- YYYY-MM-DD (fim por data) ou NULL
        max_occurrences INTEGER,               -- fim por contagem ou NULL
        next_run_at DATETIME,                  -- próximo disparo (UTC ISO)
        status TEXT DEFAULT 'active',          -- active | paused | completed
        notification_policy_json TEXT,         -- política de lembrete (TASK-007, fatia futura)
        created_by TEXT,
        updated_by TEXT,
        version INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_task_recurrence_due ON task_recurrence_rules (status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_task_recurrence_org ON task_recurrence_rules (organization_id);
    `);
  } catch (e) { /* noop */ }
  // Colunas de OCORRÊNCIA nas tarefas materializadas + índice único p/ dedupe.
  try { db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_rule_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_occurrence_at DATETIME`); } catch(e){}
  try { db.exec(`ALTER TABLE tasks ADD COLUMN occurrence_dedupe_key TEXT`); } catch(e){}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_occurrence_dedupe ON tasks (organization_id, occurrence_dedupe_key) WHERE occurrence_dedupe_key IS NOT NULL`); } catch(e){}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_rule ON tasks (recurrence_rule_id)`); } catch(e){}

  // Log de lembretes de tarefa (PRD Moda/TOULON, TASK-007; ADR-172). Dedupe por
  // (org, tarefa, canal, tipo) — nunca manda o mesmo lembrete duas vezes.
  // status: sent | failed (candidato a retry). Também é a trilha de auditoria.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_reminder_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        assigned_to TEXT,
        channel TEXT NOT NULL,                 -- whatsapp | (futuro: outros)
        reminder_type TEXT NOT NULL DEFAULT 'materialized',
        status TEXT NOT NULL DEFAULT 'sent',   -- sent | failed
        attempts INTEGER DEFAULT 1,
        detail TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reminder_dedupe ON task_reminder_log (organization_id, task_id, channel, reminder_type);
      CREATE INDEX IF NOT EXISTS idx_task_reminder_status ON task_reminder_log (status);
    `);
  } catch (e) { /* noop */ }

  // Escopo de LOJA por usuário (PRD Moda/TOULON, CRM-002/AC-04; ADR-173). N:N
  // usuário↔loja. Regra: owner/admin veem tudo; usuário SEM atribuição vê tudo
  // (opt-in, retrocompatível); usuário COM atribuição fica restrito às lojas dele.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_stores (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_stores_uniq ON user_stores (organization_id, user_id, store_id);
      CREATE INDEX IF NOT EXISTS idx_user_stores_user ON user_stores (organization_id, user_id);
    `);
  } catch (e) { /* noop */ }

  // Propostas de solução do gerente (PRD Moda/TOULON, frente LEARN; ADR-174).
  // Conhecimento HUMANO governado: proposta → revisão → teste → resultado
  // assegurado → promoção à memória de padrões (nunca "treino automático").
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS manager_solution_proposals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT,                          -- NULL = escopo da organização (várias lojas)
        ref_type TEXT,                          -- signal | pattern | task
        ref_id TEXT,
        author_user_id TEXT,
        title TEXT NOT NULL,
        proposal_text TEXT NOT NULL,
        conditions TEXT,                        -- condição em que funciona
        expected_metric TEXT,                   -- indicador esperado
        baseline REAL,
        observation_deadline TEXT,              -- prazo de observação (YYYY-MM-DD)
        risks TEXT,
        state TEXT NOT NULL DEFAULT 'draft',    -- draft | in_review | approved_for_test | testing | validated | promoted | rejected | archived | revoked
        approver_user_id TEXT,
        action_task_id TEXT,                    -- experimento vinculado (ação/tarefa)
        outcome_final REAL,                     -- métrica final medida
        outcome_confidence REAL,                -- 0..1
        outcome_period TEXT,
        promoted_pattern_id TEXT,               -- linha em retail_store_patterns (p/ revogar)
        rejection_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_manager_solutions_org ON manager_solution_proposals (organization_id, state);
    `);
  } catch (e) { /* noop */ }

  // FLOOR — talão da venda no atendimento convertido (PRD Moda/TOULON; ADR-175).
  // Liga o atendimento (lista da vez) ao nº do talão manuscrito → conciliação
  // venda-a-venda com a boleta/PDV (hoje é agregada por filial+matrícula).
  // Aditivo. Único por turno: dois atendimentos não podem reivindicar o mesmo
  // talão no mesmo turno (índice parcial).
  try { db.exec(`ALTER TABLE retail_floor_attendances ADD COLUMN boleta_number TEXT`); } catch (e) { /* noop */ }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_floor_attendance_boleta ON retail_floor_attendances (organization_id, shift_id, boleta_number) WHERE boleta_number IS NOT NULL`); } catch (e) { /* noop */ }

  // FIN — conexão de COBRANÇA Sicredi (PRD Moda/TOULON; ADR-177). SCAFFOLD
  // honesto: 1 conexão por org, credenciais CIFRADAS (config_enc/AES-GCM), estado
  // OBSERVÁVEL. Nunca "connected" enquanto a homologação bancária não fecha —
  // fica em 'awaiting_homologation' e as capacidades ficam indisponíveis. Opt-in;
  // não emite PIX/boleto real (a chamada à API vive num stub honesto até as
  // credenciais + homologação chegarem). Aditivo; isolado por organização.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sicredi_cobranca_connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        config_enc TEXT,                                   -- JSON de credenciais CIFRADO (cooperativa/posto/conta/client_id/secret)
        connection_state TEXT NOT NULL DEFAULT 'not_configured', -- not_configured|awaiting_homologation|connected|disabled
        state_detail TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,                -- opt-in; 0 = desligada
        configured_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sicredi_cobranca_org ON sicredi_cobranca_connections (organization_id);
    `);
  } catch (e) { /* noop */ }

  // LEGAL — base trabalhista CURADA (PRD Moda/TOULON; ADR-178). GLOBAL (lei federal
  // é a mesma p/ todos — SEM organization_id), escrita SÓ pelo admin master, lida
  // por todos os tenants. NASCE VAZIA: nenhuma regra trabalhista é publicada sem
  // REVISÃO JURÍDICA humana (reviewed_by obrigatório). O advisor só orienta
  // ancorado no que está aqui; vazio → "aguardando validação jurídica", nunca
  // inventa CLT. Aditivo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS labor_law_entries (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,                               -- taxonomia (admissao|jornada|ferias|rescisao|...)
        title TEXT NOT NULL,
        guidance TEXT NOT NULL,                            -- orientação CURADA (texto revisado)
        citations_json TEXT,                               -- artigos/normas (CLT, súmulas) citados
        terms_json TEXT,                                   -- termos p/ recuperação determinística
        source TEXT,                                       -- origem da curadoria
        reviewed_by TEXT NOT NULL,                         -- QUEM revisou juridicamente (obrigatório)
        status TEXT NOT NULL DEFAULT 'published',          -- published|archived
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_labor_law_entries_topic ON labor_law_entries (topic, status);
    `);
  } catch (e) { /* noop */ }

  // TIME — fuso da organização para a DATA COMERCIAL (PDR Estabilização TOULON,
  // Fatia A / TIME-002). Aditivo; NULL = fallback 'America/Sao_Paulo' no
  // BusinessTimeService. Corrige "boletas somem no reload após 21h" (data UTC).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN timezone TEXT`); } catch (e) { /* noop */ }

  // BOL-002 — idempotência do clique de boleta (PDR TOULON, Fatia 1B). Chave
  // gerada no dispositivo; double-tap/retry/resposta-perdida retornam o MESMO
  // evento em vez de consumir outro número. Aditivo: cliques sem chave seguem
  // como antes. Índice único parcial por (org, loja, chave).
  try { db.exec(`ALTER TABLE retail_boleta_events ADD COLUMN idempotency_key TEXT`); } catch (e) { /* noop */ }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_boleta_events_idem ON retail_boleta_events (organization_id, store_id, idempotency_key) WHERE idempotency_key IS NOT NULL`); } catch (e) { /* noop */ }

  // SAVE-003 (§7.6) — versão otimista da config financeira da loja (PDR TOULON,
  // Fatia 1C). O endpoint composto incrementa dentro da mesma transação; edição
  // concorrente com versão antiga recebe 409. Aditivo (default 0).
  try { db.exec(`ALTER TABLE retail_stores ADD COLUMN financial_settings_version INTEGER DEFAULT 0`); } catch (e) { /* noop */ }

  // SELL-001/002 (PDR TOULON, Fatia 2) — diretório de vendedores + LOTAÇÃO por
  // loja. `retail_sellers` é a IDENTIDADE canônica (matrícula ERP), sem store_id
  // de propósito. Metadados aditivos + a lotação numa tabela SEPARADA (um vendedor
  // pode atuar em várias lojas sem duplicar a identidade).
  try { db.exec(`ALTER TABLE retail_sellers ADD COLUMN source TEXT`); } catch (e) { /* noop */ }            // erp | user | manual
  try { db.exec(`ALTER TABLE retail_sellers ADD COLUMN identity_status TEXT`); } catch (e) { /* noop */ }   // pending | confirmed | conflict
  try { db.exec(`ALTER TABLE retail_sellers ADD COLUMN erp_last_seen_at DATETIME`); } catch (e) { /* noop */ }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_seller_store_assignments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        seller_id TEXT NOT NULL,               -- retail_sellers.id (identidade canônica)
        store_id TEXT NOT NULL,                -- retail_stores.id
        is_primary INTEGER DEFAULT 0,          -- loja principal (opcional)
        active INTEGER DEFAULT 1,              -- vínculo vigente
        effective_from DATETIME DEFAULT CURRENT_TIMESTAMP,
        effective_to DATETIME,                 -- histórico de movimentação
        source TEXT,                           -- manual | erp | escala | atendimento
        confirmed_by TEXT,
        confirmed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_store_active ON retail_seller_store_assignments (organization_id, seller_id, store_id) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS idx_seller_store_by_store ON retail_seller_store_assignments (organization_id, store_id, active);
      CREATE INDEX IF NOT EXISTS idx_seller_store_by_seller ON retail_seller_store_assignments (organization_id, seller_id, active);
    `);
  } catch (e) { /* noop */ }

  // POS-002 (§7.5) — tarifas POS por loja × meio de pagamento (PDR TOULON, Fatia
  // 3). Detalha crédito/débito (percent + fixo por transação). Quando existe regra
  // detalhada, ela SUBSTITUI a tarifa agregada legada (card_fee) no cálculo —
  // NUNCA somar as duas (evita dupla contabilização). Aditivo; opt-in.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS retail_store_pos_fee_rules (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        payment_type TEXT NOT NULL,            -- credit | debit
        percent REAL DEFAULT 0,                -- % sobre o valor
        fixed_per_transaction REAL DEFAULT 0,  -- R$ por transação
        provider TEXT,                         -- adquirente (ex.: Sicredi), se confirmado
        effective_from DATETIME DEFAULT CURRENT_TIMESTAMP,
        effective_to DATETIME,                 -- NULL = vigente
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_fee_active ON retail_store_pos_fee_rules (organization_id, store_id, payment_type) WHERE effective_to IS NULL;
    `);
  } catch (e) { /* noop */ }

  // PERF-001/002 (PDR TOULON, Fatia 4) — catálogo RESOLVIDO na ingestão. Hoje
  // "Resultado por loja" e "Mais vendidos" resolvem o código do ERP → catálogo
  // com LIKE-prefix a CADA consulta. Persistir a resolução (produto/variante +
  // status do match) permite consultas por índice em vez de scan. Aditivo; a
  // resolução acontece na ingestão + backfill; itens legados ficam NULL até lá.
  try { db.exec(`ALTER TABLE retail_pdv_sale_items ADD COLUMN product_service_id TEXT`); } catch (e) { /* noop */ }
  try { db.exec(`ALTER TABLE retail_pdv_sale_items ADD COLUMN variant_id TEXT`); } catch (e) { /* noop */ }
  try { db.exec(`ALTER TABLE retail_pdv_sale_items ADD COLUMN catalog_match_status TEXT`); } catch (e) { /* noop */ } // exact | prefix | unmatched | ambiguous
  try { db.exec(`ALTER TABLE retail_pdv_sale_items ADD COLUMN catalog_resolved_at DATETIME`); } catch (e) { /* noop */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pdv_items_product ON retail_pdv_sale_items (organization_id, product_service_id) WHERE product_service_id IS NOT NULL`); } catch (e) { /* noop */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pdv_items_unresolved ON retail_pdv_sale_items (organization_id) WHERE catalog_resolved_at IS NULL`); } catch (e) { /* noop */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pdv_items_org_filial_date ON retail_pdv_sale_items (organization_id, filial, sale_date)`); } catch (e) { /* noop */ }

  // PERF-002 (PDR TOULON, Fatia 4B) — Resultado da Rede set-based agrega
  // faturamento/contagem por store_id. O índice (org, store_id, closing_date)
  // dá o store_id/data pela árvore (antes só (org, closing_date), forçando ler
  // cada linha pra agrupar por loja). Medido por EXPLAIN QUERY PLAN.
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_retail_closings_store_date ON retail_daily_closings (organization_id, store_id, closing_date)`); } catch (e) { /* noop */ }

  // Fase 6B (PDR TOULON) — KILL-SWITCHES de runtime das duas mudanças de maior
  // risco, pra reverter no piloto sem deploy. DEFAULT 1 = comportamento NOVO
  // (0-regressão nas orgs existentes); setar 0 volta pro legado:
  //   retail_business_date_v1 = 0  → data comercial volta ao UTC (pré-Fatia 1A);
  //   retail_analytics_resolved_products_v1 = 0 → analíticas voltam a resolver
  //     produto por LIKE-prefix a cada consulta (pré-Fatia 4B), mais lento porém
  //     no caminho antigo provado.
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_business_date_v1 INTEGER DEFAULT 1`); } catch (e) { /* noop */ }
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN retail_analytics_resolved_products_v1 INTEGER DEFAULT 1`); } catch (e) { /* noop */ }

  // AJUDA — base de artigos de ajuda do USUÁRIO (ADR-179 F1). É o Fala Tu
  // (ZeroTrainingHelpService) respondendo dúvida ATERRADO em conteúdo CURADO —
  // NÃO nos ADRs crus (RN-HELP-5). GLOBAL (o "como faço" é o mesmo p/ todos os
  // tenants — SEM organization_id) com recorte OPCIONAL por vertical (vertical
  // NULL = todas). Cada artigo segue o padrão "O que é · Pra que serve · Como
  // faço · Erros comuns" e só vai ao ar com reviewed_by (RN-HELP-3 — curadoria
  // humana; o bootstrap da F2 gera rascunho, humano publica). Aditivo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS help_articles (
        id TEXT PRIMARY KEY,
        vertical TEXT,                                 -- NULL = todas as verticais
        module_key TEXT,                               -- chave do MODULE_META / superfície
        title TEXT NOT NULL,
        what TEXT,                                     -- "O que é"
        purpose TEXT,                                  -- "Pra que serve"
        steps_json TEXT,                               -- ["passo 1", ...] "Como faço"
        common_errors_json TEXT,                       -- ["erro comum 1", ...]
        keywords TEXT,                                 -- termos p/ recuperação determinística
        reviewed_by TEXT NOT NULL,                     -- QUEM revisou (obrigatório, RN-HELP-3)
        source_ref TEXT,                               -- ADR/feature de origem do rascunho
        status TEXT NOT NULL DEFAULT 'published',      -- draft|published|archived
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_help_articles_module ON help_articles (module_key, status);
      CREATE INDEX IF NOT EXISTS idx_help_articles_vertical ON help_articles (vertical, status);
    `);
  } catch (e) { /* noop */ }

  // AJUDA — log de LACUNA (ADR-179 F1). Pergunta que a base ainda não cobre vira
  // fila de conteúdo (RN-HELP-1: sem cobertura, admite e REGISTRA a lacuna; a base
  // cresce puxada pela dúvida real). POR-ORG e MINIMIZADO (query normalizada, sem
  // PII — LGPD RN-HELP-6). Upsert incrementa `hits`. Aditivo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS help_gap_log (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        query_norm TEXT NOT NULL,                      -- pergunta normalizada (sem PII)
        module_key TEXT,
        hits INTEGER DEFAULT 1,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_help_gap_unique ON help_gap_log (organization_id, query_norm, module_key);
    `);
  } catch (e) { /* noop */ }

  // AJUDA — contador AGREGADO de perguntas (ADR-179 F4). Para a "taxa de resposta"
  // (respondidas × sem cobertura) e "onde travam" (por módulo) sem guardar o TEXTO
  // das perguntas respondidas (LGPD RN-HELP-6 — só contadores por org+módulo). O
  // TEXTO das lacunas segue só em help_gap_log (fila de conteúdo). Upsert incrementa.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS help_ask_stats (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        module_key TEXT NOT NULL,                       -- '' quando sem contexto de tela
        asks INTEGER DEFAULT 0,                         -- total de perguntas
        answered INTEGER DEFAULT 0,                     -- respondidas (engine ou artigo)
        last_ask_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_help_ask_stats_unique ON help_ask_stats (organization_id, module_key);
    `);
  } catch (e) { /* noop */ }

  // AJUDA — feedback 👍/👎 por resposta (ADR-179 F3). AGREGADO por org+artigo+módulo
  // (up/down), sem texto (LGPD RN-HELP-6). article_id='' quando a resposta NÃO veio
  // de artigo (ex.: lacuna) — 👎 aí é sinal de que o tema precisa de conteúdo. Upsert.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS help_feedback (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        article_id TEXT NOT NULL DEFAULT '',            -- '' = resposta sem artigo
        module_key TEXT NOT NULL DEFAULT '',
        up INTEGER DEFAULT 0,                            -- 👍
        down INTEGER DEFAULT 0,                          -- 👎
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_help_feedback_unique ON help_feedback (organization_id, article_id, module_key);
    `);
  } catch (e) { /* noop */ }

  // AJUDA — mídia CURADA opcional por artigo (ADR-179 F5). URL de um GIF/vídeo curto
  // que ILUSTRA a feature. Curada (nunca inventada); NULL por padrão → sem mídia, o
  // tour/orb só mostra os passos. Aditivo.
  try { db.exec(`ALTER TABLE help_articles ADD COLUMN media_url TEXT`); } catch (e) { /* noop */ }

  // PETSHOP F3 — Ficha do PET. O `contact` é a PESSOA (tutor); o PET é uma entidade
  // própria que pertence a um tutor (1 tutor → N pets). Aditivo; só a vertical petshop
  // usa, mas a tabela é neutra. Idade é DERIVADA de birth_date (RN-004, sem contador).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_pets (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        tutor_contact_id TEXT NOT NULL,                  -- dono (contacts.id)
        name TEXT NOT NULL,
        species TEXT,                                    -- cachorro|gato|ave|roedor|reptil|outro
        breed TEXT,                                      -- raça (texto livre)
        sex TEXT,                                        -- male|female|unknown
        size TEXT,                                       -- porte: small|medium|large|giant
        weight_kg REAL,                                  -- peso atual (kg)
        birth_date TEXT,                                 -- ISO date (idade DERIVADA)
        color TEXT,                                      -- pelagem/cor
        microchip TEXT,                                  -- nº do microchip
        neutered INTEGER DEFAULT 0,                      -- castrado (0/1)
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active',           -- active|inactive|deceased
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_pets_tutor ON clinic_pets (organization_id, tutor_contact_id, status);
    `);
  } catch (e) { /* noop */ }

  // PETSHOP F3 — Carteira de VACINAÇÃO do pet. Cada dose é uma linha; `next_due_at`
  // alimenta os lembretes (Scheduler → business_signals, conv. nº 12). Aditivo.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_pet_vaccinations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        pet_id TEXT NOT NULL,
        vaccine TEXT NOT NULL,                           -- V8/V10/antirrábica/gripe/...
        dose TEXT,                                       -- 1ª dose|2ª dose|reforço|anual
        applied_at TEXT,                                 -- ISO date da aplicação
        next_due_at TEXT,                                -- ISO date da próxima dose (lembrete)
        professional_id TEXT,                            -- quem aplicou (clinic_professionals.id)
        lote TEXT,                                       -- lote/batch do imunizante
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'applied',          -- applied|scheduled|cancelled
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_pet_vax_pet ON clinic_pet_vaccinations (organization_id, pet_id);
      CREATE INDEX IF NOT EXISTS idx_clinic_pet_vax_due ON clinic_pet_vaccinations (organization_id, next_due_at) WHERE next_due_at IS NOT NULL AND status = 'applied';
    `);
  } catch (e) { /* noop */ }

  // PETSHOP F4 — catálogo de serviços de BANHO & TOSA (grooming) da loja. Curado pela
  // loja (nome/duração/preço); alimenta o agendamento. Aditivo; a fila é a própria
  // agenda (reuso — o appointment recebe pet_id + grooming_service_id abaixo).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_grooming_services (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,                              -- Banho | Tosa | Banho e tosa | Hidratação | ...
        duration_min INTEGER DEFAULT 60,                -- duração padrão (min)
        price_cents INTEGER,                            -- preço (opcional)
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_grooming_services_org ON clinic_grooming_services (organization_id, active);
    `);
  } catch (e) { /* noop */ }

  // PETSHOP F4 — o agendamento de grooming aponta pro PET (F3) e pro SERVIÇO. Aditivos;
  // agendamentos legados/veterinários ficam NULL (0-regressão). A fila da vez segue
  // sendo a agenda (chegada→atendimento→checkout já existentes).
  try { db.exec(`ALTER TABLE appointments ADD COLUMN pet_id TEXT`); } catch (e) { /* noop */ }
  try { db.exec(`ALTER TABLE appointments ADD COLUMN grooming_service_id TEXT`); } catch (e) { /* noop */ }

  // PETSHOP F5 — plano de saúde pet como ATRIBUTO do pet (o que está coberto). A
  // COBRANÇA recorrente é do módulo Assinaturas (reuso, sem motor paralelo); aqui só
  // guardamos qual plano o pet tem, pra aparecer na ficha e nos alertas. Aditivo.
  try { db.exec(`ALTER TABLE clinic_pets ADD COLUMN health_plan_name TEXT`); } catch (e) { /* noop */ }
  try { db.exec(`ALTER TABLE clinic_pets ADD COLUMN health_plan_status TEXT`); } catch (e) { /* noop */ } // active|inactive (NULL = sem plano)

  // PETSHOP F5 — INTERNAÇÃO do pet. Registro de entrada/alta com motivo e
  // profissional responsável. Aditivo; isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_pet_hospitalizations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        pet_id TEXT NOT NULL,
        reason TEXT,                                     -- motivo da internação
        professional_id TEXT,                            -- responsável
        admitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- entrada
        discharged_at DATETIME,                          -- alta (NULL = internado)
        status TEXT NOT NULL DEFAULT 'admitted',         -- admitted|discharged
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_pet_hosp_pet ON clinic_pet_hospitalizations (organization_id, pet_id, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_pet_hosp_active ON clinic_pet_hospitalizations (organization_id, status);
    `);
  } catch (e) { /* noop */ }

  // PETSHOP F5 — CIRURGIA/procedimento do pet com checklist pré-operatório. O
  // checklist é uma lista de itens {label, done} em JSON. Aditivo; isolado por org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_pet_surgeries (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        pet_id TEXT NOT NULL,
        procedure_name TEXT NOT NULL,                    -- castração, remoção de tumor, ...
        professional_id TEXT,
        scheduled_at DATETIME,                           -- data prevista
        performed_at DATETIME,                           -- realizada em (NULL = não feita)
        status TEXT NOT NULL DEFAULT 'scheduled',        -- scheduled|done|cancelled
        checklist_json TEXT,                             -- [{label, done}] pré-operatório
        notes TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_pet_surgery_pet ON clinic_pet_surgeries (organization_id, pet_id, status);
    `);
  } catch (e) { /* noop */ }

  // ── ADR-191 F4 — Processo (vertical Advocacia) ──
  // `legal_cases`: registro LONGITUDINAL do caso, modelado no clinic_care_episodes
  // (D2 — tabela PRÓPRIA, não sobrecarrega a clínica; o vocabulário processual difere
  // do clínico). Cliente=contact, área=clinic_specialties, advogado=clinic_professionals.
  // cnj_number VALIDADO (dígito verificador módulo 97) e nullable (caso consultivo/
  // pré-processual não tem número) — nunca inventado (RN-ADV-08). Unique parcial garante
  // 1 processo por número CNJ na org.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS legal_cases (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,                        -- cliente
        practice_area_id TEXT,                           -- área do direito (clinic_specialties); nullable
        responsible_lawyer_id TEXT,                      -- advogado responsável (clinic_professionals)
        cnj_number TEXT,                                 -- número CNJ normalizado; nullable (consultivo)
        title TEXT NOT NULL,                             -- descrição do caso
        case_type TEXT DEFAULT 'judicial',              -- judicial|consultivo|administrativo
        court TEXT,                                      -- vara/tribunal
        comarca TEXT,                                    -- comarca/foro
        opposing_party TEXT,                             -- parte contrária
        phase TEXT,                                      -- fase processual (livre: conhecimento/recurso/execução…)
        status TEXT NOT NULL DEFAULT 'active',           -- active|on_hold|closed|archived
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        closed_reason TEXT,
        closed_by TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_legal_cases_org ON legal_cases (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_legal_cases_client ON legal_cases (organization_id, contact_id);
      CREATE INDEX IF NOT EXISTS idx_legal_cases_lawyer ON legal_cases (organization_id, responsible_lawyer_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_cases_cnj ON legal_cases (organization_id, cnj_number) WHERE cnj_number IS NOT NULL;
    `);
  } catch (e) { console.error('[DB] Falha ao criar legal_cases', e); }

  // ── ADR-191 F5 — Prazos processuais (vertical Advocacia) ──
  // `legal_holidays`: calendário de feriados POR-ORG (o escritório configura o seu:
  // nacionais + forenses móveis + recesso + locais/tribunal). Nunca inventado — a
  // contagem em dias úteis só é confiável com o calendário carregado (a UI avisa
  // quando não há cobertura). `legal_deadlines`: o prazo em si, com a data-fim
  // DERIVADA pelo motor (dias úteis) e materializado numa `task` (reuso ADR-171/172).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS legal_holidays (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        date TEXT NOT NULL,                              -- YYYY-MM-DD
        name TEXT NOT NULL,
        holiday_type TEXT DEFAULT 'national',            -- national|forum_movable|forum_recess|local
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_holiday_date ON legal_holidays (organization_id, date);

      CREATE TABLE IF NOT EXISTS legal_deadlines (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        case_id TEXT,                                    -- processo (legal_cases); nullable (prazo avulso)
        title TEXT NOT NULL,
        publication_date TEXT NOT NULL,                  -- data da publicação/intimação (YYYY-MM-DD)
        term_days INTEGER NOT NULL,                       -- nº de dias do prazo
        counting_mode TEXT NOT NULL DEFAULT 'business',   -- business (dias úteis, CPC) | calendar (corridos)
        due_date TEXT NOT NULL,                           -- data-fim DERIVADA pelo motor
        is_fatal INTEGER DEFAULT 1,                        -- prazo fatal (peremptório)?
        status TEXT NOT NULL DEFAULT 'open',              -- open|done|cancelled
        task_id TEXT,                                     -- tarefa materializada (ADR-171)
        holidays_loaded INTEGER DEFAULT 0,                -- havia cobertura de feriado no período? (honestidade)
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_legal_deadlines_org ON legal_deadlines (organization_id, status, due_date);
      CREATE INDEX IF NOT EXISTS idx_legal_deadlines_case ON legal_deadlines (organization_id, case_id);
    `);
  } catch (e) { console.error('[DB] Falha ao criar legal_deadlines', e); }

  // ── ADR-180 F1 — Professional Identity & Federated Calendar (Agenda Federada) ──
  // Decisão de fronteira (§90): o profissional pertence ao ECOSSISTEMA ZapFlow, não
  // a uma clínica. Espelha vertical_intelligence (GLOBAL, sem organization_id) +
  // organization_contextualization (bridge por-org), estruturado como
  // retail_sellers (identidade) + assignments (vínculo).
  try {
    // `professionals` — camada GLOBAL, SEM organization_id (RN-PN-1). Identidade do
    // profissional no ecossistema, chaveada por conselho + registro (ex.
    // "CRMV-SP" + "12345"). Zero dado por-org/relação aqui — tudo que é da relação
    // clínica↔profissional vive no bridge abaixo.
    db.exec(`
      CREATE TABLE IF NOT EXISTS professionals (
        id TEXT PRIMARY KEY,
        council TEXT NOT NULL,                   -- conselho (CRMV, CRM, CRO, CREFITO, ...)
        registration_number TEXT NOT NULL,       -- nº de registro no conselho
        name TEXT NOT NULL,
        specialties_json TEXT,                   -- ["cardiologia veterinária", ...]
        phone TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'active',   -- active | inactive
        created_by TEXT,                         -- org que cadastrou (auditoria; NÃO é dono)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(council, registration_number)     -- 1 identidade por registro no conselho
      );
      CREATE INDEX IF NOT EXISTS idx_professionals_name ON professionals (name);
    `);
    // `clinic_professional_relationships` — bridge POR-ORG (RN-PN-2, isolado por
    // organization_id). É onde vive a RELAÇÃO clínica↔profissional: status do
    // convite, permissões (quais serviços a clínica pode agendar), comissão. Revogar
    // não apaga a identidade global (RN-PN-3). UNIQUE(org, professional) → 1 relação
    // viva por par.
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_professional_relationships (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | revoked
        permissions_json TEXT,                   -- {services:[serviceId,...]} — o que pode agendar
        commission_percent REAL,                 -- % da clínica (âncora de finanças, F8 diferido)
        notes TEXT,
        invited_by TEXT,
        invited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        responded_at DATETIME,                   -- quando aceitou/recusou
        revoked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, professional_id)
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_rel_by_org
        ON clinic_professional_relationships (organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_rel_by_prof
        ON clinic_professional_relationships (professional_id, status);
    `);
    // Opt-in por org (RN-PN-8, convenção nº 10). Default 0: legado opera intocado.
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN professional_network_enabled INTEGER DEFAULT 0`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha ao criar professionals / relationships (ADR-180 F1)', e); }

  // ── ADR-180 F2 — Serviços ofertados + janelas de disponibilidade (por vínculo) ──
  // Ambas as tabelas são POR-ORG (RN-PN-2), presas ao VÍNCULO (relationship_id) — o
  // profissional oferta serviços e trabalha janelas ESPECÍFICAS de cada clínica. São a
  // config que o Availability Engine (F3) consome. Isolamento pela org do vínculo.
  try {
    // Serviços que o profissional OFERTA nesta clínica. service_id → products_services.id
    // (catálogo canônico). duration_min sobrepõe a duração do catálogo quando setado
    // (null = usa a do catálogo). active=0 desliga sem apagar. UNIQUE evita duplicar.
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_professional_offerings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        duration_min INTEGER,                    -- override; null = duração do catálogo
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(organization_id, relationship_id, service_id)
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_offerings
        ON clinic_professional_offerings (organization_id, relationship_id, active);
    `);
    // Janelas de trabalho SEMANAIS recorrentes do profissional NESTA clínica.
    // day_of_week 0=domingo..6=sábado. start_minute/end_minute = minutos desde a
    // meia-noite (0..1440), start < end. buffer_min = folga entre atendimentos (F3).
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_professional_windows (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        day_of_week INTEGER NOT NULL,            -- 0..6
        start_minute INTEGER NOT NULL,           -- 0..1440
        end_minute INTEGER NOT NULL,             -- 0..1440, > start_minute
        buffer_min INTEGER DEFAULT 0,            -- folga pós-atendimento (min)
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_prof_windows
        ON clinic_professional_windows (organization_id, relationship_id, day_of_week);
    `);
  } catch (e) { console.error('[DB] Falha ao criar offerings / windows (ADR-180 F2)', e); }

  // ── ADR-180 F3 — Availability Engine + Hold atômico ──
  // clinic_slot_holds: reserva TEMPORÁRIA de uma vaga do profissional numa clínica
  // (RN-PN-5: confirmação ≠ agendamento). Impede corrida entre "sugerir" e "confirmar":
  // duas reservas na mesma vaga → só uma vence (guarda atômica SELECT-COUNT-in-tx,
  // padrão AC-012). status: active (segurando, com TTL) | confirmed (vaga travada) |
  // released (solto) | expired (TTL estourou). Isolado por org (RN-PN-2).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clinic_slot_holds (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        professional_id TEXT NOT NULL,
        service_id TEXT,
        scheduled_start TEXT NOT NULL,           -- ISO
        scheduled_end TEXT NOT NULL,             -- ISO
        status TEXT NOT NULL DEFAULT 'active',   -- active | confirmed | released | expired
        hold_token TEXT NOT NULL,
        expires_at TEXT,                         -- ISO; NULL quando confirmed
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_slot_holds_rel
        ON clinic_slot_holds (organization_id, relationship_id, status);
      CREATE INDEX IF NOT EXISTS idx_clinic_slot_holds_slot
        ON clinic_slot_holds (organization_id, relationship_id, scheduled_start);
    `);
    // Hook aditivo: liga um appointment a um vínculo da rede (o agendamento federado).
    // Populado na F4 (confirmBooking governado); aqui o Availability Engine já subtrai
    // appointments que carreguem este vínculo — forward-compatible, 0-regressão.
    try { db.exec(`ALTER TABLE appointments ADD COLUMN network_relationship_id TEXT`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha ao criar clinic_slot_holds (ADR-180 F3)', e); }

  // ── ADR-180 F4 — Booking federado governado + AutoBooking ──
  // slot_hold_id: liga o appointment ao HOLD que o originou (idempotência DURÁVEL do
  // confirmBooking — 2ª confirmação do mesmo hold devolve o MESMO appointment, nunca
  // cria 2). autobooking_enabled: 2ª flag opt-in (RN-PN-8) — sem ela o AutoBooking
  // (agendar automático governado) não roda; legado intocado (default 0).
  try {
    try { db.exec(`ALTER TABLE appointments ADD COLUMN slot_hold_id TEXT`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN autobooking_enabled INTEGER DEFAULT 0`); } catch (e) { /* noop */ }
    // Índice parcial: garante 1 appointment por hold (idempotência forte do confirmBooking).
    try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_slot_hold ON appointments (organization_id, slot_hold_id) WHERE slot_hold_id IS NOT NULL`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de booking federado (ADR-180 F4)', e); }

  // ── ADR-180 F8.1 — Finanças da Agenda Federada (split clínica×profissional) ──
  // Snapshot do serviço + preço ACORDADO no momento do agendamento (confirmBooking):
  // o valor devido é o combinado quando reservou, não o preço de catálogo de hoje
  // (espírito da convenção nº 3 — congelar o que foi acordado). Aditivo, NULL em
  // agendamento legado/sem serviço → o financeiro deriva honesto (gross null, nunca
  // inventa dinheiro — RN-PN-4/RN-004). O split (comissão do profissional × resto da
  // clínica) e realizado×previsto (completed×confirmed, AGENDADO≠ATENDIDO) são DERIVADOS
  // por query no ProfessionalFinanceService — sem contador mutável, sem ledger paralelo.
  try {
    try { db.exec(`ALTER TABLE appointments ADD COLUMN network_service_id TEXT`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE appointments ADD COLUMN network_service_price REAL`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de finanças federadas (ADR-180 F8.1)', e); }

  // ── ADR-180 F8.2 — Direção do split (aberto) + imposto retido + previsão ──
  // commission_beneficiary: DE QUEM é o percentual do vínculo — 'professional' (a parte
  // do profissional) ou 'clinic' (a parte da clínica). Cada par clínica↔profissional
  // combina o seu (o dono pediu: "cada parte define o seu percentual combinado"); a
  // config nomeia o lado, o financeiro sempre mostra AS DUAS partes. Default 'professional'
  // = 0-regressão sobre a F8.1 (que tratava o % como do profissional).
  // tax_withholding_percent: % de imposto RETIDO na fonte sobre o repasse do profissional,
  // OPT-IN por vínculo. Sem config → imposto NULL (nunca inventa CLT/ISS — RN-PN-4);
  // o líquido do profissional = bruto dele − retido.
  try {
    try { db.exec(`ALTER TABLE clinic_professional_relationships ADD COLUMN commission_beneficiary TEXT DEFAULT 'professional'`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE clinic_professional_relationships ADD COLUMN tax_withholding_percent REAL`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de finanças federadas (ADR-180 F8.2)', e); }

  // ── ADR-180 F6.1 — Google Calendar POR PROFISSIONAL (Agenda Federada) ──
  // Conexão GLOBAL, chaveada por `professional_id` (sem organization_id) — o profissional
  // tem UMA agenda que TODAS as clínicas respeitam (§90: o calendário é da identidade do
  // ecossistema, não de uma clínica). Espelha `professionals` (global) e a shape de
  // `oauth_connections`, mas keyed por profissional. Tokens CIFRADOS (EncryptionService,
  // AES-GCM — convenção nº 4/6). Escopo calendar-only (least-privilege). `connected_by_org`
  // é só AUDITORIA (qual clínica iniciou o connect) — não confere propriedade (RN-PN-1/3).
  // Aditivo/opt-in: sem conexão, a disponibilidade opera igual (0-regressão).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS professional_google_connections (
        id TEXT PRIMARY KEY,
        professional_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'google',
        access_token TEXT,           -- cifrado (enc:v1:...)
        refresh_token TEXT,          -- cifrado
        scopes TEXT,
        account_email TEXT,
        account_name TEXT,
        expires_at DATETIME,
        connected_by_org TEXT,       -- auditoria (não é propriedade)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(professional_id, provider)
      );
    `);
    // Evento do Google criado na agenda DO PROFISSIONAL para o appointment federado
    // (registry de "eventos que criamos" — só mexemos no que é nosso). Separado do
    // `google_event_id` (que é da agenda da ORG); federado nunca passa pelo sync da org.
    try { db.exec(`ALTER TABLE appointments ADD COLUMN network_google_event_id TEXT`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha ao criar professional_google_connections (ADR-180 F6.1)', e); }

  // ── ADR-180 F5.1 — Recursos (sala/equipamento) como restrição de disponibilidade ──
  // required_room_id: a oferta (serviço×profissional numa clínica) pode EXIGIR uma sala
  // da própria clínica (`clinic_rooms`, per-org). Quando exige, a disponibilidade subtrai
  // os horários em que a sala está ocupada (por QUALQUER atendimento da org — federado ou
  // local) e o `confirmBooking` reserva a sala (grava `appointments.room_id`, reusando o
  // findConflicts/checkRoomCapacity da agenda). Aditivo; sem sala exigida → 0-regressão.
  try {
    try { db.exec(`ALTER TABLE clinic_professional_offerings ADD COLUMN required_room_id TEXT`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de recursos federados (ADR-180 F5.1)', e); }

  // ── ADR-180 F5.2 — Deslocamento entre clínicas ──
  // travel_buffer_min: o profissional é GLOBAL e atende em VÁRIAS clínicas; se ele tem um
  // atendimento federado em OUTRA clínica, ele não pode estar aqui no mesmo horário. Esta
  // coluna liga (opt-in) o bloqueio cross-clínica pra ESTE vínculo: NULL = desligado
  // (0-regressão, sem consciência cross-clínica); um valor (inclusive 0) = LIGA — bloqueia
  // a sobreposição com atendimentos do profissional em outras clínicas + margem de
  // deslocamento (minutos) de cada lado. Privacidade (exceção mínima à RN-PN-2): a
  // disponibilidade só enxerga o BLOCO DE TEMPO do outro atendimento, nunca a clínica nem
  // detalhes — o suficiente pra não marcar em cima, nada mais.
  try {
    try { db.exec(`ALTER TABLE clinic_professional_relationships ADD COLUMN travel_buffer_min INTEGER`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de deslocamento federado (ADR-180 F5.2)', e); }

  // ── ADR-180 F7.1 — Auth passwordless do profissional (webapp de autoatendimento) ──
  // Token GLOBAL de acesso do profissional (SEM organization_id — o acesso pertence à
  // identidade do ecossistema, não a uma clínica; espelha a fronteira §90). Molde do
  // ClinicPortalService: token aleatório de 32 bytes devolvido UMA vez; no banco fica só
  // o hash SHA-256 + expiração + active. Resolve SEMPRE por hash (nunca por id — evita
  // enumeração). A troca do magic-link por uma sessão (JWT com escopo `professional_portal`,
  // sem organizationId) é feita no ProfessionalAuthService — nunca toca a tabela `users`
  // (que é UNIQUE por e-mail + presa a 1 org, o invariante que o profissional cross-clínica
  // quebraria).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS professional_auth_tokens (
        id TEXT PRIMARY KEY,
        professional_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        expires_at DATETIME,
        last_access_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_prof_auth_tokens_hash ON professional_auth_tokens (token_hash, active);
      CREATE INDEX IF NOT EXISTS idx_prof_auth_tokens_prof ON professional_auth_tokens (professional_id, active);
    `);
  } catch (e) { console.error('[DB] Falha ao criar professional_auth_tokens (ADR-180 F7.1)', e); }

  // ── ADR-180 F7.4 — Aceitar/recusar do profissional (webapp) ──
  // professional_ack_at: quando o profissional CONFIRMOU presença no atendimento federado
  // (sinal positivo pra clínica). NÃO muda o status FSM (segue `confirmed`) — é um ACK
  // aditivo. Recusar não usa coluna: vira `cancelled` (reusa cancelBooking) + sinal pra
  // clínica. Aditivo; legado sem ack → null.
  try {
    try { db.exec(`ALTER TABLE appointments ADD COLUMN professional_ack_at DATETIME`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de aceite do profissional (ADR-180 F7.4)', e); }

  // ── ADR-180 F10.1 — Profissional DESCOBRÍVEL (rede/marketplace) ──
  // discoverable: OPT-IN (default 0) do profissional aparecer na descoberta cross-org
  // (RN-PN-9 — ninguém aparece sem ligar a própria visibilidade). base_city/base_state/
  // base_lat/base_lng: localização base pra match por região grossa (RN-PN-10 — nunca rua
  // exata). Colunas na identidade GLOBAL (o profissional não tem organization_settings). A
  // projeção publicável carrega só nome/conselho/especialidades/região — NUNCA em quais
  // clínicas atende nem termos financeiros (isso vive no bridge, fora daqui).
  try {
    try { db.exec(`ALTER TABLE professionals ADD COLUMN discoverable INTEGER DEFAULT 0`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE professionals ADD COLUMN base_city TEXT`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE professionals ADD COLUMN base_state TEXT`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE professionals ADD COLUMN base_lat REAL`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE professionals ADD COLUMN base_lng REAL`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de descoberta do profissional (ADR-180 F10.1)', e); }

  // ── ADR-180 F10.2 — Clínica DESCOBRÍVEL (rede/marketplace) ──
  // network_discoverable: OPT-IN (default 0) da clínica aparecer na descoberta pra
  // especialistas (RN-PN-9). A projeção publicável carrega business_name + cidade/estado
  // (address_city/address_state já existem) + especialidades PROCURADAS derivadas dos
  // `demand_gap` de pressão ALTA (F9.2) — NUNCA contagem crua, dado de paciente ou receita
  // (RN-PN-10). Aditivo/reversível.
  try {
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN network_discoverable INTEGER DEFAULT 0`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de descoberta da clínica (ADR-180 F10.2)', e); }

  // ── ADR-180 F11.1 — Aceite do vínculo PELO profissional (mútuo consentimento) ──
  // professional_accepted_at: quando o PRÓPRIO profissional aceitou o vínculo pelo webapp
  // (fecha o consentimento dos dois lados — RN-PN-11; antes só a clínica aceitava). Aditivo;
  // legado/aceite-pela-clínica → null. Recusar não usa coluna: revoga (reusa revoke) + sinal.
  try {
    try { db.exec(`ALTER TABLE clinic_professional_relationships ADD COLUMN professional_accepted_at DATETIME`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes de aceite do vínculo (ADR-180 F11.1)', e); }

  // ── ADR-181 F1 — Perfil Fiscal da org (prontidão Reforma Tributária CBS/IBS/IS) ──
  // Identidade fiscal por-org, aditiva/opt-in. NÃO duplica comigo_cnpj/comigo_formalization
  // (aqueles são do fluxo de formalização MEI do Comigo, grosseiros); o perfil fiscal é o
  // recorte estruturado que o motor CBS/IBS/IS (F3) precisa: regime + inscrições + município
  // (código IBGE p/ IBS) + a opção pelo regime regular (Simples híbrido — RN-FISCAL-9, default
  // DAS). Tudo nullable: perfil incompleto → o motor não calcula, avisa (RN-FISCAL-4). Regime
  // é string livre validada no service contra um registry (mei/simples/simples_hibrido/
  // presumido/real), não enum de coluna (CREATE-then-ALTER não reordena — convenção nº 2).
  try {
    // Regime tributário declarado pelo dono (null = não declarado; nunca presumido).
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN fiscal_regime TEXT`); } catch (e) { /* noop */ }
    // Opção pelo regime regular de CBS/IBS (Simples híbrido). 0 = dentro do DAS (default,
    // RN-FISCAL-9). Só o híbrido gera/aproveita crédito (LC 214 art. 47 §9).
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN fiscal_regime_regular_optin INTEGER DEFAULT 0`); } catch (e) { /* noop */ }
    // Inscrições fiscais (municipal p/ ISS→IBS de serviço; estadual p/ ICMS→IBS de mercadoria).
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN fiscal_municipal_registration TEXT`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN fiscal_state_registration TEXT`); } catch (e) { /* noop */ }
    // Município do estabelecimento + código IBGE (chave do IBS municipal). UF reusa
    // address_state; guardamos o código IBGE explícito porque o município é o fato gerador.
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN fiscal_municipality_ibge TEXT`); } catch (e) { /* noop */ }
    try { db.exec(`ALTER TABLE organization_settings ADD COLUMN fiscal_municipality_name TEXT`); } catch (e) { /* noop */ }
  } catch (e) { console.error('[DB] Falha em ajustes do Perfil Fiscal (ADR-181 F1)', e); }

  // ── ADR-181 F2 — Base de Referência Tributária CURADA (CBS/IBS/IS) ──
  // GLOBAL (a lei é a mesma p/ todos — SEM organization_id), DATE-EFFECTIVE, escrita SÓ pelo
  // admin master (molde labor_law_entries/ADR-178). NASCE VAZIA: o ZapFlow NUNCA inventa
  // alíquota (RN-FISCAL-1) — o operador cura da fonte oficial quando a resolução sai. A alíquota
  // efetiva vale pela DATA DO FATO GERADOR (RN-FISCAL-3): `effective_from`..`effective_to`
  // (to NULL = em aberto). `applies_to` NULL = geral; valores como 'simples_das'/'mei' permitem
  // o recorte por regime (MEI no DAS = 0,9% CBS + 0,1% IBS). `reviewed_by` obrigatório.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tax_reference_rates (
        id TEXT PRIMARY KEY,
        tribute TEXT NOT NULL,                             -- cbs | ibs | is
        phase TEXT NOT NULL,                               -- rótulo da fase (ex.: teste_2026, cheia_2027)
        rate_percent REAL NOT NULL,                        -- alíquota em % (0.9 = 0,9%)
        applies_to TEXT,                                   -- NULL = geral; 'simples_das' | 'mei' | ...
        effective_from TEXT NOT NULL,                      -- YYYY-MM-DD (início da vigência)
        effective_to TEXT,                                 -- YYYY-MM-DD ou NULL (em aberto)
        source TEXT,                                       -- origem oficial da curadoria
        notes TEXT,
        reviewed_by TEXT NOT NULL,                         -- QUEM curou/revisou (obrigatório)
        status TEXT NOT NULL DEFAULT 'published',          -- published | archived
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tax_reference_rates_lookup
        ON tax_reference_rates (tribute, status, effective_from);
    `);
  } catch (e) { console.error('[DB] Falha ao criar tax_reference_rates (ADR-181 F2)', e); }

  // ── ADR-181 F4 — breakdown CBS/IBS/IS CONGELADO no snapshot do recibo ──
  // fiscal_breakdown_snapshot: JSON do bloco (FiscalDocumentBreakdownService) gravado NO ISSUE
  // (congela junto do resto do snapshot canônico — convenção nº 3; recurar alíquota depois NÃO
  // muda o documento emitido). Aditivo; recibos legados/rascunho → null. Informativo (2026).
  try { db.exec(`ALTER TABLE clinical_receipts ADD COLUMN fiscal_breakdown_snapshot TEXT`); } catch (e) { /* noop */ }

  // ── ADR-181 F6 — Conexão de EMISSÃO fiscal (NFS-e/NFC-e) — SCAFFOLD HONESTO ──
  // Espelha sicredi_cobranca_connections (ADR-177): guarda a config CIFRADA + estado observável.
  // NUNCA marca 'connected' sem homologação real (certificado A1 + prefeitura/SEFAZ ou provedor
  // homologado) — RN-FISCAL-8. Enquanto não homologa, `issue` LANÇA (nunca finge emitir nota).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fiscal_issuance_connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        config_enc TEXT,                                   -- JSON cifrado (provedor/token/certificado A1)
        connection_state TEXT NOT NULL DEFAULT 'not_configured', -- not_configured|awaiting_homologation|connected|disabled
        state_detail TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,                -- opt-in; 0 = desligada
        configured_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_issuance_org ON fiscal_issuance_connections (organization_id);
    `);
  } catch (e) { console.error('[DB] Falha ao criar fiscal_issuance_connections (ADR-181 F6)', e); }

  // ADR-189 F1 — Mission Contract (Mission OS). Uma MISSÃO é uma INICIATIVA de negócio
  // limitada (estado final + prazo + critério), distinta do `business_goals` — que é
  // SINGLETON por métrica (UNIQUE(org,metric)) e não comporta várias missões concorrentes.
  // Por isso a Missão é uma ENTIDADE FINA PRÓPRIA que COMPÕE o registro de métricas do
  // BusinessGoal pra medir (RN-MOL-1/2, correção de D1 do ADR-189 forçada pelo schema real):
  // NÃO é uma linha de goal, e NÃO duplica o Goal (Goal = alvo permanente por métrica;
  // Missão = iniciativa bounded que referencia opcionalmente uma métrica conhecida).
  //   desired_state/baseline_state — texto do estado final × ponto de partida;
  //   target_metric — métrica conhecida (BusinessGoalService.METRICS) OU null (missão qualitativa);
  //   target_value/target_unit — alvo inline (o Mission carrega o próprio alvo, §7 do PRD);
  //   autonomy_level — off|shadow|suggest|approval|autopilot (shadow-first, D6);
  //   source — user|system_proposed|system_generated (§10);
  //   mission_status — draft|planning|ready|running|at_risk|waiting_approval|blocked|achieved|failed|cancelled;
  //   confidence — 0..1 (hipótese; null até haver evidência). Isolada por org; opt-in por flag.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        desired_state TEXT,
        baseline_state TEXT,
        target_metric TEXT,
        target_value REAL,
        target_unit TEXT,
        deadline TEXT,
        owner TEXT,
        autonomy_level TEXT NOT NULL DEFAULT 'off',
        source TEXT NOT NULL DEFAULT 'user',
        mission_status TEXT NOT NULL DEFAULT 'draft',
        confidence REAL,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_missions_org_status ON missions (organization_id, mission_status);
    `);
  } catch (e) { console.error('[DB] Falha ao criar missions (ADR-189 F1)', e); }
  // Flag opt-in do Mission Layer (default 0 — 0-regressão; nada aparece até o dono ligar).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN mission_layer_enabled INTEGER DEFAULT 0`); } catch(e){}
  // ADR-189 F11 — postura de missões PROATIVAS (off|shadow|suggest). Shadow-first: default off; NUNCA
  // 'auto'/autopilot (missão proativa é sempre PROPOSTA, nunca executa sozinha).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN mission_proactive_mode TEXT DEFAULT 'off'`); } catch(e){}
  // ADR-190 F3 (CEO Operating Layer) — VISÃO estratégica do negócio (§12/§56). Intenção HUMANA:
  // a IA pode ajudar a estruturar, mas NUNCA inventa a visão. 3 colunas aditivas (sem tabela nova, D6);
  // snapshots derivados NUNCA persistem aqui. Vazias por padrão (0-regressão; recurso dormente).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN vision_statement TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN vision_horizon TEXT`); } catch(e){}         // ex.: "36 meses"
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN strategic_priority TEXT`); } catch(e){}     // commercial|operations|finance|growth|... (texto livre curto)
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN vision_updated_at TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN vision_updated_by TEXT`); } catch(e){}
};

initDb();

export default db;
