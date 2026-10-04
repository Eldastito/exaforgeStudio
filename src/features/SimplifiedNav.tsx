/**
 * SimplifiedNav (ADR-203 F2.2) — menu simplificado atrás da flag `simplified_navigation_enabled`.
 * 5 superfícies de 1º nível (Hoje · FalaTu · Executando · Resultados · Empresa) + "Explorar"
 * (tudo o mais, agrupado, com busca). Nada é removido: cada tela do menu legado segue
 * alcançável em Explorar sob o MESMO gate de RBAC/plano (RN-F2-1/3). Destinos dos 5 itens são
 * interinos (telas existentes) — F2.3..F2.6 trocam por telas dedicadas.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Sun, Mic, Rocket, TrendingUp, Building2, Store, Compass, ChevronDown, Search } from 'lucide-react';
import { exploreGroups, primaryNav, type NavCtx } from '@/src/lib/navCatalog';
import { trackAction, trackSearchMiss } from '@/src/lib/uxTelemetry';

const ICON: Record<string, React.ReactNode> = {
  hoje: <Sun className="h-4 w-4" />, falatu: <Mic className="h-4 w-4" />, executando: <Rocket className="h-4 w-4" />,
  resultados: <TrendingUp className="h-4 w-4" />, empresa: <Building2 className="h-4 w-4" />, rede: <Store className="h-4 w-4" />,
};

export function SimplifiedNav({ ctx, viewMode, onNavigate }: { ctx: NavCtx; viewMode: string; onNavigate: (vm: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const primary = primaryNav(ctx);
  const groups = exploreGroups(ctx, q);
  // busca sem resultado = sinal de que falta um atalho/nome; registra QUE aconteceu (nunca o que foi digitado), uma vez por busca
  const lastMiss = useRef('');
  useEffect(() => {
    const t = q.trim();
    if (t.length >= 3 && groups.length === 0 && lastMiss.current !== t) { lastMiss.current = t; trackSearchMiss(); }
  }, [q, groups.length]);
  // a ABERTURA da tela é registrada uma vez pelo App (view_opened); aqui só COMO chegou: pelo 1º nível ou pelo Explorar
  const go = (vm: string, from: string) => { trackAction(from, vm); onNavigate(vm); };
  const item = (active: boolean) => `w-full zf-nav-item ${active ? 'zf-nav-item-active' : ''}`;

  return (
    <nav className="space-y-1" data-testid="simplified-nav">
      {primary.map(p => (
        <button key={p.key} className={item(viewMode === p.viewMode)} onClick={() => go(p.viewMode, 'nav_primario')}>
          {ICON[p.key]}{p.label}
        </button>
      ))}
      <button className="w-full zf-nav-item mt-2" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Compass className="h-4 w-4" />Explorar
        <ChevronDown className={`ml-auto h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 pt-1">
          <label className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs text-slate-400" style={{ borderColor: 'var(--color-border)' }}>
            <Search className="h-3.5 w-3.5" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar tela…" className="w-full bg-transparent outline-none text-slate-200 placeholder:text-slate-500" />
          </label>
          {groups.length === 0 && <p className="px-2 text-xs text-slate-500">Nada encontrado.</p>}
          {groups.map(g => (
            <div key={g.group}>
              <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">{g.label}</p>
              {g.items.map(e => (
                <button key={e.viewMode} className={item(viewMode === e.viewMode)} onClick={() => go(e.viewMode, 'nav_explorar')}>{e.label}</button>
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
