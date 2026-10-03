/**
 * uxTelemetry (ADR-203 F2.2/RN-F2-10) — evento de UX fire-and-forget. O servidor só grava com a
 * flag opt-in `ux_telemetry_enabled` (LGPD §84; no-op caso contrário) e NUNCA conteúdo: só o
 * tipo de evento, a superfície e a tela. Falha de rede é silenciosa (não pode quebrar a UI).
 */
import { apiFetch } from '@/src/lib/api';

export function trackView(surface: string, moduleKey: string): void {
  try {
    void apiFetch('/api/ux/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'view_opened', surface, moduleKey }),
    }).catch(() => {});
  } catch { /* noop */ }
}
