import React, { useEffect, useState } from 'react';
import { devLog } from '@/src/lib/log';
import { COOKIE_SESSION } from '@/src/lib/sessionMode';
import { Sidebar } from '@/src/features/Sidebar';
import { HelpOrb } from '@/src/features/HelpOrb';
import { KanbanBoard } from '@/src/features/KanbanBoard';
import { ChatPanel } from '@/src/features/ChatPanel';
import { ChannelsPanel } from '@/src/features/ChannelsPanel';
import { DashboardPanel } from '@/src/features/DashboardPanel';
import { ReportsPanel } from '@/src/features/ReportsPanel';
import { MissionsView } from '@/src/features/MissionsView';
import { ReservasView } from '@/src/features/ReservasView';
import { AssinaturasView } from '@/src/features/AssinaturasView';
import { ProcurementView } from '@/src/features/ProcurementView';
import { QuotesView } from '@/src/features/QuotesView';
import { EventsView } from '@/src/features/EventsView';
import { ExecutiveView } from '@/src/features/ExecutiveView';
import { RevenueIntelligenceView } from '@/src/features/rie/RevenueIntelligenceView';
import { StudioView } from '@/src/features/StudioView';
import { BeautyView } from '@/src/features/BeautyView';
import BeautyTvPanel from '@/src/features/BeautyTvPanel';
import BeautyQueuePanel from '@/src/features/BeautyQueuePanel';
import { TasksView } from '@/src/features/TasksView';
import { ProspectView } from '@/src/features/ProspectView';
import { RadarB2BView } from '@/src/features/RadarB2BView';
import { ClinicAgendaView } from '@/src/features/ClinicAgendaView';
import { AdvocaciaView } from '@/src/features/AdvocaciaView';
import { EscolaView } from '@/src/features/EscolaView';
import { VisionVmsView } from '@/src/features/VisionVmsView';
import { RadarView } from '@/src/features/RadarView';
import { RadarConsultantView } from '@/src/features/RadarConsultantView';
import { FalaTuView } from '@/src/features/FalaTuView';
import { OrgGroupView } from '@/src/features/orggroup/OrgGroupView';
import { OrgSwitcher } from '@/src/features/orggroup/OrgSwitcher';
import { AgendaView } from '@/src/features/AgendaView';
import { CatalogView } from '@/src/features/CatalogView';
import { SalesView } from '@/src/features/SalesView';
import { CampaignsView } from '@/src/features/CampaignsView';
import { CadencesView } from '@/src/features/CadencesView';
import { ContactsView } from '@/src/features/ContactsView';
import { IntegrationsView } from '@/src/features/IntegrationsView';
import { SettingsView } from '@/src/features/SettingsView';
import { ManifestoView } from '@/src/features/ManifestoView';
import { EscutaView } from '@/src/features/EscutaView';
import { StorefrontSettingsView } from '@/src/features/StorefrontSettingsView';
import { AreasView } from '@/src/features/AreasView';
import { AdminMasterView } from '@/src/features/AdminMasterView';
import { ProductEvolutionView } from '@/src/features/ProductEvolutionView';
import { AiUsageDashboardView } from '@/src/features/AiUsageDashboardView';
import { NicheIntelligenceView } from '@/src/features/NicheIntelligenceView';
import { ProductionReadinessView } from '@/src/features/ProductionReadinessView';
import { RadarHealthView } from '@/src/features/RadarHealthView';
import { RetailOpsView } from '@/src/features/RetailOpsView';
import { RetailFloorView } from '@/src/features/RetailFloorView';
import { LegalAdvisorView } from '@/src/features/LegalAdvisorView';
import { CashView } from '@/src/features/CashView';
import { HealthCenterView } from '@/src/features/HealthCenterView';
import { InsightsView } from '@/src/features/InsightsView';
import { ComigoView } from '@/src/features/ComigoView';
import { LoginView } from '@/src/features/LoginView';
import { OnboardingView } from '@/src/features/OnboardingView';
import { GlobalSearch } from '@/src/features/GlobalSearch';
import { ErrorBoundary } from '@/src/features/ErrorBoundary';
import { useAuth } from '@/src/contexts/AuthContext';
import { useStore } from '@/src/store/useStore';
import { Bell, X, Menu, Wifi, WifiOff, Radio, RefreshCw, Server, Activity } from 'lucide-react';
import io from 'socket.io-client';
import { apiFetch } from '@/src/lib/api';
import { deriveConnectivity, classifyApi, CONNECTIVITY_META, type Connectivity, type ProbeInfo } from '@/src/lib/connectivity';

