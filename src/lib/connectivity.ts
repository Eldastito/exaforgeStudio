/**
 * Conectividade — lógica PURA dos estados de conexão (PDR TOULON, Fatia 5).
 * Isolada de React/DOM pra ser testável (`test:connectivity`) e reutilizável.
 * O `App.tsx` consome daqui; a parte com efeito (probe HTTP, painel) fica lá.
 *
 * CONN-001 — quatro estados derivados de DOIS sinais independentes (saúde da
 * API via probe autenticado + tempo real via Socket.IO), com a rede do
 * navegador vencendo tudo. A queda do socket NUNCA vira "servidor caiu".
 */
export type Connectivity = 'online' | 'realtime_degraded' | 'api_degraded' | 'offline';
export type ApiState = 'ok' | 'slow' | 'down' | 'unknown';
export type ProbeInfo = { state: ApiState; latencyMs: number | null; dbMs: number | null; lastOkAt: number | null };

/** Round-trip do probe acima disso = API degradada (latência alta, CONN-001). */
export const API_SLOW_MS = 2500;

/**
 * Classifica a saúde da API a partir do resultado do probe.
 *   ok=false            → 'down' (sem resposta / não-2xx)
 *   latência > limiar   → 'slow'
 *   caso contrário      → 'ok'
 */
export function classifyApi(ok: boolean, latencyMs: number | null): ApiState {
  if (!ok) return 'down';
  if (latencyMs != null && latencyMs > API_SLOW_MS) return 'slow';
  return 'ok';
}

/**
 * Deriva o estado de conectividade dos sinais independentes. Sem rede vence
 * tudo (offline); API caindo/lenta é `api_degraded` mesmo com o socket de pé;
 * socket caído com API saudável é só `realtime_degraded` (CONN-001).
 */
export function deriveConnectivity(online: boolean, socketUp: boolean, api: ApiState): Connectivity {
  if (!online) return 'offline';
  if (api === 'down') return 'api_degraded';   // navegador online mas a API não responde
  if (api === 'slow') return 'api_degraded';   // latência alta
  if (!socketUp) return 'realtime_degraded';   // API saudável, só o tempo real reconectando
  return 'online';
}

// CONN-002 — texto HONESTO por estado (nunca só "Instável"). Dados puros
// (rótulo + descrição + classes de cor); sem React.
export const CONNECTIVITY_META: Record<Connectivity, { label: string; text: string; dot: string; cls: string }> = {
  online: { label: 'Online', text: 'Tudo normal — API e tempo real conectados.', dot: 'bg-emerald-400', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  realtime_degraded: { label: 'Tempo real reconectando', text: 'Tempo real reconectando — consultas e salvamentos continuam disponíveis.', dot: 'bg-amber-400 animate-pulse', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  api_degraded: { label: 'Servidor instável', text: 'A API está lenta ou com falhas. Consultas podem demorar; salvamentos podem exigir nova tentativa.', dot: 'bg-orange-400 animate-pulse', cls: 'text-orange-300 bg-orange-500/10 border-orange-500/30' },
  offline: { label: 'Offline', text: 'Sem conexão com a internet. As ações ficam pendentes até a rede voltar.', dot: 'bg-red-400', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};
