/**
 * VideoSubtitleService — legenda automática (ADR-207 F13b.5). Transforma a transcrição com tempo (F13b.4, já com as
 * correções do dono) em legenda ASS pronta para queimar no vídeo pelo `FfmpegService` (filtro `ass`/libass).
 *
 * Tudo aqui é PURO e determinístico (sem ffmpeg, sem banco, sem rede): `buildCues` (quebra em linhas curtas, sem
 * sobreposição, recortada à janela do vídeo editado) e `toAss` (formato ASS). ASS e não SRT porque permite posição, contorno e
 * área segura. Estilo v1: 1–2 linhas, centralizada, base segura da tela, branco com contorno preto — legível sobre qualquer fundo.
 *
 * A fala NUNCA é alterada pelo sistema: nada de censura nem reescrita (só o dono edita o texto, na transcrição). Termos
 * que a marca não usa viram AVISO (`flagged`), não troca. O texto transcrito é dado não confiável: o ASS só o recebe
 * escapado (sem chaves de override, sem quebra de linha injetada) e sem caracteres de controle.
 *
 * A fonte (DejaVu Sans Bold, licença livre) vem EMPACOTADA em `assets/fonts` — o servidor não precisa ter fonte instalada.
 * Sem a fonte (ou sem libass no ffmpeg) a capacidade fica indisponível e dita; nunca renderiza com fonte aleatória.
 */
import fs from "node:fs";
import path from "node:path";
import { FfmpegService } from "./FfmpegService.js";
import type { TranscriptSegment } from "./SpeechToTextProvider.js";

export type SubtitleAspect = "9:16" | "1:1" | "16:9";
export interface SubtitleCue { startMs: number; endMs: number; lines: string[] }

// Resolução nominal do ASS por proporção (libass escala para o tamanho real do vídeo): o tamanho da fonte e as margens
// ficam proporcionais em qualquer resolução de origem.
const PLAY_RES: Record<SubtitleAspect, { w: number; h: number }> = { "9:16": { w: 1080, h: 1920 }, "1:1": { w: 1080, h: 1080 }, "16:9": { w: 1920, h: 1080 } };
// Caracteres por linha e margem inferior (área segura: a base do Reels/TikTok/Shorts é coberta por legenda/botões da plataforma).
const LAYOUT: Record<SubtitleAspect, { maxChars: number; fontSize: number; marginV: number; marginLR: number }> = {
  "9:16": { maxChars: 24, fontSize: 74, marginV: 300, marginLR: 90 },
  "1:1": { maxChars: 28, fontSize: 60, marginV: 120, marginLR: 80 },
  "16:9": { maxChars: 42, fontSize: 56, marginV: 70, marginLR: 140 },
};
const MIN_CUE_MS = 700;
const MAX_LINES = 2;

export const FONT_FILE = "DejaVuSans-Bold.ttf";
export function fontsDir(): string { return process.env.SUBTITLE_FONTS_DIR || path.join(process.cwd(), "assets", "fonts"); }

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029]", "g");
function clean(s: string): string { return String(s || "").replace(CONTROL, " ").replace(/\s+/g, " ").trim(); }

