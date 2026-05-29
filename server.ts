import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { Server as SocketIOServer } from "socket.io";

import multer from "multer";
import { processDocument, generateRagResponse } from "./src/server/geminiRAG.js";
import { suggestResponse, summarizeConversation } from "./src/lib/gemini.js";

// Tipos de arquivo de texto suportados pelo pipeline RAG (extração UTF-8).
const ALLOWED_DOC_EXTENSIONS = [".txt", ".csv", ".md"];
const MAX_DOC_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_DOC_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Tipo de arquivo não suportado. Envie .txt, .csv ou .md."));
    }
  },
});

// Avisa (sem derrubar o processo) quando variáveis de ambiente importantes faltam.
function warnMissingEnv() {
  const optional = ["GEMINI_API_KEY", "EVOLUTION_API_KEY", "META_VERIFY_TOKEN"];
  for (const name of optional) {
    if (!process.env[name]) {
      console.warn(`[ENV] Aviso: ${name} não configurada. Funcionalidades relacionadas ficarão limitadas.`);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  warnMissingEnv();

  // Middleware for parsing JSON
  app.use(express.json());

  // --- META WEBHOOK (WhatsApp & Instagram) ---
  
  // --- EVOLUTION API Backend ---
  let evolutionConfig = {
    baseUrl: process.env.EVOLUTION_BASE_URL || '',
    apiKey: process.env.EVOLUTION_API_KEY || '',
    instanceName: process.env.EVOLUTION_INSTANCE_NAME || ''
  };

  app.post("/api/evolution/config", (req, res) => {
    evolutionConfig = req.body;
    console.log("[Evolution API] Configuração salva: ", evolutionConfig.baseUrl, evolutionConfig.instanceName);
    res.json({ success: true, message: 'Configuração salva na sessão atual.' });
  });

  app.post("/api/webhooks/evolution", async (req, res) => {
    try {
      const payload = req.body;
      console.log(`[Evolution Webhook] Recebido Evento: ${payload.event}`);

      if (payload.event === "messages.upsert") {
        const messageData = payload.data?.message;
        if (!messageData) return res.status(200).send("OK");

        let incomingMessageText = messageData.conversation || messageData.extendedTextMessage?.text || "";
        const senderId = payload.data?.key?.remoteJid?.split('@')[0];
        const fromMe = payload.data?.key?.fromMe;
        const pushName = payload.data?.pushName;
        const businessId = evolutionConfig.instanceName || 'evolution_api';

        if (fromMe || !incomingMessageText || !senderId) return res.status(200).send("OK");

        const provider = 'whatsapp';
        console.log(`[EVOLUTION WA] Mensagem de ${senderId}: ${incomingMessageText}`);

        let contactAvatar = undefined;

        // Tentar buscar imagem de perfil da Evolution API
        if (evolutionConfig.baseUrl && evolutionConfig.apiKey) {
           try {
              const picEndpoint = `${evolutionConfig.baseUrl.replace(/\/$/, '')}/chat/fetchProfilePictureUrl/${evolutionConfig.instanceName}`;
              const picResp = await fetch(picEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': evolutionConfig.apiKey },
                body: JSON.stringify({ number: senderId })
              });
              if (picResp.ok) {
                 const picData = await picResp.json();
                 if (picData && picData.picture) {
                    contactAvatar = picData.picture;
                 }
              }
           } catch(e) {
              console.log("[Evolution] Não foi possível buscar avatar do contato.");
           }
        }

        // Emite a mensagem do usuário para o frontend via WebSocket
        if ((global as any).io) {
          (global as any).io.emit("new_message", {
            contactId: senderId,
            contactName: pushName,
            contactAvatar: contactAvatar,
            provider,
            text: incomingMessageText,
            sender: "contact",
            timestamp: new Date().toISOString()
          });
        }

        // --- INTEGRAÇÃO RAG (Motor de IA) ---
        try {
          const iaResponse = await generateRagResponse(incomingMessageText, businessId);
          console.log(`[IA RAG] Resposta Gerada: ${iaResponse.text} | Estágio: ${iaResponse.newStage}`);

          if ((global as any).io) {
            (global as any).io.emit("new_message", {
              contactId: senderId,
              provider,
              text: iaResponse.text,
              sender: "bot",
              timestamp: new Date().toISOString()
            });

            if (iaResponse.newStage) {
              (global as any).io.emit("ticket_stage_change", {
                contactId: senderId,
                newStage: iaResponse.newStage
              });
            }
          }

          // Disparar resposta para Evolution API
          if (evolutionConfig.baseUrl && evolutionConfig.apiKey) {
            const sendData = {
               number: senderId,
               options: { delay: 1200, presence: "composing" },
               textMessage: { text: iaResponse.text }
            };
            const endpoint = `${evolutionConfig.baseUrl.replace(/\/$/, '')}/message/sendText/${evolutionConfig.instanceName}`;
            
            await fetch(endpoint, {
               method: 'POST',
               headers: {
                 'Content-Type': 'application/json',
                 'apikey': evolutionConfig.apiKey
               },
               body: JSON.stringify(sendData)
            });
            console.log(`[EVOLUTION API] Mensagem enviada para ${senderId}`);
          } else {
            console.warn(`[EVOLUTION API] Aviso: Dados da Evolution não configurados no backend, pulando envio real.`);
          }

        } catch (e) {
          console.error("[IA RAG] Falha ao processar RAG no webhook Evolution", e);
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
      const payload = req.body;
      
      // Validação rápida do formato padrão do Graph API
      if (payload.object !== "whatsapp_business_account" && payload.object !== "instagram" && payload.object !== "page") {
         return res.sendStatus(404);
      }

      console.log(`[Webhook] Evento recebido - Source: ${payload.object}`);

      // 1. Tratamento do Payload (Diferenciar WhatsApp vs Instagram)
      let provider: 'whatsapp' | 'instagram' = 'whatsapp';
      let incomingMessageText = '';
      let senderId = '';
      let businessId = '';
      let contactName: string | undefined = undefined;

      if (payload.object === "whatsapp_business_account") {
        provider = 'whatsapp';
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
        
        // No insta o profile precisa ser buscado na GraphAPI separadamente pelo senderId (não há contactData nativo no webhook de texto)

        if (messaging) {
          senderId = messaging.sender?.id;
          incomingMessageText = messaging.message?.text || '';
        }
      }

      // Se processou a mensagem com sucesso
      if (incomingMessageText && senderId) {
        console.log(`[${provider.toUpperCase()}] Mensagem de ${senderId}: ${incomingMessageText}`);
        
        // Emite a mensagem do usuário para o frontend via WebSocket
        if ((global as any).io) {
          (global as any).io.emit("new_message", {
            contactId: senderId,
            contactName,
            provider,
            text: incomingMessageText,
            sender: "contact",
            timestamp: new Date().toISOString()
          });
        }

        // --- 2. INTEGRAÇÃO RAG (Motor de IA) ---
        try {
          const iaResponse = await generateRagResponse(incomingMessageText, businessId);
          console.log(`[IA RAG] Resposta Gerada: ${iaResponse.text} | Estágio: ${iaResponse.newStage}`);

          // Emite a resposta da IA para o frontend via WebSocket
          if ((global as any).io) {
            (global as any).io.emit("new_message", {
              contactId: senderId,
              provider,
              text: iaResponse.text,
              sender: "bot",
              timestamp: new Date().toISOString()
            });

            if (iaResponse.newStage) {
              (global as any).io.emit("ticket_stage_change", {
                contactId: senderId,
                newStage: iaResponse.newStage
              });
            }
          }

          // --- 3. DISPARO DE RESPOSTA (Simulação Meta Graph API) ---
          // Aqui faria requisição POST para a Graph API apropriada
          // Ex (WhatsApp): POST /v19.0/${businessId}/messages ...
          // Ex (Insta): POST /v19.0/${businessId}/messages ...
        } catch (e) {
          console.error("[IA RAG] Falha ao processar RAG no webhook", e);
        }
      }
      
      // Importante sempre retornar 200 OK para a Meta
      res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
       console.error("[Webhook] Erro Processando", error);
       res.sendStatus(500);
    }
  });

  // --- ENDPOINT UPLOAD RAG ---
  app.post("/api/rag/upload", (req, res) => {
    upload.single("document")(req, res, async (uploadErr) => {
      if (uploadErr) {
        // Erros de limite de tamanho ou tipo de arquivo (fileFilter)
        return res.status(400).json({ error: (uploadErr as Error).message });
      }
      try {
        if (!req.file) {
          return res.status(400).json({ error: "Nenhum arquivo enviado" });
        }
        // Sanitiza o channelId para evitar valores inesperados como chave de metadados.
        const rawChannelId = typeof req.body.channelId === "string" ? req.body.channelId : "global";
        const channelId = rawChannelId.replace(/[^a-zA-Z0-9_-]/g, "") || "global";
        const result = await processDocument(req.file.buffer, req.file.originalname, channelId);
        res.json({ message: "Documento vetorizado com sucesso", ...result });
      } catch (error) {
        console.error("[RAG Upload]", error);
        res.status(500).json({ error: "Erro ao vetorizar documento" });
      }
    });
  });

  // --- ENDPOINTS DE IA (mantém a GEMINI_API_KEY no backend) ---
  app.post("/api/ai/suggest", async (req, res) => {
    try {
      const { contact, history } = req.body || {};
      if (!contact || !Array.isArray(history)) {
        return res.status(400).json({ error: "Payload inválido: contact e history são obrigatórios." });
      }
      const text = await suggestResponse(contact, history);
      res.json({ text });
    } catch (error) {
      console.error("[AI Suggest]", error);
      res.status(500).json({ error: "Erro ao gerar sugestão" });
    }
  });

  app.post("/api/ai/summarize", async (req, res) => {
    try {
      const { history } = req.body || {};
      if (!Array.isArray(history)) {
        return res.status(400).json({ error: "Payload inválido: history é obrigatório." });
      }
      const text = await summarizeConversation(history);
      res.json({ text });
    } catch (error) {
      console.error("[AI Summarize]", error);
      res.status(500).json({ error: "Erro ao resumir conversa" });
    }
  });

  // --- WA WEB ENDPOINTS ---
  app.get("/api/wa-web/status", async (req, res) => {
     try {
        const { getWhatsAppWebStatus } = await import("./src/server/whatsappWebClient.js");
        res.json(getWhatsAppWebStatus());
     } catch (e) {
        res.status(500).json({ error: (e as Error).message });
     }
  });

  app.post("/api/wa-web/connect", async (req, res) => {
     try {
        const { initializeWhatsAppWeb } = await import("./src/server/whatsappWebClient.js");
        initializeWhatsAppWeb((global as any).io);
        res.json({ success: true, message: 'Iniciando conexão...' });
     } catch (e) {
        res.status(500).json({ error: (e as Error).message });
     }
  });

  app.post("/api/wa-web/disconnect", async (req, res) => {
     try {
        const { disconnectWhatsAppWeb } = await import("./src/server/whatsappWebClient.js");
        disconnectWhatsAppWeb();
        res.json({ success: true, message: 'Desconectado.' });
     } catch (e) {
        res.status(500).json({ error: (e as Error).message });
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

  // Restringe origens permitidas para o WebSocket. Configure ALLOWED_ORIGINS
  // (separado por vírgula) em produção; em dev usa localhost por padrão.
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : ["http://localhost:3000", "http://127.0.0.1:3000"];

  const io = new SocketIOServer(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
  });

  // Torna o io acessível globalmente (para uso no webhook)
  (global as any).io = io;

}

startServer();
