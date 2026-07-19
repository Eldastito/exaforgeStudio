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

/**
 * Foto profissional de catálogo a partir da FOTO REAL do produto (Fase B do
 * cadastro por WhatsApp, ADR-032) — diferente de generateImageB64() (que cria
 * uma imagem do ZERO a partir só de texto), aqui usamos o endpoint de EDIÇÃO
 * da OpenAI (images.edit, gpt-image-1): a imagem de entrada é preservada
 * (o produto fotografado continua sendo o mesmo produto) e só o prompt de
 * estilo (fundo, iluminação, identidade visual da loja) é aplicado por cima.
 * Gerar do zero arriscaria criar um produto GENÉRICO diferente do que está
 * de verdade em estoque — edição preserva a fidelidade ao item real.
 */
export async function editProductImageB64(base64: string, mimetype: string, stylePrompt: string): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const ext = mimetype.includes("png") ? "png" : "jpg";
  const file = await toFile(buffer, `product.${ext}`, { type: mimetype });
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const res = await getClient().images.edit({
    model, image: file,
    prompt: `Transforme esta foto em uma imagem de produto com aparência profissional para e-commerce. ` +
      `REGRAS OBRIGATÓRIAS: preserve o produto EXATAMENTE como está na foto original — mesma embalagem, rótulos, texto impresso, formato, cores, texturas e detalhes do próprio produto. ` +
      `NÃO altere, melhore ou modifique o produto em si. ` +
      `APENAS substitua o fundo, cenário e iluminação conforme o estilo solicitado abaixo. ` +
      `Remova completamente qualquer elemento do cenário original (mãos, mesa, chão, outros objetos). ` +
      `Resultado: imagem de alta resolução, cores fiéis, bordas nítidas, pronta para venda online. ` +
      stylePrompt,
  });
  const b64 = (res as any).data?.[0]?.b64_json || "";
  recordUsage(model, "image", 0, 0, Number(process.env.OPENAI_IMAGE_COST_USD || 0.04));
  return b64;
}

/**
 * Edição multi-imagem (Provador Virtual FAS-3, ADR-037): o gpt-image-1 aceita
 * VÁRIAS imagens de entrada no endpoint de edição — a foto da cliente + as
 * fotos reais das peças do look — e compõe uma única saída. Mesmo princípio
 * do editProductImageB64 (edição preserva o real; geração do zero inventaria
 * uma pessoa/peça genérica), estendido para N entradas.
 *
 * IDENTIDADE (ADR-040): o gpt-image-1, por padrão (input_fidelity="low"),
 * "reimagina" a pessoa — o rosto sai diferente. `input_fidelity: "high"` é o
 * parâmetro feito para PRESERVAR rosto e detalhes finos da imagem de entrada;
 * é o que faz o provador manter a MESMA pessoa. `quality: "high"` e a saída em
 * retrato (1024x1536, corpo inteiro) completam. São opcionais para não afetar
 * o editProductImageB64 (catálogo), que não precisa de rosto.
 */
