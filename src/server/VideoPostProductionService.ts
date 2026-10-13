/**
 * VideoPostProductionService — vídeo bruto → pronto, ATÉ ONDE DÁ (ADR-207 F13b).
 *
 * O que ENTREGA hoje (determinístico, sem LLM, sem tabela, sem tocar arquivo):
 *  - `plan`: PLANO DE EDIÇÃO por canal (cortes por beat, gancho nos primeiros segundos, remoção de pausas, legenda
 *    queimada, título, CTA, enquadramento) montado sobre o que já existe — roteiro (F4/`ScriptIntelligenceService`, que por
 *    sua vez reusa gancho F3 e Brand DNA F1) e normas de canal (F5/`ChannelAdaptationService`). É o roteiro que o dono, um
 *    editor ou um provider segue. NÃO existe 2º gerador de roteiro/gancho (§37).
 *  - `capabilities`: o que o SERVIDOR realmente consegue fazer, DESCOBERTO (`FfmpegService.available()` roda `-version`;
 *    serviço de transcrição configurado?) — nunca presumido (RN-SI-06).
 *  - `render` (parcial): com ffmpeg disponível, CORTA e ENQUADRA (crop central) um vídeo do Estúdio conforme o plano do canal
 *    e salva como NOVA criação (a original nunca é alterada). Com `subtitles` queima a LEGENDA (F13b.5) a partir da transcrição
 *    (já com as correções do dono). NÃO aplica remoção de pausas, título nem CTA na imagem — a resposta diz o que foi aplicado
 *    e o que não foi. Todo ffmpeg passa por `FfmpegService`.
 *
 * Guardrails: RN-CG-09 (grounded — só o que foi informado; canal desconhecido rejeitado; duração-fonte desconhecida não
 * é inventada), RN-CG-04 (termo proibido pela marca já saneado pelo roteiro/gancho), PUBLISHED≠RESULTADO (plano ≠ vídeo
 * pronto: nada é publicado, nada é marcado como editado), publicar segue sendo `social_publish` governado (F11 PRD 10).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { FfmpegService, FfmpegError } from "./FfmpegService.js";
import { getSpeechToTextProvider } from "./SpeechToTextProvider.js";
import { VideoSubtitleService, buildCues, buildOverlays, toAss, fontsDir, type OverlayEvent } from "./VideoSubtitleService.js";
import { PauseRemovalService, remapCues, type PauseResult } from "./PauseRemovalService.js";
import { VideoTranscriptionService } from "./VideoTranscriptionService.js";
import { ScriptIntelligenceService } from "./ScriptIntelligenceService.js";
import { ChannelAdaptationService, SocialChannelName } from "./ChannelAdaptationService.js";

export interface VideoPostCapabilities {
  ffmpeg: boolean;                 // binário presente e respondeu -version
  transcription: boolean;          // VIDEO_TRANSCRIBE_URL configurado (legenda automática exige)
  canRenderTrimReframe: boolean;   // corte + enquadramento (só ffmpeg)
  canRenderCaptions: boolean;      // legenda queimada (ffmpeg + transcrição)
  renderImplemented: boolean;      // true quando há ffmpeg: corte + enquadramento (legenda/silêncio/título NÃO)
  notes: string[];
}

export interface VideoPostProvider {
  id: string;
  capabilities(): Promise<VideoPostCapabilities> | VideoPostCapabilities;
}

/** Provider embutido: ffmpeg do próprio servidor (`ffmpeg-static`), descoberto — nunca presumido. */
export class StubVideoPostProvider implements VideoPostProvider {
  id = "ffmpeg";
  async capabilities(): Promise<VideoPostCapabilities> {
    const av = await FfmpegService.available();
    const ffmpeg = av.available;
    const transcription = ffmpeg && getSpeechToTextProvider().available();
    const notes: string[] = [];
    if (!ffmpeg) notes.push("O processamento de vídeo não está disponível neste servidor no momento (ffmpeg).");
    else notes.push("Disponível: corte, enquadramento e legenda (com a transcrição). Remoção de pausas, título e CTA na imagem ainda não são aplicados.");
    if (!transcription) notes.push("A transcrição não está disponível neste servidor no momento.");
    const captions = ffmpeg && (await VideoSubtitleService.available());
    if (ffmpeg && !captions) notes.push("Legenda na imagem indisponível neste servidor (precisa do filtro de legenda do ffmpeg e da fonte empacotada).");
    return { ffmpeg, transcription, canRenderTrimReframe: ffmpeg, canRenderCaptions: captions, renderImplemented: ffmpeg, notes };
  }
}

