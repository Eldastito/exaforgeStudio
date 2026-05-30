import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { Server as SocketIOServer } from "socket.io";

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
import managersRoutes from "./src/server/routes/managers.js";
import aiRoutes from "./src/server/routes/ai.js";
import ordersRoutes from "./src/server/routes/orders.js";
import { requireAuth, requireOrganizationAccess, requireMasterAdmin } from "./src/server/middleware/auth.js";
import { processIncomingMessage } from "./src/server/webhookProcessor.js";
import db from "./src/server/db.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { transcribeAudio, describeImage } from "./src/server/llm.js";
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

  // --- Verificação de autenticidade do webhook (C3/W1) ---
  // Se WEBHOOK_SECRET estiver definido, exige que o provedor inclua o segredo
  // (header x-webhook-secret OU query ?secret=). Sem a env, apenas avisa — assim
  // o deploy ao vivo não quebra antes de você configurar a Evolution.
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
  let warnedNoWebhookSecret = false;
  const verifyWebhookSecret = (req: express.Request, res: express.Response): boolean => {
    if (!WEBHOOK_SECRET) {
      if (!warnedNoWebhookSecret) {
        console.warn("[SECURITY] WEBHOOK_SECRET não configurado: o webhook está aberto. Defina a env e adicione ?secret=... na URL do webhook na Evolution.");
        warnedNoWebhookSecret = true;
      }
      return true;
    }
    // Aceita o segredo via header (x-webhook-secret) OU query (?secret=).
    // Caso "Webhook by Events" da Evolution: ela anexa /EVENTO ao fim da URL,
    // o que pode corromper o valor do query (ex.: secret=ABC/MESSAGES_UPSERT).
    // Por isso, normalizamos pegando só o trecho antes de uma eventual barra.
    const rawProvided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string) || '';
    const provided = String(rawProvided).split('/')[0].trim();
    // Comparação em tempo constante para evitar timing attacks.
    const a = Buffer.from(provided);
    const b = Buffer.from(WEBHOOK_SECRET);
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
  protectedApi.use("/orders", ordersRoutes);
  protectedApi.use("/appointments", appointmentsRoutes);
  protectedApi.use("/integrations", integrationsRoutes);
  protectedApi.use("/analytics", analyticsRoutes);
  protectedApi.use("/admin", requireMasterAdmin, adminRoutes);
  protectedApi.use("/audit", requireMasterAdmin, auditRoutes);
  protectedApi.use("/notifications", notificationsRoutes);
  protectedApi.use("/users", usersRoutes);
  protectedApi.use("/rag", ragRoutes);
  protectedApi.use("/managers", managersRoutes);
  protectedApi.use("/ai", aiRoutes);

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
      // Autenticidade + anti-abuso/custo (W1/M3)
      if (!verifyWebhookSecret(req, res)) return;
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
              // Visão/OCR: a IA entende o conteúdo da imagem.
              try {
                const desc = await describeImage(imgB64, mime);
                console.log(`[Vision] Imagem analisada: ${desc.slice(0, 80)}`);
                incomingMessageText = caption ? `${caption}\n\n[Conteúdo da imagem: ${desc}]` : `[Imagem] ${desc}`;
              } catch (e) {
                console.error("[Vision] Falha ao analisar imagem:", e);
                incomingMessageText = caption || "📷 [Imagem recebida]";
              }
            } else {
              incomingMessageText = caption ? `📷 [Imagem] ${caption}` : "📷 [Imagem recebida]";
            }
          }
          else if (msgObj.videoMessage || msgObj.VideoMessage) incomingMessageText = "🎥 [Vídeo recebido]";
          else if (msgObj.documentMessage || msgObj.DocumentMessage) incomingMessageText = "📄 [Documento recebido]";
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

        // Foto de perfil: o endpoint /user/avatar do Evolution GO trava (504 após 60s),
        // então não buscamos (evita latência). O card usa o avatar padrão/inicial.
        let contactAvatar = undefined;

        await processIncomingMessage({
           channelId: null, // mapped by identifier 
           organizationId: null,
           identifier: businessId,
           provider: 'evolution',
           senderId: senderId,
           contactName: pushName,
           contactAvatar: contactAvatar,
           text: incomingMessageText,
           mediaUrl: incomingMediaUrl
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
  const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  
  app.get("/api/webhooks/meta", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!META_VERIFY_TOKEN) {
      console.warn("[Webhook] META_VERIFY_TOKEN não configurado; verificação rejeitada.");
      return res.sendStatus(403);
    }

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
      if (!verifyWebhookSecret(req, res)) return;
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
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
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

}

startServer();