export async function editImagesB64(
  images: { buffer: Buffer; name: string; mime: string }[],
  prompt: string,
  opts: { inputFidelity?: "high" | "low"; quality?: "high" | "medium" | "low" | "auto"; size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto" } = {},
): Promise<string> {
  const files = await Promise.all(images.map((img) => toFile(img.buffer, img.name, { type: img.mime })));
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const params: any = { model, image: files as any, prompt };
  if (opts.inputFidelity) params.input_fidelity = opts.inputFidelity;
  if (opts.quality) params.quality = opts.quality;
  if (opts.size) params.size = opts.size;
  const res = await getClient().images.edit(params);
  const b64 = (res as any).data?.[0]?.b64_json || "";
  recordUsage(model, "image", 0, 0, Number(process.env.OPENAI_IMAGE_COST_USD || 0.04));
  return b64;
}

function googleAiKey(): string {
  return process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || "";
}

/**
 * Provador Virtual via Google Gemini (ADR-042): envia a foto da pessoa + fotos
 * das peças como partes multimodais e pede ao Gemini que GERE uma imagem de
 * try-on. O Gemini com responseModalities=["IMAGE","TEXT"] trata as imagens de
 * entrada como REFERÊNCIA e gera a composição preservando a identidade da pessoa
 * — diferente do gpt-image-1 que re-sintetiza tudo (rosto inclusive). Mesmo
 * padrão de fetch das outras integrações Google (Imagen, Veo); sem SDK extra.
 */
export async function editImagesGoogleB64(
  images: { buffer: Buffer; mime: string }[],
  prompt: string,
): Promise<string> {
  const key = googleAiKey();
  if (!key) throw new Error("GOOGLE_AI_API_KEY não configurada para provador virtual.");
  const model = process.env.GOOGLE_TRYON_MODEL || "gemini-2.0-flash-exp";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const parts: any[] = images.map((img) => ({
    inlineData: { mimeType: img.mime, data: img.buffer.toString("base64") },
  }));
  parts.push({ text: prompt });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const candidate = data?.candidates?.[0]?.content?.parts || [];
  for (const part of candidate) {
    if (part?.inlineData?.data) {
      recordUsage(model, "tryon_image", 0, 0, Number(process.env.GOOGLE_TRYON_COST_USD || 0.04));
      return part.inlineData.data;
    }
  }
  throw new Error("Gemini não retornou imagem na resposta.");
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
 * Cadastro Inteligente (Smart Inventory, ADR-019/ADR-020): a partir da FOTO
 * de UM produto, extrai os campos de cadastro em JSON estruturado — nunca
 * inventa o que não está visível na embalagem/produto (mesma regra de "não
 * invente" já usada em /ai/describe). NUNCA sugere preço aqui: sem nota
 * fiscal/custo conhecido, a IA não tem base para precificar — quem define o
 * preço final é sempre o humano, na tela de confirmação (nunca publicado sem
 * essa revisão). `confidence` numérico (0-100) orienta a UI a exigir mais ou
 * menos atenção do humano na revisão (ADR-020).
 */
export async function extractProductFromImage(base64: string, mimetype = "image/jpeg"): Promise<string> {
  const system = `Você é um assistente de cadastro de produtos para varejo brasileiro. A partir da foto de um produto (embalagem, rótulo, etiqueta), extraia os dados visíveis e devolva SOMENTE um JSON com os campos:
{"name": "nome comercial do produto, ex.: 'Feijão Preto Kicaldo 1kg'", "brand": "marca (ou null se não identificável)", "category": "categoria/subcategoria em português, ex.: 'Alimentos > Grãos' (ou null)", "weightLabel": "peso/volume/tamanho como aparece na embalagem, ex.: '1 Kg' (ou null)", "ean": "os dígitos do código de barras (EAN/GTIN) impresso na embalagem, SOMENTE os números, sem espaços — ex.: '7891000315507'; use null se não houver código de barras visível ou se você não conseguir ler TODOS os dígitos com nitidez", "description": "descrição de venda curta e honesta, 1-2 frases", "confidence": <número inteiro de 0 a 100 representando sua certeza geral na leitura — 95+ se a embalagem está nítida e todos os dados principais são claramente legíveis, 80-94 se há alguma dúvida pontual, abaixo de 80 se a imagem está borrada/incompleta/ambígua>}
Regras rígidas: NUNCA invente marca, peso, categoria ou dígitos do código de barras que não estejam visíveis/legíveis na imagem — use null quando não tiver certeza (e reflita isso num confidence mais baixo). Em especial, NÃO adivinhe o EAN: se o código de barras estiver borrado, cortado ou parcialmente ilegível, devolva "ean": null em vez de chutar dígitos. NUNCA inclua preço (não há como saber o preço de custo/venda a partir de uma foto). Responda SOMENTE o JSON, sem texto ao redor.`;
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Identifique este produto e devolva o JSON pedido." },
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      },
    ] as any,
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: "json_object" },
  });
  recordUsage(process.env.OPENAI_VISION_MODEL || CHAT_MODEL, "vision", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
  return res.choices[0]?.message?.content || "";
}

/**
 * Cadastro por Nota Fiscal (Smart Inventory Fase 1, ADR-021): a partir da FOTO
 * de uma nota fiscal/cupom/comprovante de COMPRA de mercadorias, extrai TODOS
 * os itens comprados (nome, quantidade, custo unitário) em JSON estruturado —
 * diferente de `extractProductFromImage()`, aqui a IA JÁ TEM o custo real (veio
 * da nota), então pode ser usado depois para atualizar o custo médio do
 * produto (InventoryService.recordMovement). Mesma regra de "não invente": só
 * lista o que está de fato na nota, ignora frete/impostos/totais, e sinaliza
 * baixa confiança por item quando a leitura ficar duvidosa em vez de inventar
 * um número. Continua sem sugerir PREÇO DE VENDA — só custo de compra; quem
 * decide a margem/preço final é sempre o humano.
 */
