/**
 * PublishPackageService — pacote de publicação ASSISTIDA (ADR-207 F13c).
 *
 * Para canais sem API conectada (TikTok/LinkedIn/YouTube/X — `AssistedChannelProvider`) devolve, por canal, o conteúdo JÁ
 * ADAPTADO às normas do canal (F5 `ChannelAdaptationService`: legenda, hashtags, formato, CTA), os passos manuais e o site
 * onde publicar. Para canal de vídeo e `topic`, anexa o plano de edição (F13b). Read-only, determinístico, sem tabela.
 *
 * Guardrails: RN-CG-04 (legenda com termo PROIBIDO pela marca é recusada, não "corrigida"), RN-CG-09 (só usa o que foi
 * informado; canal desconhecido → skipped; canal com API real conectada (instagram/facebook) NÃO é assistido → skipped,
 * o caminho dele é a publicação governada F11), PUBLISHED≠RESULTADO (o pacote não publica nada nem registra resultado:
 * sem API não há analytics — o resultado dessa publicação não entra no ciclo medido, e isso é dito).
 */
import { ChannelAdaptationService } from "./ChannelAdaptationService.js";
import { AssistedChannelProvider, isAssistedChannel, AssistedChannel } from "./AssistedChannelProvider.js";

// Site de entrada de cada plataforma (não é deep link de API): o dono cola o conteúdo lá.
const COMPOSE: Record<AssistedChannel, { label: string; url: string; steps: string[] }> = {
  tiktok: { label: "TikTok", url: "https://www.tiktok.com/upload", steps: ["Abra o envio de vídeo do TikTok.", "Envie o vídeo no formato indicado.", "Cole a legenda e as hashtags abaixo.", "Publique e guarde o link do vídeo."] },
  linkedin: { label: "LinkedIn", url: "https://www.linkedin.com/feed/", steps: ["Abra o LinkedIn e clique em \"Começar um post\".", "Cole o texto abaixo.", "Anexe o vídeo/imagem, se houver.", "Publique e guarde o link do post."] },
  youtube: { label: "YouTube", url: "https://studio.youtube.com/", steps: ["Abra o YouTube Studio e clique em \"Criar\" → \"Enviar vídeos\".", "Envie o vídeo (Shorts: vertical e curto).", "Cole título/descrição abaixo.", "Publique e guarde o link do vídeo."] },
  x: { label: "X", url: "https://x.com/compose/post", steps: ["Abra o X e crie um post.", "Cole o texto abaixo (respeite o limite).", "Anexe a mídia, se houver.", "Publique e guarde o link do post."] },
};

export interface PublishPackageChannel {
  channel: string; label: string; mode: "assisted"; publishStatus: "manual_required";
  content: { caption: string; hook: string | null; format: string; hashtags: string[]; cta: string; tone: string };
  changes: string[]; caveats: string[]; openUrl: string; steps: string[];
  videoPlan?: unknown;
}
export interface PublishPackage {
  packages: PublishPackageChannel[]; skipped: { channel: string; reason: string }[];
  note: string;
}

export class PublishPackageService {
  static async build(orgId: string, input: { caption: string; hook?: string | null; format?: string | null; hashtags?: string[]; channels: string[]; topic?: string | null; objectiveId?: string | null; sourceDurationSec?: number | null }): Promise<PublishPackage> {
    const caption = String(input?.caption || "").trim();
    if (!caption) throw new Error("Informe a legenda base.");
    const channels = Array.from(new Set((input?.channels || []).map((c) => String(c)))).filter(Boolean);
    if (!channels.length) throw new Error("Informe pelo menos um canal.");

    // Respeito à marca (RN-CG-04): termo proibido recusa; não reescreve por conta própria.
    try {
      const { BrandDnaService } = await import("./BrandDnaService.js");
      const dna = await BrandDnaService.get(orgId);
      const text = `${caption} ${input.hook || ""} ${(input.hashtags || []).join(" ")}`.toLowerCase();
      const hit = (dna.forbidden || []).find((f) => f && text.includes(f.toLowerCase()));
      if (hit) throw new Error(`O texto contém um termo que a marca não usa ("${hit}"). Ajuste antes de publicar.`);
    } catch (e: any) { if (/termo que a marca/.test(String(e?.message))) throw e; /* sem Brand DNA → segue */ }

    const packages: PublishPackageChannel[] = [];
    const skipped: { channel: string; reason: string }[] = [];
    for (const channel of channels) {
      if (!ChannelAdaptationService.isKnownChannel(channel)) { skipped.push({ channel, reason: "canal desconhecido" }); continue; }
      if (!isAssistedChannel(channel)) { skipped.push({ channel, reason: "este canal tem API conectada — use a publicação governada" }); continue; }
      const a = ChannelAdaptationService.adapt({ caption, hook: input.hook ?? null, format: input.format ?? null, hashtags: input.hashtags || [], channel });
      const meta = COMPOSE[channel];
      const pkg: PublishPackageChannel = {
        channel, label: meta.label, mode: "assisted", publishStatus: new AssistedChannelProvider(channel).publish({ kind: "text", idempotencyKey: "pkg" }).status as "manual_required",
        content: { caption: a.caption, hook: a.hook, format: a.format, hashtags: a.hashtags, cta: a.cta, tone: a.tone },
        changes: a.changes, caveats: a.caveats, openUrl: meta.url, steps: meta.steps,
      };
      if (input.topic && ["reel", "video", "short"].includes(a.format)) {
        try {
          const { VideoPostProductionService } = await import("./VideoPostProductionService.js");
          const vp = await VideoPostProductionService.plan(orgId, { topic: String(input.topic), objectiveId: input.objectiveId ?? null, channels: [channel], sourceDurationSec: input.sourceDurationSec ?? null });
          pkg.videoPlan = vp.plans[0] || null;
        } catch { /* plano é complemento; falha não derruba o pacote */ }
      }
      packages.push(pkg);
    }
    return { packages, skipped, note: "Publicação assistida: o sistema NÃO publica nesses canais e não mede o resultado (sem API conectada). Publicar e acompanhar é por sua conta; o link do post fica com você." };
  }
}

export default PublishPackageService;
