import { GoogleGenAI } from "@google/genai";
import { Message, Contact } from "@/src/store/useStore";

// Initialize the API only when we need it
let ai: GoogleGenAI | null = null;

function getAi() {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
      console.warn("GEMINI_API_KEY is not set. AI features will mock responses.");
    } else {
      ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
  }
  return ai;
}

export async function suggestResponse(contact: Contact, history: Message[]): Promise<string> {
  const aiInstance = getAi();
  
  if (!aiInstance) {
    // Mock response if no API key
    return `Olá ${contact.name}, como posso te ajudar hoje?`;
  }

  const prompt = `
Você é um assistente especialista em atendimento ao cliente via WhatsApp.
Você deve gerar uma sugestão de resposta educada, curta e humanizada.

Nome do Cliente: ${contact.name}
Histórico da conversa:
${history.map(m => `${m.sender}: ${m.text}`).join('\n')}

Gere apenas o texto da resposta que o atendente deve enviar, sem aspas ou meta-comentários.
`;

  try {
    const response = await aiInstance.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: prompt,
    });
    return response.text || "";
  } catch (err) {
    console.error("AI Generate Error:", err);
    return "Desculpe, ocorreu um erro ao gerar a sugestão.";
  }
}

export async function summarizeConversation(history: Message[]): Promise<string> {
  const aiInstance = getAi();
  if (!aiInstance) return "Sem chave API para resumir conversa.";
  if (history.length === 0) return "A conversa está vazia.";

  const prompt = `
Faça um resumo conciso (em tópicos) desta conversa de atendimento.
Destaque o problema principal e as ações já tomadas.

Histórico:
${history.map(m => `${m.sender}: ${m.text}`).join('\n')}

Resumo em tópicos:
`;

  try {
     const response = await aiInstance.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: prompt,
    });
    return response.text?.trim() || "Resumo indisponível.";
  } catch (err) {
    return "Falha ao gerar resumo.";
  }
}
export async function analyzeIntent(message: string): Promise<string> {
  const aiInstance = getAi();
  if (!aiInstance) return "Suporte";

  const prompt = `Classifique a intenção dessa mensagem de cliente em uma das seguintes categorias: Vendas, Suporte, Dúvida, Reclamação, Outros. Responda apenas com a categoria. Mensagem: "${message}"`;
  
  try {
     const response = await aiInstance.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });
    return response.text?.trim() || "Outros";
  } catch (err) {
    return "Outros";
  }
}
