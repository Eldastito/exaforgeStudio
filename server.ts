import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { Server as SocketIOServer } from "socket.io";

import multer from "multer";
import { processDocument, generateRagResponse } from "./src/server/geminiRAG.js";
import channelsRoutes from "./src/server/routes/channels.js";
import messagesRoutes from "./src/server/routes/messages.js";
import ticketsRoutes from "./src/server/routes/tickets.js";
import productsRoutes from "./src/server/routes/products.js";
import appointmentsRoutes from "./src/server/routes/appointments.js";
import integrationsRoutes from "./src/server/routes/integrations.js";
import analyticsRoutes from "./src/server/routes/analytics.js";
import adminRoutes from "./src/server/routes/admin.js";
import notificationsRoutes from "./src/server/routes/notifications.js";
import authRoutes from "./src/server/routes/auth.js";
import usersRoutes from "./src/server/routes/users.js";
import auditRoutes from "./src/server/routes/audit.js";
import ragRoutes from "./src/server/routes/rag.js";
import { requireAuth, requireOrganizationAccess, requireMasterAdmin } from "./src/server/middleware/auth.js";
import { processIncomingMessage } from "./src/server/webhookProcessor.js";
import db from "./src/server/db.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

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
  app.use((req, res, next) => {
    const origin = process.env.NODE_ENV === 'production' 
       ? (process.env.CORS_ORIGIN || 'https://' + req.headers.host) 
       : '*';
    if (origin !== '*') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,x-organization-id');
      if (req.method === 'OPTIONS') {
         return res.status(200).end();
      }
    }
    next();
  });

  // --- RATE LIMTING (Simple Mock/Memory for prototype) ---
  const rateLimitMap = new Map<string, { count: number, resetTime: number }>();
  app.use((req, res, next) => {
     // Apply rate limiting in production or if enabled
     if (process.env.ENABLE_RATE_LIMIT === 'true' || process.env.NODE_ENV === 'production') {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const limitConfig = { max: 100, windowMs: 15 * 60 * 1000 }; 
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
  const ensureMasterAdmin = async () => {
    const email = 'eldastito@gmail.com';
    const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!existingAdmin) {
       const saltRounds = 10;
       const passwordHash = await bcrypt.hash('Alice2020@', saltRounds);
       const userId = uuidv4();
       db.prepare(`
         INSERT INTO users (id, organization_id, name, email, password_hash, role)
         VALUES (?, 'default_org', 'Eldas Tito', ?, ?, 'owner')
       `).run(userId, email, passwordHash);
       console.log('Master admin created: ' + email);
    }
  };
  await ensureMasterAdmin();

  // Middleware for parsing JSON with limit blocker
  app.use(express.json({ limit: '2mb' }));

  // Financial Block Middleware (for API routes)
  app.use("/api", (req, res, next) => {
    // Allow these paths regardless of block status
    if (req.path.startsWith('/admin') || req.path.startsWith('/analytics/settings') || req.path.startsWith('/notifications')) {
      return next();
    }
    const orgId = req.headers['x-organization-id'] || 'default_org';
    try {
      const org: any = db.prepare('SELECT status, billing_status FROM organization_settings WHERE organization_id = ?').get(orgId);
      // If it's blocked, block POST/PUT/DELETE
      if (org && (org.status === 'blocked' || org.billing_status === 'blocked')) {
          const method = req.method;
          if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
             return res.status(403).json({ error: "CONTA BLOQUEADA. Entre em contato com o suporte." });
          }
      }
    } catch(e) {}
    next();
  });

  app.use("/api/auth", authRoutes);

  // Apply Auth Middleware to all subsequent protected API routes
  const protectedApi = express.Router();
  protectedApi.use(requireAuth);
  protectedApi.use(requireOrganizationAccess);
  
  protectedApi.use("/channels", channelsRoutes);
  protectedApi.use("/messages", messagesRoutes);
  protectedApi.use("/tickets", ticketsRoutes);
  protectedApi.use("/products", productsRoutes);
  protectedApi.use("/appointments", appointmentsRoutes);
  protectedApi.use("/integrations", integrationsRoutes);
  protectedApi.use("/analytics", analyticsRoutes);
  protectedApi.use("/admin", requireMasterAdmin, adminRoutes);
  protectedApi.use("/audit", requireMasterAdmin, auditRoutes);
  protectedApi.use("/notifications", notificationsRoutes);
  protectedApi.use("/users", usersRoutes);
  protectedApi.use("/rag", ragRoutes);

  // Rotas de webhook (/api/webhooks/*) são chamadas por serviços EXTERNOS
  // (Evolution, Meta) que NÃO enviam JWT. Elas são registradas abaixo, em `app`.
  // Aqui garantimos que o requireAuth do protectedApi NÃO intercepte esses
  // caminhos públicos — caso contrário o webhook recebe 401 e a mensagem nunca
  // chega ao Kanban.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith('/webhooks')) {
      return next(); // segue para os handlers públicos de webhook abaixo
    }
    return protectedApi(req, res, next);
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
                console.log("[Evolution] Instância existente encontrada com token:", inst.token);
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
      const payload = req.body;
      const rawEvent = payload.event ?? req.params.event;
      console.log(`[Evolution Webhook] Recebido Evento: ${rawEvent} (path: ${req.path})`);

      const normalizedEvent = String(rawEvent ?? "").toLowerCase().replace(/[_-]/g, ".");
      if (normalizedEvent === "messages.upsert" || normalizedEvent === "message") {
        const messageData = payload.data?.message;
        if (!messageData) return res.status(200).send("OK");

        let incomingMessageText = messageData.conversation || messageData.extendedTextMessage?.text || "";
        const senderId = payload.data?.key?.remoteJid?.split('@')[0];
        const fromMe = payload.data?.key?.fromMe;
        const pushName = payload.data?.pushName;
        const businessId = payload.instance || evolutionConfig.instanceName || 'evolution_api';

        if (fromMe || !incomingMessageText || !senderId) return res.status(200).send("OK");

        let contactAvatar = undefined;
        // Tentar buscar imagem de perfil da Evolution API
        if (evolutionConfig.baseUrl && evolutionConfig.apiKey) {
           try {
              const picEndpoint = `${evolutionConfig.baseUrl.replace(/\/$/, '')}/chat/fetchProfilePictureUrl/${businessId}`;
              const picResp = await fetch(picEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': evolutionConfig.apiKey, 'instance': businessId },
                body: JSON.stringify({ number: senderId })
              });
              if (picResp.ok) {
                 const picData = await picResp.json();
                 if (picData && picData.picture) {
                    contactAvatar = picData.picture;
                 }
              }
           } catch(e) {}
        }

        await processIncomingMessage({
           channelId: null, // mapped by identifier 
           organizationId: null,
           identifier: businessId,
           provider: 'evolution',
           senderId: senderId,
           contactName: pushName,
           contactAvatar: contactAvatar,
           text: incomingMessageText
        }, (global as any).io);
        
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
  const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "meu_token_secreto_123";
  
  app.get("/api/webhooks/meta", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log("[Webhook] Verificado com sucesso pela Meta.");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  // RECEBIMENTO DE EVENTOS (POST)
  app.post("/api/webhooks/meta", async (req, res) => {
    try {
      const payload = req.body;
      
      // Validação rápida do formato padrão do Graph API
      if (payload.object !== "whatsapp_business_account" && payload.object !== "instagram" && payload.object !== "page") {
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
      } else if (payload.object === "instagram" || payload.object === "page") {
        provider = 'instagram';
        const entry = payload.entry?.[0];
        businessId = entry?.id; // Page ID associado
        const messaging = entry?.messaging?.[0];
        
        if (messaging) {
          senderId = messaging.sender?.id;
          incomingMessageText = messaging.message?.text || '';
        }
      }

      // Se processou a mensagem com sucesso
      if (incomingMessageText && senderId) {
        console.log(`[${provider.toUpperCase()}] Mensagem de ${senderId}: ${incomingMessageText}`);
        
        await processIncomingMessage({
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
      res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
       console.error("[Webhook] Erro Processando", error);
       res.sendStatus(500);
    }
  });

  // --- ENDPOINT UPLOAD RAG ---
  app.post("/api/rag/upload", upload.single("document"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }
      const channelId = req.body.channelId || 'global';
      const result = await processDocument(req.file.buffer, req.file.originalname, channelId);
      res.json({ message: "Documento vetorizado com sucesso", ...result });
    } catch (error) {
      console.error("[RAG Upload]", error);
      res.status(500).json({ error: "Erro ao vetorizar documento" });
    }
  });

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
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    
    socket.on("join_org", (data: { organizationId: string }) => {
       if (data.organizationId) {
          socket.join(`org:${data.organizationId}`);
          console.log(`Socket ${socket.id} joined org ${data.organizationId}`);
       }
    });

    socket.on("join_ticket", (data: { ticketId: string }) => {
       if (data.ticketId) {
          socket.join(`ticket:${data.ticketId}`);
       }
    });
  });

  // Torna o io acessível globalmente (para uso no webhook)
  (global as any).io = io;

}

startServer();
