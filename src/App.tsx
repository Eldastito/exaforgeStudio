import React, { useEffect, useState } from 'react';
import { Sidebar } from '@/src/features/Sidebar';
import { KanbanBoard } from '@/src/features/KanbanBoard';
import { ChatPanel } from '@/src/features/ChatPanel';
import { ChannelsPanel } from '@/src/features/ChannelsPanel';
import { DashboardPanel } from '@/src/features/DashboardPanel';
import { AgendaView } from '@/src/features/AgendaView';
import { CatalogView } from '@/src/features/CatalogView';
import { ContactsView } from '@/src/features/ContactsView';
import { IntegrationsView } from '@/src/features/IntegrationsView';
import { SettingsView } from '@/src/features/SettingsView';
import { AdminMasterView } from '@/src/features/AdminMasterView';
import { LoginView } from '@/src/features/LoginView';
import { OnboardingView } from '@/src/features/OnboardingView';
import { useAuth } from '@/src/contexts/AuthContext';
import { useStore } from '@/src/store/useStore';
import { Search, Bell, X } from 'lucide-react';
import io from 'socket.io-client';

export default function App() {
  const { receiveMessage, viewMode, updateStageByContactId, hydrate } = useStore();
  const { user, token, loading } = useAuth();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    if (!token) return;
    // Carrega os tickets/contatos reais do banco (substitui os dados de exemplo)
    hydrate();
  }, [token, hydrate]);

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
    // Conectar ao Socket.IO do backend
    const socket = io(window.location.origin);
    
    socket.on("connect", () => {
      console.log("Conectado ao servidor via WebSocket", socket.id);
      socket.emit("join_org", { organizationId: user?.organizationId || "default_org" });
    });

    socket.on("new_message", (data: { contactId: string, contactName?: string, contactNumber?: string, contactAvatar?: string, provider: string, text: string, sender: string }) => {
      console.log("Recebido novo evento via WebSocket:", data);
      // Adiciona na store independentemente se é bot ou user
      receiveMessage(data.contactId, data.text, data.sender as any, data.contactName, data.contactAvatar, data.contactNumber);
    });

    socket.on("ticket_stage_change", (data: { contactId: string, newStage: string }) => {
      console.log("Movendo cartão do lead...", data);
      updateStageByContactId(data.contactId, data.newStage as any);
    });

    socket.on("ticket_ai_paused", (data: { ticketId: string }) => {
       console.log("Pausando IA do ticket...", data);
       const state = useStore.getState();
       const ticket = state.tickets[data.ticketId];
       if (ticket) {
          useStore.setState({
             tickets: {
                ...state.tickets,
                [data.ticketId]: { ...ticket, aiPaused: true }
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
  }, [receiveMessage, updateStageByContactId, user?.organizationId]);

  if (loading) return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">Carregando...</div>;
  if (!user) return <LoginView />;
  if (user.role === 'owner' && user.onboarding_status === 'pending') return <OnboardingView />;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#09090b] text-foreground font-sans">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top Navbar */}
        <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-6 backdrop-blur-sm">
           <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
             {viewMode === 'kanban' && 'Atendimento'}
             {viewMode === 'agenda' && 'Agenda'}
             {viewMode === 'catalog' && 'Catálogo'}
             {viewMode === 'contacts' && 'Contatos'}
             {viewMode === 'integrations' && 'Integrações'}
             {viewMode === 'settings' && 'Configurações'}
             {viewMode === 'admin' && 'Admin Master'}
             {viewMode === 'channels' && 'Canais e IA'}
             {viewMode === 'dashboard' && 'Dashboard'}
           </h1>
           <div className="flex items-center gap-4">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
                <input 
                  type="text" 
                  placeholder="Buscar leads ou tags..." 
                  className="h-9 w-[250px] rounded-md border border-zinc-800 bg-zinc-900 pl-9 pr-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 transition-colors"
                />
              </div>
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
                    notifications.map(n => (
                       <div key={n.id} className={`p-3 rounded-lg border ${n.is_read ? 'border-zinc-800 bg-zinc-900/50' : 'border-indigo-500/30 bg-indigo-500/10'} cursor-pointer`} onClick={() => !n.is_read && handleMarkAsRead(n.id)}>
                          <p className="text-sm font-semibold text-zinc-100">{n.title}</p>
                          <p className="text-xs text-zinc-400 mt-1">{n.message}</p>
                       </div>
                    ))
                 )}
              </div>
           </div>
        )}

        {/* Main Content Area */}
        <main className="flex-1 flex overflow-hidden">
          {viewMode === 'kanban' && (
            <>
              <KanbanBoard />
              <ChatPanel />
            </>
          )}
          {viewMode === 'agenda' && <AgendaView />}
          {viewMode === 'catalog' && <CatalogView />}
          {viewMode === 'contacts' && <ContactsView />}
          {viewMode === 'integrations' && <IntegrationsView />}
          {viewMode === 'settings' && <SettingsView />}
          {viewMode === 'admin' && <AdminMasterView />}
          {viewMode === 'channels' && <ChannelsPanel />}
          {viewMode === 'dashboard' && <DashboardPanel />}
        </main>
      </div>
    </div>
  );
}