// ============================================================================
// PDR TOULON, Fatia 5 (CONN-001/002/003/004) — estados de conectividade HONESTOS.
// A lógica PURA (estados + texto) vive em `@/src/lib/connectivity` (testável);
// aqui fica só o que tem efeito: o probe HTTP e o painel de diagnóstico.
// ============================================================================

// Probe LEVE e autenticado (CONN-003): mede a latência de round-trip pra separar
// API saudável × lenta × caindo. Teto de 8 s pra não pendurar.
async function probeApi(): Promise<ProbeInfo> {
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const r = await apiFetch('/api/health/ping', { signal: ctrl.signal });
    clearTimeout(to);
    const latencyMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
    if (!r.ok) return { state: 'down', latencyMs, dbMs: null, lastOkAt: null };
    const d = await r.json().catch(() => ({} as any));
    return { state: classifyApi(true, latencyMs), latencyMs, dbMs: typeof d?.dbMs === 'number' ? d.dbMs : null, lastOkAt: Date.now() };
  } catch {
    return { state: 'down', latencyMs: null, dbMs: null, lastOkAt: null };
  }
}

const fmtTime = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

// CONN-004: diagnóstico expandido ao clicar no chip. Mostra os sinais que
// permitem ao usuário (ou ao suporte) entender O QUE está degradado sem chutar.
function ConnectivityDiagnostic({ connectivity, online, socketUp, probe, onRetry, onClose }: {
  connectivity: Connectivity; online: boolean; socketUp: boolean; probe: ProbeInfo;
  onRetry: () => void; onClose: () => void;
}) {
  const [alterdata, setAlterdata] = useState<{ loading: boolean; lastRun: number | null; found: boolean }>({ loading: true, lastRun: null, found: false });
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    // Alterdata: última sincronização (best-effort — só faz sentido no varejo).
    apiFetch('/api/integrations/alterdata/last-sync').then(r => r.ok ? r.json() : null).then(d => {
      if (!alive) return;
      const ranAt = d?.summary?.ranAt;
      const ts = ranAt ? Date.parse(ranAt) : NaN;
      setAlterdata({ loading: false, lastRun: Number.isFinite(ts) ? ts : null, found: !!d?.summary });
    }).catch(() => { if (alive) setAlterdata({ loading: false, lastRun: null, found: false }); });
    // Fila de comandos pendentes no outbox durável (ADR-082).
    import('@/src/lib/continuity/sync').then(({ getOutbox }) => getOutbox().pending())
      .then(list => { if (alive) setPending(Array.isArray(list) ? list.length : 0); })
      .catch(() => { if (alive) setPending(null); });
    return () => { alive = false; };
  }, []);

  const Row = ({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: string }) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-zinc-400">{icon}{label}</span>
      <span className={`text-right ${tone || 'text-zinc-200'}`}>{value}</span>
    </div>
  );

  return (
    <div className="absolute right-0 top-full mt-2 w-72 z-50 rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl p-3 text-[12px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-zinc-100">Diagnóstico de conexão</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-3.5 h-3.5" /></button>
      </div>
      <p className="mb-2 text-zinc-400">{CONNECTIVITY_META[connectivity].text}</p>
      <div className="divide-y divide-zinc-800">
        <Row icon={online ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />} label="Internet" value={online ? 'Conectada' : 'Sem rede'} tone={online ? 'text-emerald-300' : 'text-red-300'} />
        <Row icon={<Server className="w-3.5 h-3.5" />} label="API"
          value={probe.state === 'ok' ? `Online · ${probe.latencyMs ?? '—'} ms` : probe.state === 'slow' ? `Lenta · ${probe.latencyMs ?? '—'} ms` : probe.state === 'down' ? 'Sem resposta' : 'Verificando…'}
          tone={probe.state === 'ok' ? 'text-emerald-300' : probe.state === 'down' ? 'text-red-300' : 'text-amber-300'} />
        <Row icon={<Activity className="w-3.5 h-3.5" />} label="Último sucesso da API" value={fmtTime(probe.lastOkAt)} />
        <Row icon={<Radio className="w-3.5 h-3.5" />} label="Tempo real" value={socketUp ? 'Conectado' : 'Reconectando'} tone={socketUp ? 'text-emerald-300' : 'text-amber-300'} />
        <Row icon={<RefreshCw className="w-3.5 h-3.5" />} label="Última sync Alterdata" value={alterdata.loading ? '…' : alterdata.lastRun ? fmtTime(alterdata.lastRun) : (alterdata.found ? 'Nunca' : '—')} />
        <Row icon={<Server className="w-3.5 h-3.5" />} label="Comandos pendentes" value={pending == null ? '—' : String(pending)} tone={pending && pending > 0 ? 'text-amber-300' : 'text-zinc-200'} />
      </div>
      <button onClick={onRetry} className="mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-800">
        <RefreshCw className="w-3.5 h-3.5" /> Testar agora
      </button>
    </div>
  );
}

