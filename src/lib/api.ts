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
  if (!token) return null;
  try {
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return payload?.organizationId || payload?.organization_id || payload?.orgId || null;
  } catch { return null; }
}
