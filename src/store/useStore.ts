import { create } from 'zustand';
import { apiFetch } from '@/src/lib/api';

/**
 * Normaliza datetimes vindos do SQLite para ISO-UTC. O SQLite grava
 * CURRENT_TIMESTAMP como "YYYY-MM-DD HH:MM:SS" em UTC, SEM marcador de fuso.
 * `new Date("2026-06-28 03:19:26")` é interpretado como horário LOCAL pelo
 * navegador → desloca pelo fuso (ex.: −3h no Brasil), fazendo a hora parecer
 * "aleatória". Aqui marcamos explicitamente como UTC (T...Z) para o front
 * exibir no fuso local correto. Strings que já têm fuso (Z/+hh:mm) passam direto.
 */
function toIso(s?: string | null): string {
  if (!s) return new Date().toISOString();
  if (typeof s !== 'string') return s as any;
  const v = s.trim();
  if (/(z|[+-]\d\d:?\d\d)$/i.test(v)) return v;       // já tem fuso
  return v.replace(' ', 'T') + 'Z';                    // UTC do SQLite → ISO-UTC
}

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
  // Continuity Layer (ADR-082, Fase 0): estado REAL de entrega da mensagem
  // enviada pelo painel. 'pending' até o servidor confirmar; nunca mostrar
  // como enviada sem confirmação.
  // 'queued'/'delivered' entram com a fila de entrega ao provedor (ADR-082,
  // Fase 3): queued = na fila do servidor; delivered = confirmado ao destinatário.
  deliveryStatus?: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
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
  handoffSummary?: string;
  slaState?: 'ok' | 'at_risk' | 'breached' | null;
  slaSegment?: string | null;
};

