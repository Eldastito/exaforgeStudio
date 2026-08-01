import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * Comigo — Cadastro do catálogo por ÁUDIO (Gap A do levantamento autônomos, ADR-088 D2).
 *
 * "Digitar é o atrito." O empreendedor dita a lista de produtos ("bolo de pote P,
 * 8 reais; galeto inteiro, 45; água mineral, 3") e a IA transcreve (Whisper) +
 * extrai N itens estruturados. O SERVICE NÃO CRIA NADA — devolve um preview pro
 * dono revisar e confirmar linha a linha no front (mesmo padrão do Smart Inventory,
 * ADR-030/019: humano confirma antes de salvar).
 *
 * Guardas duros:
 * - Isolamento por organization_id em cap e audit.
 * - NUNCA inventa item: se a IA devolver lista vazia, source='empty'.
 * - Nomes normalizados (trim, tamanho máximo), tipos validados contra allow-list.
 * - Preço opcional (o dono pode ditar só "bolo de pote"); mas se ditar, tem que
 *   ser número > 0 — string tipo "combinar" é descartada silenciosamente.
 * - Teto por org/dia via ai_usage_log (kind='comigo_audio_catalog'). Whisper é
 *   caro (~10x chat por minuto), então default 30/dia.
 * - Áudio de min-length 0.5s exigido (evita transcrição vazia).
 *
 * Frugalidade: temperature 0, chat com json:true, prompt curto. O `chat()` e o
 * `transcribeAudio()` já registram custo real em ai_usage_log; NÓS gravamos um
 * meter separado ('comigo_audio_catalog') com 0 tokens/0 custo pra contar o cap
 * sem dupla contabilidade.
 */

import { chat as realChat, transcribeAudio as realTranscribe, isAIConfigured } from "./llm.js";

// ── Tipos ──────────────────────────────────────────────────────────────────
export type ProductKind = "product" | "service";
const VALID_KINDS: ProductKind[] = ["product", "service"];

export interface CatalogItem {
  name: string;
  price: number | null;    // null = não ditado, dono digita depois
  type: ProductKind;       // 'product' (padrão) | 'service'
  description: string | null;
  confidence: number;      // 0-100: quão certo o LLM está deste item
}
export type ParseSource = "llm" | "empty" | "no_transcript" | "cap_reached";
export interface ParseResult {
  transcript: string;      // sempre devolve o que Whisper ouviu (dono valida)
  items: CatalogItem[];    // até 20 itens
  source: ParseSource;
  capReached?: boolean;
}

const MAX_ITEMS = 20;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 200;

// ── Injeção pra teste (mesmo padrão de ComigoMenuSuggestService) ──────────
type ChatFn = (prompt: string, opts?: { temperature?: number; json?: boolean; system?: string }) => Promise<string>;
type TranscribeFn = (buffer: Buffer, filename?: string, mimetype?: string) => Promise<string>;
let chatFn: ChatFn = realChat;
let transcribeFn: TranscribeFn = realTranscribe;
let aiConfiguredFn: () => boolean = isAIConfigured;

export const _internals = {
  setChatFn(fn: ChatFn | null) { chatFn = fn || realChat; },
  setTranscribeFn(fn: TranscribeFn | null) { transcribeFn = fn || realTranscribe; },
  setAIConfiguredFn(fn: (() => boolean) | null) { aiConfiguredFn = fn || isAIConfigured; },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function llmCallsLast24h(orgId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM ai_usage_log
      WHERE organization_id = ? AND kind = 'comigo_audio_catalog'
        AND created_at >= datetime('now', '-1 day')`
  ).get(orgId) as any;
  return Number(row?.c) || 0;
}

function dailyCap(orgId: string): number {
  const row = db.prepare(
    `SELECT comigo_audio_catalog_daily_cap AS cap FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  const cap = Number(row?.cap);
  return Number.isFinite(cap) && cap >= 0 ? cap : 30;
}

function recordMeter(orgId: string): void {
  try {
    db.prepare(
      `INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl)
       VALUES (?, ?, 'meter', 'comigo_audio_catalog', 0, 0, 0, 0, 0)`
    ).run(randomUUID(), orgId);
  } catch { /* medição nunca pode quebrar */ }
}

/**
 * Extrai a lista de itens do TRANSCRITO. LLM decide `type` (product vs service)
 * a partir do próprio texto ("bolo" → product, "corte de cabelo" → service);
 * `product` é o default seguro. Preço vira null quando ditado como palavra
 * ("combinar", "sob consulta") em vez de número.
 */
function buildPrompt(transcript: string): { system: string; user: string } {
  const system = [
    "Você extrai uma LISTA de PRODUTOS/SERVIÇOS que um empreendedor brasileiro dita em áudio pra cadastrar rapidamente no catálogo do PDV.",
    'Responda SOMENTE um JSON com o shape: {"items":[{"name":"...","price":<número em reais ou null>,"type":"product"|"service","description":"...ou null","confidence":<0-100>}]}',
    "Regras rígidas:",
    "1) `name`: nome curto e comercial (ex.: 'Bolo de Pote P', 'Galeto Inteiro'). NUNCA invente item que não está no áudio.",
    "2) `price`: número em reais (use ponto decimal). Se o dono NÃO ditou preço, ou ditou algo tipo 'combinar' / 'sob consulta' / 'depois eu vejo', devolva null.",
    "3) `type`: 'service' quando é serviço mensurável em tempo (corte de cabelo, chave, tosa, consulta), senão 'product'. Na dúvida, 'product'.",
    "4) `description`: só se houver detalhe relevante ditado (ex.: 'com farofa e vinagrete'); senão null. NUNCA inventar detalhes decorativos.",
    "5) `confidence`: 90+ quando nome e preço vieram claros; 60-89 se preço veio ambíguo ou nome parcial; abaixo de 60 se dúvida real (ainda inclua no items, deixe o humano decidir).",
    "6) Se o áudio NÃO for uma lista de cadastro (conversa fiada, teste de mic, dúvida) devolva `items:[]`.",
    "7) NUNCA repita o mesmo item — se o dono se corrigiu ('bolo de pote 8 reais... não, 9'), use o último valor.",
    "8) Preserve a ORDEM em que os itens foram ditados.",
    `Devolva no MÁXIMO ${MAX_ITEMS} itens.`,
  ].join("\n");
  const user = `ÁUDIO TRANSCRITO:\n${transcript}\n\nExtraia os itens.`;
  return { system, user };
}

/** Parse defensivo. Formato inválido devolve []. */
function parseLLMResponse(raw: string): CatalogItem[] {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const arr = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: CatalogItem[] = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const name = String(x.name || "").trim().slice(0, MAX_NAME);
    if (!name) continue;
    const type: ProductKind = VALID_KINDS.includes(x.type) ? x.type : "product";
    const priceRaw = x.price;
    let price: number | null = null;
    if (priceRaw != null && priceRaw !== "" && Number.isFinite(Number(priceRaw))) {
      const n = Number(priceRaw);
      if (n > 0) price = Math.round(n * 100) / 100;   // arredonda a centavo
    }
    const description = x.description ? String(x.description).trim().slice(0, MAX_DESCRIPTION) : null;
    const conf = Number(x.confidence);
    const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : 60;
    out.push({ name, price, type, description: description || null, confidence });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ── API pública ────────────────────────────────────────────────────────────

export class ComigoAudioCatalogService {
  /**
   * Recebe áudio + mimetype, devolve transcript + lista de itens candidatos.
   * NUNCA salva nada. NUNCA lança pro caller — sempre devolve estado explícito
   * (source='no_transcript'|'empty'|'cap_reached'|'llm'). Front decide o UX.
   */
  static async parseAudio(orgId: string, buffer: Buffer, mimetype = "audio/ogg"): Promise<ParseResult> {
    // Áudio muito pequeno: quase certeza que é botão apertado sem querer.
    if (!buffer || buffer.length < 512) {
      return { transcript: "", items: [], source: "no_transcript" };
    }
    if (!aiConfiguredFn()) {
      // Sem OpenAI: não tem Whisper nem chat. Não fingimos que funcionou.
      return { transcript: "", items: [], source: "no_transcript" };
    }
    // Cap ANTES de Whisper (que é caro): se estourou, nem transcreve.
    const cap = dailyCap(orgId);
    const used = llmCallsLast24h(orgId);
    if (cap > 0 && used >= cap) {
      return { transcript: "", items: [], source: "cap_reached", capReached: true };
    }

    // Transcrição. Best-effort — se falhar (formato incompatível, rede), reporta.
    let transcript = "";
    try {
      const fname = mimetype.includes("webm") ? "audio.webm" : mimetype.includes("mp3") ? "audio.mp3" : mimetype.includes("wav") ? "audio.wav" : "audio.ogg";
      transcript = (await transcribeFn(buffer, fname, mimetype)).trim();
    } catch {
      return { transcript: "", items: [], source: "no_transcript" };
    }
    if (!transcript || transcript.length < 2) {
      return { transcript: "", items: [], source: "no_transcript" };
    }

    // A partir daqui gastamos LLM — conta contra o cap.
    recordMeter(orgId);

    const { system, user } = buildPrompt(transcript);
    let raw = "";
    try {
      raw = await chatFn(user, { system, json: true, temperature: 0 });
    } catch {
      // LLM caiu: devolve transcript pro front (dono digita à mão se quiser).
      return { transcript, items: [], source: "empty" };
    }
    const items = parseLLMResponse(raw);
    return { transcript, items, source: items.length > 0 ? "llm" : "empty" };
  }

  /** Status do cap (debug/UI). */
  static status(orgId: string): { cap: number; used: number; remaining: number; aiConfigured: boolean } {
    const cap = dailyCap(orgId);
    const used = llmCallsLast24h(orgId);
    return { cap, used, remaining: Math.max(0, cap - used), aiConfigured: aiConfiguredFn() };
  }
}

export default ComigoAudioCatalogService;
