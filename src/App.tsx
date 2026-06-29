import React, { useEffect, useState } from 'react';
import { Sidebar } from '@/src/features/Sidebar';
import { KanbanBoard } from '@/src/features/KanbanBoard';
import { ChatPanel } from '@/src/features/ChatPanel';
import { ChannelsPanel } from '@/src/features/ChannelsPanel';
import { DashboardPanel } from '@/src/features/DashboardPanel';
import { ReportsPanel } from '@/src/features/ReportsPanel';
import { ReservasView } from '@/src/features/ReservasView';
import { AssinaturasView } from '@/src/features/AssinaturasView';
import { ProcurementView } from '@/src/features/ProcurementView';
import { QuotesView } from '@/src/features/QuotesView';
import { EventsView } from '@/src/features/EventsView';
import { ExecutiveView } from '@/src/features/ExecutiveView';
import { RevenueIntelligenceView } from '@/src/features/rie/RevenueIntelligenceView';
import { StudioView } from '@/src/features/StudioView';
import { TasksView } from '@/src/features/TasksView';
import { AgendaView } from '@/src/features/AgendaView';
import { CatalogView } from '@/src/features/CatalogView';
import { SalesView } from '@/src/features/SalesView';
import { CampaignsView } from '@/src/features/CampaignsView';
import { CadencesView } from '@/src/features/CadencesView';
import { ContactsView } from '@/src/features/ContactsView';
import { IntegrationsView } from '@/src/features/IntegrationsView';
import { SettingsView } from '@/src/features/SettingsView';
import { StorefrontSettingsView } from '@/src/features/StorefrontSettingsView';
import { AreasView } from '@/src/features/AreasView';
import { AdminMasterView } from '@/src/features/AdminMasterView';
import { LoginView } from '@/src/features/LoginView';
import { OnboardingView } from '@/src/features/OnboardingView';
import { GlobalSearch } from '@/src/features/GlobalSearch';
import { ErrorBoundary } from '@/src/features/ErrorBoundary';
import { useAuth } from '@/src/contexts/AuthContext';
import { useStore } from '@/src/store/useStore';
import { Bell, X, Menu } from 'lucide-react';
import io from 'socket.io-client';

export default function App() {
  const { receiveMessage, viewMode, updateStageByContactId, hydrate, setSidebarOpen, activeTicketId, loadOrgConfig, isModuleEnabled, setViewMode, enabledModules } = useStore();
  const { user, token, loading } = useAuth();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    if (!token) return;
    // Carrega os tickets/contatos reais do banco (substitui os dados de exemplo)
    hydrate();
    // Carrega a config da org (vertical + módulos habilitados) para o gating da UI.
    loadOrgConfig();
  }, [token, hydrate, loadOrgConfig]);

  // Se a aba atual aponta para um módulo desligado, volta para o Atendimento.
  useEffect(() => {
    const map: Record<string, string> = {
      agenda: 'agenda', catalog: 'catalogo', vendas: 'vendas', storefront: 'loja',
      campanhas: 'campanhas', cadencias: 'cadencias', areas: 'areas', integrations: 'integracoes',
      reservas: 'reservas', assinaturas: 'assinaturas', compras: 'compras',
      orcamentos: 'orcamentos', eventos: 'eventos', diretor: 'diretor',
    };
    const mod = map[viewMode];
    // Só redireciona DEPOIS que a config da org carregou (enabledModules != null),
    // para não ricochetear para o Atendimento durante o carregamento inicial.
    if (enabledModules !== null && mod && !isModuleEnabled(mod)) setViewMode('kanban');
  }, [viewMode, isModuleEnabled, setViewMode, enabledModules]);

  useEffect(() => {
    if (!token) return;
    // Carregar notificações
    fetch('/api/notifications', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(setNotifications)
      .catch(() => {});
  }, [token]);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const handleMarkAsRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
      setNotifications(notifications.map(n => n.id === id ? { ...n, is_read: 1 } : n));
    } catch(e) {}
  };

  useEffect(() => {
    if (!token) return;
    // Conectar ao Socket.IO do backend (autenticado via JWT no handshake)
    const socket = io(window.location.origin, { auth: { token } });

    socket.on("connect", () => {
      console.log("Conectado ao servidor via WebSocket", socket.id);
      // O servidor decide a organização a partir do token; não enviamos o id.
      socket.emit("join_org");
    });

    socket.on("new_message", (data: { contactId: string, contactName?: string, contactNumber?: string, contactAvatar?: string, provider: string, text: string, sender: string, mediaUrl?: string }) => {
      console.log("Recebido novo evento via WebSocket:", data);
      // Adiciona na store independentemente se é bot ou user
      receiveMessage(data.contactId, data.text, data.sender as any, data.contactName, data.contactAvatar, data.contactNumber, data.mediaUrl);
    });

    socket.on("ticket_stage_change", (data: { contactId: string, newStage: string }) => {
      console.log("Movendo cartão do lead...", data);
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
       console.log("Pausando IA do ticket...", data);
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
       console.log("Despausando IA do ticket...", data);
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
  }, [token, receiveMessage, updateStageByContactId]);

  if (loading) return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">Carregando...</div>;
  if (!user) return <LoginView />;
  if (user.role === 'owner' && user.onboarding_status === 'pending') return <OnboardingView />;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#09090b] text-foreground font-sans">
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
             {viewMode === 'admin' && 'Admin Master'}
             {viewMode === 'channels' && 'Canais e IA'}
             {viewMode === 'areas' && 'Áreas de Atendimento'}
             {viewMode === 'dashboard' && 'Dashboard'}
             {viewMode === 'reports' && 'Relatórios'}
             {viewMode === 'reservas' && 'Reservas'}
             {viewMode === 'assinaturas' && 'Assinaturas'}
             {viewMode === 'compras' && 'Compras'}
             {viewMode === 'orcamentos' && 'Orçamentos'}
             {viewMode === 'eventos' && 'Eventos & Grupos'}
             {viewMode === 'diretor' && 'Diretor Executivo IA'}
             {viewMode === 'rie' && 'Revenue Intelligence'}
             {viewMode === 'studio' && 'Estúdio de Criação'}
             {viewMode === 'tarefas' && 'Tarefas'}
           </h1>
           <div className="flex items-center gap-2 md:gap-4">
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
          {viewMode === 'admin' && <AdminMasterView />}
          {viewMode === 'channels' && <ChannelsPanel />}
          {viewMode === 'areas' && <AreasView />}
          {viewMode === 'dashboard' && <DashboardPanel />}
          {viewMode === 'reports' && <ReportsPanel />}
          {viewMode === 'reservas' && <ReservasView />}
          {viewMode === 'assinaturas' && <AssinaturasView />}
          {viewMode === 'compras' && <ProcurementView />}
          {viewMode === 'orcamentos' && <QuotesView />}
          {viewMode === 'eventos' && <EventsView />}
          {viewMode === 'diretor' && <ExecutiveView />}
          {viewMode === 'rie' && <RevenueIntelligenceView />}
          {viewMode === 'studio' && <StudioView />}
          {viewMode === 'tarefas' && <TasksView />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