// Enquadramento e tamanho de título por canal (recomendação editorial, não limite oficial da plataforma).
const VIDEO_NORMS: Record<SocialChannelName, { aspect: string; titleMax: number; supportsVideo: boolean }> = {
  instagram: { aspect: "9:16", titleMax: 60, supportsVideo: true },
  facebook: { aspect: "9:16", titleMax: 80, supportsVideo: true },
  tiktok: { aspect: "9:16", titleMax: 60, supportsVideo: true },
  youtube: { aspect: "9:16", titleMax: 70, supportsVideo: true },
  linkedin: { aspect: "1:1", titleMax: 100, supportsVideo: true },
  x: { aspect: "16:9", titleMax: 100, supportsVideo: true },
};

export interface EditStep { order: number; kind: "hook" | "segment" | "silence" | "captions" | "title" | "cta" | "reframe"; startSec?: number; endSec?: number; instruction: string; text?: string }
export interface ChannelEditPlan {
  channel: SocialChannelName; label: string; aspect: string; targetDurationSec: number;
  title: string; hookText: string; ctaText: string; steps: EditStep[]; caveats: string[];
}
export interface VideoPostPlan {
  topic: string; objectiveId: string | null; sourceDurationSec: number | null;
  plans: ChannelEditPlan[]; skipped: { channel: string; reason: string }[];
  render: { status: "partial_available" | "unavailable"; provider: string; capabilities: VideoPostCapabilities; reason: string };
  note: string;
}

export interface VideoRenderResult {
  creationId: string; mediaUrl: string; channel: string; aspect: string; startSec: number; durationSec: number;
  applied: string[]; notApplied: string[]; outputBytes: number; note: string;
  /** Só quando a remoção de pausas foi pedida: duração antes/depois e quanto foi cortado (0 = nenhuma pausa clara encontrada). */
  /** Só quando título/CTA foram pedidos: o que entrou na imagem e o que foi omitido por falta de espaço. */
  overlays?: { title: string | null; cta: string | null; omitted: string[] };
  pauses?: { removedCount: number; removedSec: number; durationBeforeSec: number; durationAfterSec: number };
}

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
const RENDER_MESSAGES: Record<string, string> = {
  ffmpeg_unavailable: "O processamento de vídeo não está disponível neste servidor no momento.",
  input_not_found: "Não encontrei o arquivo desse vídeo.",
  input_too_large: "Esse vídeo é grande demais para ser editado aqui.",
  timeout: "A edição demorou demais e foi interrompida. Tente um vídeo menor.",
  ffmpeg_failed: "Não consegui editar esse vídeo. Tente outro arquivo.",
  output_too_large: "O vídeo editado ficou grande demais.",
  busy: "Há edições demais em andamento. Tente de novo em instantes.",
};

function clip(s: string, max: number): string { return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + "…"; }
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

export class VideoPostProductionService {
  static provider: VideoPostProvider = new StubVideoPostProvider();

  static async capabilities(): Promise<VideoPostCapabilities> { return this.provider.capabilities(); }

