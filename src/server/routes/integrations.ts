import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { logAuthEvent } from "../auditLog.js";
import { AuthRequest } from "../middleware/auth.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import { BackupService } from "../BackupService.js";
import { StorageService } from "../StorageService.js";
import { NotificationService } from "../NotificationService.js";
import { effectiveWebhookSecret, isWebhookEnforced, setWebhookEnforced, rotateStoredWebhookSecret, usingEnvSecret, getLastWebhookHit } from "../webhookSecurity.js";
import { GoogleOAuthService } from "../GoogleOAuthService.js";
import { GoogleAutomationService } from "../GoogleAutomationService.js";
import { ReportsService } from "../ReportsService.js";
import { AlterdataConnectorService } from "../AlterdataConnectorService.js";

const router = Router();

const APP_BASE = (process.env.APP_URL || "").replace(/\/$/, "");

// ===== Google Workspace (OAuth server-side, acesso offline) =====
// GET status da conexão Google
router.get("/google/status", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(GoogleOAuthService.status(req.organizationId));
});

// GET URL de consentimento (inicia a conexão server-side)
router.get("/google/login-url", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (!GoogleOAuthService.isConfigured()) {
    return res.status(400).json({ error: "Integração Google não configurada no servidor (defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e APP_URL)." });
  }
  res.json({ url: GoogleOAuthService.authUrl(req.organizationId) });
});

// GET/POST automações Google (registrar pedidos no Sheets, etc.)
router.get("/google/automations", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(GoogleAutomationService.getSettings(req.organizationId));
});
router.post("/google/automations", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (req.body?.logOrders !== undefined) GoogleAutomationService.setLogOrders(req.organizationId, !!req.body.logOrders);
  if (req.body?.emailAppointments !== undefined) GoogleAutomationService.setEmailAppointments(req.organizationId, !!req.body.emailAppointments);
  if (req.body?.emailOrders !== undefined) GoogleAutomationService.setEmailOrders(req.organizationId, !!req.body.emailOrders);
  if (req.body?.liveSync !== undefined) GoogleAutomationService.setLiveSync(req.organizationId, !!req.body.liveSync);
  res.json({ success: true, ...GoogleAutomationService.getSettings(req.organizationId) });
});

// POST /google/sheets/sync-now — força uma sincronização imediata do painel
// vivo (também roda sozinho de hora em hora pelo Scheduler quando ligado).
router.post("/google/sheets/sync-now", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!GoogleOAuthService.getConnection(orgId)) return res.status(400).json({ error: "Conecte a conta Google primeiro." });
  GoogleAutomationService.setLiveSync(orgId, true);
  const r = await GoogleAutomationService.syncLiveSheet(orgId);
  if (!r.ok) return res.status(400).json({ error: r.reason === "desligado" ? "Sincronização desligada." : (r.reason || "Falha ao sincronizar.") });
  const sheetUrl = r.sheetId ? `https://docs.google.com/spreadsheets/d/${r.sheetId}` : null;
  res.json({ success: true, sheetUrl, counts: r.counts });
});

// POST desconectar
router.post("/google/disconnect", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  GoogleOAuthService.disconnect(req.organizationId);
  res.json({ success: true });
});

// POST /backups/:id/drive -> envia o backup para o Google Drive do dono.
router.post("/backups/:id/drive", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const job = db.prepare("SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?").get(req.params.id, orgId) as any;
  if (!job || !job.file_url) return res.status(404).json({ error: "Backup não encontrado." });
  const fullPath = BackupService.resolveFile(orgId, job.file_url);
  if (!fullPath) return res.status(404).json({ error: "Arquivo do backup não encontrado." });
  try {
    const fs = await import("fs");
    const content = fs.readFileSync(fullPath);
    const result = await GoogleOAuthService.driveUpload(orgId, job.file_url, "application/json", content);
    if ("error" in result) return res.status(400).json({ error: result.error });
    res.json({ success: true, link: result.link });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao enviar ao Drive." });
  }
});

