import { v4 as uuidv4 } from "uuid";
import { embed, chat } from "./llm.js";
import db from "./db.js";

interface DocumentChunk {
  id: string;
  text: string;
  embedding: number[];
  channelId: string;
}

/**
 * Cache em memória dos chunks por organização para evitar reler/parsear o JSON
 * dos embeddings do SQLite a cada mensagem. É populado sob demanda a partir do
 * banco (que agora é a fonte da verdade e persiste entre redeploys) e
 * invalidado sempre que documentos são adicionados/removidos.
 */
const orgCache = new Map<string, DocumentChunk[]>();

function invalidateCache(orgId: string) {
  orgCache.delete(orgId);
}

function loadOrgChunks(orgId: string): DocumentChunk[] {
  const cached = orgCache.get(orgId);
  if (cached) return cached;

  let chunks: DocumentChunk[] = [];
  try {
    const rows: any[] = db.prepare(
      `SELECT id, content, embedding, channel_id FROM knowledge_chunks WHERE organization_id = ?`
    ).all(orgId);
    chunks = rows.map((r) => {
      let embedding: number[] = [];
      try { embedding = JSON.parse(r.embedding); } catch (e) { embedding = []; }
      return { id: r.id, text: r.content, embedding, channelId: r.channel_id || 'global' };
    }).filter((c) => c.embedding.length > 0);
  } catch (e) {
    console.error("[RAG] Falha ao carregar chunks do banco:", e);
  }
  orgCache.set(orgId, chunks);
  return chunks;
}

/**
 * Normaliza o texto e divide em pequenos chunks (por parágrafo / linha em branco).
 */
function splitIntoChunks(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Processa e indexa um documento na base de conhecimento (embeddings OpenAI),
 * persistindo o documento e seus chunks vetorizados no SQLite.
 */
export async function processDocument(
  fileBuffer: Buffer,
  fileName: string,
  orgId: string,
  channelId: string = 'global'
): Promise<{ success: boolean; documentId: string; chunksProcessed: number }> {
  const text = fileBuffer.toString('utf-8');
  const docId = uuidv4();

  const chunks = splitIntoChunks(text);

  // Persistência do documento (metadados)
  try {
    db.prepare(
      `INSERT INTO knowledge_documents (id, organization_id, title, content, status, channel_id, chunk_count, size_bytes)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?)`
    ).run(docId, orgId, fileName, text, channelId, chunks.length, fileBuffer.length);
  } catch (e) {
    console.error("[RAG] Falha ao salvar documento:", e);
    throw new Error("Falha ao salvar o documento");
  }

  if (chunks.length === 0) {
    invalidateCache(orgId);
    return { success: true, documentId: docId, chunksProcessed: 0 };
  }

  // Vetorização via OpenAI Embeddings
  const vectors = await embed(chunks);
  if (!vectors || vectors.length !== chunks.length) {
    // Marca como erro e propaga
    try { db.prepare(`UPDATE knowledge_documents SET status = 'error' WHERE id = ?`).run(docId); } catch (e) {}
    throw new Error("Falha ao gerar embeddings");
  }

  const insert = db.prepare(
    `INSERT INTO knowledge_chunks (id, organization_id, document_id, channel_id, chunk_index, content, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction((items: { i: number; values: number[] }[]) => {
    for (const item of items) {
      insert.run(uuidv4(), orgId, docId, channelId, item.i, chunks[item.i], JSON.stringify(item.values));
    }
  });

  const toInsert: { i: number; values: number[] }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const values = vectors[i];
    if (!values || values.length === 0) continue;
    toInsert.push({ i, values });
  }
  insertMany(toInsert);

  invalidateCache(orgId);
  return { success: true, documentId: docId, chunksProcessed: toInsert.length };
}

/**
 * Remove um documento e seus chunks vetorizados.
 */
export function deleteDocument(docId: string, orgId: string): boolean {
  try {
    db.prepare(`DELETE FROM knowledge_chunks WHERE document_id = ? AND organization_id = ?`).run(docId, orgId);
    const info = db.prepare(`DELETE FROM knowledge_documents WHERE id = ? AND organization_id = ?`).run(docId, orgId);
    invalidateCache(orgId);
    return info.changes > 0;
  } catch (e) {
    console.error("[RAG] Falha ao remover documento:", e);
    return false;
  }
}

/**
 * Similaridade por cosseno entre dois vetores.
 */
function cosineSimilarity(A: number[], B: number[]): number {
  let dotproduct = 0;
  let mA = 0;
  let mB = 0;
  const len = Math.min(A.length, B.length);
  for (let i = 0; i < len; i++) {
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
 * Busca os N chunks de contexto mais relevantes para uma organização.
 */
export async function searchContext(
  query: string,
  orgId: string,
  channelId: string = 'global',
  topK: number = 3
): Promise<string[]> {
  const chunks = loadOrgChunks(orgId);
  if (chunks.length === 0) return [];

  let queryVec: number[] | undefined;
  try {
    [queryVec] = await embed([query]);
  } catch (e) {
    console.error("[RAG] Falha ao embeddar a query:", e);
    return [];
  }
  if (!queryVec) return [];

  const relevantDocs = chunks.filter((doc) => doc.channelId === 'global' || doc.channelId === channelId);

  const scoredDocs = relevantDocs.map((doc) => ({
    text: doc.text,
    score: cosineSimilarity(queryVec!, doc.embedding),
  }));

  scoredDocs.sort((a, b) => b.score - a.score);
  return scoredDocs.slice(0, topK).map((doc) => doc.text);
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
  return suspiciousKeywords.some((keyword) => lowercase.includes(keyword));
}

/**
 * RAG workflow: Busca RAG + Geração de Resposta via OpenAI.
 * (Mantido para compatibilidade; o fluxo principal usa o AIOrchestratorService.)
 */
export async function generateRagResponse(
  userMessage: string,
  orgId: string,
  channelId: string = 'global'
): Promise<{ text: string, newStage?: string }> {
  if (isPromptInjection(userMessage)) {
    return {
      text: "Sinto muito, não posso ajudar com essa solicitação.",
      newStage: "em_atendimento"
    };
  }

  const contextChunks = await searchContext(userMessage, orgId, channelId);
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
