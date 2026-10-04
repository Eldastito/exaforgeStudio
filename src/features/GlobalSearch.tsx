import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Search, X, Mic, CornerDownLeft } from 'lucide-react';
import { Avatar } from '@/src/components/ui/Avatar';
import { useStore } from '@/src/store/useStore';
import { useAuth } from '@/src/contexts/AuthContext';
import { exploreGroups, primaryNav, type NavCtx } from '@/src/lib/navCatalog';
import { actionOrder, retailTabMatches, type BarAction } from '@/src/lib/commandBar';
import { trackAction } from '@/src/lib/uxTelemetry';

/**
 * Busca global funcional: filtra os contatos/tickets já carregados na store
 * (em memória, via hydrate) por nome ou número. Ao escolher um resultado,
 * abre a conversa no Kanban (setViewMode + setActiveTicket).
 *
 * ADR-203 §35 — com a navegação simplificada LIGADA vira "Pergunte ou procure qualquer coisa": o mesmo campo oferece
 * PERGUNTAR ao FalaTu (a pergunta é enviada ao abrir "Conversar"), ABRIR uma tela (mesmo gate de RBAC/plano do menu) e
 * achar um CONTATO. A decisão de ordem é pura (`lib/commandBar`); quem responde é sempre o FalaTu. Flag OFF = comportamento de sempre.
 */