export async function extractInvoiceItems(base64: string, mimetype = "image/jpeg"): Promise<string> {
  const system = `Você é um assistente de leitura de notas fiscais e comprovantes de compra de mercadorias para varejo brasileiro. A partir da foto de uma nota fiscal, cupom fiscal ou comprovante de compra, extraia os itens comprados e devolva SOMENTE um JSON:
{"supplierName": "nome do fornecedor/emitente da nota, se legível (ou null)", "items": [{"name": "nome do item exatamente como aparece na nota", "quantity": <número, quantidade comprada>, "unit": "unidade como aparece na nota, ex.: 'un', 'kg', 'cx' (ou null se não estiver claro)", "unitCost": <número, custo unitário em reais>, "confidence": <número inteiro de 0 a 100, confiança na leitura DESTE item específico>}], "confidence": <número inteiro de 0 a 100, confiança geral na leitura da nota>}
Regras rígidas: liste TODOS os itens de MERCADORIA visíveis na nota — IGNORE linhas de frete, impostos, descontos e a linha de total. NUNCA invente itens que não estejam na nota. Se a quantidade ou o custo unitário de um item não estiverem claros, inclua o item mesmo assim com sua melhor leitura e um confidence baixo nesse item (não descarte o item). Responda SOMENTE o JSON, sem texto ao redor.`;
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Leia esta nota fiscal e devolva o JSON pedido com todos os itens comprados." },
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      },
    ] as any,
    temperature: 0.2,
    max_tokens: 1500,
    response_format: { type: "json_object" },
  });
  recordUsage(process.env.OPENAI_VISION_MODEL || CHAT_MODEL, "vision", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
  return res.choices[0]?.message?.content || "";
}

/**
 * Retail Ops (ADR-083, Fase C): a partir da FOTO/documento da folha de
 * fechamento de loja, extrai os valores por forma de pagamento em JSON — mesma
 * disciplina de "nunca invente valor ilegível" do Smart Inventory. Devolve um
 * `confidence` para a UI exigir revisão humana quando a leitura for duvidosa.
 * NUNCA aprova nada: quem confirma os valores é sempre o humano.
 */
export async function extractClosingFromImage(base64: string, mimetype = "image/jpeg"): Promise<string> {
  const system = `Você é um assistente de leitura de FOLHAS DE FECHAMENTO DE CAIXA de loja no varejo brasileiro. A partir da foto/documento da folha do dia, extraia os valores por forma de pagamento e devolva SOMENTE um JSON:
{"dinheiro": <número em reais ou null>, "pix": <número ou null>, "credito": <número ou null>, "debito": <número ou null>, "voucher": <número ou null>, "troca": <número ou null>, "outros": <número ou null>, "total": <número, o total informado na folha, ou null se não houver linha de total legível>, "confidence": <número inteiro de 0 a 100, confiança geral na leitura>}
Regras rígidas: use PONTO como separador decimal (ex.: 1250.50). NUNCA invente um valor que não esteja legível na folha — use null para o campo que você não conseguir ler com clareza e reflita isso num confidence mais baixo. Não some nem calcule o total por conta própria: só devolva "total" se houver uma linha de total escrita na folha; senão devolva null. Ignore anotações que não sejam valores de fechamento. Responda SOMENTE o JSON, sem texto ao redor.`;
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Leia esta folha de fechamento e devolva o JSON pedido com os valores por forma de pagamento." },
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      },
    ] as any,
    temperature: 0.2,
    max_tokens: 500,
    response_format: { type: "json_object" },
  });
  recordUsage(process.env.OPENAI_VISION_MODEL || CHAT_MODEL, "vision", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
  return res.choices[0]?.message?.content || "";
}

/**
 * Cadastro por foto direto no WhatsApp (canal do gestor/lojista, separado da
 * IA de atendimento ao cliente): classificação BARATA e rápida (sem extrair
 * nada ainda) — só decide se a foto é de UM produto avulso (embalagem/rótulo)
 * ou de uma NOTA FISCAL (tabela de itens, fornecedor, total), para então
 * chamar extractProductFromImage/extractInvoiceItems (já testados, ADR-030).
 * 'unclear' quando a IA não tem certeza — quem chama pergunta ao gestor.
 */
export async function classifyInventoryPhoto(base64: string, mimetype = "image/jpeg"): Promise<"product" | "invoice" | "unclear"> {
  const system = `Classifique a foto enviada por um lojista para cadastro de estoque. Responda SOMENTE um JSON: {"type": "product"|"invoice"|"unclear"}.
"product": foto de UM produto/embalagem/rótulo avulso (sem tabela de itens).
"invoice": nota fiscal, cupom fiscal ou comprovante de compra com lista de itens/fornecedor/total.
"unclear": não dá para saber com confiança.`;
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Classifique esta foto." },
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      },
    ] as any,
    temperature: 0,
    max_tokens: 20,
    response_format: { type: "json_object" },
  });
  recordUsage(process.env.OPENAI_VISION_MODEL || CHAT_MODEL, "vision", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
  try {
    const parsed = JSON.parse(res.choices[0]?.message?.content || "{}");
    if (parsed.type === "product" || parsed.type === "invoice") return parsed.type;
  } catch { /* cai no unclear */ }
  return "unclear";
}

