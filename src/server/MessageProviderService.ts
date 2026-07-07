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
         // Instagram API with Instagram Login (não Facebook Messenger): o token
         // salvo em token_encrypted (routes/instagramOAuth.ts) é um IG User Token
         // que só é válido contra graph.instagram.com — o host correto para o
         // endpoint /me/messages deste produto. Usar graph.facebook.com aqui
         // rejeita 100% dos envios silenciosamente (bug histórico) e o cliente
         // no Instagram nunca recebe a resposta da IA.
         endpoint = `https://graph.instagram.com/v21.0/me/messages`;
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

  /**
   * Envia um DOCUMENTO (ex.: PDF) por link público. Best-effort: quem chama deve
   * tratar a exceção e cair para o link em texto se necessário (não quebra nada).
   * - whatsapp_cloud: mensagem type=document com document.link.
   * - evolution/evolution_go: POST no endpoint de mídia (configurável por env).
   * - instagram: não suportado (lança, para o chamador usar o link).
   */
  static async sendDocument(channelId: string, recipientIdentifier: string, fileUrl: string, fileName: string, caption?: string) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any;
    if (!channel) throw new Error("Canal não encontrado");
    if (channel.status === 'disabled') throw new Error("Canal desabilitado ou empresa bloqueada");

    let metadada: any = {};
    try { metadada = channel.metadata_json ? JSON.parse(channel.metadata_json) : {}; } catch (e) {}

    if (channel.provider === 'whatsapp_cloud') {
      const token = channel.token_encrypted;
      if (!token) throw new Error("Token não configurado para este canal");
      const endpoint = `https://graph.facebook.com/v19.0/${channel.identifier}/messages`;
      const body: any = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientIdentifier,
        type: "document",
        document: { link: fileUrl, filename: fileName, ...(caption ? { caption } : {}) },
      };
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Erro na Graph API (documento): ${await response.text()}`);
      return true;
    }

    if (channel.provider === 'evolution_go' || channel.provider === 'evolution') {
      const token = process.env.EVOLUTION_API_KEY || channel.token_encrypted || '';
      const baseUrl = (metadada.baseUrl || process.env.EVOLUTION_BASE_URL || 'https://evolutiongo.tesseractauto.com.br').replace(/[\/\\]$/, '');
      const instanceName = channel.identifier;
      const headers: any = {
        'Content-Type': 'application/json',
        'apikey': token, 'token': token, 'Authorization': `Bearer ${token}`, 'instance': instanceName,
      };

      // Corpos candidatos (forks da Evolution divergem nos nomes de campo).
      const bodyA = { number: recipientIdentifier, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName, caption, delay: 1200 };
      const bodyB = { number: recipientIdentifier, type: 'document', url: fileUrl, fileName, caption, delay: 1200 };
      const bodyC = { number: recipientIdentifier, document: fileUrl, fileName, caption, delay: 1200 };

      // Se o caminho foi fixado por env, usa só ele. Senão, tenta os mais comuns
      // (o 1º que responder 2xx vence). Falhou tudo -> lança (chamador usa o link).
      const envPath = process.env.EVOLUTION_SEND_MEDIA_PATH;
      const attempts: { path: string; body: any }[] = envPath
        ? [{ path: envPath, body: bodyA }, { path: envPath, body: bodyB }]
        : [
            { path: '/send/media', body: bodyA },
            { path: '/send/media', body: bodyB },
            { path: '/send/document', body: bodyC },
            { path: '/message/sendMedia', body: bodyA },
          ];

      let lastErr = 'sem tentativa';
      for (const a of attempts) {
        try {
          const response = await fetch(`${baseUrl}${a.path}`, { method: 'POST', headers, body: JSON.stringify(a.body) });
          if (response.ok) {
            console.log(`[MessageProvider] Documento enviado via ${a.path}`);
            return true;
          }
          lastErr = `${a.path} -> HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`;
          console.warn(`[MessageProvider] Tentativa de documento falhou: ${lastErr}`);
        } catch (e: any) {
          lastErr = `${a.path} -> ${e?.message || e}`;
          console.warn(`[MessageProvider] Tentativa de documento erro: ${lastErr}`);
        }
      }
      throw new Error(`Evolution: nenhuma rota de mídia aceitou o documento. Último erro: ${lastErr}`);
    }

    throw new Error("Envio de documento não suportado neste provedor");
  }
}
