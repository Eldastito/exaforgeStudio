import { create } from 'zustand';

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
};

export type Stage = 'novo_lead' | 'em_atendimento' | 'proposta' | 'fechado';

export type Ticket = {
  id: string;
  contactId: string;
  stage: Stage;
  priority: 'baixa' | 'media' | 'alta';
  lastMessageAt: string;
  unreadCount: number;
};

export type ViewMode = 'kanban' | 'channels' | 'dashboard';

export type EvolutionConfig = {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
};

export type ChannelInfo = {
  id: string;
  provider: 'whatsapp' | 'instagram';
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
  sendMessage: (ticketId: string, text: string, sender?: 'human' | 'bot') => void;
  receiveMessage: (contactId: string, text: string, sender?: 'contact' | 'bot' | 'human', contactName?: string, contactAvatar?: string) => void;
  connectInstagram: () => void;
  addRagDocument: (doc: Omit<RagDocument, 'id' | 'status' | 'uploadDate'>) => string;
  setRagDocumentStatus: (id: string, status: RagDocument['status']) => void;
};

// Gera um ID único de forma robusta (crypto.randomUUID em contextos seguros).
function genId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid}`;
}

const initialContacts: Record<string, Contact> = {
  c1: { id: 'c1', name: 'João Silva', number: '+55 11 99999-1111', avatar: 'https://i.pravatar.cc/150?u=c1' },
  c2: { id: 'c2', name: 'Maria Souza', number: '+55 11 99999-2222', avatar: 'https://i.pravatar.cc/150?u=c2' },
  c3: { id: 'c3', name: 'Empresa XYZ', number: '+55 11 99999-3333', avatar: 'https://i.pravatar.cc/150?u=c3' },
};

const initialTickets: Record<string, Ticket> = {
  t1: { id: 't1', contactId: 'c1', stage: 'novo_lead', priority: 'media', lastMessageAt: new Date().toISOString(), unreadCount: 1 },
  t2: { id: 't2', contactId: 'c2', stage: 'em_atendimento', priority: 'alta', lastMessageAt: new Date(Date.now() - 3600000).toISOString(), unreadCount: 0 },
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
  { id: 'ch1', provider: 'whatsapp', name: 'WhatsApp Business', identifier: '+55 11 99822-4433', status: 'connected', isActiveAI: true },
];

const initialRagDocuments: RagDocument[] = [
  { id: 'doc1', name: 'tabela_precos_2024.pdf', size: '1.2 MB', status: 'ready', channelId: 'global', uploadDate: new Date().toISOString() },
];

export const useStore = create<AppState>((set, get) => ({
  viewMode: 'kanban',
  contacts: initialContacts,
  tickets: initialTickets,
  messages: initialMessages,
  channels: initialChannels,
  ragDocuments: initialRagDocuments,
  evolutionConfig: null,
  stages: [
    { id: 'novo_lead', title: 'Novo Lead' },
    { id: 'em_atendimento', title: 'Em Atendimento' },
    { id: 'proposta', title: 'Proposta Enviada' },
    { id: 'fechado', title: 'Fechado' },
  ],
  activeTicketId: null,

  setViewMode: (mode) => set({ viewMode: mode }),
  setEvolutionConfig: (config) => set({ evolutionConfig: config }),
  setActiveTicket: (id) => set({ activeTicketId: id }),

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

  addRagDocument: (doc) => {
    const newDoc: RagDocument = {
      ...doc,
      id: genId('doc'),
      status: 'processing',
      uploadDate: new Date().toISOString()
    };
    set((state) => ({ ragDocuments: [...state.ragDocuments, newDoc] }));
    // Retorna o id para que o chamador atualize o status conforme o upload real.
    return newDoc.id;
  },

  setRagDocumentStatus: (id, status) => set((state) => ({
    ragDocuments: state.ragDocuments.map(d => (d.id === id ? { ...d, status } : d))
  })),

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

  sendMessage: (ticketId, text, sender = 'human') => set((state) => {
    const ticket = state.tickets[ticketId];
    if (!ticket) return state;

    const newMessage: Message = {
      id: genId('msg'),
      contactId: ticket.contactId,
      text,
      sender,
      timestamp: new Date().toISOString()
    };

    return {
      messages: {
        ...state.messages,
        [ticketId]: [...(state.messages[ticketId] || []), newMessage]
      },
      tickets: {
        ...state.tickets,
        [ticketId]: { ...ticket, lastMessageAt: newMessage.timestamp, unreadCount: 0 }
      }
    };
  }),

  receiveMessage: (contactId, text, sender = 'contact', contactName, contactAvatar) => set((state) => {
    // Check if contact exists, if not create it
    let newContacts = { ...state.contacts };
    const existingContact = newContacts[contactId];
    
    newContacts[contactId] = {
      id: contactId,
      name: contactName || existingContact?.name || `Contato ${contactId.slice(0, 4)}`,
      number: contactId,
      avatar: contactAvatar || existingContact?.avatar,
    };

    // Find open ticket for contact
    let ticketId = Object.keys(state.tickets).find(id => state.tickets[id].contactId === contactId);
    let newTickets = { ...state.tickets };
    
    // Create new ticket if none exists
    if (!ticketId) {
      ticketId = genId('t');
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
      id: genId('msg'),
      contactId,
      text,
      sender,
      timestamp: new Date().toISOString()
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