/**
 * Interpreta a resposta em texto livre do gestor durante o cadastro
 * conversacional por WhatsApp (custo pago, margem, preço de venda direto,
 * quantidade em estoque) — o lojista pode responder tudo de uma vez
 * ("paguei 5, quero 40% de margem, tenho 20 unidades") ou aos poucos.
 * Só preenche o que estiver INEQUIVOCAMENTE na mensagem; nunca inventa
 * valor para um campo que não foi mencionado (fica null/undefined).
 */
export async function parseInventoryReply(text: string, awaiting: string[]): Promise<{ costPrice?: number; marginPercent?: number; salePrice?: number; quantity?: number }> {
  const system = `Extraia valores numéricos de uma resposta de lojista brasileiro sobre um produto que está cadastrando. Campos possíveis: costPrice (quanto pagou/custo), marginPercent (margem de lucro em %), salePrice (preço de venda final, se ele disse direto), quantity (quantidade em estoque, unidades inteiras). Responda SOMENTE um JSON só com os campos que a mensagem realmente informa (omita o resto, NUNCA invente ou assuma um valor não dito). Campos que a IA está aguardando nesta pergunta: ${awaiting.join(", ")}.`;
  const raw = await chat(text, { json: true, temperature: 0, system });
  try {
    const parsed = JSON.parse(raw || "{}");
    const out: { costPrice?: number; marginPercent?: number; salePrice?: number; quantity?: number } = {};
    if (Number.isFinite(Number(parsed.costPrice)) && Number(parsed.costPrice) > 0) out.costPrice = Number(parsed.costPrice);
    if (Number.isFinite(Number(parsed.marginPercent)) && Number(parsed.marginPercent) >= 0) out.marginPercent = Number(parsed.marginPercent);
    if (Number.isFinite(Number(parsed.salePrice)) && Number(parsed.salePrice) > 0) out.salePrice = Number(parsed.salePrice);
    if (Number.isFinite(Number(parsed.quantity)) && Number(parsed.quantity) >= 0) out.quantity = Math.round(Number(parsed.quantity));
    return out;
  } catch {
    return {};
  }
}

/**
 * Provador Virtual (FAS-1, ADR-035): valida a FOTO GUIADA contra os critérios
 * da seção 6.2 do PRD-E-006 (uma pessoa adulta, corpo inteiro, frontal, boa
 * luz, sem nudez, sem múltiplas pessoas, sem documento em primeiro plano).
 * Devolve JSON estruturado com flags booleanas — quem mapeia flags para as
 * mensagens de recusa LEGÍVEIS (seção 6.3) é código nosso, determinístico
 * (FashionAvatarService.evaluatePhotoReport): o texto mostrado à cliente
 * nunca vem de texto livre da IA, então nunca pode "julgar aparência".
 */
export async function validateGuidedPhoto(base64: string, mimetype = "image/jpeg"): Promise<string> {
  const system = `Você avalia se uma foto serve para um provador virtual de roupas. Responda SOMENTE um JSON com flags booleanas objetivas:
{"singlePerson": <exatamente UMA pessoa visível?>, "adultApparent": <a pessoa aparenta ser adulta?>, "fullBody": <corpo inteiro visível, da cabeça aos pés?>, "frontal": <pose frontal ou quase frontal?>, "goodLighting": <iluminação/nitidez suficientes para distinguir a silhueta?>, "armsVisible": <braços não totalmente colados/escondidos?>, "safeContent": <SEM nudez, roupa íntima exposta ou conteúdo sexualizado?>, "noDocuments": <SEM documento, QR code ou dados de terceiros em primeiro plano?>}
Regras: avalie SÓ o que está pedido, com true/false. NUNCA descreva, avalie ou comente o corpo, peso, beleza ou aparência da pessoa.`;
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Avalie esta foto e devolva o JSON pedido." },
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
        ],
      },
    ] as any,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
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

/**
 * Extração estruturada genérica a partir de uma IMAGEM (multimodal, GPT-4o).
 * Recebe o system prompt (que define o schema/regras) e devolve o JSON cru.
 * Usado pelo SmartImportService (ADR-101) para "Importar PDF/imagem".
 */
export async function extractStructuredFromImage(base64: string, mimetype: string, system: string, userText = "Extraia os dados pedidos e devolva SOMENTE o JSON."): Promise<string> {
  const res = await getClient().chat.completions.create({
    model: process.env.OPENAI_VISION_MODEL || CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
      ] },
    ] as any,
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: "json_object" },
  });
  recordUsage(process.env.OPENAI_VISION_MODEL || CHAT_MODEL, "vision", res.usage?.prompt_tokens || 0, res.usage?.completion_tokens || 0);
  return res.choices[0]?.message?.content || "";
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
