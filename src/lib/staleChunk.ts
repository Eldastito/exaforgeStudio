// Após um deploy, o navegador/service worker pode ter o index ANTIGO apontando
// para chunks (`StrategicPlanCard-<hash>.js`) que já não existem no servidor.
// Recarregar a página baixa o index novo. Recarrega UMA vez por janela de
// tempo para nunca entrar em loop quando o erro tem outra causa (ex.: offline).

const STALE_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;
const KEY = "zf_stale_chunk_reload_at";
export const STALE_CHUNK_WINDOW_MS = 60_000;

export function isStaleChunkError(err: unknown): boolean {
  const msg = typeof err === "string" ? err : (err as any)?.message;
  return typeof msg === "string" && STALE_RE.test(msg);
}

type StoreLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** true = pode recarregar agora (e registra); false = já recarregou há pouco. */
export function claimReload(store: StoreLike | null, now: number = Date.now()): boolean {
  try {
    const last = Number(store?.getItem(KEY) || 0);
    if (last && now - last < STALE_CHUNK_WINDOW_MS) return false;
    store?.setItem(KEY, String(now));
    return true;
  } catch {
    return false; // sem storage: não arrisca loop
  }
}

function session(): StoreLike | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function reloadIfStale(err: unknown): boolean {
  if (!isStaleChunkError(err)) return false;
  if (!claimReload(session())) return false;
  window.location.reload();
  return true;
}

export function installStaleChunkGuard(): void {
  window.addEventListener("vite:preloadError", (e: any) => {
    if (claimReload(session())) { e.preventDefault?.(); window.location.reload(); }
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    reloadIfStale(e.reason);
  });
}

/** Botão "Tentar de novo": em chunk obsoleto, recarrega de verdade. */
export function hardReload(): void { window.location.reload(); }