// POST /google/sheets/export { dataset: 'orders'|'contacts'|'appointments'|'summary' }
// -> cria uma planilha no Google Sheets do dono com os dados e devolve o link.
router.post("/google/sheets/export", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const allowed = ["orders", "contacts", "appointments", "summary"];
  const dataset = allowed.includes(req.body?.dataset) ? req.body.dataset : "orders";
  const brl = (v: any) => `R$ ${Number(v || 0).toFixed(2)}`;
  const dt = (v: any) => v ? new Date(v).toLocaleString("pt-BR") : "";
  const today = new Date().toLocaleDateString("pt-BR");

  let title = ""; let header: string[] = []; let rows: (string | number)[][] = [];
  try {
    if (dataset === "contacts") {
      title = `Contatos — ExaForge — ${today}`;
      header = ["Nome", "Telefone/ID", "E-mail", "Cadastrado em", "Compras", "Total gasto"];
      const list = db.prepare("SELECT name, identifier, email, created_at, purchase_count, total_spent FROM contacts WHERE organization_id = ? ORDER BY created_at DESC LIMIT 5000").all(orgId) as any[];
      rows = list.map(c => [c.name || "", c.identifier || "", c.email || "", dt(c.created_at), Number(c.purchase_count || 0), brl(c.total_spent)]);
    } else if (dataset === "appointments") {
      title = `Agendamentos — ExaForge — ${today}`;
      header = ["Data/hora", "Cliente", "Título", "Status", "E-mail", "Criado em"];
      const list = db.prepare(
        `SELECT a.scheduled_start, c.name AS contact, a.title, a.status, c.email AS email, a.created_at
           FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
          WHERE a.organization_id = ? ORDER BY a.scheduled_start DESC LIMIT 2000`
      ).all(orgId) as any[];
      rows = list.map(a => [dt(a.scheduled_start), a.contact || "Cliente", a.title || "", a.status || "", a.email || "", dt(a.created_at)]);
    } else if (dataset === "summary") {
      title = `Resumo de vendas — ExaForge — ${today}`;
      header = ["Métrica", "Últimos 30 dias", "Total geral"];
      const sum = ReportsService.salesSummary(orgId);
      rows = [
        ["Pedidos (não cancelados)", sum.orders.d30, sum.orders.all],
        ["Faturamento", brl(sum.revenue.d30), brl(sum.revenue.all)],
        ["Ticket médio", brl(sum.ticket.d30), brl(sum.ticket.all)],
        ["Pedidos pagos", sum.paidOrders.d30, sum.paidOrders.all],
        ["Agendamentos", sum.appointments.d30, sum.appointments.all],
        ["Contatos", sum.contacts.d30, sum.contacts.all],
      ];
    } else {
      title = `Pedidos — ExaForge — ${today}`;
      header = ["Data", "Cliente", "Status", "Pagamento", "Total"];
      const list = db.prepare(
        `SELECT o.created_at, c.name AS contact, o.status, o.payment_status, o.total_amount
           FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
          WHERE o.organization_id = ? ORDER BY o.created_at DESC LIMIT 2000`
      ).all(orgId) as any[];
      rows = list.map(o => [dt(o.created_at), o.contact || "Cliente", o.status || "", o.payment_status || "", brl(o.total_amount)]);
    }
    if (rows.length === 0) return res.status(400).json({ error: "Nada para exportar ainda." });
    const r = await GoogleOAuthService.sheetsCreate(orgId, title, header, rows);
    if ("error" in r) return res.status(400).json({ error: r.error });
    res.json({ success: true, url: r.url, count: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao exportar." });
  }
});

// POST /google/gmail/test -> envia um e-mail de teste para a conta conectada.
router.post("/google/gmail/test", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const st = GoogleOAuthService.status(orgId);
  if (!st.connected || !st.email) return res.status(400).json({ error: "Conecte uma conta Google primeiro." });
  const r = await GoogleOAuthService.gmailSend(orgId, st.email, "Teste de e-mail — ExaForge", "Este é um e-mail de teste enviado pela sua conta Google conectada ao ExaForge. Se você recebeu, a integração de Gmail está funcionando. ✅");
  if ("error" in r) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});

