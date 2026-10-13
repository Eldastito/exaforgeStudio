/**
 * SpeechToTextProvider — contrato de transcrição com TEMPO (ADR-207 F13b.4). Separado do ffmpeg: o ffmpeg manipula mídia,
 * o provider transforma áudio em texto com timestamps. O Estúdio nunca fala com um fornecedor direto — só com este contrato.
 *
 * Provider real: Whisper (OpenAI) via `llm.transcribeAudioTimed` (reusa a chave e o ledger de IA `ai_usage_log`; sem 2º medidor).
 * Sem chave configurada → `available()` false (honesto: nunca finge transcrever). `StubSpeechToTextProvider` é determinístico
 * p/ testes. Texto transcrito é DADO NÃO CONFIÁVEL (vem da fala de terceiros): é só guardado/exibido, nunca vira instrução.
 */
import fs from "node:fs";
import path from "node:path";

export interface TranscriptSegment { startMs: number; endMs: number; text: string }
export interface TranscriptResult {
  text: string; language: string | null; durationSec: number | null;
  segments: TranscriptSegment[]; words: TranscriptSegment[];
}
export interface TranscribeInput { organizationId: string; mediaPath: string; language?: string; durationSec?: number }
export interface SpeechToTextProvider {
  id: string;
  available(): boolean;
  transcribe(input: TranscribeInput): Promise<TranscriptResult>;
}

export class OpenAiWhisperProvider implements SpeechToTextProvider {
  id = "openai-whisper";
  available(): boolean { return !!process.env.OPENAI_API_KEY; }
  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const { transcribeAudioTimed } = await import("./llm.js");
    const buf = fs.readFileSync(input.mediaPath);
    return transcribeAudioTimed(buf, path.basename(input.mediaPath) || "audio.wav", "audio/wav", { language: input.language, durationSec: input.durationSec });
  }
}

/** Determinístico (CI): devolve o roteiro injetado, ou um padrão fixo. Não faz rede. */
export class StubSpeechToTextProvider implements SpeechToTextProvider {
  id = "stub";
  constructor(private script: TranscriptResult | ((i: TranscribeInput) => TranscriptResult | Promise<TranscriptResult>) | null = null, private isAvailable = true) {}
  available(): boolean { return this.isAvailable; }
  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    if (typeof this.script === "function") return this.script(input);
    return this.script || {
      text: "Olá, esse é um teste. Vamos ver a coleção.", language: "pt", durationSec: 3,
      segments: [{ startMs: 0, endMs: 1500, text: "Olá, esse é um teste." }, { startMs: 1600, endMs: 3000, text: "Vamos ver a coleção." }],
      words: [],
    };
  }
}

const REGISTRY: Record<string, () => SpeechToTextProvider> = { "openai-whisper": () => new OpenAiWhisperProvider() };
/** STT_PROVIDER → registry → whisper. */
export function getSpeechToTextProvider(name?: string): SpeechToTextProvider {
  const key = name || process.env.STT_PROVIDER || "openai-whisper";
  return (REGISTRY[key] || REGISTRY["openai-whisper"])();
}
