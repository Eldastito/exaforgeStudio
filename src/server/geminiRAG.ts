import { GoogleGenAI } from "@google/genai";
import { v4 as uuidv4 } from "uuid";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface DocumentChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    fileName: string;
    channelId: string | 'global';
  };
}

// Emulação de um banco de dados vetorial em memória (ex: PgVector, Pinecone)
const vectorStore: DocumentChunk[] = [];

/**
 * Normaliza o texto e divide em pequenos chunks.
 * Em um cenário real, usariamos um TextSplitter mais sofisticado (como o do LangChain)
 */
function splitIntoChunks(text: string, maxTokens: number = 500): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  // Simplificação: apenas quebrando por parágrafos para simular chunks
  return paragraphs.filter(p => p.trim().length > 0);
}

/**
 * Função para processar e indexar um documento no banco vetorial
 */
export async function processDocument(fileBuffer: Buffer, fileName: string, channelId: string = 'global') {
  // 1. Extração de texto (assumindo que seja um TXT simples para o exemplo)
  const text = fileBuffer.toString('utf-8');
  
  // 2. Chunks
  const chunks = splitIntoChunks(text);
  
  // 3. Vetorização via Gemini Embeddings
  const response = await ai.models.embedContent({
    model: "text-embedding-004", // Modelo de embedding atual recomendado
    contents: chunks,
  });

  const embeddings = response.embeddings;
  
  if (!embeddings) {
    throw new Error("Falha ao gerar embeddings");
  }

  // 4. Salvar no "Banco Vector"
  for (let i = 0; i < chunks.length; i++) {
    vectorStore.push({
      id: uuidv4(),
      text: chunks[i],
      embedding: embeddings[i].values || [],
      metadata: { fileName, channelId }
    });
  }
  
  return { success: true, chunksProcessed: chunks.length };
}

/**
 * Calcula similaridade por Cosseno entre dois vetores
 */
function cosineSimilarity(A: number[], B: number[]): number {
  let dotproduct = 0;
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < A.length; i++) {
    dotproduct += A[i] * B[i];
    mA += Math.pow(A[i], 2);
    mB += Math.pow(B[i], 2);
  }
  mA = Math.sqrt(mA);
  mB = Math.sqrt(mB);
  if (mA * mB === 0) return 0;
  return dotproduct / (mA * mB);
}

/**
 * Busca os N chunks de contexto mais relevantes
 */
export async function searchContext(query: string, channelId: string, topK: number = 3): Promise<string[]> {
  const queryEmbeddingRes = await ai.models.embedContent({
    model: "text-embedding-004",
    contents: query
  });
  
  const queryVec = queryEmbeddingRes.embeddings?.[0]?.values;
  if (!queryVec) return [];

  // Filtrar apenas documentos globais ou específicos do canal
  const relevantDocs = vectorStore.filter(doc => doc.metadata.channelId === 'global' || doc.metadata.channelId === channelId);

  // Calcular similaridade
  const scoredDocs = relevantDocs.map(doc => ({
    text: doc.text,
    score: cosineSimilarity(queryVec, doc.embedding)
  }));

  // Ordenar por maior score
  scoredDocs.sort((a, b) => b.score - a.score);
  
  // Pegar os top K
  return scoredDocs.slice(0, topK).map(doc => doc.text);
}

/**
 * RAG workflow: Busca RAG + Geração de Resposta via Gemini
 */
export async function generateRagResponse(userMessage: string, channelId: string): Promise<{ text: string, newStage?: string }> {
  const contextChunks = await searchContext(userMessage, channelId);
  const contextText = contextChunks.length > 0 ? contextChunks.join('\n\n---\n\n') : "Nenhum documento adicional encontrado na base de conhecimento.";

  const prompt = `
Você é um assistente de IA focado em vendas e atendimento, representando a nossa empresa via WhatsApp/Instagram.
Use o CONTEXTO FORNECIDO abaixo para responder à pergunta do cliente.
Se a resposta não estiver no contexto, seja honesto e diga que vai transferir para um humano.

CONTEXTO FORNECIDO:
${contextText}

PERGUNTA DO CLIENTE:
"${userMessage}"

Você também é responsável por mover o lead no Pipeline de Vendas (Kanban) de acordo com a conversa.
Estágios válidos do Kanban:
- "novo_lead": Quando o cliente acabou de mandar a primeira mensagem.
- "em_atendimento": Quando você está conversando e tirando dúvidas do cliente.
- "proposta": Quando você acabou de enviar preços, orçamento, ou links de pagamento.
- "fechado": Quando o cliente confirmou a compra ou encerrou agradecendo após receber os valores.

Sua resposta OBRIGATORIAMENTE DEVE SER UM OBJETO JSON VÁLIDO com a seguinte estrutura:
{
  "text": "Sua resposta humana e educada para o cliente aqui",
  "newStage": "novo_lead" | "em_atendimento" | "proposta" | "fechado"
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: prompt
  });

  const rawText = response.text || "";
  try {
    // Tenta limpar o json caso venha com markdown ```json
    const cleanedJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanedJson);
    return {
      text: parsed.text || "Desculpe, ocorreu um erro.",
      newStage: parsed.newStage,
    };
  } catch (e) {
    console.error("Erro ao fazer parse do JSON RAG:", e);
    // Caso falhe, retorna apenas o texto cru, assumindo em_atendimento
    return { text: rawText.replace(/```json/g, '').replace(/```/g, '').trim(), newStage: 'em_atendimento' };
  }
}

