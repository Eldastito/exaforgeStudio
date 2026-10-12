/**
 * VideoPostProductionService — vídeo bruto → pronto, ATÉ ONDE DÁ (ADR-207 F13b).
 *
 * O que ENTREGA hoje (determinístico, sem LLM, sem tabela, sem tocar arquivo):
 *  - `plan`: PLANO DE EDIÇÃO por canal (cortes por beat, gancho nos primeiros segundos, remoção de pausas, legenda
 *    queimada, título, CTA, enquadramento) montado sobre o que já existe — roteiro (F4/`ScriptIntelligenceService`, que por
 *    sua vez reusa gancho F3 e Brand DNA F1) e normas de canal (F5/`ChannelAdaptationService`). É o roteiro que o dono, um
 *    editor ou um provider segue. NÃO existe 2º gerador de roteiro/gancho (§37).
 *  - `capabilities`: o que o SERVIDOR realmente consegue fazer, DESCOBERTO (binário `ffmpeg` presente? serviço de
 *    transcrição configurado?) — nunca presumido (RN-SI-06). Editar o arquivo de fato NÃO é feito aqui: `render.status`
 *    diz "awaiting_provider" e o motivo (precisa de ffmpeg + transcrição no servidor, ou provider externo — terceiro).
 *
 * Guardrails: RN-CG-09 (grounded — só o que foi informado; canal desconhecido rejeitado; duração-fonte desconhecida não
 * é inventada), RN-CG-04 (termo proibido pela marca já saneado pelo roteiro/gancho), PUBLISHED≠RESULTADO (plano ≠ vídeo
 * pronto: nada é publicado, nada é marcado como editado), publicar segue sendo `social_publish` governado (F11 PRD 10).
 */
import { spawnSync } from "child_process";
import { ScriptIntelligenceService } from "./ScriptIntelligenceService.js";
import { ChannelAdaptationService, SocialChannelName } from "./ChannelAdaptationService.js";

export interface VideoPostCapabilities {
  ffmpeg: boolean;                 // binário presente e respondeu -version
  transcription: boolean;          // VIDEO_TRANSCRIBE_URL configurado (legenda automática exige)
  canRenderTrimReframe: boolean;   // corte + enquadramento (só ffmpeg)
  canRenderCaptions: boolean;      // legenda queimada (ffmpeg + transcrição)
  renderImplemented: false;        // o render de arquivo NÃO está implementado nesta fatia
  notes: string[];
}

export interface VideoPostProvider {
  id: string;
  capabilities(): VideoPostCapabilities;
}

/** Provider honesto: descobre o ambiente e declara que o render ainda não está ligado. */
export class StubVideoPostProvider implements VideoPostProvider {
  id = "stub";
  capabilities(): VideoPostCapabilities {
    let ffmpeg = false;
    try { ffmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { timeout: 3000 }).status === 0; } catch { ffmpeg = false; }
    const transcription = !!process.env.VIDEO_TRANSCRIBE_URL;
    const notes: string[] = [];
    if (!ffmpeg) notes.push("ffmpeg não encontrado no servidor — corte/enquadramento não podem ser feitos aqui.");
    if (!transcription) notes.push("Sem serviço de transcrição configurado — legenda automática indisponível.");
    notes.push("A edição do arquivo ainda não está ligada: use o plano abaixo no seu editor ou conecte um provider de vídeo.");
    return { ffmpeg, transcription, canRenderTrimReframe: ffmpeg, canRenderCaptions: ffmpeg && transcription, renderImplemented: false, notes };
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
  render: { status: "awaiting_provider"; provider: string; capabilities: VideoPostCapabilities; reason: string };
  note: string;
}

function clip(s: string, max: number): string { return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + "…"; }
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

export class VideoPostProductionService {
  static provider: VideoPostProvider = new StubVideoPostProvider();

  static capabilities(): VideoPostCapabilities { return this.provider.capabilities(); }

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

    const capabilities = this.provider.capabilities();
    return {
      topic, objectiveId: script.objectiveId, sourceDurationSec: source, plans, skipped,
      render: { status: "awaiting_provider", provider: this.provider.id, capabilities, reason: "A edição automática do arquivo ainda não está ligada neste servidor; o plano é o roteiro de edição." },
      note: "Plano de edição, não vídeo pronto. Enquadramentos são recomendações editoriais (não limites oficiais). Publicar segue pelo fluxo governado.",
    };
  }
}

export default VideoPostProductionService;
