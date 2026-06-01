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
  // Número de WhatsApp da empresa para a IA encaminhar leads (ex.: vindos do Instagram).
  try { db.exec(`ALTER TABLE organization_settings ADD COLUMN forward_whatsapp TEXT`); } catch(e){}

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
};

initDb();

export default db;
