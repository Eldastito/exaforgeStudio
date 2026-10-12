/**
 * Atribuição social da vitrine (ADR-207 F1) — funções PURAS, sem DOM. Lê `zf_source`, `zf_campaign`,
 * `zf_content` e `zf_ref` da URL do link, guarda por 7 dias no navegador (para o pedido, feito depois,
 * ainda saber de onde o cliente veio) e entrega o objeto que a vitrine envia na visita e no pedido.
 * A validação que vale é a do servidor (StorefrontAttributionService.sanitize); aqui só se evita lixo óbvio.
 * Sem parâmetro e sem nada guardado → null (a vitrine se comporta exatamente como antes).
 */
export interface StoredAttribution { source?: string; campaign?: string; content?: string; ref?: string }

export const ATTRIBUTION_KEY = 'zf_attr';
export const ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function parseAttributionParams(search: string): StoredAttribution | null {
  let p: URLSearchParams;
  try { p = new URLSearchParams(search); } catch { return null; }
  const pick = (k: string) => { const v = (p.get(k) || '').trim(); return v ? v.slice(0, 80) : undefined; };
  const a: StoredAttribution = { source: pick('zf_source'), campaign: pick('zf_campaign'), content: pick('zf_content'), ref: pick('zf_ref') };
  return a.source || a.campaign || a.content || a.ref ? a : null;
}

/** URL tem parâmetro → guarda e usa; senão usa o guardado se ainda dentro do prazo. Nunca lança. */
export function resolveAttribution(search: string, storage: StorageLike | null, nowMs: number): StoredAttribution | null {
  const fromUrl = parseAttributionParams(search);
  if (fromUrl) {
    try { storage?.setItem(ATTRIBUTION_KEY, JSON.stringify({ at: nowMs, a: fromUrl })); } catch { /* sem storage: segue só nesta página */ }
    return fromUrl;
  }
  try {
    const raw = storage?.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j.at !== 'number' || nowMs - j.at > ATTRIBUTION_TTL_MS || nowMs < j.at) return null;
    const a = j.a as StoredAttribution;
    return a && (a.source || a.campaign || a.content || a.ref) ? a : null;
  } catch { return null; }
}
