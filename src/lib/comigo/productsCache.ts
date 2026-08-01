/**
 * Comigo Balcão — cache local do catálogo pra funcionar offline.
 *
 * O service worker (vite-plugin-pwa) EXPLICITAMENTE não cacheia /api/* por
 * razão de LGPD (não vaza dados entre tenants). Então cacheamos aqui, no
 * app, por orgId, em IndexedDB. Estratégia: network-first (tenta a rede,
 * atualiza o cache no sucesso); no fallback offline, devolve o snapshot.
 *
 * Formato guardado: { orgId, products, fetchedAt }. Uma linha por orgId.
 */
const DB_NAME = "zappflow_comigo";
const STORE = "products_cache";

type Product = { id: string; name: string; price: number; type: string; active: number; sale_mode?: string; sale_options_json?: string | null };
type CacheEntry = { orgId: string; products: Product[]; fetchedAt: number };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const dbi = req.result;
      if (!dbi.objectStoreNames.contains(STORE)) dbi.createObjectStore(STORE, { keyPath: "orgId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(entry: CacheEntry): Promise<void> {
  const dbi = await open();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => { dbi.close(); resolve(); };
    tx.onerror = () => { dbi.close(); reject(tx.error); };
  });
}

async function get(orgId: string): Promise<CacheEntry | undefined> {
  const dbi = await open();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(orgId);
    req.onsuccess = () => { dbi.close(); resolve(req.result as CacheEntry | undefined); };
    req.onerror = () => { dbi.close(); reject(req.error); };
  });
}

/**
 * Puxa o catálogo com fallback offline. `orgId` é usado apenas como chave do
 * cache — a autenticação continua sendo o token no `apiFetch` (o server
 * decide qual org atender).
 *
 * Retorna { products, fromCache, fetchedAt }. `fromCache=true` sinaliza pro
 * UI mostrar um chip "modo offline" ou similar.
 */
export async function loadProductsWithCache(
  orgId: string,
  apiFetch: (path: string) => Promise<Response>,
  path = "/api/products"
): Promise<{ products: Product[]; fromCache: boolean; fetchedAt: number }> {
  // Network-first
  try {
    if (typeof navigator !== "undefined" && navigator.onLine !== false) {
      const res = await apiFetch(path);
      if (res.ok) {
        const data = await res.json();
        const products: Product[] = Array.isArray(data) ? data : (data?.products || data?.items || []);
        const fetchedAt = Date.now();
        try { await put({ orgId, products, fetchedAt }); } catch { /* IDB pode falhar em privado/mobile */ }
        return { products, fromCache: false, fetchedAt };
      }
    }
  } catch { /* cai no cache */ }
  // Fallback: cache
  try {
    const cached = await get(orgId);
    if (cached) return { products: cached.products, fromCache: true, fetchedAt: cached.fetchedAt };
  } catch { /* IDB indisponível */ }
  return { products: [], fromCache: true, fetchedAt: 0 };
}
