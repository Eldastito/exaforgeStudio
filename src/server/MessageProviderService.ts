import db from "./db.js";
// Node 18+/22 já possui fetch global — não usar node-fetch (quebra no bundle CJS).

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
        // Prioriza a chave do ambiente (fonte da verdade no deploy) e só usa a do
        // canal como fallback — evita um token antigo/errado salvo no banco vencer.
        const token = process.env.EVOLUTION_API_KEY || channel.token_encrypted || '';
        const baseUrl = metadada.baseUrl || process.env.EVOLUTION_BASE_URL || 'https://evolutiongo.tesseractauto.com.br';
        const instanceName = channel.identifier;

        // Evolution GO: endpoint é /send/text (a instância vem pelo token no header, não na URL)
        const endpoint = `${baseUrl.replace(/[\/\\]$/, '')}${process.env.EVOLUTION_SEND_PATH || '/send/text'}`;
        // Evolution GO usa corpo plano: { number, text, delay }
        const sendData = {
           number: recipientIdentifier,
           text: content,
           delay: 1200
        };

        console.log(`[MessageProvider] POST ${endpoint} (number=${recipientIdentifier}, tokenLen=${token.length})`);
        const response = await fetch(endpoint, {
           method: 'POST',
           headers: {
             'Content-Type': 'application/json',
             'apikey': token,
             'token': token,
             'Authorization': `Bearer ${token}`,
             'instance': instanceName
           },
           body: JSON.stringify(sendData)
        });

        if (!response.ok) {
           throw new Error(`Erro na Evolution API (${response.status}) em ${endpoint}: ${await response.text()}`);
        }
        return true;
    }
    
    throw new Error("Provedor não suportado");
  }
}
