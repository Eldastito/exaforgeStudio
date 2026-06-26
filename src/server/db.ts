import Database from 'better-sqlite3';
import path from 'path';

// DATA_DIR permite apontar o banco para um volume persistente (ex.: /data no
// Coolify), evitando perda de dados a cada redeploy. Sem ela, usa o cwd.
const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, 'zappflow.db');
const db = new Database(dbPath, process.env.NODE_ENV === 'production' ? {} : { verbose: console.log });

db.pragma('journal_mode = WAL');

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
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN onboarding_status TEXT DEFAULT 'pending'`); } catch(e){}
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
  // Mídia (imagem/etc) anexada a uma mensagem
  try { db.exec(`ALTER TABLE messages ADD COLUMN media_url TEXT`); } catch(e){}
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

  // ===== Planos / Billing (Fase 2) =====
  // Plans.features (JSON) com limites: ai_monthly_limit, contacts_limit, channels_limit, users_limit, trial_days.
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM plans`).get() as any;
    if (!row || row.c === 0) {
      const seed = db.prepare(`INSERT INTO plans (id, name, price, features) VALUES (?, ?, ?, ?)`);
      seed.run('starter', 'Starter',  99, JSON.stringify({ ai_monthly_limit:   500, contacts_limit:  1000, channels_limit: 1,  users_limit:  2, trial_days: 14 }));
      seed.run('pro',     'Pro',     299, JSON.stringify({ ai_monthly_limit:  3000, contacts_limit: 10000, channels_limit: 3,  users_limit:  5, trial_days: 14 }));
      seed.run('business','Business',799, JSON.stringify({ ai_monthly_limit: 15000, contacts_limit: 50000, channels_limit: 10, users_limit: 20, trial_days: 14 }));
      console.log('[DB] Planos padrão criados (Starter, Pro, Business).');
    }
  } catch (e) { console.error('[DB] Falha ao popular planos', e); }

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
};

initDb();

export default db;
