// Aviso "pronto para retirar" (ADR-207 F14) — rótulos PUROS da fila da loja (testáveis sem navegador).
// Regra de ouro: a equipe nunca pode achar que o cliente foi avisado sem ter sido. Todo estado que NÃO é "enviado" diz o que fazer.

export type NoticeTone = 'ok' | 'wait' | 'warn';
export interface NoticeBadge { text: string; tone: NoticeTone }

const MAP: Record<string, NoticeBadge> = {
  sent: { text: 'Cliente avisado por WhatsApp ✓', tone: 'ok' },
  blocked_quiet_hours: { text: 'Aviso adiado (fora do horário de contato) — sai sozinho depois', tone: 'wait' },
  blocked_frequency_cap: { text: 'Aviso adiado (limite de mensagens ao cliente) — sai sozinho depois', tone: 'wait' },
  failed: { text: 'Não consegui avisar agora — tento de novo; se urgente, avise por outro meio', tone: 'warn' },
  no_channel: { text: 'WhatsApp desconectado — reconecte ou avise o cliente por outro meio', tone: 'warn' },
  blocked_consent: { text: 'Cliente sem autorização para WhatsApp — avise por outro meio', tone: 'warn' },
  opted_out: { text: 'Cliente pediu para não receber mensagens — avise por outro meio', tone: 'warn' },
  no_phone: { text: 'Sem telefone válido — avise o cliente por outro meio', tone: 'warn' },
  expired: { text: 'Aviso não foi enviado — avise o cliente por outro meio', tone: 'warn' },
  obsolete: { text: 'Aviso encerrado', tone: 'wait' },
};

/** Selo da linha da fila. `enabled` = a empresa ligou o aviso. Sem registro e aviso desligado → nada (não polui a tela). */
export function noticeBadge(notice: { status?: string } | null | undefined, stage: string | null | undefined, enabled: boolean): NoticeBadge | null {
  if (notice?.status) return MAP[notice.status] || { text: 'Situação do aviso desconhecida — confira com o cliente', tone: 'warn' };
  if (enabled && stage === 'pronto') return { text: 'Aviso ao cliente em preparo…', tone: 'wait' };
  return null;
}

/** Texto do botão de configuração (liga/desliga) e a explicação honesta do que ele faz. */
export const NOTICE_SETTING_HELP =
  'Quando a loja marcar “Está pronto”, o cliente recebe UMA mensagem de WhatsApp com o nº do pedido, a loja e as peças. ' +
  'Respeita o consentimento, o horário de silêncio e o limite de mensagens da empresa, e nunca manda para quem pediu para não receber. ' +
  'Se não der para avisar, a fila mostra “avise por outro meio”.';

export const TONE_CLASS: Record<NoticeTone, string> = {
  ok: 'border-emerald-500/40 text-emerald-300',
  wait: 'border-zinc-600 text-zinc-400',
  warn: 'border-amber-500/50 text-amber-300',
};
