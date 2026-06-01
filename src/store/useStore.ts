import { create } from 'zustand';
import { apiFetch } from '@/src/lib/api';

export type Contact = {
  id: string;
  name: string;
  number: string;
  avatar?: string;
};

export type Message = {
  id: string;
  contactId: string;
  text: string;
  sender: 'human' | 'bot' | 'contact';
  timestamp: string;
  read?: boolean;
  mediaUrl?: string;
};

export type Stage = 
  | 'novo_lead'
  | 'ia_atendendo'
  | 'aguardando_humano'
  | 'em_atendimento_humano'
  | 'qualificado'
  | 'proposta'
  | 'aguardando_pagamento'
  | 'agendado'
  | 'em_execucao'
  | 'entregue_concluido'
  | 'perdido'
  | 'pos_venda';

export type Ticket = {
  id: string;
  contactId: string;
  stage: Stage;
  priority: 'baixa' | 'media' | 'alta';
  lastMessageAt: string;
  unreadCount: number;
  aiPaused?: boolean;
  temperature?: 'cold' | 'warm' | 'hot';
  assignedTo?: string;
  handoffReason?: string;
};

export type ViewMode = 'kanban' | 'channels' | 'dashboard' | 'agenda' | 'catalog' | 'vendas' | 'campanhas' | 'cadencias' | 'contacts' | 'integrations' | 'settings' | 'admin';

export type EvolutionConfig = {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
};

export type ChannelInfo = {
  id: string;
  provider: 'whatsapp_cloud' | 'instagram' | 'whatsapp_web' | 'evolution';
  name: string;
  identifier: string;
  status: 'connected' | 'disconnected';
  isActiveAI: boolean;
};

export type RagDocument = {
  id: string;
  name: string;
  size: string;
  status: 'processing' | 'ready' | 'error';
  channelId: string | 'global';
  uploadDate: string;
};

type AppState = {
  viewMode: ViewMode;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  contacts: Record<string, Contact>;
  tickets: Record<string, Ticket>;
  messages: Record<string, Message[]>;
  stages: { id: Stage; title: string }[];
  activeTicketId: string | null;
  channels: ChannelInfo[];
  ragDocuments: RagDocument[];
  evolutionConfig: EvolutionConfig | null;
  
  setViewMode: (mode: ViewMode) => void;
  setEvolutionConfig: (config: EvolutionConfig) => void;
  setActiveTicket: (id: string | null) => void;
  moveTicket: (ticketId: string, destStage: Stage) => void;
  updateStageByContactId: (contactId: string, destStage: Stage) => void;
  takeOverTicket: (ticketId: string) => Promise<void>;
  returnToAI: (ticketId: string) => Promise<void>;
  closeTicket: (ticketId: string, reason: string, status: 'entregue_concluido' | 'perdido') => Promise<void>;
  sendMessage: (ticketId: string, text: string, sender?: 'human' | 'bot') => void;
  toggleAiPaused: (ticketId: string) => Promise<void>;
  receiveMessage: (contactId: string, text: string, sender?: 'contact' | 'bot' | 'human', contactName?: string, contactAvatar?: string, contactNumber?: string, mediaUrl?: string) => void;
  fetchChannels: () => Promise<void>;
  updateChannel: (id: string, updates: Partial<ChannelInfo>) => Promise<void>;
  removeChannel: (id: string) => Promise<void>;
  connectInstagram: () => void;
  addRagDocument: (doc: Omit<RagDocument, 'id' | 'status' | 'uploadDate'>) => string;
  setRagDocumentStatus: (id: string, status: RagDocument['status'], patch?: Partial<RagDocument>) => void;
  removeRagDocument: (id: string) => void;
  loadRagDocuments: () => Promise<void>;
  hydrate: () => Promise<void>;
  loadMessages: (ticketId: string) => Promise<void>;
};

const initialContacts: Record<string, Contact> = {
  c1: { id: 'c1', name: 'João Silva', number: '+55 11 99999-1111', avatar: 'https://i.pravatar.cc/150?u=c1' },
  c2: { id: 'c2', name: 'Maria Souza', number: '+55 11 99999-2222', avatar: 'https://i.pravatar.cc/150?u=c2' },
  c3: { id: 'c3', name: 'Empresa XYZ', number: '+55 11 99999-3333', avatar: 'https://i.pravatar.cc/150?u=c3' },
};

