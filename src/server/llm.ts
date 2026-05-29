import OpenAI, { toFile } from "openai";

/**
 * Camada única de IA (OpenAI) usada por todos os agentes:
 * - chat()           → raciocínio dos agentes (orquestrador / atendimento)
 * - embed()          → embeddings para o RAG
 * - transcribeAudio()→ transcrição de áudio (Whisper) para o Zapp entender áudios
 *
 * A chave NUNCA fica no código: é lida de process.env.OPENAI_API_KEY,
 * configurada como variável de ambiente/segredo no deploy.
 */

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY não configurada. Defina a variável de ambiente para usar a IA.");
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// Modelos configuráveis por env (com defaults sensatos).
export const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
export const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
export const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

export function isAIConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/** Chat completion. Use json:true para forçar resposta em JSON. */
export async function chat(
  prompt: string,
  opts: { temperature?: number; json?: boolean; system?: string } = {}
): Promise<string> {
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const res = await getClient().chat.completions.create({
    model: CHAT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });
  return res.choices[0]?.message?.content || "";
}

/** Embeddings de uma lista de textos. Retorna um vetor por texto. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getClient().embeddings.create({ model: EMBED_MODEL, input: texts });
  return res.data.map((d) => d.embedding as number[]);
}

/** Transcreve um áudio (Buffer) para texto via Whisper. */
export async function transcribeAudio(
  buffer: Buffer,
  filename = "audio.ogg",
  mimetype = "audio/ogg"
): Promise<string> {
  const file = await toFile(buffer, filename, { type: mimetype });
  const res = await getClient().audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
  });
  return res.text || "";
}
