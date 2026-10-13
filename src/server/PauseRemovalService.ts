/**
 * PauseRemovalService — remoção de pausas (ADR-207 F13b.6). Detecta silêncios (ffmpeg `silencedetect`, via FfmpegService),
 * monta a lista de trechos MANTIDOS (EDL) e remapeia os tempos da legenda para o vídeo já cortado.
 *
 * Tudo que decide é PURO e determinístico (`parseSilences`, `buildKeepSegments`, `remapCues`): só a detecção toca o ffmpeg.
 * Modo CONSERVADOR (único na v1): só corta silêncio claro (limiar baixo, duração longa) e mantém um respiro antes e depois
 * de cada fala — melhor deixar uma pausa do que comer o início de uma palavra. Se o áudio tem música/ruído de fundo, o
 * silêncio nunca é detectado e o vídeo sai sem cortes (o resultado diz isso, não finge).
 *
 * Mapeamento de tempo: um instante dentro de um trecho removido não existe no vídeo novo. Início de cue que cai num corte
 * vai para o início do próximo trecho mantido; fim de cue que cai num corte vai para o fim do trecho mantido anterior.
 * A transformação é monótona, então cues que não se sobrepunham continuam sem se sobrepor.
 */
import { FfmpegService } from "./FfmpegService.js";
import type { SubtitleCue } from "./VideoSubtitleService.js";

export interface PauseOptions { noiseDb: number; minSilenceSec: number; paddingSec: number }
export const CONSERVATIVE: PauseOptions = { noiseDb: -35, minSilenceSec: 0.6, paddingSec: 0.15 };
export interface Span { startSec: number; endSec: number }
export interface KeepSegment extends Span { outStartSec: number }
export interface PauseResult { silences: Span[]; keep: KeepSegment[]; removedSec: number; removedCount: number; keptSec: number }

const MAX_CUTS = 80;      // limite do grafo de filtros: se houver mais pausas, corta só as mais longas
const MIN_KEPT_SEC = 1;   // nunca devolve um vídeo praticamente vazio

/** Saída do `silencedetect` (stderr) → intervalos de silêncio. Silêncio aberto até o fim usa `totalSec`. */
export function parseSilences(stderr: string, totalSec: number): Span[] {
  const out: Span[] = []; let open: number | null = null;
  for (const line of String(stderr || "").split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open !== null) { const end = Math.min(Number(e[1]), totalSec); if (end > open) out.push({ startSec: open, endSec: end }); open = null; }
  }
  if (open !== null && totalSec > open) out.push({ startSec: open, endSec: totalSec });
  return out.filter((x) => Number.isFinite(x.startSec) && Number.isFinite(x.endSec));
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Silêncios → trechos mantidos na janela [0, totalSec]. Cada silêncio ≥ minSilence vira um corte que PRESERVA `padding` junto da
 * fala (nas bordas do vídeo não há fala do outro lado, então o silêncio inicial/final é cortado sem respiro).
 */
export function buildKeepSegments(silences: Span[], totalSec: number, opts: PauseOptions = CONSERVATIVE): PauseResult {
  const cuts: Span[] = [];
  for (const s of [...silences].sort((a, b) => a.startSec - b.startSec)) {
    if (s.endSec - s.startSec < opts.minSilenceSec) continue;
    const a = s.startSec <= 0.001 ? 0 : s.startSec + opts.paddingSec;
    const b = s.endSec >= totalSec - 0.001 ? totalSec : s.endSec - opts.paddingSec;
    if (b - a > 0.05) cuts.push({ startSec: Math.max(0, a), endSec: Math.min(totalSec, b) });
  }
  const used = cuts.length > MAX_CUTS ? [...cuts].sort((x, y) => (y.endSec - y.startSec) - (x.endSec - x.startSec)).slice(0, MAX_CUTS).sort((x, y) => x.startSec - y.startSec) : cuts;
  const keep: KeepSegment[] = []; let pos = 0, out = 0;
  for (const c of used) {
    if (c.startSec > pos + 0.001) { keep.push({ startSec: r3(pos), endSec: r3(c.startSec), outStartSec: r3(out) }); out += c.startSec - pos; }
    pos = Math.max(pos, c.endSec);
  }
  if (totalSec > pos + 0.001) { keep.push({ startSec: r3(pos), endSec: r3(totalSec), outStartSec: r3(out) }); out += totalSec - pos; }
  const keptSec = r3(out);
  if (!used.length || keptSec < MIN_KEPT_SEC) return { silences, keep: [{ startSec: 0, endSec: r3(totalSec), outStartSec: 0 }], removedSec: 0, removedCount: 0, keptSec: r3(totalSec) };
  return { silences, keep, removedSec: r3(totalSec - keptSec), removedCount: used.length, keptSec };
}

/** Instante do vídeo original → instante no cortado. `edge`: "start" cai no próximo trecho mantido; "end", no anterior. */
export function remapMs(ms: number, keep: KeepSegment[], edge: "start" | "end"): number | null {
  const t = ms / 1000;
  if (edge === "start") {
    for (const k of keep) { if (t < k.endSec) return Math.round((k.outStartSec + Math.max(0, t - k.startSec)) * 1000); }
    return null;
  }
  for (let i = keep.length - 1; i >= 0; i--) { const k = keep[i]; if (t > k.startSec) return Math.round((k.outStartSec + Math.min(t, k.endSec) - k.startSec) * 1000); }
  return null;
}

/** Cues do vídeo original → cues do vídeo cortado. Cue que sumiu inteira num corte é descartada. */
export function remapCues(cues: SubtitleCue[], keep: KeepSegment[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const s = remapMs(c.startMs, keep, "start"), e = remapMs(c.endMs, keep, "end");
    if (s === null || e === null || e - s < 200) continue;
    out.push({ ...c, startMs: s, endMs: e });
  }
  return out;
}

export class PauseRemovalService {
  /** Detecta as pausas do áudio da janela [0, windowSec] e devolve os trechos mantidos. Sem áudio → erro claro. */
  static async analyze(inputPath: string, windowSec: number, opts: PauseOptions = CONSERVATIVE, signal?: AbortSignal): Promise<PauseResult> {
    const info = await FfmpegService.probe(inputPath, signal);
    if (!info.hasAudio) throw new Error("Esse vídeo não tem áudio — não há pausas para remover.");
    const total = Math.min(windowSec, info.durationMs > 0 ? info.durationMs / 1000 : windowSec);
    const silences = await FfmpegService.detectSilence(inputPath, { noiseDb: opts.noiseDb, minSilenceSec: opts.minSilenceSec, windowSec: total, signal });
    return buildKeepSegments(silences.map((s) => ({ startSec: s.startSec, endSec: Math.min(s.endSec, total) })), total, opts);
  }
}
export default PauseRemovalService;