const initialTickets: Record<string, Ticket> = {
  t1: { id: 't1', contactId: 'c1', stage: 'novo_lead', priority: 'media', lastMessageAt: new Date().toISOString(), unreadCount: 1 },
  t2: { id: 't2', contactId: 'c2', stage: 'ia_atendendo', priority: 'alta', lastMessageAt: new Date(Date.now() - 3600000).toISOString(), unreadCount: 0 },
  t3: { id: 't3', contactId: 'c3', stage: 'proposta', priority: 'baixa', lastMessageAt: new Date(Date.now() - 86400000).toISOString(), unreadCount: 0 },
};

const initialMessages: Record<string, Message[]> = {
  t1: [
    { id: 'm1', contactId: 'c1', text: 'Olá, gostaria de saber mais sobre o sistema omni.', sender: 'contact', timestamp: new Date().toISOString() }
  ],
  t2: [
    { id: 'm2', contactId: 'c2', text: 'Boa tarde, qual o valor da licença?', sender: 'contact', timestamp: new Date(Date.now() - 7200000).toISOString() },
    { id: 'm3', contactId: 'c2', text: 'Olá Maria! Nosso plano inicial custa R$ 199/mês.', sender: 'bot', timestamp: new Date(Date.now() - 7000000).toISOString() },
    { id: 'm4', contactId: 'c2', text: 'Perfeito, me manda o link por favor.', sender: 'contact', timestamp: new Date(Date.now() - 3600000).toISOString() },
  ],
  t3: [
    { id: 'm5', contactId: 'c3', text: 'Vocês fazem integração com ERP?', sender: 'contact', timestamp: new Date(Date.now() - 86400000).toISOString() }
  ]
};

const initialChannels: ChannelInfo[] = [
  { id: 'ch1', provider: 'whatsapp_cloud', name: 'WhatsApp Business', identifier: '+55 11 99822-4433', status: 'connected', isActiveAI: true },
];

const initialRagDocuments: RagDocument[] = [];

