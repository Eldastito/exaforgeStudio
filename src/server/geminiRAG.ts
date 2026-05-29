import { v4 as uuidv4 } from "uuid";
import { embed, chat } from "./llm.js";

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
 */
function splitIntoChunks(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs.filter(p => p.trim().length > 0);
}

/**
 * Processa e indexa um documento no banco vetorial (embeddings OpenAI).
 */
export async function processDocument(fileBuffer: Buffer, fileName: string, channelId: string = 'global') {
  const text = fileBuffer.toString('utf-8');

  // Salvar no DB (best-effort)
  const docId = uuidv4();
  const orgId = "default_org";
  try {
    import("./db.js").then((mod) => {
      const db = mod.default;
      db.prepare(`INSERT INTO knowledge_documents (id, organization_id, title, content) VALUES (?, ?, ?, ?)`).run(
        docId, orgId, fileName, text
      );
    });
  } catch (e) {}

  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) {
    return { success: true, chunksProcessed: 0 };
  }

  // Vetorização via OpenAI Embeddings
  const vectors = await embed(chunks);
  if (!vectors || vectors.length !== chunks.length) {
    throw new Error("Falha ao gerar embeddings");
  }

  for (let i = 0; i < chunks.length; i++) {
    const values = vectors[i];
    if (!values || values.length === 0) continue;
    vectorStore.push({
      id: uuidv4(),
      text: chunks[i],
      embedding: values,
      metadata: { fileName, channelId }
    });
  }

  return { success: true, chunksProcessed: chunks.length };
}

/**
 * Similaridade por cosseno entre dois vetores.
 */
function cosineSimilarity(A: number[], B: number[]): number {
  let dotproduct = 0;
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < A.length; i++) {
    dotproduct += A[i] * B[i];
    mA += A[i] * A[i];
    mB += B[i] * B[i];
  }
  mA = Math.sqrt(mA);
  mB = Math.sqrt(mB);
  if (mA * mB === 0) return 0;
  return dotproduct / (mA * mB);
}

/**
 * Busca os N chunks de contexto mais relevantes.
 */
export async function searchContext(query: string, channelId: string, topK: number = 3): Promise<string[]> {
  if (vectorStore.length === 0) return [];

  const [queryVec] = await embed([query]);
  if (!queryVec) return [];

  const relevantDocs = vectorStore.filter(doc => doc.metadata.channelId === 'global' || doc.metadata.channelId === channelId);

  const scoredDocs = relevantDocs.map(doc => ({
    text: doc.text,
    score: cosineSimilarity(queryVec, doc.embedding)
  }));

  scoredDocs.sort((a, b) => b.score - a.score);
  return scoredDocs.slice(0, topK).map(doc => doc.text);
}

/**
 * Verifica tentativa de Prompt Injection baseado em heurísticas básicas.
 */
function isPromptInjection(text: string): boolean {
  const lowercase = text.toLowerCase();
  const suspiciousKeywords = [
    "ignore todas as instru", "ignore previous", "esqueça o que eu disse", "sistema:", "system prompt", "você é agora",
    "you are now", "bypasse", "modo desenvolvedor", "desconsidere as regras"
  ];
  return suspiciousKeywords.some(keyword => lowercase.includes(keyword));
}

/**
 * RAG workflow: Busca RAG + Geração de Resposta via OpenAI.
 */
export async function generateRagResponse(userMessage: string, channelId: string): Promise<{ text: string, newStage?: string }> {
  if (isPromptInjection(userMessage)) {
    return {
      text: "Sinto muito, não posso ajudar com essa solicitação.",
      newStage: "em_atendimento"
    };
  }

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

  const rawText = await chat(prompt, { temperature: 0.4, json: true });
  try {
    const cleanedJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanedJson);
    return {
      text: parsed.text || "Desculpe, ocorreu um erro.",
      newStage: parsed.newStage,
    };
  } catch (e) {
    console.error("Erro ao fazer parse do JSON RAG:", e);
    return { text: rawText.replace(/```json/g, '').replace(/```/g, '').trim(), newStage: 'em_atendimento' };
  }
}
