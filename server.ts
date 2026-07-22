import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { Server as SocketIOServer } from "socket.io";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";

import channelsRoutes from "./src/server/routes/channels.js";
import messagesRoutes from "./src/server/routes/messages.js";
import ticketsRoutes from "./src/server/routes/tickets.js";
import productsRoutes from "./src/server/routes/products.js";
import appointmentsRoutes from "./src/server/routes/appointments.js";
import integrationsRoutes from "./src/server/routes/integrations.js";
import importRoutes from "./src/server/routes/import.js";
import metaDebugRoutes from "./src/server/routes/metaDebug.js";
import manifestoRoutes from "./src/server/routes/manifesto.js";
import opportunityRadarRoutes from "./src/server/routes/opportunityRadar.js";
import frustrationsRoutes from "./src/server/routes/frustrations.js";
import recoveryRoutes from "./src/server/routes/recovery.js";
import bigIdeaRoutes from "./src/server/routes/bigIdea.js";
import recognitionRoutes from "./src/server/routes/recognition.js";
import philosophyAuditRoutes from "./src/server/routes/philosophyAudit.js";
import { effectiveWebhookSecret, isWebhookEnforced, recordWebhookHit } from "./src/server/webhookSecurity.js";
import analyticsRoutes from "./src/server/routes/analytics.js";
import adminRoutes from "./src/server/routes/admin.js";
import notificationsRoutes from "./src/server/routes/notifications.js";
import authRoutes from "./src/server/routes/auth.js";
import usersRoutes from "./src/server/routes/users.js";
import permissionsRoutes from "./src/server/routes/permissions.js";
import auditRoutes from "./src/server/routes/audit.js";
import ragRoutes from "./src/server/routes/rag.js";
import studioRoutes from "./src/server/routes/studio.js";
import taskRoutes from "./src/server/routes/tasks.js";
import prospectRoutes from "./src/server/routes/prospect.js";
import radarB2BRoutes from "./src/server/routes/radarB2B.js";
import clinicRoutes from "./src/server/routes/clinic.js";
import retailOpsRoutes from "./src/server/routes/retailops.js";
import comigoRoutes from "./src/server/routes/comigo.js";
import continuityRoutes from "./src/server/routes/continuity.js";
import { edgeSyncRoutes, edgeDeviceRoutes } from "./src/server/routes/edge.js";
import managersRoutes from "./src/server/routes/managers.js";
import areasRoutes from "./src/server/routes/areas.js";
import aiRoutes from "./src/server/routes/ai.js";
import ordersRoutes from "./src/server/routes/orders.js";
import contactsRoutes from "./src/server/routes/contacts.js";
import campaignsRoutes from "./src/server/routes/campaigns.js";
import paymentsRoutes from "./src/server/routes/payments.js";
import cadencesRoutes from "./src/server/routes/cadences.js";
import procurementRoutes from "./src/server/routes/procurement.js";
import quotesRoutes from "./src/server/routes/quotes.js";
import eventsRoutes from "./src/server/routes/events.js";
import quickstartRoutes from "./src/server/routes/quickstart.js";
import connectorRoutes from "./src/server/routes/connector.js";
import connectorPublicRoutes from "./src/server/routes/connectorPublic.js";
import mfaRoutes from "./src/server/routes/mfa.js";
import lgpdRoutes from "./src/server/routes/lgpd.js";
import executiveRoutes from "./src/server/routes/executive.js";
import plansRoutes from "./src/server/routes/plans.js";
import { PlanService } from "./src/server/PlanService.js";
import instagramOAuthRoutes, { instagramCallback } from "./src/server/routes/instagramOAuth.js";
import { GoogleOAuthService } from "./src/server/GoogleOAuthService.js";
import storefrontRoutes from "./src/server/routes/storefront.js";
import reservationsRoutes from "./src/server/routes/reservations.js";
import subscriptionsRoutes from "./src/server/routes/subscriptions.js";
import storefrontPublicRoutes from "./src/server/routes/storefrontPublic.js";
import comigoPublicRoutes from "./src/server/routes/comigoPublic.js";
import subscriptionPublicRoutes from "./src/server/routes/subscriptionPublic.js";
import fashionPublicRoutes from "./src/server/routes/fashionPublic.js";
import uploadsRoutes from "./src/server/routes/uploads.js";
import radarRoutes from "./src/server/routes/radar.js";
import radarPublicRoutes from "./src/server/routes/radarPublic.js";
import clinicPublicRoutes from "./src/server/routes/clinicPublic.js";
import radarConsultantRoutes from "./src/server/routes/radarConsultant.js";
import { Scheduler } from "./src/server/Scheduler.js";
import { NotificationService } from "./src/server/NotificationService.js";
import { MessageDeliveryService } from "./src/server/MessageDeliveryService.js";
import { EdgeInboxProcessor } from "./src/server/EdgeInboxProcessor.js";
import { registerBuiltinEdgeCommandHandlers } from "./src/server/edgeCommandHandlers.js";
import { PaymentService } from "./src/server/PaymentService.js";
import { ComigoPixService } from "./src/server/ComigoPixService.js";
import { AsaasService } from "./src/server/AsaasService.js";
import { requireAuth, requireOrganizationAccess, requireMasterAdmin, requireRole, enforceModulePermission } from "./src/server/middleware/auth.js";
import { ModuleService } from "./src/server/ModuleService.js";
import { PermissionService } from "./src/server/PermissionService.js";
import { EncryptionService } from "./src/server/EncryptionService.js";
import { dispatchIncomingMessage } from "./src/server/webhookProcessor.js";
import { MetaWebhookLogService } from "./src/server/MetaWebhookLogService.js";
import { setUsageOrg } from "./src/server/usageContext.js";
import { maybeFetchEvolutionAvatar } from "./src/server/evolutionAvatar.js";
import db from "./src/server/db.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { transcribeAudio, describeImage, analyzeImageForChat, analyzePdfForChat } from "./src/server/llm.js";
import { JWT_SECRET } from "./src/server/config/secret.js";
import fs from "fs";

// Diretório onde as mídias (imagens) recebidas são salvas (volume persistente /data).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}