export const useStore = create<AppState>((set, get) => ({
  viewMode: ((): ViewMode => {
    try { return (localStorage.getItem('zappflow_view') as ViewMode) || 'kanban'; } catch { return 'kanban'; }
  })(),
  contacts: initialContacts,
  tickets: initialTickets,
  messages: initialMessages,
  channels: initialChannels,
  ragDocuments: initialRagDocuments,
  evolutionConfig: null,
  stages: [
    { id: 'novo_lead', title: 'Novo Lead' },
    { id: 'ia_atendendo', title: 'IA Atendendo' },
    { id: 'aguardando_humano', title: 'Aguard. Humano' },
    { id: 'em_atendimento_humano', title: 'Em Atend. Humano' },
    { id: 'qualificado', title: 'Qualificado' },
    { id: 'proposta', title: 'Proposta' },
    { id: 'aguardando_pagamento', title: 'Aguard. Pagto' },
    { id: 'agendado', title: 'Agendado' },
    { id: 'em_execucao', title: 'Em Execução' },
    { id: 'entregue_concluido', title: 'Concluído' },
    { id: 'perdido', title: 'Perdido' },
    { id: 'pos_venda', title: 'Pós Venda' },
  ],
  activeTicketId: null,

  fetchChannels: async () => {
    try {
      const res = await apiFetch('/api/channels');
      if (res.ok) {
        const data = await res.json();
        // convert from db snake case to frontend camel case where needed
        const formatted = data.map((d: any) => ({
           id: d.id,
           provider: d.provider,
           name: d.name,
           identifier: d.identifier,
           status: d.status,
           isActiveAI: d.ai_enabled === 1,
        }));
        set({ channels: formatted });
      }
    } catch(e) { console.error(e) }
  },

  updateChannel: async (id, updates) => {
    try {
       const dbUpdates: any = {};
       if (updates.name !== undefined) dbUpdates.name = updates.name;
       if (updates.identifier !== undefined) dbUpdates.identifier = updates.identifier;
       if (updates.status !== undefined) dbUpdates.status = updates.status;
       if (updates.isActiveAI !== undefined) dbUpdates.ai_enabled = updates.isActiveAI ? 1 : 0;
       
       const res = await apiFetch(`/api/channels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dbUpdates)
       });
       
       if (res.ok) {
          set(state => ({
             channels: state.channels.map(c => c.id === id ? { ...c, ...updates } : c)
          }));
       }
    } catch (e) {
       console.error(e);
    }
  },

  removeChannel: async (id) => {
    try {
      const res = await apiFetch(`/api/channels/${id}`, { method: 'DELETE' });
      if (res.ok) {
        set(state => ({ channels: state.channels.filter(c => c.id !== id) }));
      }
    } catch (e) { console.error(e); }
  },

  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setViewMode: (mode) => { try { localStorage.setItem('zappflow_view', mode); } catch {} set({ viewMode: mode, sidebarOpen: false }); },
  setEvolutionConfig: (config) => set({ evolutionConfig: config }),
  setActiveTicket: (id) => set({ activeTicketId: id }),

  // Carrega tickets/contatos reais do banco (substitui os dados de exemplo).
  hydrate: async () => {
    try {
      const res = await apiFetch('/api/tickets');
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows)) return;

      const contacts: Record<string, Contact> = {};
      const tickets: Record<string, Ticket> = {};
      const messages: Record<string, Message[]> = {};

      for (const r of rows) {
        contacts[r.contact_id] = {
          id: r.contact_id,
          name: r.contact_name || r.contact_identifier,
          number: r.contact_identifier,
          avatar: r.profile_pic_url || undefined,
        };
        tickets[r.id] = {
          id: r.id,
          contactId: r.contact_id,
          stage: (r.stage || 'novo_lead') as Stage,
          priority: (r.priority || 'media'),
          lastMessageAt: r.last_message_at || r.updated_at || r.created_at || new Date().toISOString(),
          unreadCount: 0,
          aiPaused: r.ai_paused === 1,
        };
        messages[r.id] = r.last_message
          ? [{ id: `last_${r.id}`, contactId: r.contact_id, text: r.last_message, sender: 'contact', timestamp: r.last_message_at || r.updated_at }]
          : [];
      }

      set({ contacts, tickets, messages });
    } catch (e) {
      console.error('Falha ao carregar tickets do servidor:', e);
    }
  },

  // Carrega o histórico completo de mensagens de um ticket (ao abrir a conversa).
  loadMessages: async (ticketId) => {
    try {
      const res = await apiFetch(`/api/messages/${ticketId}`);
      if (!res.ok) return;
      const rows = await res.json();
      if (!Array.isArray(rows)) return;
      const msgs: Message[] = rows.map((m: any) => ({
        id: m.id,
        contactId: '',
        text: m.content,
        sender: m.sender_type === 'agent' ? 'human' : (m.sender_type as 'contact' | 'bot' | 'human'),
        timestamp: m.created_at,
        mediaUrl: m.media_url || undefined,
      }));
      set((s) => ({ messages: { ...s.messages, [ticketId]: msgs } }));
    } catch (e) {
      console.error('Falha ao carregar mensagens:', e);
    }
  },

  connectInstagram: () => {
    // Simulando o delay do popup OAuth da Meta
    setTimeout(() => {
      set((state) => ({
        channels: [
          ...state.channels,
          { id: 'ch2', provider: 'instagram', name: 'Instagram Direct', identifier: '@minha_loja', status: 'connected', isActiveAI: true }
        ]
      }));
    }, 1500);
  },

  // Adiciona um documento de forma otimista (status 'processing') e devolve o id
  // temporário para que o caller atualize o status conforme a resposta real do upload.
  addRagDocument: (doc) => {
    const tempId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `doc_${Date.now()}_${Math.random()}`;
    const newDoc: RagDocument = {
      ...doc,
      id: tempId,
      status: 'processing',
      uploadDate: new Date().toISOString()
    };
    set((state) => ({ ragDocuments: [newDoc, ...state.ragDocuments] }));
    return tempId;
  },

  setRagDocumentStatus: (id, status, patch = {}) => set((state) => ({
    ragDocuments: state.ragDocuments.map(d => d.id === id ? { ...d, ...patch, status } : d)
  })),

  removeRagDocument: (id) => set((state) => ({
    ragDocuments: state.ragDocuments.filter(d => d.id !== id)
  })),

  loadRagDocuments: async () => {
    try {
      const res = await apiFetch('/api/rag/documents');
      if (!res.ok) return;
      const rows = await res.json();
      const docs: RagDocument[] = (rows || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        size: r.size_bytes ? `${(r.size_bytes / 1024 / 1024).toFixed(2)} MB` : '—',
        status: (r.status === 'error' ? 'error' : 'ready') as RagDocument['status'],
        channelId: r.channel_id || 'global',
        uploadDate: r.created_at || new Date().toISOString()
      }));
      set({ ragDocuments: docs });
    } catch (e) {
      // silencioso: mantém o que já está em tela
    }
  },

  moveTicket: (ticketId, destStage) => set((state) => ({
    tickets: {
      ...state.tickets,
      [ticketId]: { ...state.tickets[ticketId], stage: destStage }
    }
  })),

  updateStageByContactId: (contactId, destStage) => set((state) => {
    let ticketId = Object.keys(state.tickets).find(id => state.tickets[id].contactId === contactId);
    if (!ticketId) return state; // se não achou, não move
    return {
      tickets: {
        ...state.tickets,
        [ticketId]: { ...state.tickets[ticketId], stage: destStage }
      }
    };
  }),

  takeOverTicket: async (ticketId) => {
    try {
      const res = await apiFetch(`/api/tickets/${ticketId}/take-over`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        set((s) => ({
          tickets: {
            ...s.tickets,
            [ticketId]: { ...s.tickets[ticketId], aiPaused: true, stage: data.stage as Stage, assignedTo: 'user_1' } // mocking current_user assignment
          }
        }));
      }
    } catch(e) {}
  },

  returnToAI: async (ticketId) => {
    try {
      const res = await apiFetch(`/api/tickets/${ticketId}/return-to-ai`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        set((s) => ({
          tickets: {
            ...s.tickets,
            [ticketId]: { ...s.tickets[ticketId], aiPaused: false, stage: data.stage as Stage, assignedTo: undefined }
          }
        }));
      }
    } catch(e) {}
  },

  closeTicket: async (ticketId, reason, status) => {
    try {
      const res = await apiFetch(`/api/tickets/${ticketId}/close`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, status })
      });
      if (res.ok) {
        const data = await res.json();
        set((s) => ({
          tickets: {
            ...s.tickets,
            [ticketId]: { ...s.tickets[ticketId], stage: data.stage as Stage }
          }
        }));
      }
    } catch(e) {}
  },

  sendMessage: async (ticketId, text, sender = 'human') => {
    const state = get();
    const ticket = state.tickets[ticketId];
    if (!ticket) return;

    if (sender === 'human') {
       const contact = state.contacts[ticket.contactId];
       try {
          await apiFetch('/api/messages/send', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             // O backend localiza o contato pelo identifier (número), não pelo uuid.
             body: JSON.stringify({ contactId: contact?.number || ticket.contactId, text })
          });
       } catch(e) {
          console.error("Failed to send msg:", e);
       }
    }

    const newMessage: Message = {
      id: Date.now().toString(),
      contactId: ticket.contactId,
      text,
      sender,
      timestamp: new Date().toISOString()
    };

    set((s) => ({
      messages: {
        ...s.messages,
        [ticketId]: [...(s.messages[ticketId] || []), newMessage]
      },
      tickets: {
        ...s.tickets,
        [ticketId]: { ...s.tickets[ticketId], lastMessageAt: newMessage.timestamp, unreadCount: 0 }
      }
    }));
  },

  toggleAiPaused: async (ticketId) => {
    const state = get();
    const ticket = state.tickets[ticketId];
    if (!ticket) return;
    const newPaused = !ticket.aiPaused;
    const contact = state.contacts[ticket.contactId];

    try {
        await apiFetch('/api/messages/toggle-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId: contact?.number || ticket.contactId, ai_paused: newPaused })
        });
    } catch(e) {}

    set((s) => ({
      tickets: {
        ...s.tickets,
        [ticketId]: { ...ticket, aiPaused: newPaused }
      }
    }));
  },

  receiveMessage: (contactId, text, sender = 'contact', contactName, contactAvatar, contactNumber, mediaUrl) => set((state) => {
    // Check if contact exists, if not create it
    let newContacts = { ...state.contacts };
    const existingContact = newContacts[contactId];

    newContacts[contactId] = {
      id: contactId,
      name: contactName || existingContact?.name || `Contato ${contactId.slice(0, 4)}`,
      number: contactNumber || existingContact?.number || contactId,
      avatar: contactAvatar || existingContact?.avatar,
    };

    // Find open ticket for contact
    let ticketId = Object.keys(state.tickets).find(id => state.tickets[id].contactId === contactId);
    let newTickets = { ...state.tickets };
    
    // Create new ticket if none exists
    if (!ticketId) {
      ticketId = `t_${Date.now()}`;
      newTickets[ticketId] = {
        id: ticketId,
        contactId,
        stage: 'novo_lead',
        priority: 'media',
        lastMessageAt: new Date().toISOString(),
        unreadCount: sender === 'contact' ? 1 : 0
      };
    } else {
      newTickets[ticketId].lastMessageAt = new Date().toISOString();
      if (state.activeTicketId !== ticketId && sender === 'contact') {
        newTickets[ticketId].unreadCount += 1;
      }
    }

    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(),
      contactId,
      text,
      sender: sender as 'contact' | 'bot' | 'human',
      timestamp: new Date().toISOString(),
      mediaUrl,
    };

    return {
      contacts: newContacts,
      tickets: newTickets,
      messages: {
        ...state.messages,
        [ticketId]: [...(state.messages[ticketId] || []), newMessage]
      }
    };
  }),
}));