  static async plan(orgId: string, input: { topic: string; objectiveId?: string | null; channels: string[]; sourceDurationSec?: number | null }): Promise<VideoPostPlan> {
    const topic = String(input?.topic || "").trim();
    if (!topic) throw new Error("Informe o tópico do vídeo.");
    const channels = Array.from(new Set((input?.channels || []).map((c) => String(c)))).filter(Boolean);
    if (!channels.length) throw new Error("Informe pelo menos um canal.");
    let source: number | null = null;
    if (input?.sourceDurationSec !== undefined && input?.sourceDurationSec !== null) {
      const n = Number(input.sourceDurationSec);
      if (!Number.isFinite(n) || n <= 0) throw new Error("Duração do vídeo bruto inválida.");
      source = Math.round(n);
    }

    const script = await ScriptIntelligenceService.generate(orgId, { topic, objectiveId: input.objectiveId ?? null, format: "reels" });
    const ctaBeat = script.beats[script.beats.length - 1];
    const body = script.beats.slice(1, -1);
    const bodyTotal = body.reduce((a, b) => a + b.durationSec, 0);

    const plans: ChannelEditPlan[] = [];
    const skipped: { channel: string; reason: string }[] = [];
    for (const channel of channels) {
      if (!ChannelAdaptationService.isKnownChannel(channel)) { skipped.push({ channel, reason: "canal desconhecido" }); continue; }
      const ch = channel as SocialChannelName;
      const norm = VIDEO_NORMS[ch];
      const label = ChannelAdaptationService.channels().find((c) => c.channel === ch)!.label;
      const caveats: string[] = [...script.caveats];

      // Duração-alvo: a do roteiro (formato reels, ~20 s), nunca maior que o bruto.
      let target = script.totalDurationSec;
      if (source !== null && source < target) { target = source; caveats.push("o vídeo bruto é mais curto que o roteiro — o plano usa só o que há"); }
      const hookLen = Math.min(script.beats[0].durationSec, target);
      const ctaLen = Math.min(ctaBeat.durationSec, Math.max(0, target - hookLen));
      const bodyAvail = Math.max(0, target - hookLen - ctaLen);

      const steps: EditStep[] = [];
      let t = 0; let n = 0;
      steps.push({ order: ++n, kind: "reframe", instruction: `Enquadrar em ${norm.aspect} mantendo o assunto no centro (margens seguras ~10% nas bordas pra legenda).` });
      steps.push({ order: ++n, kind: "hook", startSec: 0, endSec: hookLen, instruction: "Abrir com o trecho mais forte; texto do gancho na tela já no 1º segundo.", text: script.hook });
      t = hookLen;
      for (const b of body) {
        const len = bodyTotal > 0 ? Math.floor((b.durationSec / bodyTotal) * bodyAvail) : 0;
        if (len <= 0) continue;
        steps.push({ order: ++n, kind: "segment", startSec: t, endSec: t + len, instruction: `${b.label}: ${b.visual}`, text: b.script });
        t += len;
      }
      steps.push({ order: ++n, kind: "silence", instruction: "Cortar pausas e silêncios maiores que ~0,7 s entre falas (ritmo)." });
      steps.push({ order: ++n, kind: "captions", instruction: "Legenda queimada na tela, linhas curtas, contraste alto, dentro da margem segura." });
      const title = clip(cap(topic), norm.titleMax);
      steps.push({ order: ++n, kind: "title", instruction: `Título/capa (até ${norm.titleMax} caracteres).`, text: title });
      const channelCta = ChannelAdaptationService.adapt({ caption: topic, channel: ch }).cta;
      const ctaText = `${ctaBeat.script} ${channelCta}`.trim();
      if (ctaLen > 0) steps.push({ order: ++n, kind: "cta", startSec: t, endSec: t + ctaLen, instruction: "Tela final com marca + chamada clara.", text: ctaText });
      plans.push({ channel: ch, label, aspect: norm.aspect, targetDurationSec: t + ctaLen, title, hookText: script.hook, ctaText, steps, caveats });
    }

    const capabilities = await this.provider.capabilities();
    return {
      topic, objectiveId: script.objectiveId, sourceDurationSec: source, plans, skipped,
      render: capabilities.renderImplemented
        ? { status: "partial_available", provider: this.provider.id, capabilities, reason: "Dá para cortar, enquadrar, legendar, tirar pausas e pôr título/CTA automaticamente; trilha, cortes criativos e a publicação seguem manuais (use o plano)." }
        : { status: "unavailable", provider: this.provider.id, capabilities, reason: "O processamento de vídeo não está disponível neste servidor no momento; o plano é o roteiro de edição." },
      note: "Plano de edição, não vídeo pronto. Enquadramentos são recomendações editoriais (não limites oficiais). Publicar segue pelo fluxo governado.",
    };
  }

