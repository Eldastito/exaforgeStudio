/**
 * ChannelAdaptationService — Channel Adaptation (PRD 11 / ADR-168 F5).
 *
 * O `SocialChannelProvider` (PRD 10) abstrai o TRANSPORTE, mas o Estúdio gera uma legenda
 * canal-agnóstica: a mesma peça vai pro Instagram e pro TikTok sem ajuste. F5 acrescenta a
 * camada de ADAPTAÇÃO DE CONTEÚDO por canal — reescreve limite de legenda, quantidade de
 * hashtags, FORMATO e estilo de CTA/tom respeitando as normas de cada canal.
 *
 * ESTENDE o Estúdio (§37 — sem 2º Estúdio); DETERMINÍSTICO (sem LLM, roda em CI). Não faz
 * transporte nem toca credencial — só molda o conteúdo. Conhecimento de canal é uma tabela
 * fixa (grounded): canal desconhecido é rejeitado (RN-CG-09 — não inventa norma).
 *
 * Guardrails: RN-CG-09 (grounded — canal desconhecido rejeitado; só usa o que foi passado),
 * convenção nº 1 não se aplica (transform puro, sem dado por-org).
 */

export type SocialChannelName = "instagram" | "facebook" | "tiktok" | "linkedin" | "youtube" | "x";

interface ChannelProfile {
  label: string;
  captionMax: number;          // limite de caracteres da legenda
  hashtagRange: [number, number];
  formats: string[];           // formatos suportados (o 1º é o default)
  tone: string;                // orientação de tom
  cta: string;                 // CTA idiomática do canal
  emojiOk: boolean;
}

// Normas por canal (fonte fixa/pública — não inventa). Números conservadores e idiomáticos.
const CHANNEL_PROFILES: Record<SocialChannelName, ChannelProfile> = {
  instagram: { label: "Instagram", captionMax: 2200, hashtagRange: [3, 5], formats: ["post", "reel", "story"], tone: "visual e próximo", cta: "Link na bio.", emojiOk: true },
  facebook: { label: "Facebook", captionMax: 2000, hashtagRange: [0, 2], formats: ["post", "video", "story"], tone: "conversacional", cta: "Saiba mais no link.", emojiOk: true },
  tiktok: { label: "TikTok", captionMax: 150, hashtagRange: [3, 5], formats: ["reel"], tone: "casual e rápido", cta: "Link no perfil.", emojiOk: true },
  linkedin: { label: "LinkedIn", captionMax: 3000, hashtagRange: [3, 5], formats: ["post", "video"], tone: "profissional", cta: "Link nos comentários.", emojiOk: false },
  youtube: { label: "YouTube", captionMax: 1000, hashtagRange: [2, 3], formats: ["video", "short"], tone: "explicativo", cta: "Inscreva-se no canal.", emojiOk: true },
  x: { label: "X", captionMax: 280, hashtagRange: [1, 2], formats: ["post"], tone: "direto e curto", cta: "Detalhes no link.", emojiOk: true },
};

// Mapa de formato do Estúdio → formato do canal (quando o canal não suporta o pedido).
function mapFormat(requested: string | undefined, profile: ChannelProfile): { format: string; changed: boolean } {
  const req = String(requested || profile.formats[0]);
  // "reels" (Estúdio) e "reel" (canal) são o mesmo.
  const norm = req === "reels" ? "reel" : req;
  if (profile.formats.includes(norm)) return { format: norm, changed: norm !== req };
  return { format: profile.formats[0], changed: true };
}

export interface ChannelAdaptationInput {
  caption: string;
  hook?: string | null;
  format?: string | null;
  hashtags?: string[];
  channel: SocialChannelName;
}

export interface ChannelAdaptation {
  channel: SocialChannelName; label: string;
  caption: string; hook: string | null; format: string;
  hashtags: string[]; cta: string; tone: string;
  changes: string[]; caveats: string[];
}

export class ChannelAdaptationService {
  static isKnownChannel(channel: string): channel is SocialChannelName {
    return Object.prototype.hasOwnProperty.call(CHANNEL_PROFILES, String(channel));
  }

  static channels(): { channel: SocialChannelName; label: string; captionMax: number; hashtagRange: [number, number]; formats: string[]; tone: string }[] {
    return (Object.keys(CHANNEL_PROFILES) as SocialChannelName[]).map((c) => {
      const p = CHANNEL_PROFILES[c];
      return { channel: c, label: p.label, captionMax: p.captionMax, hashtagRange: p.hashtagRange, formats: p.formats, tone: p.tone };
    });
  }

  /** Adapta o conteúdo base pra UM canal (grounded nas normas do canal). */
  static adapt(input: ChannelAdaptationInput): ChannelAdaptation {
    const channel = input?.channel;
    if (!this.isKnownChannel(channel)) throw new Error(`canal_desconhecido: ${channel}`);
    const p = CHANNEL_PROFILES[channel];
    const changes: string[] = []; const caveats: string[] = [];

    // Legenda: respeita o limite do canal (trunca com reticências, registra a mudança).
    let caption = String(input.caption || "").trim();
    if (caption.length > p.captionMax) {
      caption = caption.slice(0, p.captionMax - 1).trimEnd() + "…";
      changes.push(`legenda truncada pra ${p.captionMax} caracteres (${p.label})`);
    }

    // Hashtags: clampeia pro range do canal (nunca inventa hashtag — só corta o excesso).
    let hashtags = Array.isArray(input.hashtags) ? input.hashtags.map((h) => String(h).trim()).filter(Boolean) : [];
    const [minH, maxH] = p.hashtagRange;
    if (hashtags.length > maxH) { hashtags = hashtags.slice(0, maxH); changes.push(`hashtags reduzidas pra ${maxH} (${p.label})`); }
    if (hashtags.length < minH) caveats.push(`${p.label} rende melhor com ${minH}+ hashtags (tem ${hashtags.length})`);

    // Formato: mapeia pro que o canal suporta.
    const fm = mapFormat(input.format || undefined, p);
    if (fm.changed) changes.push(`formato adaptado pra "${fm.format}" (${p.label})`);

    // Hook e tom: hook segue; tom é orientação do canal.
    const hook = input.hook ? String(input.hook) : null;
    if (!p.emojiOk && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(caption)) caveats.push(`${p.label} prefere linguagem sem emoji`);

    return { channel, label: p.label, caption, hook, format: fm.format, hashtags, cta: p.cta, tone: p.tone, changes, caveats };
  }

  /** Adapta o conteúdo base pra VÁRIOS canais de uma vez (o uso real do Estúdio). */
  static adaptMany(base: Omit<ChannelAdaptationInput, "channel">, channels: string[]): { adaptations: ChannelAdaptation[]; skipped: { channel: string; reason: string }[] } {
    const adaptations: ChannelAdaptation[] = []; const skipped: { channel: string; reason: string }[] = [];
    for (const c of channels || []) {
      if (!this.isKnownChannel(c)) { skipped.push({ channel: String(c), reason: "canal_desconhecido" }); continue; }
      adaptations.push(this.adapt({ ...base, channel: c }));
    }
    return { adaptations, skipped };
  }
}

export default ChannelAdaptationService;