export default function App() {
  const { receiveMessage, viewMode, updateStageByContactId, hydrate, setSidebarOpen, activeTicketId, loadOrgConfig, loadPermissions, isModuleEnabled, canAccessModule, setViewMode, enabledModules } = useStore();
  const { user, token, loading, logout } = useAuth();
  // SEC-F24 Fase 2 — em cookie mode a sessão vive no cookie httpOnly; após um refresh o `token`
  // fica null (o JWT é httpOnly, JS não lê), mas o usuário SEGUE logado. O sinal canônico de
  // "logado" passa a ser o usuário; o token, quando existe em memória (login recente), ainda
  // serve pro header/socket, senão o cookie carrega a auth sozinho (same-origin). Em header mode
  // (default) `authed`/`sessionKey` colapsam pro token — comportamento idêntico ao de antes.
  const authed = COOKIE_SESSION ? !!user : !!token;
  const sessionKey = COOKIE_SESSION ? (user?.id ?? null) : token;
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  // F2.1c — se o navegador tem sessão ativa e o usuário abre `?solo=<key>`
  // (link de onboarding Solo), mostramos um modal explicando que ele já
  // está logado e ofereço logout, senão o parâmetro seria ignorado em
  // silêncio (o LoginView só roda pra deslogados) e o usuário ficaria sem
  // saber pra onde ir.
  const [soloConflict, setSoloConflict] = useState<string | null>(null);
  // Conectividade (ADR-082 Fase 0 + PDR TOULON Fatia 5): derivada de DOIS sinais
  // independentes — rede do navegador, saúde da API (probe /api/health/ping) e
  // tempo real (Socket.IO) — pra distinguir "só o tempo real caiu" de "API/
  // servidor com problema" (CONN-001). Nunca mais um "Instável" genérico.
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine !== false);
  const [socketUp, setSocketUp] = useState(true);
  const [probe, setProbe] = useState<ProbeInfo>({ state: 'unknown', latencyMs: null, dbMs: null, lastOkAt: null });
  const [showDiag, setShowDiag] = useState(false);
  const connectivity = deriveConnectivity(online, socketUp, probe.state);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // Probe de saúde da API (CONN-003): confirma se a API está saudável mesmo com o
  // Socket.IO caído. Definido aqui; o polling (que depende de `authed`) roda mais
  // abaixo, depois que `authed` existe.
  const runProbe = React.useCallback(async () => {
    const info = await probeApi();
    setProbe(prev => ({ ...info, lastOkAt: info.lastOkAt ?? prev.lastOkAt }));
  }, []);
  // Polling do probe: a cada 30 s normalmente; a cada 8 s quando o tempo real
  // está caído, pra classificar rápido (realtime_degraded × api_degraded).
  // Roda imediatamente ao montar e sempre que `socketUp` muda.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    const tick = async () => { if (!cancelled) await runProbe(); };
    tick();
    const id = setInterval(tick, socketUp ? 30000 : 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, [authed, socketUp, runProbe]);

  // Outbox durável (ADR-082, Fase 1b): reenvia comandos enfileirados offline e
  // reflete o resultado no balão da mensagem (id do comando = id local da msg).
  useEffect(() => {
    if (!authed) return;
    let stop = () => {};
    import('@/src/lib/continuity/sync').then(({ startOutboxFlusher }) => {
      stop = startOutboxFlusher((commandId, status) => {
        const s = useStore.getState();
        const messages = { ...s.messages };
        for (const tid of Object.keys(messages)) {
          const arr = messages[tid];
          const idx = arr.findIndex(m => m.id === commandId);
          if (idx >= 0) { messages[tid] = arr.map((m, i) => i === idx ? { ...m, deliveryStatus: status } : m); break; }
        }
        useStore.setState({ messages });
      });
    });
    return () => stop();
  }, [sessionKey]);

  useEffect(() => {
    if (!authed) return;
    // Carrega os tickets/contatos reais do banco (substitui os dados de exemplo)
    hydrate();
    // Carrega a config da org (vertical + módulos habilitados) para o gating da UI.
    loadOrgConfig();
    // RBAC granular (ADR-095): carrega o nível de acesso do usuário por módulo.
    loadPermissions();
  }, [sessionKey, hydrate, loadOrgConfig, loadPermissions]);

  // F2.1c — detecta ?solo=<key> em sessão logada. Nunca faz redirect
  // automático (respeitamos a sessão ativa); o usuário decide se quer
  // deslogar pra criar conta Solo, ou continuar na sessão atual.
  useEffect(() => {
    if (!authed) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const solo = params.get('solo') || params.get('blueprint');
      if (solo) {
        setSoloConflict(solo);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch { /* noop */ }
  }, [sessionKey]);

  // Se a aba atual aponta para um módulo desligado, volta para o Atendimento.
  useEffect(() => {
    const map: Record<string, string> = {
      agenda: 'agenda', catalog: 'catalogo', vendas: 'vendas', storefront: 'loja',
      campanhas: 'campanhas', cadencias: 'cadencias', areas: 'areas', integrations: 'integracoes',
      reservas: 'reservas', assinaturas: 'assinaturas', compras: 'compras',
      orcamentos: 'orcamentos', eventos: 'eventos', diretor: 'diretor',
      vision: 'vms', radar: 'radar', clinica: 'clinica', escola: 'escola', advocacia: 'advocacia', prospect: 'prospect', radar_b2b: 'prospect',
      retailops: 'retail', retailfloor: 'retail_floor', comigo: 'copiloto',
    };
    const mod = map[viewMode];
    // Só redireciona DEPOIS que a config da org carregou (enabledModules != null),
    // para não ricochetear para o Atendimento durante o carregamento inicial.
    // Redireciona se o módulo está desligado na org OU se o perfil do usuário não
    // tem acesso (RBAC granular, ADR-095) — cobre uma aba salva em módulo oculto.
    if (enabledModules !== null && mod && (!isModuleEnabled(mod) || !canAccessModule(mod))) setViewMode('saude');
  }, [viewMode, isModuleEnabled, canAccessModule, setViewMode, enabledModules]);

  useEffect(() => {
    if (!authed) return;
    // Carregar notificações. Em cookie mode sem token em memória (pós-refresh), NÃO mandamos
    // header — a auth vai pelo cookie httpOnly (same-origin). Com token (login recente ou header
    // mode), mandamos o Bearer como antes.
    fetch('/api/notifications', token ? { headers: { 'Authorization': `Bearer ${token}` } } : undefined)
      .then(r => r.json())
      .then(setNotifications)
      .catch(() => {});
  }, [sessionKey]);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const handleMarkAsRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
      setNotifications(notifications.map(n => n.id === id ? { ...n, is_read: 1 } : n));
    } catch(e) {}
  };

  useEffect(() => {
    if (!authed) return;
    // Conectar ao Socket.IO do backend (autenticado no handshake). Em cookie mode sem token em
    // memória (pós-refresh), NÃO passamos auth.token — o handshake lê o cookie httpOnly (Fase 1).
    // Com token (login recente ou header mode), passamos como antes.
    const socket = io(window.location.origin, token ? { auth: { token } } : undefined);

    let hadDisconnect = false;
    socket.on("connect", () => {
      devLog("Conectado ao servidor via WebSocket", socket.id);
      // O servidor decide a organização a partir do token; não enviamos o id.
      socket.emit("join_org");
      setSocketUp(true); // só o TEMPO REAL — a saúde da API vem do probe
      // ADR-082 (Fase 0): ao RECONECTAR, re-hidrata para recuperar tickets/
      // mensagens que chegaram durante a queda (antes, só entrava na sala e os
      // eventos perdidos ficavam faltando até um refresh manual). Paliativo até
      // o delta sync por domain_events (Fases 1+2).
      if (hadDisconnect) { hadDisconnect = false; hydrate(); }
    });

    // Queda do Socket.IO afeta APENAS o tempo real — a API REST segue via probe.
    socket.on("disconnect", () => { hadDisconnect = true; setSocketUp(false); });
    socket.on("connect_error", () => setSocketUp(false));

    socket.on("new_message", (data: { contactId: string, contactName?: string, contactNumber?: string, contactAvatar?: string, provider: string, text: string, sender: string, mediaUrl?: string }) => {
      devLog("Recebido novo evento via WebSocket:", data);
      // Adiciona na store independentemente se é bot ou user
      receiveMessage(data.contactId, data.text, data.sender as any, data.contactName, data.contactAvatar, data.contactNumber, data.mediaUrl);
    });

    // Fila de entrega ao provedor (ADR-082, Fase 3): o dispatcher promove o
    // estado da mensagem (queued → sent → delivered | failed) e avisa o painel.
    // Casa pelo commandId (id local do balão otimista) ou pelo id do servidor.
    socket.on("message_delivery_status", (data: { id: string; commandId?: string; ticketId?: string; status: 'queued' | 'sent' | 'delivered' | 'failed'; error?: string }) => {
      const s = useStore.getState();
      const messages = { ...s.messages };
      for (const tid of Object.keys(messages)) {
        const arr = messages[tid];
        const idx = arr.findIndex(m => (data.commandId && m.id === data.commandId) || m.id === data.id);
        if (idx >= 0) { messages[tid] = arr.map((m, i) => i === idx ? { ...m, deliveryStatus: data.status } : m); break; }
      }
      useStore.setState({ messages });
    });

    socket.on("ticket_stage_change", (data: { contactId: string, newStage: string }) => {
      devLog("Movendo cartão do lead...", data);
      updateStageByContactId(data.contactId, data.newStage as any);
    });

    // Foto de perfil do WhatsApp obtida em segundo plano: atualiza o card ao vivo.
    socket.on("contact_avatar", (data: { contactId: string, avatar: string }) => {
      const state = useStore.getState();
      const contact = state.contacts[data.contactId];
      if (contact && data.avatar) {
        useStore.setState({
          contacts: { ...state.contacts, [data.contactId]: { ...contact, avatar: data.avatar } },
        });
      }
    });

    // Notificação in-app em tempo real (sino no topo).
    socket.on("notification", (n: any) => {
      setNotifications(prev => {
        if (prev.some(p => p.id === n.id)) return prev;
        return [n, ...prev].slice(0, 30);
      });
    });

    socket.on("ticket_ai_paused", (data: { ticketId: string, summary?: string }) => {
       devLog("Pausando IA do ticket...", data);
       const state = useStore.getState();
       const ticket = state.tickets[data.ticketId];
       if (ticket) {
          useStore.setState({
             tickets: {
                ...state.tickets,
                [data.ticketId]: { ...ticket, aiPaused: true, handoffSummary: data.summary || ticket.handoffSummary }
             }
          });
       }
    });

    socket.on("ticket_ai_unpaused", (data: { ticketId: string }) => {
       devLog("Despausando IA do ticket...", data);
       const state = useStore.getState();
       const ticket = state.tickets[data.ticketId];
       if (ticket) {
          useStore.setState({
             tickets: {
                ...state.tickets,
                [data.ticketId]: { ...ticket, aiPaused: false }
             }
          });
       }
    });

    return () => {
      socket.disconnect();
    };
  }, [token, receiveMessage, updateStageByContactId, hydrate]);

  // F37 — FILA VIRTUAL no celular do cliente (rota PÚBLICA, sem login): quando
  // a URL traz `?beautyQueue=<id>&exp=&sig=` (o QR que a recepção mostrou), a
  // página da fila renderiza SEM sessão nem shell. Precede os gates de
  // loading/login porque o cliente não está autenticado.
  if ((() => { try { return !!new URLSearchParams(window.location.search).get('beautyQueue'); } catch { return false; } })()) {
    return <BeautyQueuePanel />;
  }
  if (loading) return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">Carregando...</div>;
  if (!user) return <LoginView />;
  // F36 — JANELA DEDICADA do Painel de TV (monitor extra do salão): mesma
  // sessão logada, SEM o shell (sidebar/main) — assim a recepção NÃO perde a
  // tela dela. Aberta via window.open('?beautyTv=1') e arrastada pro 2º
  // monitor. `?beautyTv=1` não é limpo pelo app (só ?solo/?blueprint são).
  if ((() => { try { return new URLSearchParams(window.location.search).get('beautyTv') === '1'; } catch { return false; } })()) {
    return <BeautyTvPanel onClose={() => { try { window.close(); } catch { /* noop */ } }} />;
  }
  if (user.role === 'owner' && user.onboarding_status === 'pending') return <OnboardingView />;

  return (
    <div className="zf-page-shell flex h-screen w-full overflow-hidden text-foreground font-sans">
      {/* F2.1c — modal explicando ?solo=<key> quando sessão já ativa. */}
      {soloConflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-6">
            <h3 className="text-lg font-semibold text-zinc-100 mb-2">Você já está logado</h3>
            <p className="text-sm text-zinc-400 mb-4">
              Você abriu um link de cadastro do FalaTu ({soloConflict}), mas já existe uma sessão ativa como <span className="text-zinc-200 font-medium">{user?.email}</span>. Escolha o que fazer:
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={() => setSoloConflict(null)}
                className="w-full rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm py-2.5 font-medium">
                Continuar nesta sessão
              </button>
              <button onClick={() => {
                // Guarda o slug pra reabrir o fluxo Solo já na tela de login
                // pós-logout — logout() zera token+user, React re-renderiza,
                // LoginView monta, effect lê o `?solo=` e cai direto no form.
                const target = `/?solo=${encodeURIComponent(soloConflict)}`;
                logout();
                setSoloConflict(null);
                try { window.location.replace(target); } catch { /* noop */ }
              }}
                className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm py-2.5 font-medium">
                Fazer logout e criar conta FalaTu Solo
              </button>
            </div>
            <p className="text-xs text-zinc-500 mt-3 text-center">
              Dica: se você quer o FalaTu com este mesmo email, é mais fácil adicionar o módulo ao seu plano atual.
            </p>
          </div>
        </div>
      )}
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top Navbar */}
        <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-4 md:px-6 backdrop-blur-sm gap-2">
           <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 -ml-1 text-zinc-300 hover:text-white" aria-label="Menu">
             <Menu className="w-5 h-5" />
           </button>
           <h1 className="text-lg md:text-xl font-semibold tracking-tight text-zinc-100 truncate flex-1 lg:flex-none">
             {viewMode === 'kanban' && 'Atendimento'}
             {viewMode === 'agenda' && 'Agenda'}
             {viewMode === 'catalog' && 'Catálogo'}
             {viewMode === 'vendas' && 'Vendas'}
             {viewMode === 'storefront' && 'Loja Virtual'}
             {viewMode === 'campanhas' && 'Campanhas'}
             {viewMode === 'cadencias' && 'Cadências'}
             {viewMode === 'contacts' && 'Contatos'}
             {viewMode === 'integrations' && 'Integrações'}
             {viewMode === 'settings' && 'Configurações'}
             {viewMode === 'manifesto' && 'Manifesto da Marca'}
             {viewMode === 'escuta' && 'Escuta Ativa'}
             {viewMode === 'admin' && 'Admin Master'}
             {viewMode === 'product_evolution' && 'Product Evolution Ledger'}
             {viewMode === 'ai_usage' && 'Consumo de IA'}
             {viewMode === 'niche_intel' && 'Inteligência de Nicho'}
             {viewMode === 'production_readiness' && 'Prontidão de Produção'}
             {viewMode === 'radar_health' && 'Saúde do Radar'}
             {viewMode === 'retailops' && 'Operação da Rede'}
             {viewMode === 'retailfloor' && 'Atendimento de Loja'}
             {viewMode === 'channels' && 'Canais e IA'}
             {viewMode === 'areas' && 'Áreas de Atendimento'}
             {viewMode === 'dashboard' && 'Dashboard'}
             {viewMode === 'reports' && 'Relatórios'}
             {viewMode === 'missoes' && 'Missões'}
             {viewMode === 'juridico' && 'Consultora Jurídica'}
             {viewMode === 'caixa' && 'Caixa'}
             {viewMode === 'saude' && 'Central de Saúde'}
             {viewMode === 'insights' && 'Insights'}
             {viewMode === 'reservas' && 'Reservas'}
             {viewMode === 'assinaturas' && 'Assinaturas'}
             {viewMode === 'compras' && 'Compras'}
             {viewMode === 'orcamentos' && 'Orçamentos'}
             {viewMode === 'eventos' && 'Eventos & Grupos'}
             {viewMode === 'diretor' && 'Diretor Executivo IA'}
             {viewMode === 'rie' && 'Revenue Intelligence'}
             {viewMode === 'studio' && 'Estúdio de Criação'}
             {viewMode === 'beauty' && 'Beauty AI — Consulta Visual'}
             {viewMode === 'tarefas' && 'Tarefas'}
             {viewMode === 'prospect' && 'Prospect AI'}
             {viewMode === 'radar_b2b' && 'Radar B2B'}
             {viewMode === 'clinica' && 'Agenda Clínica'}
             {viewMode === 'advocacia' && 'Advocacia'}
             {viewMode === 'escola' && 'Escola'}
             {viewMode === 'vision' && 'Vision VMS'}
             {viewMode === 'radar' && 'Radar de Execução IA'}
             {viewMode === 'radar_consultant' && 'Radar — Painel do Consultor'}
             {viewMode === 'falatu' && 'FalaTu'}
             {viewMode === 'comigo' && 'Comigo'}
             {viewMode === 'grupo' && 'Grupo'}
           </h1>
           <div className="flex items-center gap-2 md:gap-4">
              <OrgSwitcher />
              {connectivity !== 'online' && (
                <div className="relative">
                  <button
                    onClick={() => setShowDiag(v => !v)}
                    title={CONNECTIVITY_META[connectivity].text}
                    className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border hover:brightness-110 ${CONNECTIVITY_META[connectivity].cls}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${CONNECTIVITY_META[connectivity].dot}`}></span>
                    {CONNECTIVITY_META[connectivity].label}
                  </button>
                  {showDiag && (
                    <ConnectivityDiagnostic
                      connectivity={connectivity} online={online} socketUp={socketUp} probe={probe}
                      onRetry={runProbe} onClose={() => setShowDiag(false)}
                    />
                  )}
                </div>
              )}
              <GlobalSearch />
              <button
                onClick={() => setShowNotifications(!showNotifications)} 
                className="relative p-2 text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 border-2 border-zinc-950"></span>
                )}
              </button>
           </div>
        </header>

        {/* Notifications Dropdown */}
        {showNotifications && (
           <div className="absolute top-16 right-6 w-80 max-h-[400px] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50 flex flex-col">
              <div className="flex justify-between items-center p-4 border-b border-zinc-800">
                 <h3 className="font-semibold text-zinc-100">Notificações</h3>
                 <button onClick={() => setShowNotifications(false)} className="text-zinc-400 hover:text-zinc-100">
                    <X className="w-4 h-4" />
                 </button>
              </div>
              <div className="flex-1 flex flex-col p-2 gap-2">
                 {notifications.length === 0 ? (
                    <p className="text-sm text-zinc-500 text-center py-4">Nenhuma notificação</p>
                 ) : (
                    notifications.map(n => {
                       const accent = n.is_read ? 'border-zinc-800 bg-zinc-900/50'
                         : n.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10'
                         : n.type === 'warning' ? 'border-amber-500/30 bg-amber-500/10'
                         : n.type === 'alert' ? 'border-rose-500/30 bg-rose-500/10'
                         : 'border-indigo-500/30 bg-indigo-500/10';
                       return (
                         <div key={n.id} className={`p-3 rounded-lg border ${accent} cursor-pointer`} onClick={() => !n.is_read && handleMarkAsRead(n.id)}>
                            <p className="text-sm font-semibold text-zinc-100">{n.title}</p>
                            <p className="text-xs text-zinc-400 mt-1">{n.message}</p>
                         </div>
                       );
                    })
                 )}
              </div>
           </div>
        )}

        {/* Main Content Area — protegido por ErrorBoundary: se uma view quebrar,
            mostra o erro nela em vez de derrubar o app inteiro (tela branca). */}
        <main className="flex-1 flex overflow-hidden">
          <ErrorBoundary resetKey={viewMode}>
          {viewMode === 'kanban' && (
            <>
              {/* Mobile: empilha — mostra o Kanban OU o Chat (quando um card está aberto).
                  Desktop (lg+): mostra os dois lado a lado. */}
              <div className={`${activeTicketId ? 'hidden lg:flex' : 'flex'} flex-1 min-w-0`}>
                <KanbanBoard />
              </div>
              <div className={`${activeTicketId ? 'flex' : 'hidden lg:flex'} min-w-0`}>
                <ChatPanel />
              </div>
            </>
          )}
          {viewMode === 'agenda' && <AgendaView />}
          {viewMode === 'catalog' && <CatalogView />}
          {viewMode === 'vendas' && <SalesView />}
          {viewMode === 'storefront' && <StorefrontSettingsView />}
          {viewMode === 'campanhas' && <CampaignsView />}
          {viewMode === 'cadencias' && <CadencesView />}
          {viewMode === 'contacts' && <ContactsView />}
          {viewMode === 'integrations' && <IntegrationsView />}
          {viewMode === 'settings' && <SettingsView />}
          {viewMode === 'manifesto' && <ManifestoView />}
          {viewMode === 'escuta' && <EscutaView />}
          {viewMode === 'admin' && <AdminMasterView />}
          {viewMode === 'product_evolution' && <ProductEvolutionView />}
          {viewMode === 'ai_usage' && <AiUsageDashboardView />}
          {viewMode === 'niche_intel' && <NicheIntelligenceView />}
          {viewMode === 'production_readiness' && <ProductionReadinessView />}
          {viewMode === 'radar_health' && <RadarHealthView />}
          {viewMode === 'retailops' && <RetailOpsView />}
          {viewMode === 'retailfloor' && <RetailFloorView />}
          {viewMode === 'comigo' && <ComigoView />}
          {viewMode === 'grupo' && <OrgGroupView />}
          {viewMode === 'channels' && <ChannelsPanel />}
          {viewMode === 'areas' && <AreasView />}
          {viewMode === 'dashboard' && <DashboardPanel />}
          {viewMode === 'reports' && <ReportsPanel />}
          {viewMode === 'missoes' && <MissionsView />}
          {viewMode === 'juridico' && <LegalAdvisorView />}
          {viewMode === 'caixa' && <CashView />}
          {viewMode === 'saude' && <HealthCenterView />}
          {viewMode === 'insights' && <InsightsView />}
          {viewMode === 'reservas' && <ReservasView />}
          {viewMode === 'assinaturas' && <AssinaturasView />}
          {viewMode === 'compras' && <ProcurementView />}
          {viewMode === 'orcamentos' && <QuotesView />}
          {viewMode === 'eventos' && <EventsView />}
          {viewMode === 'diretor' && <ExecutiveView />}
          {viewMode === 'rie' && <RevenueIntelligenceView />}
          {viewMode === 'studio' && <StudioView />}
          {viewMode === 'beauty' && <BeautyView />}
          {viewMode === 'tarefas' && <TasksView />}
          {viewMode === 'prospect' && <ProspectView />}
          {viewMode === 'radar_b2b' && <RadarB2BView />}
          {viewMode === 'clinica' && <ClinicAgendaView />}
          {viewMode === 'advocacia' && <AdvocaciaView />}
          {viewMode === 'escola' && <EscolaView />}
          {viewMode === 'vision' && <VisionVmsView />}
          {viewMode === 'radar' && <RadarView />}
          {viewMode === 'radar_consultant' && <RadarConsultantView />}
          {viewMode === 'falatu' && <FalaTuView />}
          </ErrorBoundary>
        </main>
      </div>
      {/* ADR-179 F1/F3 — Tutor de Ajuda flutuante. Universal (não exige falatu_enabled);
          passa a tela atual como contexto e navega por deep-link ("me mostra onde"). */}
      <HelpOrb moduleKey={viewMode} onNavigate={(v) => setViewMode(v as any)} />
    </div>
  );
}