export type ViewMode = 'kanban' | 'channels' | 'dashboard' | 'agenda' | 'catalog' | 'vendas' | 'campanhas' | 'cadencias' | 'contacts' | 'integrations' | 'settings' | 'admin' | 'storefront' | 'areas' | 'reports' | 'reservas' | 'assinaturas' | 'compras' | 'orcamentos' | 'eventos' | 'diretor' | 'rie' | 'studio' | 'tarefas' | 'prospect' | 'radar_b2b' | 'clinica' | 'vision' | 'radar' | 'radar_consultant' | 'manifesto' | 'escuta';

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
  vertical: string | null;
  enabledModules: string[] | null; // null = todos habilitados (legado)
  loadOrgConfig: () => Promise<void>;
  isModuleEnabled: (moduleKey: string) => boolean;
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
  moveTicket: (ticketId: string, destStage: Stage) => Promise<void>;
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

  vertical: null,
  enabledModules: null,
  loadOrgConfig: async () => {
    try {
      const res = await apiFetch('/api/analytics/settings');
      const s = await res.json().catch(() => ({}));
      let mods: string[] | null = null;
      if (typeof s?.enabled_modules === 'string' && s.enabled_modules) {
        try { const a = JSON.parse(s.enabled_modules); if (Array.isArray(a)) mods = a; } catch {}
      } else if (Array.isArray(s?.enabled_modules)) {
        mods = s.enabled_modules;
      }
      set({ vertical: s?.vertical || null, enabledModules: mods });
      const landing = s?.default_landing_view;
      if (landing && !localStorage.getItem('zappflow_view')) {
        set({ viewMode: landing as ViewMode });
      }
    } catch (e) { /* mantém null = tudo liberado */ }
  },
  isModuleEnabled: (moduleKey) => {
    const em = get().enabledModules;
    // Sem config explícita ⇒ só o núcleo (os itens core da sidebar não passam
    // por aqui). Evita o "todo mundo vê tudo" enquanto a vertical não é definida.
    if (em == null) return false;
    return em.includes(moduleKey);
  },
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
          lastMessageAt: toIso(r.last_message_at || r.updated_at || r.created_at),
          unreadCount: 0,
          aiPaused: r.ai_paused === 1,
          assignedTo: r.assigned_to || undefined,
          handoffSummary: r.handoff_summary || undefined,
          handoffReason: r.handoff_reason || undefined,
          slaState: r.sla_state ?? null,
          slaSegment: r.sla_segment || null,
        };
        messages[r.id] = r.last_message
          ? [{ id: `last_${r.id}`, contactId: r.contact_id, text: r.last_message, sender: 'contact', timestamp: toIso(r.last_message_at || r.updated_at) }]
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
        timestamp: toIso(m.created_at),
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

  moveTicket: async (ticketId, destStage) => {
    // Atualização otimista: move na hora e persiste no backend; se falhar, reverte.
    const prevStage = get().tickets[ticketId]?.stage;
    set((state) => ({
      tickets: { ...state.tickets, [ticketId]: { ...state.tickets[ticketId], stage: destStage } }
    }));
    if (prevStage === destStage) return;
    try {
      const res = await apiFetch(`/api/tickets/${ticketId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: destStage }),
      });
      if (!res.ok) throw new Error(`Falha ao mover ticket: ${res.status}`);
    } catch (e) {
      console.error(e);
      // Reverte para o estágio anterior se o backend não aceitou.
      if (prevStage) set((state) => ({
        tickets: { ...state.tickets, [ticketId]: { ...state.tickets[ticketId], stage: prevStage } }
      }));
    }
  },

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
            [ticketId]: { ...s.tickets[ticketId], aiPaused: true, stage: data.stage as Stage, assignedTo: 'user_1', handoffSummary: data.summary || s.tickets[ticketId]?.handoffSummary } // mocking current_user assignment
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

    const localId = (globalThis.crypto?.randomUUID?.() || Date.now().toString());
    const newMessage: Message = {
      id: localId,
      contactId: ticket.contactId,
      text,
      sender,
      timestamp: new Date().toISOString(),
      // Mensagens do próprio painel nascem 'pending' e só viram 'sent' com a
      // confirmação do servidor (ADR-082, Fase 0 — corrige a mensagem fantasma).
      deliveryStatus: sender === 'human' ? 'pending' : undefined,
    };

    // Mostra imediatamente como PENDENTE (não como "enviada") — feedback honesto.
    set((s) => ({
      messages: { ...s.messages, [ticketId]: [...(s.messages[ticketId] || []), newMessage] },
      tickets: { ...s.tickets, [ticketId]: { ...s.tickets[ticketId], lastMessageAt: newMessage.timestamp, unreadCount: 0 } },
    }));

    if (sender !== 'human') return;

    const contact = state.contacts[ticket.contactId];
    const patch = (status: Message['deliveryStatus']) => set((s) => ({
      messages: {
        ...s.messages,
        [ticketId]: (s.messages[ticketId] || []).map(m => m.id === localId ? { ...m, deliveryStatus: status } : m),
      },
    }));
    try {
      const res = await apiFetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // O backend localiza o contato pelo identifier (número), não pelo uuid.
        // commandId dá idempotência: reenvio pelo outbox não duplica (ADR-082 D3).
        body: JSON.stringify({ contactId: contact?.number || ticket.contactId, text, commandId: localId }),
      });
      if (res.ok) {
        // Com a FILA DE ENTREGA ligada (ADR-082, Fase 3) o servidor responde
        // 'queued': a mensagem entrou na fila, ainda NÃO foi entregue — o balão
        // segue "na fila" e o socket `message_delivery_status` o promove a
        // enviada/entregue/falha. Sem a fila, 2xx = 'sent' como antes.
        let status: Message['deliveryStatus'] = 'sent';
        try { const body = await res.json(); if (body?.status === 'queued') status = 'queued'; } catch { /* corpo vazio */ }
        patch(status);
      } else {
        // Um 500/502 do provedor NÃO é sucesso — vira 'failed', nunca some.
        patch('failed');
      }
    } catch (e) {
      // Erro de REDE (offline): não falha — enfileira no outbox durável
      // (ADR-082, Fase 1b) e deixa 'pending'. O flusher reenvia quando a
      // conexão voltar, com o mesmo commandId (servidor deduplica).
      console.warn("Sem conexão ao enviar — enfileirando no outbox:", e);
      try {
        const { enqueueMessage } = await import('@/src/lib/continuity/sync');
        await enqueueMessage(localId, { contactId: contact?.number || ticket.contactId, text });
        // permanece 'pending' na UI (não vira 'failed')
      } catch {
        patch('failed');
      }
    }
  },

  toggleAiPaused: async (ticketId) => {
    const state = get();
    const ticket = state.tickets[ticketId];
    if (!ticket) return;
    const newPaused = !ticket.aiPaused;
    const contact = state.contacts[ticket.contactId];

    // ADR-082 (Fase 0): a UI só reflete a mudança se o servidor confirmar. Antes,
    // o set() rodava sempre — a IA "parecia" pausada mesmo com o backend fora.
    try {
      const res = await apiFetch('/api/messages/toggle-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact?.number || ticket.contactId, ai_paused: newPaused }),
      });
      if (!res.ok) throw new Error(`toggle-ai ${res.status}`);
      set((s) => ({ tickets: { ...s.tickets, [ticketId]: { ...s.tickets[ticketId], aiPaused: newPaused } } }));
    } catch (e) {
      console.error("Failed to toggle AI:", e);
      // Não altera a UI — evita divergência com o servidor.
    }
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
