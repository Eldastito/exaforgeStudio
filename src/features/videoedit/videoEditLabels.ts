// Editar vídeo (ADR-207 F13b.9) — regras PURAS da tela (testáveis sem navegador). A tela só chama rotas que já existem
// (`/api/studio/video-post/*`); nada aqui calcula resultado de edição — quem decide o que cabe/foi feito é o servidor.

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Caps { ffmpeg: boolean; transcription: boolean; canRenderCaptions: boolean }
export interface Availability { enabled: boolean; reason: string | null }
export interface Options { subtitles: Availability & { needsTranscript: boolean }; pauses: Availability; title: Availability; cta: Availability }

export function statusLabel(s: string): string {
  switch (s) {
    case 'queued': return 'Na fila — começa em instantes';
    case 'processing': return 'Editando o vídeo…';
    case 'completed': return 'Pronto!';
    case 'failed': return 'Não deu certo';
    case 'cancelled': return 'Cancelada';
    default: return 'Situação desconhecida';
  }
}
export const isActive = (s: string): boolean => s === 'queued' || s === 'processing';
export const isFinal = (s: string): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';
export const canCancel = isActive;

/** Intervalo entre consultas ao servidor: começa rápido e vai espaçando (sem martelar a API). */
export function pollDelayMs(attempt: number): number {
  const a = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(6000, 1500 + a * 500);
}
/** Para de consultar depois de ~15 min: a edição segue no servidor e aparece em "Edições recentes". */
export const MAX_POLL_ATTEMPTS = 200;

/**
 * O que o cliente pode marcar, a partir do que o servidor DESCOBRIU que consegue (nunca presumido).
 * Sem ffmpeg nada é possível. Legenda exige a capacidade de queimar E uma transcrição pronta (ou a possibilidade de fazê-la).
 */
export function optionAvailability(caps: Caps | null | undefined, hasTranscript: boolean): Options {
  const off = (reason: string): Availability => ({ enabled: false, reason });
  const on: Availability = { enabled: true, reason: null };
  if (!caps || !caps.ffmpeg) {
    const r = 'A edição de vídeo não está disponível neste servidor no momento.';
    return { subtitles: { ...off(r), needsTranscript: false }, pauses: off(r), title: off(r), cta: off(r) };
  }
  const textOk = caps.canRenderCaptions ? on : off('Texto na imagem indisponível neste servidor no momento.');
  let subtitles: Options['subtitles'];
  if (!caps.canRenderCaptions) subtitles = { ...off('Legenda na imagem indisponível neste servidor no momento.'), needsTranscript: false };
  else if (hasTranscript) subtitles = { ...on, needsTranscript: false };
  else if (caps.transcription) subtitles = { ...off('Transcreva o vídeo primeiro (usa IA e entra no custo).'), needsTranscript: true };
  else subtitles = { ...off('A transcrição não está disponível neste servidor no momento.'), needsTranscript: false };
  return { subtitles, pauses: on, title: textOk, cta: textOk };
}

export interface Form { creationId: string; channel: string; topic: string; subtitles: boolean; removePauses: boolean; title: boolean; titleText: string; cta: boolean; ctaText: string }
export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Monta o corpo do `POST /render-async`. Texto próprio só vai se preenchido; vazio = usa o texto do plano. */
export function buildRenderBody(f: Form, opts: Options): BodyResult {
  if (!f.creationId) return { ok: false, error: 'Escolha um vídeo.' };
  if (!f.channel) return { ok: false, error: 'Escolha onde o vídeo vai ser publicado.' };
  const topic = String(f.topic || '').trim();
  if (topic.length < 2) return { ok: false, error: 'Diga em poucas palavras do que é o vídeo.' };
  if (f.subtitles && !opts.subtitles.enabled) return { ok: false, error: opts.subtitles.reason || 'Legenda indisponível.' };
  if (f.removePauses && !opts.pauses.enabled) return { ok: false, error: opts.pauses.reason || 'Corte de pausas indisponível.' };
  if (f.title && !opts.title.enabled) return { ok: false, error: opts.title.reason || 'Título indisponível.' };
  if (f.cta && !opts.cta.enabled) return { ok: false, error: opts.cta.reason || 'Chamada indisponível.' };
  const own = (on: boolean, t: string) => (!on ? false : String(t || '').trim() ? String(t).trim().slice(0, 140) : true);
  return { ok: true, body: { creationId: f.creationId, channel: f.channel, topic, subtitles: f.subtitles, removePauses: f.removePauses, title: own(f.title, f.titleText), cta: own(f.cta, f.ctaText) } };
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${(Math.round(sec * 10) / 10).toString().replace('.', ',')} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s === 60 ? `${m + 1} min` : `${m} min ${String(s).padStart(2, '0')} s`;
}

