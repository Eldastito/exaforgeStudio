import React, { useEffect, useState } from 'react';
import { Sidebar } from '@/src/features/Sidebar';
import { KanbanBoard } from '@/src/features/KanbanBoard';
import { ChatPanel } from '@/src/features/ChatPanel';
import { ChannelsPanel } from '@/src/features/ChannelsPanel';
import { DashboardPanel } from '@/src/features/DashboardPanel';
import { useStore } from '@/src/store/useStore';
import { Search } from 'lucide-react';
import io from 'socket.io-client';

export default function App() {
  const { receiveMessage, viewMode, updateStageByContactId } = useStore();

  useEffect(() => {
    // Conectar ao Socket.IO do backend
    const socket = io(window.location.origin);
    
    socket.on("connect", () => {
      console.log("Conectado ao servidor via WebSocket", socket.id);
    });

    socket.on("new_message", (data: { contactId: string, contactName?: string, contactAvatar?: string, provider: string, text: string, sender: string }) => {
      console.log("Recebido novo evento via WebSocket:", data);
      
      // Adiciona na store independentemente se é bot ou user
      // receiveMessage assume text, mas podemos verificar o formato
      receiveMessage(data.contactId, data.text, data.sender as any, data.contactName, data.contactAvatar);
    });

    socket.on("ticket_stage_change", (data: { contactId: string, newStage: string }) => {
      console.log("Movendo cartão do lead...", data);
      updateStageByContactId(data.contactId, data.newStage as any);
    });

    return () => {
      socket.disconnect();
    };
  }, [receiveMessage, updateStageByContactId]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#09090b] text-foreground font-sans">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top Navbar */}
        <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-6 backdrop-blur-sm">
           <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
             {viewMode === 'kanban' && 'Atendimento'}
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
           </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 flex overflow-hidden">
          {viewMode === 'kanban' && (
            <>
              <KanbanBoard />
              <ChatPanel />
            </>
          )}
          {viewMode === 'channels' && <ChannelsPanel />}
          {viewMode === 'dashboard' && <DashboardPanel />}
        </main>
      </div>
    </div>
  );
}

