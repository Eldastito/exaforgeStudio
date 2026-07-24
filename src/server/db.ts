import Database from 'better-sqlite3';
import path from 'path';
import { applyPlanGrade } from './plansGrade.js';

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
        status TEXT NOT NULL DEFAULT 'open',  -- open|acknowledged|resolved|dismissed
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
};

initDb();

export default db;