/** Quebra um texto em linhas de até `maxChars` (por palavras; palavra maior que a linha fica sozinha, sem cortar). */
export function wrapLines(text: string, maxChars: number): string[] {
  const words = clean(text).split(" ").filter(Boolean);
  const lines: string[] = []; let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Segmentos → cues. Cada segmento vira 1+ cues de até 2 linhas; o tempo de um segmento longo é dividido proporcionalmente ao
 * tamanho do texto. Sem sobreposição (o fim de uma cue nunca passa do início da próxima), duração mínima, e recortado à janela
 * [windowStartMs, windowEndMs] (a parte do vídeo que ficou), com tempos relativos ao início dessa janela.
 */
export function buildCues(segments: TranscriptSegment[], opts: { aspect: SubtitleAspect; windowStartMs?: number; windowEndMs?: number }): SubtitleCue[] {
  const lay = LAYOUT[opts.aspect] || LAYOUT["9:16"];
  const w0 = Math.max(0, opts.windowStartMs ?? 0), w1 = opts.windowEndMs ?? Infinity;
  const raw: SubtitleCue[] = [];
  for (const seg of [...(segments || [])].sort((a, b) => a.startMs - b.startMs)) {
    const lines = wrapLines(seg.text, lay.maxChars);
    if (!lines.length || !(seg.endMs > seg.startMs)) continue;
    const groups: string[][] = [];
    for (let i = 0; i < lines.length; i += MAX_LINES) groups.push(lines.slice(i, i + MAX_LINES));
    const total = groups.reduce((a, g) => a + g.join(" ").length, 0) || 1;
    let t = seg.startMs; const span = seg.endMs - seg.startMs;
    groups.forEach((g, i) => {
      const share = Math.round((g.join(" ").length / total) * span);
      const end = i === groups.length - 1 ? seg.endMs : Math.min(seg.endMs, t + share);
      raw.push({ startMs: t, endMs: end, lines: g });
      t = end;
    });
  }
  const out: SubtitleCue[] = [];
  for (let i = 0; i < raw.length; i++) {
    let { startMs, endMs } = raw[i];
    const nextStart = raw[i + 1]?.startMs ?? Infinity;
    endMs = Math.min(Math.max(endMs, startMs + MIN_CUE_MS), nextStart);   // mínimo legível, mas nunca invade a próxima
    if (endMs <= startMs) continue;
    const s = Math.max(startMs, w0), e = Math.min(endMs, w1);             // recorta à janela do vídeo editado
    if (e - s < 200) continue;
    out.push({ startMs: s - w0, endMs: e - w0, lines: raw[i].lines });
  }
  return out;
}

// Título e CTA na imagem (F13b.7): mesmo arquivo ASS e mesma fonte empacotada da legenda (sem dependência nova).
// Título no TOPO (abaixo da barra do app) e CTA no MEIO — a base fica livre pra legenda e pros botões da plataforma.
const OVERLAY_LAYOUT: Record<SubtitleAspect, { title: { fontSize: number; maxChars: number; marginV: number; maxLines: number }; cta: { fontSize: number; maxChars: number; maxLines: number } }> = {
  "9:16": { title: { fontSize: 84, maxChars: 20, marginV: 260, maxLines: 3 }, cta: { fontSize: 72, maxChars: 22, maxLines: 3 } },
  "1:1": { title: { fontSize: 64, maxChars: 26, marginV: 70, maxLines: 2 }, cta: { fontSize: 58, maxChars: 28, maxLines: 2 } },
  "16:9": { title: { fontSize: 58, maxChars: 40, marginV: 60, maxLines: 2 }, cta: { fontSize: 52, maxChars: 40, maxLines: 2 } },
};
export interface OverlayEvent { startMs: number; endMs: number; kind: "title" | "cta"; lines: string[] }
const TITLE_MAX_MS = 3000, CTA_MAX_MS = 3000, OVERLAY_GAP_MS = 300, CTA_MIN_MS = 1000;

/** Quebra em linhas e, se passar do máximo, corta com reticências (nunca estoura a tela). */
function fitLines(text: string, maxChars: number, maxLines: number): string[] {
  const lines = wrapLines(text, maxChars);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines); const last = kept[maxLines - 1];
  kept[maxLines - 1] = (last.length >= maxChars ? last.slice(0, Math.max(1, maxChars - 1)).trimEnd() : last) + "…";
  return kept;
}

/**
 * Título nos primeiros segundos e CTA nos últimos, sem se sobreporem. Vídeo curto: o título ocupa no máx. 45% do vídeo;
 * se o CTA não couber (menos de 1 s depois do título + respiro), ele é OMITIDO e dito em `omitted` — nunca atropela o título.
 */