  /**
   * Corta e enquadra um vídeo do Estúdio da empresa conforme o plano do canal. Entrada: `creationId` (kind video, pronto).
   * A criação original é preservada; o resultado vira uma NOVA criação. Erros do ffmpeg viram mensagem de cliente.
   */
  static async render(orgId: string, input: { creationId: string; channel: string; topic: string; objectiveId?: string | null; subtitles?: boolean; removePauses?: boolean; title?: boolean | string; cta?: boolean | string }): Promise<VideoRenderResult> {
    const row = db.prepare("SELECT id, kind, media_url, status FROM studio_creations WHERE id = ? AND organization_id = ?").get(String(input?.creationId || ""), orgId) as any;
    if (!row || row.kind !== "video") throw new Error("Vídeo do Estúdio não encontrado.");
    if (row.status && row.status !== "done") throw new Error("Esse vídeo ainda não está pronto.");
    const base = path.basename(String(row.media_url || ""));
    if (!base || !/\.(mp4|mov|webm)$/i.test(base)) throw new Error("Esse vídeo não tem um arquivo editável.");
    const inputPath = path.join(MEDIA_DIR, base);

    const plan = await this.plan(orgId, { topic: input.topic, objectiveId: input.objectiveId ?? null, channels: [input.channel] });
    const cp = plan.plans[0];
    if (!cp) throw new Error("Canal não suportado para edição.");
    const aspect = cp.aspect as "9:16" | "1:1" | "16:9";
    const outName = `studio_${randomUUID()}.mp4`;

    // Pausas (opcional, modo conservador): detecta na janela do plano e monta os trechos mantidos (EDL).
    let pauseRes: PauseResult | null = null;
    if (input.removePauses) {
      pauseRes = await PauseRemovalService.analyze(inputPath, cp.targetDurationSec).catch((e: any) => {
        if (e instanceof FfmpegError) throw new Error(RENDER_MESSAGES[e.code] || RENDER_MESSAGES.ffmpeg_failed);
        throw e;
      });
      if (!pauseRes.removedCount) pauseRes = null;     // nada a cortar → render normal (dito no resultado)
    }
    const finalDuration = pauseRes ? pauseRes.keptSec : cp.targetDurationSec;

    // Título/CTA na imagem (opcional): texto do plano (ou o do dono), na tela só nos primeiros/últimos segundos.
    const wantTitle = !!input.title, wantCta = !!input.cta;
    let overlayEvents: OverlayEvent[] = []; let overlayInfo: VideoRenderResult["overlays"];
    if (wantTitle || wantCta) {
      const titleText = typeof input.title === "string" ? input.title.trim().slice(0, 140) : cp.title;
      const ctaText = typeof input.cta === "string" ? input.cta.trim().slice(0, 140) : cp.ctaText;
      if ((wantTitle && !titleText) || (wantCta && !ctaText)) throw new Error("O texto do título/CTA está vazio.");
      const bad = await VideoSubtitleService.forbiddenIn(orgId, `${wantTitle ? titleText : ""} ${wantCta ? ctaText : ""}`);
      if (bad.length) throw new Error(`O título/CTA contém termo(s) que a marca não usa (${bad.join(", ")}). Ajuste o texto.`);
      if (!(await VideoSubtitleService.available())) throw new Error("Título e CTA na imagem não estão disponíveis neste servidor no momento.");
      // Duração real do que vai pro ar: nunca marca o CTA depois do fim (fonte mais curta que o plano).
      let realMs = finalDuration * 1000;
      try { const info = await FfmpegService.probe(inputPath); if (info.durationMs > 0) realMs = Math.min(realMs, info.durationMs); }
      catch (e: any) { if (e instanceof FfmpegError) throw new Error(RENDER_MESSAGES[e.code] || RENDER_MESSAGES.ffmpeg_failed); throw e; }
      const built = buildOverlays({ aspect, durationMs: realMs, title: wantTitle ? titleText : null, cta: wantCta ? ctaText : null });
      overlayEvents = built.events;
      overlayInfo = { title: built.events.some((e) => e.kind === "title") ? titleText : null, cta: built.events.some((e) => e.kind === "cta") ? ctaText : null, omitted: built.omitted };
    }

    // Legenda (opcional): exige transcrição JÁ feita (não gasta IA escondido) e a capacidade de queimar (libass + fonte).
    let assPath: string | null = null; let subtitleNote = "";
    let subCues: ReturnType<typeof buildCues> = [];
    if (input.subtitles) {
      const tr = VideoTranscriptionService.get(orgId, row.id);
      if (!tr) throw new Error("Transcreva o vídeo antes de pedir a legenda.");
      if (!tr.speechDetected || !tr.effectiveSegments.length) throw new Error("Não detectei fala nesse vídeo para legendar.");
      if (!(await VideoSubtitleService.available())) throw new Error("A legenda na imagem não está disponível neste servidor no momento.");
      let cues = buildCues(tr.effectiveSegments, { aspect, windowStartMs: 0, windowEndMs: cp.targetDurationSec * 1000 });
      if (pauseRes) cues = remapCues(cues, pauseRes.keep);     // legenda segue o vídeo já cortado
      if (!cues.length) throw new Error("A legenda ficou vazia na parte do vídeo que será usada.");
      const flagged = await VideoSubtitleService.flagged(orgId, cues);
      if (flagged.length) subtitleNote = ` Atenção: a fala contém termo(s) que a marca não usa (${flagged.join(", ")}); a legenda reproduz a fala sem alterá-la.`;
      subCues = cues;
    }
    if (input.subtitles || overlayEvents.length) {
      assPath = path.join(os.tmpdir(), `zf-sub-${randomUUID()}.ass`);
      fs.writeFileSync(assPath, toAss(subCues, { aspect, overlays: overlayEvents }), "utf8");
    }
    try {
      const r = await FfmpegService.trimReframe(orgId, inputPath, path.join(MEDIA_DIR, outName), { startSec: 0, durationSec: cp.targetDurationSec, aspect, subtitles: assPath ? { assPath, fontsDir: fontsDir() } : undefined, keep: pauseRes ? pauseRes.keep : undefined });
      const hasTitle = !!overlayInfo?.title, hasCta = !!overlayInfo?.cta;
      const applied = ["corte", "enquadramento", ...(input.subtitles ? ["legenda"] : []), ...(pauseRes ? ["remoção de pausas"] : []), ...(hasTitle ? ["título"] : []), ...(hasCta ? ["CTA na imagem"] : [])];
      const notApplied = [...(input.subtitles ? [] : ["legenda"]), ...(pauseRes ? [] : ["remoção de pausas"]), ...(hasTitle ? [] : ["título"]), ...(hasCta ? [] : ["CTA na imagem"])];
      const mediaUrl = `/media/${outName}`;
      const id = randomUUID();
      db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, status, source) VALUES (?, ?, 'video', ?, ?, 'done', 'edited')").run(id, orgId, `edição para ${cp.label} (corte + enquadramento${pauseRes ? " + pausas" : ""}${overlayInfo?.title || overlayInfo?.cta ? " + título/CTA" : ""})`, mediaUrl);
      return {
        creationId: id, mediaUrl, channel: cp.channel, aspect, startSec: 0, durationSec: finalDuration,
        applied, notApplied, outputBytes: r.outputBytes,
        overlays: overlayInfo,
        pauses: input.removePauses ? { removedCount: pauseRes?.removedCount ?? 0, removedSec: pauseRes?.removedSec ?? 0, durationBeforeSec: pauseRes ? Math.round((pauseRes.keptSec + pauseRes.removedSec) * 10) / 10 : cp.targetDurationSec, durationAfterSec: finalDuration } : undefined,
        note: `Cortei do início até a duração do plano, enquadrei no formato do canal${input.subtitles ? ", queimei a legenda" : ""}${hasTitle || hasCta ? `, coloquei ${[hasTitle && "o título", hasCta && "o CTA"].filter(Boolean).join(" e ")}` : ""}${pauseRes ? ` e removi ${pauseRes.removedCount} pausa(s) (${pauseRes.removedSec.toFixed(1)} s), mantendo um respiro junto das falas` : ""}. ${input.removePauses && !pauseRes ? "Não encontrei pausas claras para cortar (música ou ruído de fundo também impedem). " : ""}${overlayInfo?.omitted.length ? `Não coube (vídeo curto): ${overlayInfo.omitted.join(", ")}. ` : ""}O vídeo original não foi alterado. O restante do plano segue manual.${subtitleNote}`,
      };
    } catch (e: any) {
      if (e instanceof FfmpegError) throw new Error(RENDER_MESSAGES[e.code] || RENDER_MESSAGES.ffmpeg_failed);
      throw e;
    } finally {
      if (assPath) { try { fs.rmSync(assPath, { force: true }); } catch { /* noop */ } }
    }
  }
}

export default VideoPostProductionService;