export function GlobalSearch() {
  const { contacts, tickets, setViewMode, setActiveTicket, simplifiedNavEnabled, setPendingAsk, setPendingRetailTab, isModuleEnabled, canAccessModule, isMasterAdmin, falatuEnabled, missionLayerEnabled, vertical } = useStore();
  const { user } = useAuth();
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

  // ── "Abrir": telas do menu (1º nível + Explorar) que o usuário PODE ver — o mesmo catálogo/gate do menu simplificado ──
  const isManager = isMasterAdmin || user?.role === 'owner' || user?.role === 'admin';
  const navCtx = { isModuleEnabled, canAccessModule, isMasterAdmin, isManager, falatuEnabled, missionLayerEnabled, vertical, groupAvailable: false, coachAvailable: false } as NavCtx;
  const canAsk = simplifiedNavEnabled && (isMasterAdmin || (falatuEnabled && canAccessModule('falatu')));
  const opens = useMemo(() => {
    if (!simplifiedNavEnabled) return [] as Array<{ viewMode: string; label: string; tab?: string }>;
    const t = q.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.length < 2) return [];
    const seen = new Set<string>();
    const out: Array<{ viewMode: string; label: string; tab?: string }> = [];
    const push = (viewMode: string, label: string, tab?: string) => { const k = `${viewMode}:${tab || ''}`; if (!seen.has(k)) { seen.add(k); out.push({ viewMode, label, tab }); } };
    // atalhos para ABAS da Operação da Rede (ex.: "comissão") — só quando a tela pai está disponível pra este usuário (mesmo gate do menu)
    if (primaryNav(navCtx).some(p => p.viewMode === 'retailops')) for (const m of retailTabMatches(q)) push('retailops', m.label, m.tab);
    for (const p of primaryNav(navCtx)) if (p.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(t)) push(p.viewMode, p.label);
    for (const g of exploreGroups(navCtx, q)) for (const e of g.items) push(e.viewMode, e.label);
    return out.slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, simplifiedNavEnabled, isModuleEnabled, canAccessModule, isMasterAdmin, isManager, falatuEnabled, missionLayerEnabled, vertical]);

  type Row = { kind: BarAction; key: string; label?: string; viewMode?: string; tab?: string; contactId?: string };
  const rows: Row[] = useMemo(() => {
    const contactRows: Row[] = results.map(c => ({ kind: 'contact' as const, key: `c:${c.id}`, contactId: c.id }));
    if (!simplifiedNavEnabled) return contactRows;     // flag OFF: exatamente a busca de contatos de sempre
    const byKind: Record<BarAction, Row[]> = {
      ask: [{ kind: 'ask', key: 'ask', label: q.trim() }],
      open: opens.map(o => ({ kind: 'open' as const, key: `o:${o.viewMode}:${o.tab || ''}`, label: o.label, viewMode: o.viewMode, tab: o.tab })),
      contact: contactRows,
    };
    return actionOrder(q, { open: opens.length, contact: contactRows.length }, canAsk).flatMap(k => byKind[k]);
  }, [q, results, opens, simplifiedNavEnabled, canAsk]);

  const ticketForContact = (contactId: string) =>
    Object.values(tickets).find(t => t.contactId === contactId);

  const choose = (contactId: string) => {
    const ticket = ticketForContact(contactId);
    setViewMode('kanban');
    if (ticket) setActiveTicket(ticket.id);
    setQ('');
    setOpen(false);
  };

  const run = (r: Row) => {
    if (r.kind === 'contact') { choose(r.contactId!); return; }
    if (r.kind === 'ask') { trackAction('barra_perguntar', 'falatu'); setPendingAsk(r.label || q.trim()); setViewMode('falatu'); }
    else { trackAction('barra_abrir', r.viewMode || ''); if (r.tab) setPendingRetailTab(r.tab); setViewMode(r.viewMode as any); }
    setQ(''); setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || rows.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => (h + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => (h - 1 + rows.length) % rows.length); }
    else if (e.key === 'Enter') { e.preventDefault(); run(rows[Math.min(highlight, rows.length - 1)]); }
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
        placeholder={simplifiedNavEnabled ? 'Pergunte ou procure qualquer coisa…' : 'Buscar leads ou tags...'}
        className={`h-9 ${simplifiedNavEnabled ? 'w-[200px] lg:w-[340px]' : 'w-[180px] lg:w-[250px]'} rounded-md border border-zinc-800 bg-zinc-900 pl-9 pr-8 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 transition-colors`}
      />
      {q && (
        <button onClick={() => { setQ(''); setOpen(false); }} className="absolute right-2 top-2.5 text-zinc-500 hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      )}

      {open && q.trim() && (
        <div className="absolute right-0 mt-2 w-[calc(100vw-2rem)] max-w-96 max-h-[420px] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50" data-testid="command-bar-results">
          {rows.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-6">{simplifiedNavEnabled ? 'Nada encontrado. Tente outras palavras.' : 'Nenhum contato encontrado.'}</p>
          ) : (
            rows.map((r, i) => {
              const cls = `w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${i === highlight ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}`;
              const prev = rows[i - 1];
              const head = simplifiedNavEnabled && (!prev || prev.kind !== r.kind)
                ? <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">{r.kind === 'ask' ? 'Perguntar' : r.kind === 'open' ? 'Abrir' : 'Contatos'}</p> : null;
              if (r.kind === 'ask') return (
                <div key={r.key}>{head}
                  <button onClick={() => run(r)} onMouseEnter={() => setHighlight(i)} className={cls}>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-500/15 text-teal-300"><Mic className="h-4 w-4" /></span>
                    <span className="min-w-0 text-sm text-zinc-100">Perguntar ao FalaTu: <span className="text-teal-300">“{r.label}”</span></span>
                    {i === 0 && <CornerDownLeft className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                  </button>
                </div>
              );
              if (r.kind === 'open') return (
                <div key={r.key}>{head}
                  <button onClick={() => run(r)} onMouseEnter={() => setHighlight(i)} className={cls}>
                    <span className="text-sm text-zinc-100">{r.label}</span>
                    {i === 0 && <CornerDownLeft className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                  </button>
                </div>
              );
              const c = contacts[r.contactId!] || Object.values(contacts).find(x => x.id === r.contactId);
              return (
                <div key={r.key}>{head}
                  <button onClick={() => run(r)} onMouseEnter={() => setHighlight(i)} className={cls}>
                    <Avatar name={c?.name} src={c?.avatar} size={32} className="border border-zinc-800" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{c?.name || 'Sem nome'}</p>
                      <p className="text-xs text-zinc-500 truncate">{c?.number}</p>
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