export function buildOverlays(opts: { aspect: SubtitleAspect; durationMs: number; title?: string | null; cta?: string | null }): { events: OverlayEvent[]; omitted: string[] } {
  const lay = OVERLAY_LAYOUT[opts.aspect] || OVERLAY_LAYOUT["9:16"];
  const D = Math.max(0, Math.round(opts.durationMs));
  const events: OverlayEvent[] = []; const omitted: string[] = [];
  const titleLines = opts.title ? fitLines(opts.title, lay.title.maxChars, lay.title.maxLines) : [];
  const ctaLines = opts.cta ? fitLines(opts.cta, lay.cta.maxChars, lay.cta.maxLines) : [];
  let titleEnd = 0;
  if (titleLines.length) {
    titleEnd = Math.min(TITLE_MAX_MS, Math.floor(D * 0.45));
    if (titleEnd < 700) { omitted.push("título"); titleEnd = 0; } else events.push({ startMs: 0, endMs: titleEnd, kind: "title", lines: titleLines });
  }
  if (ctaLines.length) {
    const floor = titleEnd ? titleEnd + OVERLAY_GAP_MS : 0;
    const start = Math.max(D - CTA_MAX_MS, floor);
    if (D - start < CTA_MIN_MS) omitted.push("CTA na imagem"); else events.push({ startMs: start, endMs: D, kind: "cta", lines: ctaLines });
  }
  return { events, omitted };
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
/** Texto → ASS: tira controle, neutraliza chaves de override ({\...}) e barras, junta linhas com \N. */
export function escapeAss(line: string): string {
  return clean(line).replace(/\\/g, "＼").replace(/\{/g, "(").replace(/\}/g, ")");
}

/** Cues → arquivo ASS (UTF-8). Estilo: fonte empacotada em negrito, branco com contorno preto, centralizada embaixo (área segura). */
export function toAss(cues: SubtitleCue[], opts: { aspect: SubtitleAspect; overlays?: OverlayEvent[] }): string {
  const res = PLAY_RES[opts.aspect] || PLAY_RES["9:16"], lay = LAYOUT[opts.aspect] || LAYOUT["9:16"], ov = OVERLAY_LAYOUT[opts.aspect] || OVERLAY_LAYOUT["9:16"];
  const header = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${res.w}`, `PlayResY: ${res.h}`, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,DejaVu Sans,${lay.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,0,2,${lay.marginLR},${lay.marginLR},${lay.marginV},1`,
    // Título: topo, branco com contorno. CTA: meio da tela em caixa escura opaca (BorderStyle 3) — destaca sem cobrir a base.
    `Style: Title,DejaVu Sans,${ov.title.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,0,8,${lay.marginLR},${lay.marginLR},${ov.title.marginV},1`,
    `Style: Cta,DejaVu Sans,${ov.cta.fontSize},&H00FFFFFF,&H00FFFFFF,&H00202020,&H00202020,-1,0,0,0,100,100,0,0,3,22,0,5,${lay.marginLR},${lay.marginLR},0,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map((c) => `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Default,,0,0,0,,${c.lines.map(escapeAss).join("\\N")}`);
  // fad = entrada/saída suaves; a tag é nossa (o texto vem ANTES escapado, sem chaves).
  const overlayEvents = (opts.overlays || []).map((o) => `Dialogue: 1,${assTime(o.startMs)},${assTime(o.endMs)},${o.kind === "title" ? "Title" : "Cta"},,0,0,0,,{\\fad(250,250)}${o.lines.map(escapeAss).join("\\N")}`);
  return [...header, ...events, ...overlayEvents, ""].join("\n");
}

export class VideoSubtitleService {
  /** Fonte empacotada presente? */
  static fontAvailable(): boolean { try { return fs.statSync(path.join(fontsDir(), FONT_FILE)).isFile(); } catch { return false; } }
  /** Capacidade DESCOBERTA: ffmpeg com libass (`ass`) + fonte empacotada. */
  static async available(): Promise<boolean> { return this.fontAvailable() && (await FfmpegService.hasFilter("ass")); }

  /** Termos que a marca não usa e aparecem na fala — só AVISO (a fala não é alterada). */
  static async flagged(orgId: string, cues: SubtitleCue[]): Promise<string[]> {
    return this.forbiddenIn(orgId, cues.map((c) => c.lines.join(" ")).join(" "));
  }
  /** Termos proibidos pela marca dentro de um texto qualquer (título/CTA são texto NOSSO ou do dono → quem chama recusa). */
  static async forbiddenIn(orgId: string, text: string): Promise<string[]> {
    try {
      const { BrandDnaService } = await import("./BrandDnaService.js");
      const dna = await BrandDnaService.get(orgId);
      const low = String(text || "").toLowerCase();
      return (dna.forbidden || []).filter((f) => f && low.includes(f.toLowerCase()));
    } catch { return []; }
  }
}

export default VideoSubtitleService;
