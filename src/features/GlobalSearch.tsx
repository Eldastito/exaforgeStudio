import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Search, User, X } from 'lucide-react';
import { useStore } from '@/src/store/useStore';

/**
 * Busca global funcional: filtra os contatos/tickets já carregados na store
 * (em memória, via hydrate) por nome ou número. Ao escolher um resultado,
 * abre a conversa no Kanban (setViewMode + setActiveTicket).
 */
export function GlobalSearch() {
  const { contacts, tickets, setViewMode, setActiveTicket } = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const digits = term.replace(/\D/g, '');
    return Object.values(contacts)
      .filter(c => {
        const name = (c.name || '').toLowerCase();
        const num = (c.number || '').replace(/\D/g, '');
        return name.includes(term) || (digits.length >= 3 && num.includes(digits));
      })
      .slice(0, 8);
  }, [q, contacts]);

  const ticketForContact = (contactId: string) =>
    Object.values(tickets).find(t => t.contactId === contactId);

  const choose = (contactId: string) => {
    const ticket = ticketForContact(contactId);
    setViewMode('kanban');
    if (ticket) setActiveTicket(ticket.id);
    setQ('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => (h + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => (h - 1 + results.length) % results.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[highlight].id); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div ref={boxRef} className="relative hidden md:block">
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
      <input
        type="text"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); setHighlight(0); }}
        onFocus={() => q && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Buscar leads ou tags..."
        className="h-9 w-[180px] lg:w-[250px] rounded-md border border-zinc-800 bg-zinc-900 pl-9 pr-8 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 transition-colors"
      />
      {q && (
        <button onClick={() => { setQ(''); setOpen(false); }} className="absolute right-2 top-2.5 text-zinc-500 hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      )}

      {open && q.trim() && (
        <div className="absolute right-0 mt-2 w-80 max-h-[360px] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50">
          {results.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-6">Nenhum contato encontrado.</p>
          ) : (
            results.map((c, i) => (
              <button
                key={c.id}
                onClick={() => choose(c.id)}
                onMouseEnter={() => setHighlight(i)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${i === highlight ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}`}
              >
                {c.avatar ? (
                  <img src={c.avatar} alt="" className="h-8 w-8 rounded-full border border-zinc-800 object-cover" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800">
                    <User className="h-4 w-4 text-zinc-400" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100 truncate">{c.name || 'Sem nome'}</p>
                  <p className="text-xs text-zinc-500 truncate">{c.number}</p>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
