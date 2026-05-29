import db from "./db.js";
import fetch from "node-fetch";

export class MessageProviderService {
  /**
   * Envia uma mensagem para o contato, abstraindo o provedor.
   */
  static async sendMessage(channelId: string, recipientIdentifier: string, content: string) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any;
    if (!channel) throw new Error("Canal não encontrado");
    if (channel.status === 'disabled') throw new Error("Canal desabilitado ou empresa bloqueada");

    let metadada: any = {};
    try {
      metadada = channel.metadata_json ? JSON.parse(channel.metadata_json) : {};
    } catch(e) {}

    console.log(`[MessageProvider] Enviando via ${channel.provider} para ${recipientIdentifier}`);

    if (channel.provider === 'whatsapp_cloud' || channel.provider === 'instagram') {
       // Cloud API ou Instagram
       const token = channel.token_encrypted;
       if (!token) throw new Error("Token não configurado para este canal");
       
       let endpoint = '';
       let body: any = {};
       
       if (channel.provider === 'whatsapp_cloud') {
         endpoint = `https://graph.facebook.com/v19.0/${channel.identifier}/messages`;
         body = {
           messaging_product: "whatsapp",
           recipient_type: "individual",
           to: recipientIdentifier,
           type: "text",
           text: { body: content }
         };
       } else if (channel.provider === 'instagram') {
         endpoint = `https://graph.facebook.com/v19.0/${channel.identifier}/messages`;
         body = {
           recipient: { id: recipientIdentifier },
           message: { text: content }
         };
       }

       const response = await fetch(endpoint, {
         method: 'POST',
         headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
         },
         body: JSON.stringify(body)
       });
       
       if (!response.ok) {
          throw new Error(`Erro na Graph API: ${await response.text()}`);
       }
       return true;
    } else if (channel.provider === 'evolution_go' || channel.provider === 'evolution') {
        const token = channel.token_encrypted; // API Key
        const baseUrl = metadada.baseUrl || process.env.EVOLUTION_BASE_URL || 'https://evolutiongo.tesseractauto.com.br';
        const instanceName = channel.identifier;

        const endpoint = `${baseUrl.replace(/[\/\\]$/, '')}/message/sendText/${instanceName}`;
        const sendData = {
           number: recipientIdentifier,
           options: { delay: 1200, presence: "composing" },
           textMessage: { text: content }
        };

        const response = await fetch(endpoint, {
           method: 'POST',
           headers: {
             'Content-Type': 'application/json',
             'apikey': token,
             'instance': instanceName
           },
           body: JSON.stringify(sendData)
        });

        if (!response.ok) {
           throw new Error(`Erro na Evolution API: ${await response.text()}`);
        }
        return true;
    }
    
    throw new Error("Provedor não suportado");
  }
}