// POST /google/gmail/send { to, subject, body } -> envia um e-mail.
router.post("/google/gmail/send", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { to, subject, body } = req.body || {};
  if (!to) return res.status(400).json({ error: "Informe o destinatário." });
  const r = await GoogleOAuthService.gmailSend(orgId, String(to).trim(), String(subject || ""), String(body || ""));
  if ("error" in r) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});

// GET /api/integrations/whatsapp-webhook -> URL pronta (com segredo) + status.
// Permite ativar a exigência do segredo sem mexer em variáveis de ambiente.
router.get("/whatsapp-webhook", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const secret = effectiveWebhookSecret();
  const base = APP_BASE || `${req.protocol}://${req.headers.host}`;
  res.json({
    url: `${base}/api/webhooks/evolution?secret=${secret}`,
    enforced: isWebhookEnforced(),
    usingEnv: usingEnvSecret(),
    lastHit: getLastWebhookHit(),
  });
});

// POST /api/integrations/whatsapp-webhook/enforce { enabled }
router.post("/whatsapp-webhook/enforce", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (usingEnvSecret()) return res.status(400).json({ error: "O segredo está definido por variável de ambiente (sempre exigido)." });
  setWebhookEnforced(!!req.body?.enabled);
  logAuthEvent(req.organizationId, req.user?.userId, undefined, 'WHATSAPP_WEBHOOK_ENFORCE', { enabled: !!req.body?.enabled });
  res.json({ success: true, enforced: isWebhookEnforced() });
});

// POST /api/integrations/whatsapp-webhook/rotate -> gera um novo segredo.
router.post("/whatsapp-webhook/rotate", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  if (usingEnvSecret()) return res.status(400).json({ error: "O segredo está definido por variável de ambiente; não dá para girar por aqui." });
  const secret = rotateStoredWebhookSecret();
  const base = APP_BASE || `${req.protocol}://${req.headers.host}`;
  logAuthEvent(req.organizationId, req.user?.userId, undefined, 'WHATSAPP_WEBHOOK_ROTATE', {});
  res.json({ success: true, url: `${base}/api/webhooks/evolution?secret=${secret}` });
});

router.post("/inbound", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const authHeader = req.headers['authorization'];
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.split(' ')[1];
  
  const isValid = db.prepare('SELECT 1 FROM webhook_endpoints WHERE secret = ? AND organization_id = ?').get(token, orgId);
  
  if (!isValid) {
    return res.status(403).json({ error: "Invalid token / signature" });
  }

  const { event, payload } = req.body;
  
  if (event === 'inventory.updated') {
     try {
        db.prepare('UPDATE inventory_items SET quantity_available = ? WHERE sku = ? AND organization_id = ?')
          .run(payload.quantity, payload.sku, orgId);
        return res.json({ success: true, message: 'Estoque atualizado' });
     } catch (e: any) {
        return res.status(500).json({ error: e.message });
     }
  }

  return res.json({ success: true, message: 'Evento recebido' });
});

