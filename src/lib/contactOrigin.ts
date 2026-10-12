/**
 * Origem do contato (ADR-207 F2) — rótulos PUROS para a tela do CRM. Quem decide a origem é o servidor
 * (`ContactOriginService`); aqui só se traduz em frase. Origem inferida do canal NUNCA é apresentada como registrada.
 */
export interface OriginView { channel: string | null; campaign: string | null; content: string | null; basis: 'recorded' | 'inferred_channel' | 'unknown' }

const CHANNEL_LABEL: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn',
  x: 'X', email: 'E-mail', google: 'Google', qrcode: 'QR Code', bio: 'Link da bio', direct: 'Acesso direto', store: 'Loja física', telegram: 'Telegram', other: 'Outro canal',
};

export const originChannelLabel = (ch: string | null | undefined): string => (ch ? (CHANNEL_LABEL[ch] || 'Outro canal') : 'Origem desconhecida');

/** "Instagram · linen_out26" (registrada) ou "WhatsApp (pelo canal da 1ª conversa)" (inferida); null se desconhecida. */
export function originLine(o: OriginView | null | undefined): string | null {
  if (!o || !o.channel) return null;
  const base = originChannelLabel(o.channel);
  if (o.basis === 'inferred_channel') return `${base} (pelo canal da 1ª conversa)`;
  return o.campaign ? `${base} · ${o.campaign}` : base;
}

/** Conversão: onde a compra aconteceu. */
export const conversionLabel = (c: string | null | undefined): string | null =>
  c === 'zapflow_store' ? 'Loja virtual ZapFlow' : c === 'ai_chat' ? 'Atendimento (IA)' : c === 'staff' ? 'Equipe' : null;
