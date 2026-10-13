/**
 * VideoTranscriptionService — transcrição com tempo de um vídeo do Estúdio (ADR-207 F13b.4).
 *
 * Fluxo: criação (da empresa, kind video, pronta) → `FfmpegService.probe` (tem áudio?) → `extractAudio` (WAV mono 16 kHz em
 * pasta temporária, SEMPRE apagado) → `SpeechToTextProvider` → normaliza → grava em `video_transcripts` (1 por criação).
 * Texto e tempos ficam SEPARADOS do vídeo; correções de texto vão em `edited_segments_json` (tempos preservados, original
 * intacto) — base da legenda editável (F13b.5) e do remapeamento após cortes (F13b.6).
 *
 * Custo: o provider registra no ledger `ai_usage_log` (por minuto, atribuído à org/`video:<creationId>`). Controles: 1 por
 * criação (reaproveita, sem custo; `force` refaz e descarta edições), teto diário por empresa, vídeo ≤ limite do upload.
 * Honestidade: sem áudio / sem fala → diz isso (nunca inventa texto); provider fora → mensagem de cliente, nada gravado.
 * Texto transcrito = dado não confiável (fala de terceiros): só guardado/exibido.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { FfmpegService, FfmpegError } from "./FfmpegService.js";
import { SpeechToTextProvider, getSpeechToTextProvider, TranscriptSegment } from "./SpeechToTextProvider.js";
import { usageContext } from "./usageContext.js";

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // limite do Whisper é 25 MB
const MAX_PER_DAY = () => Number(process.env.VIDEO_TRANSCRIBE_MAX_PER_DAY) || 20;

const MESSAGES: Record<string, string> = {
  not_found: "Vídeo do Estúdio não encontrado.",
  not_ready: "Esse vídeo ainda não está pronto.",
  no_file: "Esse vídeo não tem um arquivo para transcrever.",
  no_audio: "Esse vídeo não tem áudio para transcrever.",
  unavailable: "A transcrição não está disponível neste servidor no momento.",
  media_unavailable: "O processamento de vídeo não está disponível neste servidor no momento.",
  audio_too_large: "O áudio desse vídeo é grande demais para transcrever.",
  daily_limit: "Você atingiu o limite de transcrições de hoje. Tente amanhã.",
  failed: "Não consegui transcrever esse vídeo. Tente de novo em instantes.",
  no_transcript: "Esse vídeo ainda não foi transcrito.",
  bad_edit: "Edição inválida.",
};
export class TranscriptionError extends Error { constructor(public code: string) { super(MESSAGES[code] || MESSAGES.failed); this.name = "TranscriptionError"; } }

export interface VideoTranscript {
  creationId: string; provider: string | null; language: string | null; text: string; speechDetected: boolean; audioSeconds: number | null;
  segments: TranscriptSegment[];          // original do provider
  editedSegments: TranscriptSegment[] | null; // com correções de texto (mesmos tempos)
  effectiveSegments: TranscriptSegment[]; // o que a legenda deve usar: editado, senão original
  words: TranscriptSegment[]; edited: boolean; cached?: boolean; createdAt: string;
}

function cleanText(s: unknown, max = 400): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function parse<T>(v: any, fb: T): T { try { return v ? JSON.parse(v) : fb; } catch { return fb; } }

/** Normaliza o retorno do provider: ordena, clampa ao áudio, descarta vazio/invertido. Pura. */
export function normalizeSegments(segs: TranscriptSegment[], durationMs: number | null): TranscriptSegment[] {
  const cap = durationMs && durationMs > 0 ? durationMs + 500 : Infinity;
  return (segs || [])
    .map((x) => ({ startMs: Math.max(0, Math.round(x.startMs)), endMs: Math.min(cap, Math.round(x.endMs)), text: cleanText(x.text) }))
    .filter((x) => x.text && Number.isFinite(x.startMs) && Number.isFinite(x.endMs) && x.endMs > x.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

export class VideoTranscriptionService {
  static provider: SpeechToTextProvider | null = null;
  static getProvider(): SpeechToTextProvider { return this.provider || getSpeechToTextProvider(); }

  /** Capacidade DESCOBERTA: precisa de ffmpeg (extrair áudio) E de um provider de fala disponível. */
  static async available(): Promise<boolean> {
    return (await FfmpegService.available()).available && this.getProvider().available();
  }

  private static view(r: any, cached?: boolean): VideoTranscript {
    const segments = parse<TranscriptSegment[]>(r.segments_json, []);
    const edited = r.edited_segments_json ? parse<TranscriptSegment[] | null>(r.edited_segments_json, null) : null;
    return {
      creationId: r.creation_id, provider: r.provider, language: r.language, text: r.text || "", speechDetected: r.speech_detected === 1,
      audioSeconds: r.audio_seconds ?? null, segments, editedSegments: edited, effectiveSegments: edited || segments,
      words: parse<TranscriptSegment[]>(r.words_json, []), edited: !!edited, cached, createdAt: r.created_at,
    };
  }

  static get(orgId: string, creationId: string): VideoTranscript | null {
    const r = db.prepare("SELECT * FROM video_transcripts WHERE organization_id = ? AND creation_id = ?").get(orgId, creationId) as any;
    return r ? this.view(r) : null;
  }

  private static inflight = new Map<string, Promise<VideoTranscript>>();

  /** Clique duplo/requisições simultâneas na MESMA criação compartilham uma só transcrição (um só custo). */
  static transcribe(orgId: string, userId: string | null, creationId: string, opts: { force?: boolean; language?: string } = {}): Promise<VideoTranscript> {
    const key = `${orgId}:${creationId}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(orgId, userId, creationId, opts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private static async run(orgId: string, userId: string | null, creationId: string, opts: { force?: boolean; language?: string }): Promise<VideoTranscript> {
    const c = db.prepare("SELECT id, kind, media_url, status FROM studio_creations WHERE id = ? AND organization_id = ?").get(String(creationId || ""), orgId) as any;
    if (!c || c.kind !== "video") throw new TranscriptionError("not_found");
    if (c.status && c.status !== "done") throw new TranscriptionError("not_ready");

    const existing = this.get(orgId, c.id);
    if (existing && !opts.force) return { ...existing, cached: true };

    const base = path.basename(String(c.media_url || ""));
    if (!base || !/\.(mp4|mov|webm)$/i.test(base)) throw new TranscriptionError("no_file");
    const inputPath = path.join(MEDIA_DIR, base);

    const provider = this.getProvider();
    if (!provider.available()) throw new TranscriptionError("unavailable");
    const today = (db.prepare("SELECT COUNT(*) n FROM video_transcripts WHERE organization_id = ? AND updated_at >= datetime('now','start of day')").get(orgId) as any).n;
    if (today >= MAX_PER_DAY()) throw new TranscriptionError("daily_limit");

    let wav: string | null = null;
    try {
      let meta;
      try { meta = await FfmpegService.probe(inputPath); }
      catch (e: any) { throw new TranscriptionError(e instanceof FfmpegError && e.code === "ffmpeg_unavailable" ? "media_unavailable" : "no_file"); }
      if (!meta.hasAudio) throw new TranscriptionError("no_audio");

      wav = path.join(os.tmpdir(), `zf-stt-${randomUUID()}.wav`);
      try { await FfmpegService.extractAudio(orgId, inputPath, wav); }
      catch (e: any) { throw new TranscriptionError(e instanceof FfmpegError && e.code === "ffmpeg_unavailable" ? "media_unavailable" : "failed"); }
      if (fs.statSync(wav).size > MAX_AUDIO_BYTES) throw new TranscriptionError("audio_too_large");

      const audioSeconds = meta.durationMs / 1000;
      let out;
      try {
        out = await usageContext.run({ orgId, userId: userId || null, module: "studio", correlationId: `video:${c.id}` },
          () => provider.transcribe({ organizationId: orgId, mediaPath: wav!, language: opts.language, durationSec: audioSeconds }));
      } catch { throw new TranscriptionError("failed"); }

      const segments = normalizeSegments(out.segments, meta.durationMs);
      const words = normalizeSegments(out.words || [], meta.durationMs);
      const text = cleanText(out.text, 20000);
      const speech = segments.length > 0 && text.length > 0;
      const row = [randomUUID(), orgId, c.id, provider.id, out.language || null, speech ? text : "", JSON.stringify(speech ? segments : []), JSON.stringify(speech ? words : []), speech ? 1 : 0, audioSeconds];
      db.prepare(`INSERT INTO video_transcripts (id, organization_id, creation_id, provider, language, text, segments_json, words_json, speech_detected, audio_seconds)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (organization_id, creation_id) DO UPDATE SET provider = excluded.provider, language = excluded.language, text = excluded.text,
                    segments_json = excluded.segments_json, words_json = excluded.words_json, edited_segments_json = NULL, speech_detected = excluded.speech_detected,
                    audio_seconds = excluded.audio_seconds, updated_at = CURRENT_TIMESTAMP`).run(...row);
      return this.get(orgId, c.id)!;
    } finally {
      if (wav) { try { fs.rmSync(wav, { force: true }); } catch { /* noop */ } }
    }
  }

  /** Corrige o TEXTO de frases (índice na lista original). Tempos e original preservados; `text:""` remove a frase da legenda. */
  static editText(orgId: string, creationId: string, edits: Array<{ index: number; text: string }>): VideoTranscript {
    const cur = this.get(orgId, creationId);
    if (!cur) throw new TranscriptionError("no_transcript");
    if (!Array.isArray(edits) || !edits.length) throw new TranscriptionError("bad_edit");
    const next = (cur.editedSegments || cur.segments).map((s) => ({ ...s }));
    for (const e of edits) {
      const i = Number(e?.index);
      if (!Number.isInteger(i) || i < 0 || i >= next.length || typeof e?.text !== "string") throw new TranscriptionError("bad_edit");
      next[i].text = cleanText(e.text);
    }
    db.prepare("UPDATE video_transcripts SET edited_segments_json = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND creation_id = ?").run(JSON.stringify(next), orgId, creationId);
    return this.get(orgId, creationId)!;
  }
}

export default VideoTranscriptionService;