router.get("/webhooks", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Não devolve a coluna `secret` (segredo do webhook) — só um indicador.
    const webhooks = db.prepare(
      `SELECT id, organization_id, name, url, events, active, created_at,
              CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
         FROM webhook_endpoints WHERE organization_id = ?`
    ).all(orgId);
    res.json(webhooks);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/webhooks", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, url, events, secret } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO webhook_endpoints (id, organization_id, name, url, events, secret)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, name, url, events || '*', secret || uuidv4());
    
    logAuthEvent(orgId, userId, id, 'WEBHOOK_CREATED', { name });
    
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/webhooks/:id/test", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const id = req.params.id;
  const deliveryId = uuidv4();
  
  const success = Math.random() > 0.3;

  try {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, organization_id, endpoint_id, event_type, payload, status, attempts, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
       deliveryId, 
       orgId, 
       id, 
       'test_event', 
       JSON.stringify({ message: "Test webhook" }), 
       success ? 'success' : 'failed', 
       1, 
       success ? null : 'Connection timeout'
    );

    logAuthEvent(orgId, userId, id, 'WEBHOOK_TESTED', { deliveryId });

    res.json({ success: true, deliveryId, status: success ? 'success' : 'failed' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/backups", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const jobs = db.prepare('SELECT * FROM backup_jobs WHERE organization_id = ? ORDER BY created_at DESC').all(orgId);
    res.json(jobs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Config do backup automático (ADR-097). Registrada ANTES das rotas /backups/:id
// para "settings" não ser capturado como um id.
router.get("/backups/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const s = db.prepare(`
      SELECT COALESCE(backup_auto_enabled,0) AS enabled, COALESCE(backup_frequency,'daily') AS frequency,
             COALESCE(backup_retention,30) AS retention, COALESCE(backup_to_drive,1) AS toDrive,
             backup_auto_last_run AS lastRun
      FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    res.json({
      enabled: !!s.enabled, frequency: s.frequency || 'daily',
      retention: s.retention ?? 30, toDrive: !!s.toDrive, lastRun: s.lastRun || null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/backups/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { enabled, frequency, retention, toDrive } = req.body || {};
    const freq = ['daily', '2x_week', 'weekly'].includes(frequency) ? frequency : 'daily';
    const ret = Math.min(365, Math.max(1, parseInt(String(retention ?? 30), 10) || 30));
    db.prepare(`
      UPDATE organization_settings
         SET backup_auto_enabled = ?, backup_frequency = ?, backup_retention = ?, backup_to_drive = ?
       WHERE organization_id = ?`).run(enabled ? 1 : 0, freq, ret, toDrive ? 1 : 0, orgId);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/backups", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { type } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO backup_jobs (id, organization_id, type, status)
      VALUES (?, ?, ?, 'pending')
    `).run(id, orgId, type || 'manual');

    logAuthEvent(orgId, userId, id, 'BACKUP_STARTED', { type });

    // Roda em background para não bloquear a request — backup pode levar segundos.
    setImmediate(() => {
      try {
        const result = BackupService.run(orgId, id, type || 'manual');
        db.prepare(`
          UPDATE backup_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP, file_url = ? WHERE id = ?
        `).run(result.fileName, id);
        logAuthEvent(orgId, userId, id, 'BACKUP_COMPLETED', { size: result.sizeBytes, records: result.recordCount });
        try { NotificationService.backupReady(orgId, true); } catch (e) { /* noop */ }
        // Espelho best-effort no S3 (S3_ENABLED=true): redundância além do
        // disco local. Download/exclusão continuam servindo do disco local,
        // que segue sendo a fonte de verdade — o mirror nunca bloqueia nem
        // muda o fluxo existente se falhar ou estiver desligado.
        if (StorageService.isS3Enabled()) {
          const fullPath = BackupService.resolveFile(orgId, result.fileName);
          if (fullPath) StorageService.mirrorToS3(fullPath, `backups/${result.fileName}`).catch(() => {});
        }
      } catch (err: any) {
        console.error('[Backup] Falha ao gerar:', err);
        try {
          db.prepare(`UPDATE backup_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
          logAuthEvent(orgId, userId, id, 'BACKUP_FAILED', { error: String(err?.message || err).slice(0, 300) });
          NotificationService.backupReady(orgId, false);
        } catch (e) { /* noop */ }
      }
    });

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/integrations/backups/:id/download — baixa o arquivo gerado.
router.get("/backups/:id/download", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const job = db.prepare(`SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
    if (!job) return res.status(404).json({ error: "Backup não encontrado." });
    if (job.status !== 'completed' || !job.file_url) return res.status(400).json({ error: "Backup ainda não está pronto." });

    const fullPath = BackupService.resolveFile(orgId, job.file_url);
    if (!fullPath) return res.status(404).json({ error: "Arquivo não encontrado no disco." });

    res.download(fullPath, job.file_url);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/integrations/backups/:id/restore — restaura o backup de volta ao
// banco (ADR-097). Operação sensível: só dono ou Master Admin, com confirmação
// (o front exige dupla confirmação) e auditada. Gera um backup-guard antes.
router.post("/backups/:id/restore", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  // Só o dono da conta ou o Master Admin podem restaurar.
  const isOwner = req.user?.role === 'owner';
  const isMaster = req.user?.email === MASTER_ADMIN_EMAIL;
  if (!isOwner && !isMaster) return res.status(403).json({ error: "Apenas o dono da conta pode restaurar um backup." });

  // Confirmação explícita no corpo (o front pede dupla confirmação).
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirmação necessária para restaurar." });

  try {
    const job = db.prepare(`SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
    if (!job) return res.status(404).json({ error: "Backup não encontrado." });
    if (job.status !== 'completed' || !job.file_url) return res.status(400).json({ error: "Backup ainda não está pronto." });

    const result = BackupService.restore(orgId, job.file_url);
    if (!result.ok) {
      logAuthEvent(orgId, userId, req.params.id, 'BACKUP_RESTORE_FAILED', { error: result.error, guard: result.guardFileName });
      const msg = result.error === 'falha_no_backup_guard'
        ? "Não foi possível gerar o backup de segurança — restauração cancelada para proteger seus dados."
        : "Falha ao restaurar o backup.";
      return res.status(400).json({ error: msg, code: result.error });
    }
    logAuthEvent(orgId, userId, req.params.id, 'BACKUP_RESTORED', { guard: result.guardFileName, restored: result.restored });
    res.json({ success: true, guardFileName: result.guardFileName, restored: result.restored });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/integrations/backups/:id — apaga registro + arquivo.
router.delete("/backups/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const job = db.prepare(`SELECT * FROM backup_jobs WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
    if (!job) return res.status(404).json({ error: "Backup não encontrado." });

    if (job.file_url) BackupService.deleteFile(orgId, job.file_url);
    db.prepare(`DELETE FROM backup_jobs WHERE id = ? AND organization_id = ?`).run(req.params.id, orgId);
    logAuthEvent(orgId, userId, req.params.id, 'BACKUP_DELETED', {});
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== Integração Alterdata/ModaUp (ADR-105) — config por organização =====
// Fundação: guarda credenciais CIFRADAS + rede/filial + flag. A sincronização
// real (Fase 1) entra quando a Alterdata fornecer token + homologação.
router.get("/alterdata/status", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(AlterdataConnectorService.publicSettings(req.organizationId));
});

router.put("/alterdata/settings", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  AlterdataConnectorService.saveSettings(req.organizationId, {
    enabled: b.enabled, environment: b.environment, rede: b.rede, filiais: b.filiais,
    basePattern: b.basePattern, moduleBaseUrls: b.moduleBaseUrls, authConfig: b.authConfig,
    syncIntervalMinutes: b.syncIntervalMinutes,
  });
  logAuthEvent(req.organizationId, (req as any).userId || null, null, 'ALTERDATA_SETTINGS_UPDATED', { enabled: !!b.enabled, environment: b.environment });
  res.json(AlterdataConnectorService.publicSettings(req.organizationId));
});

// Testa a emissão do token no Guardian com as credenciais gravadas (ADR-105).
// Responde só com o status público (sem token/segredo). Erro → mensagem amigável.
router.post("/alterdata/test-token", async (req: AuthRequest, res): Promise<any> => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { expiresAt } = await AlterdataConnectorService.acquireToken(req.organizationId);
    logAuthEvent(req.organizationId, (req as any).userId || null, null, 'ALTERDATA_TOKEN_ISSUED', { expiresAt });
    res.json({ ok: true, tokenExpiresAt: expiresAt, status: AlterdataConnectorService.publicSettings(req.organizationId) });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message || "Falha ao emitir o token no Guardian." });
  }
});

export default router;