// Salva um base64 como arquivo e retorna a URL pública (/media/<arquivo>).
function saveMediaBase64(base64: string, ext = 'jpg'): string | null {
  try {
    const name = `${uuidv4()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(base64, 'base64'));
    return `/media/${name}`;
  } catch (e) {
    console.error("[Media] Falha ao salvar arquivo:", e);
    return null;
  }
}

// Extrai texto de diferentes formatos de mensagem do WhatsApp.
// Suporta Evolution API (camelCase) e Evolution GO/whatsmeow (camel + Pascal).
function extractEvolutionText(message: any): string {
  if (!message) return "";
  return (
    message.conversation ||
    message.Conversation ||
    message.extendedTextMessage?.text ||
    message.ExtendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.ImageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ""
  );
}

// Tenta transcrever uma mensagem de áudio do Evolution via Whisper (OpenAI).
// Busca o base64 do áudio na Evolution API e envia ao modelo de transcrição.
async function transcribeEvolutionAudio(
  payload: any,
  cfg: { baseUrl: string; apiKey: string; instanceName: string }
): Promise<string> {
  try {
    if (!cfg.baseUrl || !cfg.apiKey) return "";
    const instance = payload.instance || cfg.instanceName;
    const endpoint = `${cfg.baseUrl.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${instance}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': cfg.apiKey, 'instance': instance },
      body: JSON.stringify({ message: payload.data, convertToMp4: false }),
    });
    if (!resp.ok) {
      console.warn(`[Audio] Falha ao obter base64 do áudio (HTTP ${resp.status}).`);
      return "";
    }
    const data: any = await resp.json();
    const b64 = data.base64 || data.media || "";
    if (!b64) return "";
    const buffer = Buffer.from(b64, 'base64');
    const transcript = await transcribeAudio(buffer, 'audio.ogg', 'audio/ogg');
    console.log(`[Audio] Transcrição: ${transcript.slice(0, 80)}...`);
    return transcript;
  } catch (e) {
    console.error("[Audio] Erro ao transcrever áudio:", e);
    return "";
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // --- SECURITY HEADERS (Helmet-like) ---
  app.use((req, res, next) => {
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // --- CORS ---
  // Em produção liberamos APENAS uma origem explícita (CORS_ORIGIN ou APP_URL) —
  // NUNCA refletimos o Host da requisição (que é falsificável). O SPA é servido
  // pela mesma origem, então não precisa de CORS; só consumidores externos.
  app.use((req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    const allowed = isProd
      ? (process.env.CORS_ORIGIN || process.env.APP_URL || '')
      : '*';
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', allowed);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,x-organization-id');
      if (req.method === 'OPTIONS') {
         return res.status(200).end();
      }
    }
    next();
  });

  // --- RATE LIMITING (anti-abuso) ---
  // Limite GENEROSO para não derrubar o uso normal do app (que faz polling e
  // várias chamadas por tela). Só conta requisições que NÃO são do webhook/estáticos,
  // e o teto é alto. Ajustável por env RATE_LIMIT_MAX (padrão 3000 / 15 min por IP).
  const rateLimitMap = new Map<string, { count: number, resetTime: number }>();
  app.use((req, res, next) => {
     if (process.env.ENABLE_RATE_LIMIT === 'true' || process.env.NODE_ENV === 'production') {
        // Não limita webhooks (serviços externos) nem assets/SPA.
        const p = req.path || '';
        if (p.startsWith('/api/webhooks') || p.startsWith('/api/connector-in') || p.startsWith('/media') || p.startsWith('/assets') || !p.startsWith('/api')) {
           return next();
        }
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const limitConfig = { max: parseInt(process.env.RATE_LIMIT_MAX || '3000', 10), windowMs: 15 * 60 * 1000 };
        const ipKey = String(ip);

        let data = rateLimitMap.get(ipKey);
        if (!data || now > data.resetTime) {
           data = { count: 0, resetTime: now + limitConfig.windowMs };
        }
        data.count++;
        rateLimitMap.set(ipKey, data);

        if (data.count > limitConfig.max) {
           return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
     }
     next();
  });

  // --- Verificação de autenticidade do webhook (C3/W1) ---
  // Self-service: o app já tem um segredo (gerado automaticamente, em app_config)
  // OU a env WEBHOOK_SECRET. A exigência do segredo é controlada por um interruptor
  // (na tela de Integrações) — por padrão NÃO exige, para o deploy ao vivo não
  // quebrar antes de você atualizar a URL na Evolution.
  let warnedNoWebhookSecret = false;
  const verifyWebhookSecret = (req: express.Request, res: express.Response): boolean => {
    if (!isWebhookEnforced()) {
      if (!warnedNoWebhookSecret) {
        console.warn("[SECURITY] Webhook do WhatsApp ABERTO (segredo não exigido). Ative em Integrações > Segurança do WhatsApp depois de colar a URL com ?secret=... na Evolution.");
        warnedNoWebhookSecret = true;
      }
      return true;
    }
    const expected = effectiveWebhookSecret();
    // Aceita o segredo via header (x-webhook-secret) OU query (?secret=).
    // Caso "Webhook by Events" da Evolution: ela anexa /EVENTO ao fim da URL,
    // o que pode corromper o valor do query (ex.: secret=ABC/MESSAGES_UPSERT).
    // Por isso, normalizamos pegando só o trecho antes de uma eventual barra.
    const rawProvided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string) || '';
    const provided = String(rawProvided).split('/')[0].trim();
    // Comparação em tempo constante para evitar timing attacks.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      console.warn(`[SECURITY] Webhook rejeitado (segredo ausente/incorreto). path=${req.path}`);
      res.status(401).json({ error: "Unauthorized webhook" });
      return false;
    }
    return true;
  };

  // --- Rate limit simples por chave (em memória), reutilizável ---
  const buckets = new Map<string, { count: number; resetTime: number }>();
  const rateLimit = (key: string, max: number, windowMs: number): boolean => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.resetTime) { b = { count: 0, resetTime: now + windowMs }; }
    b.count++;
    buckets.set(key, b);
    return b.count <= max;
  };

  // --- Ensure Default Org Exists ---
  const ensureDefaultOrg = () => {
    const existing = db.prepare('SELECT id FROM organization_settings WHERE organization_id = ?').get('default_org');
    if (!existing) {
      db.prepare(`
        INSERT INTO organization_settings (id, organization_id, business_name, status)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), 'default_org', 'Zappflow Mock Org', 'active');
    }
  };
  ensureDefaultOrg();

  // --- Ensure Master Admin Exists ---
  // A senha NUNCA é hardcoded. Vem de MASTER_ADMIN_PASSWORD (env). Se a env
  // estiver definida, também ATUALIZA a senha do admin existente — assim é
  // possível rotacionar a senha antiga (que estava exposta no código/histórico).
  const ensureMasterAdmin = async () => {
    const email = process.env.MASTER_ADMIN_EMAIL || 'eldastito@gmail.com';
    const envPassword = process.env.MASTER_ADMIN_PASSWORD;
    const saltRounds = 10;
    const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;

    if (!existingAdmin) {
       // Sem env: gera uma senha aleatória forte e a exibe UMA vez no log,
       // para não criar a conta com uma senha previsível.
       const password = envPassword || crypto.randomBytes(12).toString('base64url');
       const passwordHash = await bcrypt.hash(password, saltRounds);
       db.prepare(`
         INSERT INTO users (id, organization_id, name, email, password_hash, role)
         VALUES (?, 'default_org', 'Eldas Tito', ?, ?, 'owner')
       `).run(uuidv4(), email, passwordHash);
       if (envPassword) {
         console.log('Master admin criado: ' + email);
       } else {
         console.warn(`[SECURITY] Master admin criado com senha aleatória (defina MASTER_ADMIN_PASSWORD): ${email} / ${password}`);
       }
    } else if (envPassword) {
       // Rotaciona a senha do admin para a definida na env (corrige a senha vazada).
       const passwordHash = await bcrypt.hash(envPassword, saltRounds);
       db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, existingAdmin.id);
       console.log('[SECURITY] Senha do master admin atualizada a partir de MASTER_ADMIN_PASSWORD.');
    }
  };
  await ensureMasterAdmin();

  // Middleware for parsing JSON with limit blocker
  app.use(express.json({ limit: '2mb' }));

  // Servir mídias recebidas (imagens) — rota pública, fora do /api protegido.
  app.use('/media', express.static(MEDIA_DIR));

  // Financial Block Middleware (for API routes)
  app.use("/api", (req, res, next) => {
    // Allow these paths regardless of block status
    if (req.path.startsWith('/admin') || req.path.startsWith('/analytics/settings') || req.path.startsWith('/notifications')) {
      return next();
    }
    const orgId = req.headers['x-organization-id'] || 'default_org';
    try {
      const org: any = db.prepare('SELECT status, billing_status FROM organization_settings WHERE organization_id = ?').get(orgId);
      // Modo somente-leitura (ADR-091 Bloco B): 'blocked' (admin) e 'suspended'
      // (inadimplência D+10) bloqueiam escrita. GET segue liberado → o lojista
      // continua VENDO os dados; só não cria/edita até regularizar.
      if (org && (org.status === 'blocked' || org.billing_status === 'blocked' || org.billing_status === 'suspended')) {
          const method = req.method;
          if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
             return res.status(403).json({ error: "CONTA EM MODO SOMENTE-LEITURA por pendência de pagamento. Regularize em Configurações → Cobrança para reativar." });
          }
      }
    } catch(e) {}
    next();
  });

  app.use("/api/auth", authRoutes);

  // Provador Virtual (Fashion AI Studio, FAS-1) — auth PRÓPRIA de cliente
  // final (JWT com segredo derivado, ver FashionCustomerService). Registrado
  // antes do mount genérico /api/public por especificidade.
  app.use("/api/public/fashion", fashionPublicRoutes);

  // Comigo Mesa/QR PÚBLICO (autoatendimento sem login, ADR-119). Antes do mount
  // genérico /api/public por especificidade.
  app.use("/api/public/comigo", comigoPublicRoutes);

  // Loja virtual PÚBLICA (vitrine sem login). Registrada ANTES do catch-all
  // autenticado para que /api/public/* nunca exija JWT.
  app.use("/api/public", storefrontPublicRoutes);

  // Portal de assinatura PUBLICO (contato acessa via token HMAC).
  app.use("/api/public/subscription", subscriptionPublicRoutes);

  // Radar de Execução IA — diagnóstico rápido PÚBLICO (landing sem login,
  // Fase 2/ADR-012). Mesmo motivo de registro cedo: nunca deve exigir JWT.
  app.use("/api/public/radar", radarPublicRoutes);
  app.use("/api/public/clinic", clinicPublicRoutes);

  // LISTA DE PLANOS é PÚBLICA: a tela de cadastro/"começar grátis" precisa
  // carregar os planos SEM login. Registrada antes do protectedApi (senão a
  // página de signup recebe 401 e fica travada em "Carregando planos…").
  // Só o GET da lista é público; /plans/current e /plans/select seguem
  // protegidos no protectedApi abaixo.
  app.get("/api/plans", (_req, res): any => {
    try { res.json(PlanService.listPlans()); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Conector AGNÓSTICO de PMS/OTA/ERP — autenticado por TOKEN (não JWT). Fica
  // antes do catch-all autenticado para sistemas externos empurrarem dados.
  app.use("/api/connector-in", connectorPublicRoutes);

  // Continuity Layer (ADR-082, Fase 4a) — SYNC do Edge, autenticado por API key
  // de MÁQUINA (X-Edge-Device/X-Edge-Key), não por JWT. Montado aqui, FORA do
  // protectedApi (como os webhooks), para o requireAuth não interceptar. Só
  // define /pull|/push|/heartbeat; /api/edge/devices (provisionamento) cai no
  // protectedApi abaixo.
  app.use("/api/edge", edgeSyncRoutes);

  // Apply Auth Middleware to all subsequent protected API routes
  const protectedApi = express.Router();
  protectedApi.use(requireAuth);
  protectedApi.use(requireOrganizationAccess);

  // Atribui o consumo de IA das chamadas desta requisição à empresa do usuário.
  protectedApi.use((req: any, _res, next) => { setUsageOrg(req.organizationId || null); next(); });

  // GATING DE MÓDULOS: bloqueia rotas de módulos opcionais que a organização
  // não tem habilitados (deriva o módulo do 1º segmento do path). Rotas core/
  // infra não estão no mapa e seguem sempre. enabled_modules NULL = tudo ligado.
  protectedApi.use((req: any, res, next) => {
    const seg = (req.path || "").split("/")[1];
    const mod = ModuleService.MODULE_BY_ROUTE[seg];
    if (!mod) return next();
    if (!req.organizationId || ModuleService.isEnabled(req.organizationId, mod)) return next();
    return res.status(403).json({ error: "module_disabled", module: mod });
  });

  // ENFORCEMENT RBAC (ADR-095 Bloco 5): depois do gate de módulo da org, aplica
  // o nível de acesso do PERFIL do usuário por módulo (rota→módulo→ação). Opt-in:
  // só afeta usuários com perfil atribuído; o parque legado passa intacto.
  protectedApi.use(enforceModulePermission);

  // ZappFlow Vision Cloud: processo separado do core (docs/adr/ADR-001, adendo
  // "Vision Cloud como terceiro serviço"). NÃO é um router local — é um proxy
  // para http://127.0.0.1:VISION_CLOUD_PORT. O gate de módulo acima já resolveu
  // `vision -> "vms"`; o Authorization: Bearer original segue para o processo
  // vision-cloud, que revalida o mesmo JWT de forma independente (defesa em
  // profundidade — este processo não "confia cegamente" no hop do proxy).
  // `fixRequestBody` é obrigatório aqui: `express.json()" já rodou (mais acima
  // neste arquivo) e consumiu o stream original do corpo da requisição antes
  // do proxy conseguir repassá-lo — sem isso, todo POST/PATCH para
  // /api/vision/* trava (o vision-cloud fica esperando um corpo que nunca
  // chega até o fim, e o cliente recebe 504 depois do timeout do proxy).
  // Descoberto e corrigido durante teste real em browser desta funcionalidade
  // (não só em testes de API) — ver http-proxy-middleware README, seção
  // "Intercept and manipulate requests", e o issue #40 do projeto.
  const visionCloudTarget = `http://127.0.0.1:${process.env.VISION_CLOUD_PORT || 3101}`;
  protectedApi.use("/vision", createProxyMiddleware({ target: visionCloudTarget, changeOrigin: true, on: { proxyReq: fixRequestBody } }));

  protectedApi.use("/channels", channelsRoutes);
  protectedApi.use("/messages", messagesRoutes);
  protectedApi.use("/tickets", ticketsRoutes);
  protectedApi.use("/products", productsRoutes);
  protectedApi.use("/orders", ordersRoutes);
  protectedApi.use("/contacts", contactsRoutes);
  protectedApi.use("/campaigns", campaignsRoutes);
  protectedApi.use("/payments", paymentsRoutes);
  protectedApi.use("/appointments", appointmentsRoutes);
  protectedApi.use("/integrations", integrationsRoutes);
  protectedApi.use("/import", importRoutes);
  protectedApi.use("/meta-debug", metaDebugRoutes);
  protectedApi.use("/manifesto", manifestoRoutes);
  protectedApi.use("/opportunities", opportunityRadarRoutes);
  protectedApi.use("/frustrations", frustrationsRoutes);
  protectedApi.use("/recovery", recoveryRoutes);
  protectedApi.use("/big-idea", bigIdeaRoutes);
  protectedApi.use("/recognition", recognitionRoutes);
  protectedApi.use("/philosophy", philosophyAuditRoutes);
  protectedApi.use("/integrations", instagramOAuthRoutes);
  protectedApi.use("/analytics", analyticsRoutes);
  protectedApi.use("/studio", studioRoutes);
  protectedApi.use("/tasks", taskRoutes);
  protectedApi.use("/prospect", prospectRoutes);
  protectedApi.use("/radar-b2b", radarB2BRoutes);
  protectedApi.use("/clinic", clinicRoutes);
  protectedApi.use("/retailops", retailOpsRoutes);
  protectedApi.use("/comigo", comigoRoutes);
  protectedApi.use("/continuity", continuityRoutes);
  // Provisionamento de nós Edge (ADR-082, Fase 4a) — só owner/admin da própria
  // org emitem/revogam credenciais de máquina. O SYNC em si é machine-authed
  // (montado acima em /api/edge, fora do protectedApi).
  protectedApi.use("/edge/devices", requireRole("owner", "admin"), edgeDeviceRoutes);
  protectedApi.use("/admin", requireMasterAdmin, adminRoutes);
  protectedApi.use("/audit", requireMasterAdmin, auditRoutes);
  protectedApi.use("/radar-consultant", requireMasterAdmin, radarConsultantRoutes);
  protectedApi.use("/notifications", notificationsRoutes);
  protectedApi.use("/users", usersRoutes);
  protectedApi.use("/permissions", permissionsRoutes);
  protectedApi.use("/rag", ragRoutes);
  protectedApi.use("/managers", managersRoutes);
  protectedApi.use("/areas", areasRoutes);
  protectedApi.use("/ai", aiRoutes);
  protectedApi.use("/cadences", cadencesRoutes);
  protectedApi.use("/procurement", procurementRoutes);
  protectedApi.use("/quotes", quotesRoutes);
  protectedApi.use("/events", eventsRoutes);
  protectedApi.use("/quickstart", quickstartRoutes);
  protectedApi.use("/connector", connectorRoutes);
  protectedApi.use("/mfa", mfaRoutes);
  protectedApi.use("/lgpd", lgpdRoutes);
  protectedApi.use("/executive", executiveRoutes);
  protectedApi.use("/plans", plansRoutes);
  protectedApi.use("/storefront", storefrontRoutes);
  protectedApi.use("/reservations", reservationsRoutes);
  protectedApi.use("/subscriptions", subscriptionsRoutes);
  protectedApi.use("/uploads", uploadsRoutes);
  protectedApi.use("/radar", radarRoutes);

  // Rotas de webhook (/api/webhooks/*) são chamadas por serviços EXTERNOS
  // (Evolution, Meta) que NÃO enviam JWT. Elas são registradas abaixo, em `app`.
  // Aqui garantimos que o requireAuth do protectedApi NÃO intercepte esses
  // caminhos públicos — caso contrário o webhook recebe 401 e a mensagem nunca
  // chega ao Kanban.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith('/webhooks')) {
      return next(); // segue para os handlers públicos de webhook abaixo
    }
    // Callbacks OAuth (Instagram/Google): o provedor redireciona o navegador
    // para cá SEM o nosso JWT — precisam ficar fora do middleware autenticado.
    if (req.path === '/integrations/instagram/callback' || req.path === '/integrations/google/callback') {
      return next();
    }
    return protectedApi(req, res, next);
  });

  // Callback público do OAuth do Instagram (troca code -> token e salva o canal).
  app.get("/api/integrations/instagram/callback", instagramCallback);

  // Callback público do OAuth do Google (troca code -> tokens com acesso offline).
  app.get("/api/integrations/google/callback", async (req, res) => {
    const base = (process.env.APP_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.headers.host}`;
    const orgId = await GoogleOAuthService.handleCallback(String(req.query.code || ''), String(req.query.state || ''));
    res.redirect(`${base}/?google=${orgId ? 'conectado' : 'erro'}`);
  });

  // --- META WEBHOOK (WhatsApp & Instagram) ---
  
  // --- EVOLUTION API Backend ---
  let evolutionConfig = {
    baseUrl: process.env.EVOLUTION_BASE_URL || '',
    apiKey: process.env.EVOLUTION_API_KEY || '',
    instanceName: process.env.EVOLUTION_INSTANCE_NAME || ''
  };

  app.post("/api/evolution/config", (req, res) => {
    // Only update instanceName if provided, keep URL/API Key from ENV if not in body
    const { instanceName } = req.body;
    evolutionConfig = {
      ...evolutionConfig,
      instanceName: instanceName || evolutionConfig.instanceName
    };
    console.log("[Evolution API] Configuração salva: ", evolutionConfig.instanceName);
    res.json({ success: true, message: 'Configuração salva na sessão atual.' });
  });

  app.post("/api/evolution/instance/connect", async (req, res) => {
    try {
      const { instanceName } = req.body;
      const finalBaseUrl = (evolutionConfig.baseUrl || process.env.EVOLUTION_BASE_URL || '').replace(/\/$/, '');
      const finalApiKey = (evolutionConfig.apiKey || process.env.EVOLUTION_API_KEY || '');
      const finalInstance = instanceName || evolutionConfig.instanceName || process.env.EVOLUTION_INSTANCE_NAME || process.env.EVOLUTION_INSTANCE || '';

      if (!finalBaseUrl || !finalApiKey || !finalInstance) {
        return res.status(400).json({ error: "Faltam parâmetros de conexão (URL, API Key ou Instance Name)." });
      }

      console.log(`[Evolution DEBUG] Final BaseURL: ${finalBaseUrl}, Final Instance: ${finalInstance}, Final APIKey (len): ${finalApiKey.length}`);

      let token = finalApiKey;
      let hasInstance = false;
      let instanceToken = '';
      
      // 1. Tentar pegar a lista de instâncias
      try {
        const fetchAll = await fetch(`${finalBaseUrl}/instance/all`, { headers: { apikey: finalApiKey } });
        if (fetchAll.ok) {
           const data = await fetchAll.json();
           const inst = data.data?.find((i: any) => (i.name === finalInstance || i.instanceName === finalInstance));
           if (inst) {
                console.log("[Evolution] Instância existente encontrada (token:", (inst.token ? String(inst.token).slice(0, 5) + "…" : "—") + ")");
                hasInstance = true;
                instanceToken = inst.token || inst.apikey;
           }
        }
      } catch (err) {}

      // 2. Se não existe, Tentar Criar (Evolution Go ou Evolution API)
      if (!hasInstance) {
        try {
          const createPayload = { 
             instanceName: finalInstance, name: finalInstance, qrcode: true, 
             webhook: `${process.env.APP_URL || 'http://localhost:3000'}/api/webhooks/evolution`, events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"] 
          };
          
          let createResp = await fetch(`${finalBaseUrl}/instance/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': finalApiKey },
            body: JSON.stringify(createPayload) 
          });
          
          if (!createResp.ok && createResp.status === 400) { // Evolution Go strict mode?
             createResp = await fetch(`${finalBaseUrl}/instance/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': finalApiKey },
                body: JSON.stringify({ name: finalInstance })
             });
          }
          
          if (createResp.ok) {
             const data = await createResp.json();
             instanceToken = data.data?.token || data.instance?.token || data.hash?.apikey;
             
             if (data.qrcode?.base64) {
                 return res.json({ base64: data.qrcode.base64 }); // Retorno imeditado EvoAPI
             }
          }
        } catch(err) {
           console.log("[Evolution] Falha ao criar:", err);
        }
      }

      const activeToken = instanceToken || finalApiKey;

      // 3. Conectar e Configurar Webhook no ato (Evolution Go pattern)
      try {
        await fetch(`${finalBaseUrl}/instance/connect`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', 'apikey': activeToken, 'instance': finalInstance },
           body: JSON.stringify({ 
              webhookUrl: `${process.env.APP_URL || 'http://localhost:3000'}/api/webhooks/evolution`,
              subscribe: ["messages", "connection"]
           })
        });
      } catch(err) {}

      // 4. Se for Evolution API v1/v2, configure webhook (legacy)
      try {
        await fetch(`${finalBaseUrl}/webhook/set/${finalInstance}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': activeToken },
          body: JSON.stringify({ 
             webhook: {
               url: `${process.env.APP_URL || 'http://localhost:3000'}/api/webhooks/evolution`,
               byEvents: false,
               base64: false,
               events: [ "MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE" ]
             }
          })
        });
      } catch (err) {}

      // 5. Pegar o QR Code
      let base64qr = '';
      try {
         // Evolution Go pattern
         console.log(`[Evolution] FINAL BASE URL: ${finalBaseUrl}`);
         const qrUrl = `${finalBaseUrl}/api/v1/instance/qr`;
         console.log(`[Evolution] Tentando pegar QR em: ${qrUrl}, Token: ${activeToken?.substring(0, 5)}...`);
         
         const qrResp = await fetch(qrUrl, {
            headers: { 'apikey': activeToken, 'instance': finalInstance }
         });
         
         if (!qrResp.ok) {
            console.error(`[Evolution] Erro ao buscar QR (URL: ${qrUrl}, Status: ${qrResp.status}):`, await qrResp.text());
         } else {
             const contentType = qrResp.headers.get("content-type");
             if (contentType && contentType.includes("application/json")) {
                 const qrData = await qrResp.json();
                 console.log("[Evolution] Resposta QR Code:", JSON.stringify(qrData).substring(0, 200));
                 if (qrData.base64) base64qr = qrData.base64;
                 else if (qrData.data?.Qrcode) base64qr = qrData.data.Qrcode;
                 else if (qrData.qrcode?.base64) base64qr = qrData.qrcode.base64;
             } else {
                 console.error("[Evolution] Resposta do QR não é JSON:", await qrResp.text());
             }
         }
      } catch(err) {
         console.error("[Evolution] Erro ao buscar QR:", err);
      }

      if (!base64qr) {
         // Evolution API pattern
         try {
             console.log(`[Evolution] FINAL BASE URL LEGACY: ${finalBaseUrl}`);
             console.log(`[Evolution] Tentando conectar via legacy endpoint para: ${finalInstance}`);
             const connectResp = await fetch(`${finalBaseUrl}/instance/connect/${finalInstance}`, {
                headers: { 'apikey': finalApiKey }
             });
             
             if (!connectResp.ok) {
                console.error(`[Evolution] Erro na conexão legacy (Status: ${connectResp.status}):`, await connectResp.text());
             } else {
                 const contentType = connectResp.headers.get("content-type");
                 if (contentType && contentType.includes("application/json")) {
                     const connData = await connectResp.json();
                     console.log("[Evolution] Resposta Conexão Legacy:", JSON.stringify(connData).substring(0, 200));
                     if (connData.base64) base64qr = connData.base64;
                     else if (connData.qrcode?.base64) base64qr = connData.qrcode.base64;
                     else if ((connData.instance?.state === 'open' || connData.state === 'open') && !connData.base64) {
                         return res.json({ state: 'open' }); // Já conectado
                     }
                 } else {
                     console.error("[Evolution] Resposta de conexão legacy não é JSON:", await connectResp.text());
                 }
             }
         } catch(e){
             console.error("[Evolution] Erro na conexão legacy:", e);
         }
      }

      if (base64qr) {
         console.log(`[Evolution] QR Code Gerado (length: ${base64qr.length}):`, base64qr.substring(0, 50) + "...");
         const finalQr = base64qr.startsWith('data:image') ? base64qr : `data:image/png;base64,${base64qr}`;
         return res.json({ base64: finalQr, token: activeToken });
      }

      // Se já estava conectado
      if (hasInstance || activeToken) {
         try {
           const orgId = req.headers['x-organization-id'] || 'default_org';
           const existing = db.prepare('SELECT id FROM channels WHERE organization_id = ? AND provider = ? AND identifier = ?').get(orgId, 'evolution', finalInstance);
           if (!existing) {
             db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
               uuidv4(), orgId, 'evolution', 'Evolution API', finalInstance, 'connected', activeToken, JSON.stringify({ baseUrl: finalBaseUrl })
             );
           }
         } catch(e) {}
      }

      return res.status(400).json({ error: "Instância pode já estar conectada ou hove um erro na geração do QR Code. Verifique seu painel ou recarregue a página." });
    } catch (e: any) {
      console.error("[Evolution] Erro ao conectar instância:", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // Aceita ambas as URLs (Evolution API e Evolution GO) e a variante
  // "Webhook by Events", que anexa o nome do evento ao caminho.
  app.post([
    "/api/webhooks/evolution",
    "/api/webhooks/evolutiongo",
    "/api/webhooks/evolution/:event",
    "/api/webhooks/evolutiongo/:event",
  ], async (req, res) => {
    try {
      // Autenticidade + anti-abuso/custo (W1/M3)
      const okSecret = verifyWebhookSecret(req, res);
      recordWebhookHit(okSecret, okSecret ? 'recebido' : 'segredo_incorreto');
      if (!okSecret) return;
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown');
      if (!rateLimit(`wh:${ip}`, 120, 60 * 1000)) {
        return res.status(429).json({ error: "Too many webhook requests" });
      }
      const payload = req.body;
      const rawEvent = payload.event ?? req.params.event;
      console.log(`[Evolution Webhook] Recebido Evento: ${rawEvent} (path: ${req.path})`);

      const normalizedEvent = String(rawEvent ?? "").toLowerCase().replace(/[_-]/g, ".");
      if (normalizedEvent === "messages.upsert" || normalizedEvent === "message") {
        // O Evolution GO (whatsmeow) usa data.Info/data.Message (Pascal);
        // o Evolution API usa data.key/data.message (camel). Suportamos os dois.
        const data = Array.isArray(payload.data) ? payload.data[0] : (payload.data || {});
        const info = data.Info || data.info || data.key || {};
        const msgObj = data.Message || data.message || {};

        // Log de diagnóstico do formato real (ajuda a depurar payloads novos).
        console.log("[Evolution Webhook] data(trunc):", JSON.stringify(data).slice(0, 900));

        let incomingMessageText = extractEvolutionText(msgObj);
        // Mensagem de áudio (PTT/voz): o Evolution GO já envia o base64 no webhook.
        if (!incomingMessageText && (msgObj.audioMessage || msgObj.AudioMessage || msgObj.pttMessage)) {
          const audioB64 = msgObj.base64 || data.base64 || "";
          if (audioB64) {
            try {
              const buffer = Buffer.from(audioB64, 'base64');
              incomingMessageText = await transcribeAudio(buffer, 'audio.ogg', 'audio/ogg');
              console.log(`[Audio] Transcrição: ${incomingMessageText.slice(0, 80)}`);
            } catch (e) {
              console.error("[Audio] Falha ao transcrever (base64 inline):", e);
            }
          } else {
            // Fallback: tenta baixar da API (formatos antigos)
            incomingMessageText = await transcribeEvolutionAudio(payload, evolutionConfig);
          }
        }

        // URL da mídia (imagem) para renderizar no chat.
        let incomingMediaUrl: string | undefined = undefined;
        // Base64 original da foto — repassado ao orquestrador para o cadastro
        // de estoque por WhatsApp (WhatsAppInventoryIntake.ts); só é USADO se
        // o remetente for um gestor autorizado (checado dentro do orquestrador).
        let capturedImageBase64: string | undefined = undefined;
        let capturedImageMime: string | undefined = undefined;

        // Outras mídias sem legenda: registra um placeholder para aparecer no app.
        if (!incomingMessageText) {
          if (msgObj.imageMessage || msgObj.ImageMessage) {
            const imgB64 = msgObj.base64 || data.base64 || "";
            const caption = msgObj.imageMessage?.caption || msgObj.ImageMessage?.caption || "";
            if (imgB64) {
              // Salva a imagem para exibir a miniatura no chat.
              const mime = msgObj.imageMessage?.mimetype || msgObj.ImageMessage?.mimetype || "image/jpeg";
              const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
              incomingMediaUrl = saveMediaBase64(imgB64, ext) || undefined;
              capturedImageBase64 = imgB64;
              capturedImageMime = mime;
              // Visão/OCR: classifica (documento vs foto) e extrai os dados-chave.
              try {
                const desc = await analyzeImageForChat(imgB64, mime);
                console.log(`[Vision] Imagem analisada: ${desc.slice(0, 80)}`);
                incomingMessageText = caption ? `[Imagem recebida] ${caption}\n${desc}` : `[Imagem recebida]\n${desc}`;
              } catch (e) {
                console.error("[Vision] Falha ao analisar imagem:", e);
                incomingMessageText = caption || "📷 [Imagem recebida]";
              }
            } else {
              incomingMessageText = caption ? `📷 [Imagem] ${caption}` : "📷 [Imagem recebida]";
            }
          }
          else if (msgObj.videoMessage || msgObj.VideoMessage) incomingMessageText = "🎥 [Vídeo recebido]";
          else if (msgObj.documentMessage || msgObj.DocumentMessage) {
            // Documento anexado: se for imagem (foto de comprovante/nota/receita
            // enviada como "arquivo"), a IA também lê via visão. PDF/outros: pede a foto.
            const docMsg = msgObj.documentMessage || msgObj.DocumentMessage || {};
            const docMime = docMsg.mimetype || "";
            const docB64 = msgObj.base64 || data.base64 || "";
            const docCaption = docMsg.caption || "";
            if (docB64 && docMime.startsWith("image/")) {
              try {
                const desc = await analyzeImageForChat(docB64, docMime);
                incomingMessageText = docCaption ? `[Imagem recebida] ${docCaption}\n${desc}` : `[Imagem recebida]\n${desc}`;
              } catch (e) {
                console.error("[Vision] Falha ao analisar documento-imagem:", e);
                incomingMessageText = docCaption || "📄 [Documento recebido]";
              }
            } else if (docB64 && docMime === "application/pdf") {
              // PDF: extrai o texto e classifica (comprovante/nota/recibo/receita…).
              try {
                const desc = await analyzePdfForChat(Buffer.from(docB64, 'base64'));
                incomingMessageText = docCaption ? `[Documento recebido] ${docCaption}\n${desc}` : `[Documento recebido]\n${desc}`;
              } catch (e) {
                console.error("[PDF] Falha ao analisar PDF:", e);
                incomingMessageText = docCaption || "📄 [Documento PDF recebido]";
              }
            } else {
              // Demais formatos (docx, xls, etc.): ainda não lemos automaticamente.
              incomingMessageText = `[Documento recebido${docCaption ? `: ${docCaption}` : ""}] O cliente enviou um arquivo (${docMime || 'documento'}). Se precisar que você leia o conteúdo, peça com simpatia para ele enviar como FOTO/imagem ou PDF.`;
            }
          }
          else if (msgObj.stickerMessage || msgObj.StickerMessage) incomingMessageText = "🔖 [Figurinha]";
          else if (msgObj.locationMessage || msgObj.LocationMessage) incomingMessageText = "📍 [Localização]";
          else if (msgObj.contactMessage || msgObj.ContactMessage) incomingMessageText = "👤 [Contato]";
        }

        const rawJid = info.Sender || info.sender || info.Chat || info.chat || info.RemoteJid || data.key?.remoteJid || "";
        const senderId = String(rawJid).split('@')[0].split(':')[0]; // remove sufixo de device (:NN)
        const fromMe = info.IsFromMe ?? info.fromMe ?? data.key?.fromMe ?? false;
        const pushName = info.PushName || info.pushName || data.pushName || undefined;
        const businessId = payload.instance || evolutionConfig.instanceName || 'evolution_api';

        if (fromMe) { console.log("[Evolution Webhook] Ignorado: fromMe."); return res.status(200).send("OK"); }
        if (!senderId) { console.warn("[Evolution Webhook] Ignorado: sem remetente. info=", JSON.stringify(info).slice(0, 300)); return res.status(200).send("OK"); }
        if (!incomingMessageText) { console.warn("[Evolution Webhook] Ignorado: sem texto. chaves de Message=", Object.keys(msgObj).join(',')); return res.status(200).send("OK"); }

        console.log(`[Evolution Webhook] Mensagem de ${senderId} (${pushName || 's/ nome'}): ${incomingMessageText}`);

        // Foto de perfil: não buscamos de forma síncrona aqui (o endpoint de
        // avatar pode travar e atrasar o atendimento). Processamos a mensagem
        // primeiro e depois disparamos a busca da foto best-effort, com timeout
        // e sem bloquear o webhook (ver maybeFetchEvolutionAvatar).
        await dispatchIncomingMessage({
           channelId: null, // mapped by identifier
           organizationId: null,
           identifier: businessId,
           provider: 'evolution',
           senderId: senderId,
           contactName: pushName,
           contactAvatar: undefined,
           text: incomingMessageText,
           mediaUrl: incomingMediaUrl,
           imageBase64: capturedImageBase64,
           imageMime: capturedImageMime,
        }, (global as any).io);

        // Foto de perfil do WhatsApp em segundo plano: atualiza o card de
        // atendimento ao vivo assim que obtida, sem bloquear o atendimento.
        maybeFetchEvolutionAvatar({
          businessId,
          senderId,
          config: evolutionConfig,
          io: (global as any).io,
        });
        
      } else if (normalizedEvent === "connection.update") {
        console.log(`[Evolution Webhook] Status da conexão: ${payload.data?.state || payload.data?.status}`);
        if ((payload.data?.state === 'open' || payload.data?.status === 'open') && (global as any).io) {
           (global as any).io.emit("wa_web_status", { status: 'connected_evo' });
           // Save to DB
           try {
              const busId = payload.instance || evolutionConfig.instanceName;
              if (busId) {
                const orgId = 'default_org';
                const existing = db.prepare('SELECT id FROM channels WHERE organization_id = ? AND provider = ? AND identifier = ?').get(orgId, 'evolution', busId);
                if (!existing) {
                  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, ?, ?, ?, ?)`).run(
                    uuidv4(), orgId, 'evolution', 'Evolution API', busId, 'connected'
                  );
                } else {
                  db.prepare(`UPDATE channels SET status = 'connected' WHERE id = ?`).run((existing as any).id);
                }
              }
           } catch(e) {}
        }
      }

      res.status(200).send("EVENT_RECEIVED");
    } catch (e) {
      console.error("[Evolution Webhook] Erro", e);
      res.sendStatus(500);
    }
  });

  // VERIFICAÇÃO DO WEBHOOK (GET)
  const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  
  app.get("/api/webhooks/meta", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    // Registra o hit ANTES de qualquer decisão — o console de diagnóstico
    // precisa mostrar até tentativa rejeitada (para o lojista ver a Meta batendo).
    const hitId = MetaWebhookLogService.record({
      method: "GET",
      sourceIp: (req.ip || req.socket?.remoteAddress || "").toString(),
      userAgent: req.get("user-agent") || null,
      object: "verify",
      payload: { mode, token: token ? "<presente>" : "<vazio>", challenge: challenge ? "<presente>" : "<vazio>" },
      headers: req.headers,
    });

    if (!META_VERIFY_TOKEN) {
      console.warn("[Webhook] META_VERIFY_TOKEN não configurado; verificação rejeitada.");
      if (hitId) MetaWebhookLogService.markFailed(hitId, "META_VERIFY_TOKEN não configurado no servidor");
      return res.sendStatus(403);
    }

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log("[Webhook] Verificado com sucesso pela Meta.");
      if (hitId) MetaWebhookLogService.markProcessed(hitId);
      res.status(200).send(challenge);
    } else {
      if (hitId) MetaWebhookLogService.markFailed(hitId, `verify_token não bate (mode=${mode})`);
      res.sendStatus(403);
    }
  });

  // WEBHOOK DE PAGAMENTO (gateway externo) — público, autenticado pelo segredo
  // da organização (?secret=... ou header x-pay-secret). Marca o pedido como pago.
  // Genérico: aceita { orderId, status, externalId } ou o formato do Mercado Pago.
  app.post(["/api/webhooks/payment", "/api/webhooks/payment/:event"], async (req, res) => {
    try {
      const secret = (req.query.secret as string) || (req.headers['x-pay-secret'] as string) || '';
      const orgId = PaymentService.orgByWebhookSecret(secret);
      if (!orgId) return res.status(401).json({ error: "Unauthorized payment webhook" });

      const body = req.body || {};
      const q = req.query || {} as any;

      // FORMATO MERCADO PAGO: a notificação traz apenas o id do pagamento
      // (type/topic = 'payment'). NÃO confiar no payload — consultar a API do MP
      // para verificar se está APROVADO e descobrir o pedido (external_reference).
      const topic = String(body.type || body.topic || q.type || q.topic || '').toLowerCase();
      const mpPaymentId = (body.data && body.data.id) || q['data.id'] || (topic === 'payment' ? q.id : undefined);
      if (topic.includes('payment') && mpPaymentId) {
        const status = await PaymentService.syncMercadoPagoPayment(orgId, String(mpPaymentId));
        if (status === 'approved' && (global as any).io) {
          (global as any).io.to(`org:${orgId}`).emit("order_updated", { status: 'pago', payment_status: 'paid' });
        }
        console.log(`[PayWebhook] Mercado Pago pagamento ${mpPaymentId} -> status '${status}' (org ${orgId}).`);
        return res.status(200).send("OK");
      }

      // FORMATO PAGAR.ME (Stone, ADR-100): evento order.paid/charge.paid. Casa
      // pela `code`/metadata que gravamos ao criar o Link de Pagamento.
      const stoneType = String(body.type || '').toLowerCase();
      if (/^(order|charge)\./.test(stoneType)) {
        const status = await PaymentService.syncStonePayment(orgId, body);
        if (status === 'paid' && (global as any).io) {
          (global as any).io.to(`org:${orgId}`).emit("order_updated", { status: 'pago', payment_status: 'paid' });
        }
        console.log(`[PayWebhook] Pagar.me (Stone) evento '${stoneType}' -> '${status}' (org ${orgId}).`);
        return res.status(200).send("OK");
      }

      // FORMATO GENÉRICO (gateway 'custom' que posta no nosso formato):
      let orderId: string | undefined = body.orderId || body.order_id;
      let paid = body.status ? ['paid', 'approved', 'pago', 'completed'].includes(String(body.status).toLowerCase()) : true;
      let externalId: string | undefined = body.externalId || body.payment_id || body.id;

      if (!orderId && body.data && body.data.external_reference) {
        orderId = body.data.external_reference;
        externalId = body.data.id || externalId;
      }

      if (!orderId) {
        console.warn("[PayWebhook] Sem orderId/external_reference no payload.");
        return res.status(200).send("IGNORED");
      }
      if (paid) {
        const ok = PaymentService.markPaid(orgId, orderId, { method: 'gateway', externalId });
        if (ok && (global as any).io) {
          (global as any).io.to(`org:${orgId}`).emit("order_updated", { orderId, status: 'pago', payment_status: 'paid' });
        }
        console.log(`[PayWebhook] Pedido ${orderId} marcado como pago (org ${orgId}).`);
      }
      return res.status(200).send("OK");
    } catch (e) {
      console.error("[PayWebhook] erro", e);
      return res.status(200).send("OK"); // não devolve 500 para o gateway não reentregar em loop
    }
  });

  // WEBHOOK PIX DINÂMICO DO COMIGO (ADR-118): o PSP confirma o Pix por txid e o
  // pedido do Balcão/Mesa libera sozinho. Autentica pelo segredo da org; concilia
  // por txid; idempotente. Sempre 200 (menos unauthorized) p/ não travar o PSP.
  app.post("/api/webhooks/comigo-pix", async (req, res) => {
    try {
      const secret = (req.query.secret as string) || (req.headers['x-pay-secret'] as string) || '';
      const r = ComigoPixService.handleWebhook(secret, req.body || {});
      if (r.status === "unauthorized") return res.status(401).send("unauthorized");
      if (r.status === "ok" && r.orgId && (global as any).io) {
        (global as any).io.to(`org:${r.orgId}`).emit("comigo_pix_paid", req.body || {});
      }
      return res.status(200).send("OK");
    } catch (e) {
      console.error("[ComigoPixWebhook] erro", e);
      return res.status(200).send("OK");
    }
  });

  // WEBHOOK ASAAS (ADR-091 Bloco B): cobrança ZappFlow → lojista. Autentica pelo
  // header asaas-access-token, deduplica por id do evento, re-consulta o pagamento
  // e transiciona o billing_status. SEMPRE 200 (menos unauthorized) pra não travar
  // a fila de eventos do ASAAS.
  app.post("/api/webhooks/asaas", async (req, res) => {
    try {
      const r = await AsaasService.handleWebhook(req.headers as any, req.body || {});
      if (r.status === "unauthorized") return res.status(401).send("unauthorized");
      if (r.status === "ok" && r.billing && r.billing !== "unchanged" && r.orgId && (global as any).io) {
        (global as any).io.to(`org:${r.orgId}`).emit("billing_updated", { billingStatus: r.billing });
      }
      console.log(`[AsaasWebhook] evento '${req.body?.event}' -> ${r.status}${r.billing ? ` (billing '${r.billing}')` : ""}`);
      return res.status(200).send("OK");
    } catch (e) {
      console.error("[AsaasWebhook] erro", e);
      return res.status(200).send("OK");
    }
  });

  // RECEBIMENTO DE EVENTOS (POST)
  app.post("/api/webhooks/meta", async (req, res) => {
    // Registra o hit ANTES de qualquer validação/parse — o console de
    // diagnóstico precisa mostrar até payload malformado ou de objeto errado
    // (que a gente hoje devolve 404 e some). Sem isso, um webhook rejeitado
    // silenciosamente parece que a Meta "não mandou" — histórico do bug do
    // Instagram DM confirma esse blind spot.
    const hitId = MetaWebhookLogService.record({
      method: "POST",
      sourceIp: (req.ip || req.socket?.remoteAddress || "").toString(),
      userAgent: req.get("user-agent") || null,
      object: req.body?.object || null,
      payload: req.body,
      headers: req.headers,
    });

    try {
      // A Meta NÃO envia o nosso ?secret= (ela usa X-Hub-Signature). A autenticidade
      // da assinatura do webhook já foi feita no handshake GET (META_VERIFY_TOKEN);
      // aqui validamos o formato do payload. Por isso NÃO aplicamos verifyWebhookSecret.
      const payload = req.body;

      // Validação rápida do formato padrão do Graph API
      if (payload.object !== "whatsapp_business_account" && payload.object !== "instagram" && payload.object !== "page") {
         if (hitId) MetaWebhookLogService.markFailed(hitId, `payload.object desconhecido: ${payload.object}`);
         return res.sendStatus(404);
      }

      console.log(`[Webhook] Evento recebido - Source: ${payload.object}`);

      // 1. Tratamento do Payload (Diferenciar WhatsApp vs Instagram)
      let provider: 'whatsapp_cloud' | 'instagram' = 'whatsapp_cloud';
      let incomingMessageText = '';
      let senderId = '';
      let businessId = '';
      let contactName: string | undefined = undefined;

      if (payload.object === "whatsapp_business_account") {
        provider = 'whatsapp_cloud';
        const entry = payload.entry?.[0];
        businessId = entry?.id;
        const changes = entry?.changes?.[0]?.value;
        const message = changes?.messages?.[0];
        const contactData = changes?.contacts?.[0];

        if (contactData && contactData.profile && contactData.profile.name) {
            contactName = contactData.profile.name;
        }

        if (message) {
          senderId = message.from; // Número do cliente
          incomingMessageText = message.text?.body || '';
        }

        // Recibos de ENTREGA (ADR-082): o WhatsApp Cloud manda `value.statuses[]`
        // (wamid + status sent/delivered/read/failed) em payloads SEM `messages`.
        // Correlacionamos pela fila de entrega (Fase 3, pelo wamid guardado no
        // envio) e promovemos sent→delivered (✓✓ no painel). Best-effort.
        const statuses = changes?.statuses;
        if (Array.isArray(statuses) && statuses.length) {
          try {
            const phoneNumberId = changes?.metadata?.phone_number_id;
            const ch = phoneNumberId
              ? db.prepare(`SELECT organization_id FROM channels WHERE identifier = ? AND provider = 'whatsapp_cloud'`).get(String(phoneNumberId)) as any
              : null;
            if (ch?.organization_id) {
              for (const st of statuses) {
                if (st?.id && st?.status) MessageDeliveryService.markProviderStatus(ch.organization_id, String(st.id), String(st.status));
              }
            }
          } catch (e) { console.error("[Webhook] Falha ao processar statuses do WhatsApp", e); }
        }
      } else if (payload.object === "instagram" || payload.object === "page") {
        provider = 'instagram';
        const entry = payload.entry?.[0];
        businessId = entry?.id; // ID da conta IG/Página associada
        // Diagnóstico: estrutura real do evento do Instagram.
        console.log("[IG Webhook] entry:", JSON.stringify(entry).slice(0, 800));

        // Formato Messenger/IG: entry[].messaging[]  (DMs)
        const messaging = entry?.messaging?.[0] || entry?.standby?.[0];
        if (messaging) {
          // A conta que RECEBE é a nossa (entry.id). O remetente é messaging.sender.id.
          const recipientId = messaging.recipient?.id;
          const fromSelf = messaging.sender?.id && recipientId && messaging.sender.id === entry?.id;
          // Texto pode vir em message.text (nova) ou message_edit.text (editada).
          const msgObj = messaging.message || messaging.message_edit;

          if (messaging.message?.is_echo || fromSelf) {
            console.log("[IG Webhook] Ignorado: echo/mensagem da própria conta.");
          } else if (messaging.read || messaging.reaction || messaging.delivery || messaging.postback) {
            console.log("[IG Webhook] Ignorado: recibo/leitura/reação.");
          } else {
            senderId = messaging.sender?.id || '';
            incomingMessageText = msgObj?.text || '';
            // Anexo sem texto (figurinha/imagem): coloca um placeholder.
            if (!incomingMessageText && msgObj?.attachments?.length) {
              incomingMessageText = "📎 [Anexo recebido pelo Instagram]";
            }
            if (!incomingMessageText) {
              console.log("[IG Webhook] Evento sem texto reconhecido (tipo):", Object.keys(messaging).join(','));
            }
          }
        } else if (entry?.changes?.[0]?.value?.from) {
          // Formato alternativo via changes (alguns eventos de comentário/mensagem).
          const v = entry.changes[0].value;
          senderId = v.from?.id || v.sender?.id || '';
          incomingMessageText = v.text || v.message || '';
        }
      }

      // Se processou a mensagem com sucesso
      if (incomingMessageText && senderId) {
        console.log(`[${provider.toUpperCase()}] Mensagem de ${senderId}: ${incomingMessageText}`);
        
        await dispatchIncomingMessage({
           channelId: null, // mapped by identifier
           organizationId: null,
           identifier: businessId,
           provider: provider,
           senderId: senderId,
           contactName: contactName,
           text: incomingMessageText
        }, (global as any).io);
      }
      
      // Importante sempre retornar 200 OK para a Meta
      if (hitId) MetaWebhookLogService.markProcessed(hitId);
      res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
       console.error("[Webhook] Erro Processando", error);
       if (hitId) MetaWebhookLogService.markFailed(hitId, String((error as any)?.message || error));
       res.sendStatus(500);
    }
  });

  // O upload de RAG agora é autenticado e escopado por organização em
  // src/server/routes/rag.ts (POST /api/rag/upload), montado em protectedApi.

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));

    // ===== SEO: sitemap.xml + robots.txt =====
    app.get('/sitemap.xml', (_req, res) => {
      try {
        const base = (process.env.APP_URL || '').replace(/\/$/, '');
        if (!base) return res.status(404).end();
        const stores = db.prepare(`SELECT slug FROM storefront_settings WHERE published = 1`).all() as any[];
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
        for (const s of stores) {
          const storeUrl = `${base}/loja/${encodeURIComponent(s.slug)}`;
          xml += `  <url><loc>${storeUrl}</loc><changefreq>weekly</changefreq></url>\n`;
          const orgId = (db.prepare(`SELECT organization_id FROM storefront_settings WHERE slug = ?`).get(s.slug) as any)?.organization_id;
          if (!orgId) continue;
          const products = db.prepare(
            `SELECT slug FROM products_services WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible,1) = 1 AND slug IS NOT NULL`
          ).all(orgId) as any[];
          for (const p of products) {
            xml += `  <url><loc>${storeUrl}/produto/${encodeURIComponent(p.slug)}</loc><changefreq>weekly</changefreq></url>\n`;
          }
        }
        xml += `</urlset>`;
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send(xml);
      } catch { res.status(500).end(); }
    });

    app.get('/robots.txt', (_req, res) => {
      const base = (process.env.APP_URL || '').replace(/\/$/, '');
      let txt = `User-agent: *\nAllow: /loja/\nDisallow: /api/\nDisallow: /admin\n`;
      if (base) txt += `\nSitemap: ${base}/sitemap.xml\n`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(txt);
    });

    // SEO: store listing meta tags (/loja/:slug — sem produto)
    app.get('/loja/:slug', (req, res, next) => {
      try {
        const store = db.prepare(
          `SELECT organization_id, title, subtitle, slug FROM storefront_settings WHERE slug = ? AND published = 1`
        ).get(req.params.slug) as any;
        if (!store) return next();
        const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const title = store.title || 'Loja';
        const desc = String(store.subtitle || '').slice(0, 160) || `Conheça os produtos de ${title}.`;
        const base = (process.env.APP_URL || '').replace(/\/$/, '');
        const pageUrl = base ? `${base}/loja/${encodeURIComponent(store.slug)}` : '';
        const logo = db.prepare(`SELECT logo_url FROM organization_settings WHERE organization_id = ?`).get(store.organization_id) as any;
        const imgUrl = logo?.logo_url ? (logo.logo_url.startsWith('http') ? logo.logo_url : (base ? `${base}${logo.logo_url}` : '')) : '';

        let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
        const meta =
          `<title>${esc(title)}</title>` +
          `<meta name="description" content="${esc(desc)}">` +
          `<meta property="og:type" content="website">` +
          `<meta property="og:title" content="${esc(title)}">` +
          `<meta property="og:description" content="${esc(desc)}">` +
          (pageUrl ? `<meta property="og:url" content="${esc(pageUrl)}">` : '') +
          (pageUrl ? `<link rel="canonical" href="${esc(pageUrl)}">` : '') +
          (imgUrl ? `<meta property="og:image" content="${esc(imgUrl)}">` : '');
        html = html.replace(/<title>.*?<\/title>/s, meta);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch { next(); }
    });

    // SEO por produto (ADR-028): meta tags + JSON-LD schema.org
    app.get('/loja/:slug/produto/:productSlug', (req, res, next) => {
      try {
        const store = db.prepare(
          `SELECT organization_id, title, slug FROM storefront_settings WHERE slug = ? AND published = 1`
        ).get(req.params.slug) as any;
        if (!store) return next();
        const product = db.prepare(
          `SELECT id, name, description, price, currency FROM products_services
           WHERE organization_id = ? AND slug = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1`
        ).get(store.organization_id, req.params.productSlug) as any;
        if (!product) return next();
        const images = db.prepare(
          `SELECT url FROM product_images WHERE product_service_id = ? ORDER BY position ASC, created_at ASC`
        ).all(product.id) as any[];

        const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const escJson = (s: string) => JSON.stringify(String(s || '')).slice(1, -1);
        const title = `${product.name} — ${store.title || 'Loja'}`;
        const desc = String(product.description || '').slice(0, 160) || `Compre ${product.name} na ${store.title || 'nossa loja'}.`;
        const base = (process.env.APP_URL || '').replace(/\/$/, '');
        const pageUrl = base ? `${base}/loja/${encodeURIComponent(store.slug)}/produto/${encodeURIComponent(req.params.productSlug)}` : '';
        const resolveImg = (url: string) => url.startsWith('http') ? url : (base ? `${base}${url}` : '');
        const imgUrl = images[0]?.url ? resolveImg(images[0].url) : '';

        const jsonLd: any = {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: product.name,
          description: product.description || desc,
          ...(imgUrl ? { image: images.map((i: any) => resolveImg(i.url)).filter(Boolean) } : {}),
          ...(pageUrl ? { url: pageUrl } : {}),
          offers: {
            '@type': 'Offer',
            price: Number(product.price || 0).toFixed(2),
            priceCurrency: product.currency || 'BRL',
            availability: 'https://schema.org/InStock',
          },
        };

        let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
        const meta =
          `<title>${esc(title)}</title>` +
          `<meta name="description" content="${esc(desc)}">` +
          (pageUrl ? `<link rel="canonical" href="${esc(pageUrl)}">` : '') +
          `<meta property="og:type" content="product">` +
          `<meta property="og:title" content="${esc(title)}">` +
          `<meta property="og:description" content="${esc(desc)}">` +
          (pageUrl ? `<meta property="og:url" content="${esc(pageUrl)}">` : '') +
          (imgUrl ? `<meta property="og:image" content="${esc(imgUrl)}">` : '') +
          `<meta name="twitter:card" content="summary_large_image">` +
          `<meta name="twitter:title" content="${esc(title)}">` +
          `<meta name="twitter:description" content="${esc(desc)}">` +
          (imgUrl ? `<meta name="twitter:image" content="${esc(imgUrl)}">` : '') +
          `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
        html = html.replace(/<title>.*?<\/title>/s, meta);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (e) {
        next();
      }
    });

    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // ATENÇÃO se algum dia adicionar `process.on('SIGTERM', ...)` aqui: em
  // produção este processo roda como filho do supervisor em
  // scripts/supervisor.ts (ver docs/adr/ADR-008-process-supervisor.md), que
  // hoje assume que o core morre IMEDIATAMENTE ao receber SIGTERM (sem
  // handler, comportamento default do Node) — o supervisor só espera pelo
  // evento "exit" para considerar o shutdown completo. Um handler de
  // graceful shutdown aqui (ex.: fechar conexões HTTP em voo) é seguro de
  // adicionar, mas MUDA quanto tempo o core demora para sair; revise o
  // orçamento de tempo do supervisor (comentários em scripts/supervisor.ts,
  // janela de ~10s do Docker/Coolify) se isso passar de poucos segundos.
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Diagnóstico de sessão (Provador Virtual): confirma de ONDE vem o segredo
    // de JWT e QUANTAS instâncias/bancos existem. Se aparecerem DUAS linhas
    // [BOOT] com instanceId diferentes, há múltiplas réplicas com bancos SQLite
    // separados — causa de "Sessão inválida" (login numa, /me na outra).
    try {
      const jwtSource = (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) ? "env" : "arquivo/efêmero";
      const dbFile = path.join(process.env.DATA_DIR || process.cwd(), "zappflow.db");
      let customers = -1;
      try { customers = (db.prepare("SELECT COUNT(*) AS c FROM storefront_customers").get() as any)?.c ?? -1; } catch { /* tabela pode não existir */ }
      const instanceId = Math.random().toString(36).slice(2, 8);
      console.log(`[BOOT] instanceId=${instanceId} jwtSource=${jwtSource} db=${dbFile} storefront_customers=${customers}`);
    } catch (e) { /* diagnóstico nunca quebra o boot */ }
  });

  // CORS travado para a origem do app (em prod). "*" só em dev.
  const socketOrigin = process.env.NODE_ENV === 'production'
    ? (process.env.CORS_ORIGIN || process.env.APP_URL || true)
    : "*";
  const io = new SocketIOServer(httpServer, {
    cors: { origin: socketOrigin as any, credentials: true }
  });

  // Autenticação do socket: exige um JWT válido no handshake. Anexa o org do
  // token ao socket; o cliente NÃO escolhe em qual organização entra.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || (socket.handshake.query?.token as string)
        || (socket.handshake.headers?.authorization as string || '').split(' ')[1];
      if (!token) {
        console.warn(`[Socket] Conexão sem token recusada (${socket.id}).`);
        return next(new Error("unauthorized"));
      }
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      (socket as any).organizationId = decoded.organizationId;
      (socket as any).userId = decoded.userId;
      return next();
    } catch (e) {
      console.warn(`[Socket] Token inválido recusado (${socket.id}). Faça login novamente.`);
      return next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const orgId = (socket as any).organizationId;
    console.log(`[Socket] Conectado ${socket.id} (org: ${orgId})`);

    // O usuário só pode entrar na sala da PRÓPRIA organização (do token),
    // ignorando qualquer organizationId enviado pelo cliente.
    socket.on("join_org", () => {
       if (orgId) {
          socket.join(`org:${orgId}`);
          console.log(`[Socket] ${socket.id} entrou em org:${orgId}`);
       }
    });

    socket.on("join_ticket", (data: { ticketId: string }) => {
       // Só permite ouvir um ticket que pertença à organização do token.
       if (data?.ticketId && orgId) {
          const t = db.prepare('SELECT id FROM tickets WHERE id = ? AND organization_id = ?').get(data.ticketId, orgId);
          if (t) socket.join(`ticket:${data.ticketId}`);
       }
    });
  });

  // Torna o io acessível globalmente (para uso no webhook)
  (global as any).io = io;

  // Backfill: torna explícitos os módulos de orgs que estavam sem config (evita
  // o antigo padrão "mostra tudo"). Idempotente — roda barato a cada boot.
  try { ModuleService.backfillNullModules(); } catch (e) { console.error('[Modules] Falha no backfill', e); }
  // RBAC granular (ADR-095): garante os 6 perfis de sistema em cada org. Idempotente.
  try { PermissionService.backfillSystemProfiles(); } catch (e) { console.error('[RBAC] Falha no backfill de perfis', e); }
  // Cifra segredos em repouso (token do gateway de pagamento, tokens Google) que
  // ainda estejam em texto. Idempotente — pula o que já está cifrado.
  try { EncryptionService.backfillExistingSecrets(); } catch (e) { console.error('[Encryption] Falha no backfill', e); }

  // Agendador interno (reativação automática semanal, opt-in por organização).
  Scheduler.start(io);
  // Notificações in-app em tempo real (emite via Socket.io).
  NotificationService.setIo(io);
  // Continuity Layer (ADR-082, Fase 3): fila de entrega ao provedor. Self-gate —
  // só liga o dispatcher com CONTINUITY_DELIVERY_QUEUE_ENABLED. Recupera sozinho
  // as entregas 'queued' pendentes de um reinício ao voltar.
  try { MessageDeliveryService.start(); } catch (e) { console.error('[MsgDelivery] Falha ao iniciar', e); }
  // Continuity Layer (ADR-082, Fase 4c): processa os comandos empurrados pelos
  // nós Edge (client_commands 'received') e fecha o loop com um domain_event.
  // Self-gate na mesma flag do sync do Edge (CONTINUITY_EDGE_SYNC_ENABLED).
  try { registerBuiltinEdgeCommandHandlers(); EdgeInboxProcessor.start(); } catch (e) { console.error('[EdgeInbox] Falha ao iniciar', e); }

}

startServer();
