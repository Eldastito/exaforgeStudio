import { v4 as uuidv4 } from "uuid";
import { embed, chat } from "./llm.js";
import db from "./db.js";
import { topKBySimilarity } from "./vectorSimilarity.js";

export interface DocumentChunk {
  id: string;
  text: string;
  embedding: number[];
  channelId: string;
  areaId: string | null;
  // PRD 3 F7 (§49) — PROVENIÊNCIA que a linha JÁ carrega e era descartada: de que
  // documento veio o chunk, sua posição, o título (fonte) e quando foi indexado.
  documentId: string;
  chunkIndex: number;
  title: string | null;
  observedAt: string | null;
}

/**
 * PRD 3 F7 (§49) — um HIT de RAG com proveniência ESTRUTURADA (não só o texto):
 * de qual documento/chunk veio, a fonte (título), o score de similaridade e
 * quando o material foi indexado. É o que vira `EvidenceReference` (F1) via
 * `evidenceFromRagHit` — RAG/memória como evidência de 1ª classe, rastreável.
 */
export interface RagHit {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  title: string | null;
  source: string;        // rótulo humano da fonte (título do doc, ou 'knowledge_base')
  text: string;
  score: number;         // similaridade de cosseno (0..1)
  observedAt: string | null;
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

export function loadOrgChunks(orgId: string): DocumentChunk[] {
  const cached = orgCache.get(orgId);
  if (cached) return cached;

  let chunks: DocumentChunk[] = [];
  try {
    // F7 (§49) — preserva a proveniência que a linha já carrega (document_id,
    // chunk_index, created_at) + junta o título/created_at do documento pra a
    // FONTE. LEFT JOIN: chunk cujo documento sumiu ainda serve (sem título).
    const rows: any[] = db.prepare(
      `SELECT kc.id, kc.content, kc.embedding, kc.channel_id, kc.area_id, kc.document_id,
              kc.chunk_index, kc.created_at AS chunk_created_at,
              kd.title AS doc_title, kd.created_at AS doc_created_at
         FROM knowledge_chunks kc
         LEFT JOIN knowledge_documents kd ON kd.id = kc.document_id AND kd.organization_id = kc.organization_id
        WHERE kc.organization_id = ?`
    ).all(orgId);
    chunks = rows.map((r) => {
      let embedding: number[] = [];
      try { embedding = JSON.parse(r.embedding); } catch (e) { embedding = []; }
      return {
        id: r.id, text: r.content, embedding, channelId: r.channel_id || 'global', areaId: r.area_id || null,
        documentId: r.document_id, chunkIndex: Number(r.chunk_index) || 0, title: r.doc_title ?? null,
        observedAt: r.doc_created_at || r.chunk_created_at || null,
      };
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
  channelId: string = 'global',
  areaId: string | null = null
): Promise<{ success: boolean; documentId: string; chunksProcessed: number }> {
  const text = fileBuffer.toString('utf-8');
  const docId = uuidv4();

  const chunks = splitIntoChunks(text);

  // Persistência do documento (metadados)
  try {
    db.prepare(
      `INSERT INTO knowledge_documents (id, organization_id, title, content, status, channel_id, area_id, chunk_count, size_bytes)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?)`
    ).run(docId, orgId, fileName, text, channelId, areaId, chunks.length, fileBuffer.length);
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
    `INSERT INTO knowledge_chunks (id, organization_id, document_id, channel_id, area_id, chunk_index, content, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction((items: { i: number; values: number[] }[]) => {
    for (const item of items) {
      insert.run(uuidv4(), orgId, docId, channelId, areaId, item.i, chunks[item.i], JSON.stringify(item.values));
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
 * PRD 3 F7 (§49) — PURA: filtra (canal/área) + ranqueia os chunks por
 * similaridade e monta os `RagHit` COM proveniência. Determinística e sem I/O
 * (nem DB, nem embed) — o caller injeta o `queryVec` e os `chunks` já carregados.
 * É onde vive a lógica da F7; o `searchContextRich` só faz o I/O em volta.
 */
export function rankChunksToHits(
  queryVec: number[],
  chunks: DocumentChunk[],
  opts: { channelId?: string; areaId?: string | null; topK?: number } = {}
): RagHit[] {
  const channelId = opts.channelId || 'global';
  const areaId = opts.areaId ?? null;
  const topK = opts.topK && opts.topK > 0 ? opts.topK : 3;

  const relevantDocs = chunks.filter((doc) => {
    const chanOk = doc.channelId === 'global' || doc.channelId === channelId;
    if (!chanOk) return false;
    // Conhecimento por área: quando a conversa está numa área, usa só o material
    // daquela área + o geral (sem área). Sem área definida, mantém tudo.
    if (areaId) return !doc.areaId || doc.areaId === areaId;
    return true;
  });

  // ADR-160 F9 — ranqueamento pelo primitivo ÚNICO (dedup de RAG). Os filtros de
  // canal/área acima são específicos deste stack; a matemática da busca é a mesma
  // da memória Fala Tu.
  return topKBySimilarity(queryVec, relevantDocs, (doc) => doc.embedding, topK).map((r) => ({
    chunkId: r.item.id,
    documentId: r.item.documentId,
    chunkIndex: r.item.chunkIndex,
    title: r.item.title,
    source: r.item.title || 'knowledge_base',
    text: r.item.text,
    score: r.score,
    observedAt: r.item.observedAt,
  }));
}

/**
 * PRD 3 F7 (§49) — busca RAG devolvendo proveniência ESTRUTURADA (`RagHit[]`):
 * de qual documento/chunk veio, a fonte, o score e quando foi indexado — o que
 * a `searchContext` (string[]) descartava. É o que o Context Engine consome como
 * `EvidenceReference` (via `evidenceFromRagHit`). Isolado por org (loadOrgChunks
 * filtra `organization_id`). Best-effort: falha ao embeddar → [].
 */
export async function searchContextRich(
  query: string,
  orgId: string,
  channelId: string = 'global',
  topK: number = 3,
  areaId: string | null = null
): Promise<RagHit[]> {
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

  return rankChunksToHits(queryVec, chunks, { channelId, areaId, topK });
}

/**
 * Busca os N chunks de contexto mais relevantes para uma organização. Mantém a
 * assinatura `string[]` (retrocompat — todos os callers existentes seguem iguais);
 * é uma projeção do `searchContextRich` que descarta a proveniência (§49 preserva
 * a proveniência em quem QUER — o Context Engine —, sem quebrar quem só quer texto).
 */
export async function searchContext(
  query: string,
  orgId: string,
  channelId: string = 'global',
  topK: number = 3,
  areaId: string | null = null
): Promise<string[]> {
  return (await searchContextRich(query, orgId, channelId, topK, areaId)).map((h) => h.text);
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
    // Valida o estágio retornado pela IA contra a lista permitida — a IA interpreta,
    // mas não pode gravar um estágio inválido na coluna de funil do contato.
    const ALLOWED_STAGES = ["novo_lead", "em_atendimento", "proposta", "fechado"];
    const newStage = ALLOWED_STAGES.includes(parsed.newStage)
      ? parsed.newStage
      : "em_atendimento";
    return {
      text: parsed.text || "Desculpe, ocorreu um erro.",
      newStage,
    };
  } catch (e) {
    console.error("Erro ao fazer parse do JSON RAG:", e);
    return { text: rawText.replace(/```json/g, '').replace(/```/g, '').trim(), newStage: 'em_atendimento' };
  }
}
