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
    language: process.env.OPENAI_TRANSCRIBE_LANG || "pt", // melhora a precisão em PT-BR
  });
  return res.text || "";
}

/** Descreve/extrai texto (OCR) de uma imagem usando o modelo multimodal (GPT-4o). */
export async function describeImage(
  base64: string,
  mimetype = "image/jpeg",
  prompt = "Descreva o conteúdo desta imagem em português e extraia qualquer texto visível (OCR). Seja objetivo."
): Promise<string> {
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      },
    ] as any,
    temperature: 0.2,
    max_tokens: 500,
  });
  return res.choices[0]?.message?.content || "";
}

/**
 * "Olhos" do atendimento: analisa uma imagem recebida, CLASSIFICA (documento vs
 * foto comum) e, quando for documento (comprovante de PIX, nota fiscal, recibo,
 * receita, boleto…), extrai os dados-chave. Retorna um texto pronto para a IA
 * de atendimento reagir. Em fotos comuns, sinaliza para a IA PERGUNTAR o que o
 * cliente quer identificar.
 */
export async function analyzeImageForChat(base64: string, mimetype = "image/jpeg"): Promise<string> {
  const prompt = `Você é os "olhos" de um atendente por WhatsApp. Analise a imagem e responda em português de UMA destas formas:

1) Se for um DOCUMENTO com texto relevante (comprovante de PIX/pagamento, nota fiscal, recibo, receita/prescrição, boleto, RG/CPF, cardápio, etc.):
   Comece com "TIPO: <tipo do documento>" e depois liste os DADOS-CHAVE que conseguir ler (ex.: valor, data/hora, nome do pagador/destinatário, nº/ID da transação, itens, total). Seja fiel ao que está escrito; NÃO invente. Se algo estiver ilegível, escreva "ilegível".

2) Se for uma FOTO comum (pessoa, animal, objeto, lugar) SEM texto relevante:
   Responda exatamente neste formato: "TIPO: foto — <descrição bem curta do que aparece>. PERGUNTAR: o cliente enviou uma foto; pergunte com simpatia o que ele gostaria que você identificasse ou em que pode ajudar."`;
  return describeImage(base64, mimetype, prompt);
}
