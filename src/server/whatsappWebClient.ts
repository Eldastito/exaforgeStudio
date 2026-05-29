import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { generateRagResponse } from './geminiRAG.js';

let client: Client | null = null;
let ioInstance: any = null;
let currentQrUrl: string | null = null;
let clientStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

export function getWhatsAppWebStatus() {
  return {
    status: clientStatus,
    qrUrl: currentQrUrl,
  };
}

export function initializeWhatsAppWeb(io: any) {
  if (client) {
    console.log('[WA Web] Client already exists.');
    return;
  }

  ioInstance = io;
  clientStatus = 'connecting';
  currentQrUrl = null;

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
       args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qrText) => {
    console.log('[WA Web] QR Code recebido, envie para o frontend');
    clientStatus = 'connecting';
    try {
      currentQrUrl = await qrcode.toDataURL(qrText);
      if (ioInstance) {
        ioInstance.emit('wa_web_qr', { qrUrl: currentQrUrl });
      }
    } catch (e) {
      console.error('[WA Web] Erro ao gerar QR Code', e);
    }
  });

  client.on('ready', () => {
    console.log('[WA Web] Pronto!');
    clientStatus = 'connected';
    currentQrUrl = null;
    if (ioInstance) {
      ioInstance.emit('wa_web_status', { status: 'connected' });
    }
  });

  client.on('authenticated', () => {
    console.log('[WA Web] Autenticado com sucesso!');
  });

  client.on('auth_failure', (msg) => {
    console.error('[WA Web] Falha na autenticação', msg);
    clientStatus = 'disconnected';
    currentQrUrl = null;
    if (ioInstance) {
      ioInstance.emit('wa_web_status', { status: 'disconnected' });
    }
  });

  client.on('disconnected', (reason) => {
    console.log('[WA Web] Cliente desconectado', reason);
    clientStatus = 'disconnected';
    currentQrUrl = null;
    client = null;
    if (ioInstance) {
      ioInstance.emit('wa_web_status', { status: 'disconnected' });
    }
  });

  client.on('message', async (msg) => {
    try {
      if (msg.from === 'status@broadcast') return; // Ignore status broadcasts

      // Só reage a mensagens de texto ou outras compatíveis se necessário
      if (!msg.body) return;

      const senderId = msg.from;
      const provider = 'whatsapp';
      const incomingMessageText = msg.body;

      console.log(`[WA Web] Mensagem de ${senderId}: ${incomingMessageText}`);

      // Emite mensagem para o frontend UX
      if (ioInstance) {
        ioInstance.emit("new_message", {
          contactId: senderId,
          provider,
          text: incomingMessageText,
          sender: "contact",
          timestamp: new Date().toISOString()
        });
      }

      // Usa o chatbot (RAG) para gerar resposta
      const iaResponse = await generateRagResponse(incomingMessageText, "wa_web");
      console.log(`[IA RAG] Resposta para WA Web: ${iaResponse.text} | Estágio: ${iaResponse.newStage}`);

      // Emite a resposta da IA no front end
      if (ioInstance) {
        ioInstance.emit("new_message", {
          contactId: senderId,
          provider,
          text: iaResponse.text,
          sender: "bot",
          timestamp: new Date().toISOString()
        });

        // Move o ticket se a IA sugeriu uma mudança de estágio
        if (iaResponse.newStage) {
          ioInstance.emit("ticket_stage_change", {
            contactId: senderId,
            newStage: iaResponse.newStage
          });
        }
      }

      // Envia fisicamente a mensagem via WhatsApp
      await client?.sendMessage(msg.from, iaResponse.text);
    } catch (error) {
      console.error('[WA Web] Erro ao processar mensagem', error);
    }
  });

  try {
     client.initialize();
  } catch (error) {
     console.error('[WA Web] Erro no Initialize', error);
     clientStatus = 'disconnected';
     // Limpa a referência para permitir uma nova tentativa de conexão.
     client = null;
  }
}

export function disconnectWhatsAppWeb() {
    if (client) {
        client.logout().catch(console.error);
        client.destroy().catch(console.error);
        client = null;
        clientStatus = 'disconnected';
        currentQrUrl = null;
        if (ioInstance) {
          ioInstance.emit('wa_web_status', { status: 'disconnected' });
        }
    }
}
