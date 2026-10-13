// Registrar resultado de post feito à mão (ADR-207 F13c, 2ª etapa) — regras PURAS da tela (testáveis sem navegador).
// A tela só chama `/api/studio/manual-result(s)` e `/api/social/experiments`; quem valida domínio do link, normaliza e decide
// o que vira "análise" é o servidor. Aqui: montar o corpo, mensagens em português e resumos — sem calcular nada de negócio.

export const CHANNELS = [
  { channel: 'tiktok', label: 'TikTok' },
  { channel: 'linkedin', label: 'LinkedIn' },
  { channel: 'youtube', label: 'YouTube' },
  { channel: 'x', label: 'X' },
] as const;

export const METRICS = [
  { key: 'impressions', label: 'Visualizações' },
  { key: 'reach', label: 'Pessoas alcançadas' },
  { key: 'likes', label: 'Curtidas' },
  { key: 'comments', label: 'Comentários' },
  { key: 'shares', label: 'Compartilhamentos' },
  { key: 'saves', label: 'Salvamentos' },
  { key: 'clicks', label: 'Cliques' },
] as const;
export type MetricKey = typeof METRICS[number]['key'];

export interface Form {
  channel: string; link: string; publishedAt: string; variantKey: string;
  metrics: Partial<Record<MetricKey, string>>;
}
export const emptyForm = (): Form => ({ channel: '', link: '', publishedAt: '', variantKey: '', metrics: {} });

export const channelLabel = (c: string): string => CHANNELS.find((x) => x.channel === c)?.label || c;

export type Built = { ok: true; body: Record<string, unknown>; hasMetrics: boolean } | { ok: false; error: string };

/** Monta o corpo do pedido. Campo em branco é OMITIDO (em branco ≠ zero); só barra o que o servidor também barraria, pra avisar cedo. */
export function buildBody(f: Form): Built {
  if (!f.channel || !CHANNELS.some((c) => c.channel === f.channel)) return { ok: false, error: 'Escolha a rede onde você postou.' };
  const link = (f.link || '').trim();
  if (!link) return { ok: false, error: 'Cole o link do post.' };
  if (!/^https:\/\//i.test(link)) return { ok: false, error: 'O link precisa começar com https://.' };
  const metrics: Record<string, string> = {};
  for (const m of METRICS) {
    const raw = String(f.metrics?.[m.key] ?? '').trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw.replace(/\./g, ''))) return { ok: false, error: `"${m.label}" precisa ser um número inteiro (ex.: 1250).` };
    metrics[m.key] = raw;
  }
  const body: Record<string, unknown> = { channel: f.channel, link, metrics };
  if (f.publishedAt) {
    const t = new Date(f.publishedAt);
    if (!Number.isFinite(t.getTime())) return { ok: false, error: 'Data e hora inválidas.' };
    body.publishedAt = t.toISOString();
  }
  if (f.variantKey) body.variantKey = f.variantKey;
  return { ok: true, body, hasMetrics: Object.keys(metrics).length > 0 };
}

/** Texto do erro pra quem não é técnico: usa a mensagem do servidor quando ela já é clara. */
export function errorText(status: number, data: any): string {
  if (status === 403) return 'Só o dono ou um administrador pode registrar resultados.';
  if (status === 401) return 'Sua sessão expirou. Entre de novo.';
  if (status === 400 && data?.error) return String(data.error);
  return 'Não consegui registrar agora. Tente de novo em instantes.';
}

const nf = new Intl.NumberFormat('pt-BR');
export const fmtNum = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : '—');

/** Resumo de uma linha dos números informados (só o que existe; nada informado = diz isso). */
export function metricsLine(item: Partial<Record<MetricKey, number | null>>): string {
  const parts = METRICS.filter((m) => item?.[m.key] != null).map((m) => `${fmtNum(item[m.key])} ${m.label.toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'sem números ainda';
}

/** O que mostrar depois de salvar: o que entrou, os avisos do servidor e o limite (digitado ≠ medido). */
export function resultLines(res: any): { title: string; notes: string[]; warnings: string[] } {
  const informed = Array.isArray(res?.metricsInformed) ? res.metricsInformed.length : 0;
  const title = res?.created === false ? 'Resultado atualizado.' : 'Resultado registrado.';
  const notes: string[] = [];
  notes.push(informed > 0 ? `${informed} número(s) guardado(s). Os que ficaram em branco continuam "sem dado" — não viram zero.` : 'Guardei o post, mas ainda sem números. Volte aqui quando tiver.');
  if (res?.variantKey) notes.push('Esse post passa a contar no seu teste A/B.');
  if (res?.note) notes.push(String(res.note));
  return { title, notes, warnings: Array.isArray(res?.caveats) ? res.caveats.map(String) : [] };
}

/** Variantes escolhíveis a partir do detalhe de um experimento (`GET /api/social/experiments/:id`). */
export function variantOptions(exp: any): { key: string; label: string }[] {
  const vs = Array.isArray(exp?.variants) ? exp.variants : [];
  return vs.filter((v: any) => v?.variantKey).map((v: any) => ({ key: String(v.variantKey), label: v.label ? `${v.label} (${v.variantKey})` : String(v.variantKey) }));
}

/** Link curto pra lista (host + começo do caminho); o completo fica no `title` do elemento. */
export function shortLink(link: string): string {
  try { const u = new URL(link); const p = u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname; return u.hostname.replace(/^www\./, '') + (p === '/' ? '' : p); }
  catch { return String(link || '').slice(0, 40); }
}
