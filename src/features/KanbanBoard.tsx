import React from 'react';
import { useStore } from '@/src/store/useStore';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Badge } from '@/src/components/ui/badge';
import { Clock, MessageCircle, User } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function KanbanBoard() {
  const { stages, tickets, contacts, messages, moveTicket, setActiveTicket, activeTicketId } = useStore();

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    
    const { source, destination, draggableId } = result;
    
    if (source.droppableId !== destination.droppableId) {
      moveTicket(draggableId, destination.droppableId as any);
    }
  };

  const getTicketsForStage = (stageId: string) => {
    return Object.values(tickets)
      .filter(t => t.stage === stageId)
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
  };

    const formatNumber = (num: string) => {
      // Ex: 5511999999999 or 5511...
      const cleaned = num.replace(/\D/g, '');
      if (cleaned.length >= 12 && cleaned.startsWith('55')) {
        const ddd = cleaned.slice(2, 4);
        const prefix = cleaned.slice(4, cleaned.length - 4);
        const suffix = cleaned.slice(-4);
        return `+55 (${ddd}) ${prefix}-${suffix}`;
      }
      return num;
    };

    return (
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-3 md:p-6">
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex h-full items-start gap-4 md:gap-6">
          {stages.map((stage) => {
            const stageTickets = getTicketsForStage(stage.id);
            return (
              <div key={stage.id} className="flex h-full w-[82vw] min-w-[82vw] sm:w-[340px] sm:min-w-[340px] flex-col rounded-xl bg-zinc-900/50 border border-zinc-800">
                <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                  <h3 className="font-semibold text-zinc-100">{stage.title}</h3>
                  <Badge variant="secondary" className="bg-zinc-800 text-zinc-400">
                    {stageTickets.length}
                  </Badge>
                </div>
                
                <Droppable droppableId={stage.id}>
                  {(provided, snapshot) => (
                    <div
                      {...provided.droppableProps}
                      ref={provided.innerRef}
                      className={`flex-1 overflow-y-auto p-3 transition-colors ${snapshot.isDraggingOver ? 'bg-zinc-800/30' : ''}`}
                    >
                      {stageTickets.map((ticket, index) => {
                        const contact = contacts[ticket.contactId];
                        const ticketMessages = messages[ticket.id] || [];
                        const lastMsg = ticketMessages[ticketMessages.length - 1];

                        return (
                          // @ts-expect-error React 18+ types issue with hello-pangea/dnd
                          <Draggable key={ticket.id} draggableId={ticket.id} index={index}>
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                onClick={() => setActiveTicket(ticket.id)}
                                className={`group relative mb-3 flex flex-col gap-3 rounded-lg border p-4 shadow-sm transition-all
                                  ${activeTicketId === ticket.id ? 'border-primary bg-zinc-800' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'}
                                  ${snapshot.isDragging ? 'rotate-2 scale-105 shadow-xl ring-2 ring-primary bg-zinc-800' : ''}`}
                              >
                                {ticket.unreadCount > 0 && (
                                  <div className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-lg animate-pulse">
                                    {ticket.unreadCount}
                                  </div>
                                )}
                                
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    {contact.avatar ? (
                                      <img src={contact.avatar} alt={contact.name} className="h-8 w-8 rounded-full border border-zinc-800" />
                                    ) : (
                                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800">
                                        <User className="h-4 w-4 text-zinc-400" />
                                      </div>
                                    )}
                                    <div>
                                      <h4 className="text-sm font-medium leading-none text-zinc-100">{contact.name}</h4>
                                      <span className="text-xs text-zinc-500">{formatNumber(contact.number)}</span>
                                    </div>
                                  </div>
                                  <Badge variant="outline" className={
                                    ticket.priority === 'alta' ? 'border-red-500/50 text-red-500' : 
                                    ticket.priority === 'media' ? 'border-yellow-500/50 text-yellow-500' : 'border-blue-500/50 text-blue-500'
                                  }>
                                    {ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1)}
                                  </Badge>
                                </div>
                                
                                <div className="flex flex-col gap-1">
                                  <p className="line-clamp-2 text-xs text-zinc-400">
                                    {lastMsg ? lastMsg.text : 'Nenhuma mensagem'}
                                  </p>
                                </div>
                                
                                <div className="flex items-center justify-between text-xs text-zinc-500">
                                  <div className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    {formatDistanceToNow(new Date(ticket.lastMessageAt), { addSuffix: true, locale: ptBR })}
                                  </div>
                                  <div className="flex items-center gap-1">
                                     {ticket.aiPaused ? (
                                        <Badge variant="outline" className="text-[9px] px-1 h-4 bg-zinc-800 border-zinc-700 text-zinc-400">👤 Humano</Badge>
                                     ) : (
                                        <Badge variant="outline" className="text-[9px] px-1 h-4 bg-indigo-950/40 border-indigo-500/30 text-indigo-400">🤖 IA</Badge>
                                     )}
                                     {lastMsg?.sender === 'human' ? (
                                       <span className="text-primary/70">Você</span>
                                     ) : lastMsg?.sender === 'bot' ? (
                                        <span className="text-blue-400/70">Bot</span>
                                     ) : (
                                        <span className="text-emerald-400/70">Cliente</span>
                                     )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            );
          })}
        </div>
      </DragDropContext>
    </div>
  );
}