export interface Pauses { removedCount: number; removedSec: number; durationBeforeSec: number; durationAfterSec: number }
export function pausesSummary(p: Pauses | null | undefined): string | null {
  if (!p) return null;
  if (!p.removedCount) return 'Não encontrei pausas claras para cortar (música ou barulho de fundo também atrapalham).';
  return `Cortei ${p.removedCount} ${p.removedCount === 1 ? 'pausa' : 'pausas'} (${formatDuration(p.removedSec)}): o vídeo foi de ${formatDuration(p.durationBeforeSec)} para ${formatDuration(p.durationAfterSec)}.`;
}

export interface Result { applied?: string[]; notApplied?: string[]; mediaUrl?: string; creationId?: string; durationSec?: number; note?: string; pauses?: Pauses; overlays?: { title: string | null; cta: string | null; omitted: string[] } }
const OPTION_NAMES: Record<string, string> = { subtitles: 'legenda', removePauses: 'remoção de pausas', title: 'título', cta: 'CTA na imagem' };
export type Requested = { subtitles: boolean; removePauses: boolean; title: boolean; cta: boolean };
/**
 * O que foi feito e, só do que o cliente PEDIU, o que não aconteceu (ex.: não havia pausa clara; o CTA não coube num vídeo curto).
 * Não lista "não feito" de coisas que ele nem marcou.
 */
export function resultSummary(r: Result | null | undefined, requested: Requested): { done: string[]; notDone: string[] } {
  if (!r) return { done: [], notDone: [] };
  const applied = r.applied || [];
  const done = applied.map((x) => x.charAt(0).toUpperCase() + x.slice(1));
  const omitted = new Set(r.overlays?.omitted || []);
  const notDone: string[] = [];
  for (const k of Object.keys(OPTION_NAMES) as (keyof Requested)[]) {
    const name = OPTION_NAMES[k];
    if (!requested[k] || applied.includes(name)) continue;
    if (omitted.has(name)) notDone.push(`${name.charAt(0).toUpperCase() + name.slice(1)}: não coube — o vídeo é curto demais`);
    else if (k === 'removePauses') notDone.push('Remoção de pausas: não encontrei pausas claras');
    else notDone.push(`${name.charAt(0).toUpperCase() + name.slice(1)}: não foi aplicado`);
  }
  return { done, notDone };
}

/** Texto de erro a partir da resposta HTTP — sempre algo que o cliente entende. */
export function errorText(status: number, body: any): string {
  const m = body && typeof body.error === 'string' && body.error.trim() ? body.error.trim() : '';
  if (m) return m;
  if (status === 401 || status === 403) return 'Você não tem permissão para isso. Entre de novo.';
  if (status === 404) return 'Não encontrei esse item.';
  if (status >= 500) return 'O servidor teve um problema. Tente de novo em instantes.';
  return 'Não foi possível concluir. Tente de novo.';
}

export function isVideoEditable(c: { kind?: string; status?: string; media_url?: string } | null | undefined): boolean {
  if (!c || !c.media_url) return false;
  if (c.status && c.status !== 'done') return false;
  return c.kind === 'video' || /\.(mp4|mov|webm)$/i.test(c.media_url);
}
