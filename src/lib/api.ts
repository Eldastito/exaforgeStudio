export async function apiFetch(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('zappflow_token');
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  options.headers = headers;
  return fetch(url, options);
}

/**
 * Retorna o organizationId embutido no JWT do usuário logado (ou null).
 * Usado por caches locais (ex.: `productsCache`) pra chavear por organização
 * sem depender de um store global. Zero-op quando não há token.
 */
export function currentOrgId(): string | null {
  const token = localStorage.getItem('zappflow_token');
  if (token) {
    try {
      const [, payloadB64] = token.split('.');
      if (payloadB64) {
        const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(json);
        const fromToken = payload?.organizationId || payload?.organization_id || payload?.orgId;
        if (fromToken) return fromToken;
      }
    } catch { /* cai no fallback abaixo */ }
  }
  // SEC-F24 Fase 2 (cookie mode): sem token em JS (ele é httpOnly). Deriva o org do PERFIL salvo
  // (não-secreto). Mantém o cache local (ex.: productsCache) chaveado por org sem o token.
  try {
    const raw = localStorage.getItem('zappflow_user');
    if (raw) {
      const u = JSON.parse(raw);
      return u?.organizationId || u?.organization_id || u?.orgId || null;
    }
  } catch { /* noop */ }
  return null;
}
