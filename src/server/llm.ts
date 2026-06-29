import OpenAI, { toFile } from "openai";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { currentOrgId } from "./usageContext.js";

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

// --- Medição de consumo de IA (tokens + custo) por empresa ---
// Preço em USD por 1 milhão de tokens (entrada/saída). Ajustável por env.
const USD_BRL = Number(process.env.OPENAI_USD_BRL || 5.4);
const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "text-embedding-3-small": { in: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0 },
};
function priceFor(model: string): { in: number; out: number } {
  return PRICES[model] || PRICES[(model || "").split(":")[0]] || { in: 2.5, out: 10 };
}
// Custo fixo aproximado por transcrição de áudio (Whisper é cobrado por minuto;
// sem a duração exata, usamos uma estimativa configurável).
const WHISPER_COST_USD = Number(process.env.OPENAI_WHISPER_COST_USD || 0.006);

/** Registra o consumo de uma chamada de IA na empresa do contexto atual. */
function recordUsage(model: string, kind: string, inputTokens: number, outputTokens: number, costUsdOverride?: number): void {
  try {
    const orgId = currentOrgId();
    if (!orgId) return; // sem org no contexto: não atribui (ex.: jobs internos)
    const p = priceFor(model);
    const costUsd = costUsdOverride != null
      ? costUsdOverride
      : (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
    db.prepare(
      `INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), orgId, model, kind, inputTokens, outputTokens, inputTokens + outputTokens, costUsd, costUsd * USD_BRL);
  } catch { /* medição nunca pode quebrar o atendimento */ }
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
  recordUsage(CHAT_MODEL, "chat", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
  return res.choices[0]?.message?.content || "";
}

/** Embeddings de uma lista de textos. Retorna um vetor por texto. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getClient().embeddings.create({ model: EMBED_MODEL, input: texts });
  recordUsage(EMBED_MODEL, "embed", res.usage?.prompt_tokens || 0, 0);
  return res.data.map((d) => d.embedding as number[]);
}

const SIZE_TO_ASPECT: Record<string, string> = {
  "1024x1024": "1:1",
  "1024x1536": "9:16",
  "1536x1024": "16:9",
};

/** Gera imagem via Google Imagen (Gemini API). Retorna base64 (ou "" se falhar). */
async function generateImageGoogle(prompt: string, size: string, apiKey: string): Promise<string> {
  const model = process.env.GOOGLE_IMAGE_MODEL || "imagen-3.0-generate-002";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: SIZE_TO_ASPECT[size] || "1:1" },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Imagen ${res.status}: ${t.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded || data?.predictions?.[0]?.image?.imageBytes || "";
  recordUsage(model, "image", 0, 0, Number(process.env.GOOGLE_IMAGE_COST_USD || 0.04));
  return b64;
}

/**
 * Gera uma imagem (base64) — Estúdio de Criação. Usa o Google Imagen quando há
 * GOOGLE_AI_API_KEY; senão cai para o OpenAI (gpt-image-1) para não quebrar.
 */
export async function generateImageB64(
  prompt: string,
  size: "1024x1024" | "1024x1536" | "1536x1024" = "1024x1024"
): Promise<string> {
  const googleKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (googleKey) {
    try {
      const b64 = await generateImageGoogle(prompt, size, googleKey);
      if (b64) return b64;
    } catch (e) {
      console.error("[Imagen] falha; tentando OpenAI:", e);
    }
  }
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const res = await getClient().images.generate({ model, prompt, size, n: 1 });
  const b64 = (res as any).data?.[0]?.b64_json || "";
  recordUsage(model, "image", 0, 0, Number(process.env.OPENAI_IMAGE_COST_USD || 0.04));
  return b64;
}

function googleAiKey(): string {
  return process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || "";
}

/** Inicia a geração de vídeo (Veo, long-running) e retorna o nome da operação. */
export async function startVideoGoogle(prompt: string, aspectRatio: "16:9" | "9:16" = "16:9"): Promise<string> {
  const key = googleAiKey();
  if (!key) throw new Error("GOOGLE_AI_API_KEY não configurada para gerar vídeo.");
  const model = process.env.GOOGLE_VIDEO_MODEL || "veo-3.0-generate-001";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { aspectRatio } }),
  });
  if (!res.ok) throw new Error(`Veo ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data: any = await res.json();
  if (!data?.name) throw new Error("Veo não retornou a operação.");
  return data.name;
}

/** Consulta a operação do Veo. Em done, devolve o vídeo (uri/base64) ou erro. */
export async function pollVideoGoogle(operationName: string): Promise<{ done: boolean; b64?: string; uri?: string; error?: string }> {
  const key = googleAiKey();
  if (!key) return { done: false, error: "sem chave" };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${key}`);
  if (!res.ok) return { done: false, error: `poll ${res.status}` };
  const data: any = await res.json();
  if (!data?.done) return { done: false };
  if (data.error) return { done: true, error: data.error.message || "erro na geração" };
  const r = data.response || {};
  const sample = r?.generateVideoResponse?.generatedSamples?.[0] || r?.generatedSamples?.[0] || r?.predictions?.[0] || {};
  const uri = sample?.video?.uri || sample?.video?.fileUri || sample?.uri || sample?.videoUri;
  const b64 = sample?.video?.bytesBase64Encoded || sample?.bytesBase64Encoded;
  recordUsage(process.env.GOOGLE_VIDEO_MODEL || "veo-3.0-generate-001", "video", 0, 0, Number(process.env.GOOGLE_VIDEO_COST_USD || 0.5));
  return { done: true, b64, uri };
}

/** Baixa o arquivo de vídeo (anexa a chave para URIs de arquivo da Gemini API). */
export async function downloadVideoBuffer(uri: string): Promise<Buffer> {
  const key = googleAiKey();
  const u = /key=/.test(uri) ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${key}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error(`download vídeo ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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
  recordUsage(TRANSCRIBE_MODEL, "audio", 0, 0, WHISPER_COST_USD);
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
  recordUsage(process.env.OPENAI_VISION_MODEL || CHAT_MODEL, "vision", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
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

/** Extrai o texto de um PDF (best-effort). Vazio se não conseguir. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod: any = await import("pdf-parse");
  const PDFParse = mod.PDFParse || mod.default?.PDFParse || mod.default;
  if (typeof PDFParse !== "function") return "";
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await parser.getText();
    return String(r?.text || "").trim();
  } finally {
    try { await parser.destroy?.(); } catch { /* noop */ }
  }
}

/**
 * "Olhos" para PDFs: extrai o texto e classifica/resume (comprovante, nota,
 * recibo, receita, boleto, contrato…) num formato que a IA de atendimento usa
 * para reagir. Se não der para ler, pede para reenviar como foto.
 */
export async function analyzePdfForChat(buffer: Buffer): Promise<string> {
  let text = "";
  try { text = await extractPdfText(buffer); } catch (e) { console.error("[PDF] Falha ao extrair texto:", e); }
  if (!text) {
    return "TIPO: documento (PDF) — não consegui ler o conteúdo. PERGUNTAR: peça com simpatia para o cliente reenviar como FOTO/imagem ou descrever o que precisa.";
  }
  const snippet = text.slice(0, 6000);
  const prompt = `Você é os "olhos" de um atendente por WhatsApp. Abaixo está o TEXTO extraído de um PDF enviado pelo cliente. Responda em português:
- Comece com "TIPO: <tipo do documento>" (ex.: comprovante de PIX, nota fiscal, recibo, receita/prescrição, boleto, contrato, outro).
- Em seguida liste os DADOS-CHAVE relevantes (valor, data, nome, nº/ID, itens, total). Seja fiel ao texto; NÃO invente. Se não houver dados claros, resuma o assunto em 1-2 frases.

TEXTO DO PDF:
${snippet}`;
  try {
    const out = await chat(prompt, { temperature: 0.2 });
    return out.trim() || `TIPO: documento (PDF). ${snippet.slice(0, 300)}`;
  } catch {
    return `TIPO: documento (PDF). Conteúdo: ${snippet.slice(0, 500)}`;
  }
}
