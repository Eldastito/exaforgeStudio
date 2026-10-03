/**
 * uxTelemetry (ADR-203 F2.2/F2.9, RN-F2-10) — eventos de UX fire-and-forget. O servidor só grava com a flag opt-in
 * `ux_telemetry_enabled` (LGPD §84; no-op caso contrário) e NUNCA conteúdo: só tipo de evento, nome da tela/superfície e
 * um id de sessão aleatório (sem relação com o usuário). Falha de rede é silenciosa (não pode quebrar a UI).
 *
 * CONVENÇÃO (F2.9) — uma tela = um nome: `trackView(viewMode)` emite `view_opened` com surface = moduleKey = o NOME DA TELA
 * (o mesmo `viewMode` do app: 'hoje', 'insights', 'saude', 'dashboard'…). É esse nome que o `LegacyReductionService`
 * compara (legada × substituta); nome diferente = a retirada de tela seria avaliada SEM ver o uso do legado. Cliques DENTRO
 * de uma tela (atalhos, grupos, "Entender") são `trackAction` (`action_clicked`), nunca `view_opened`.
 */
import { apiFetch } from '@/src/lib/api';

let sid: string | null = null;
/** Id de sessão da aba (aleatório, não identifica a pessoa) — permite medir abandono (abriu e não clicou em nada). */
function sessionId(): string {
  if (sid) return sid;
  try {
    sid = sessionStorage.getItem('zf_ux_sid');
    if (!sid) { sid = 's' + Math.random().toString(36).slice(2, 12); sessionStorage.setItem('zf_ux_sid', sid); }
  } catch { sid = sid || 's' + Math.random().toString(36).slice(2, 12); }
  return sid;
}

function send(eventType: string, surface: string, moduleKey: string): void {
  try {
    void apiFetch('/api/ux/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, surface, moduleKey, sessionId: sessionId() }),
    }).catch(() => {});
  } catch { /* noop */ }
}

/** Abriu uma TELA (viewMode). Chamado UMA vez, no App, a cada troca de tela — nunca dentro das telas. */
export function trackView(viewMode: string): void { send('view_opened', viewMode, viewMode); }
/** Clicou em algo DENTRO de uma tela (atalho, grupo, aba, "Entender", pergunta ao FalaTu). `surface` = onde; `moduleKey` = o quê (nunca texto livre). */
export function trackAction(surface: string, moduleKey: string): void { send('action_clicked', surface, moduleKey); }
/** Buscou no "Explorar" e não achou nada. NÃO envia o que foi digitado. */
export function trackSearchMiss(): void { send('search_no_result', 'explorar', 'busca'); }
