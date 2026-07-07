import React from 'react';
import { Layers, MessageSquare, Users, Users2, BarChart3, Settings, LogOut, Bell, Webhook, Calendar, CalendarCheck, ShoppingBag, ShoppingCart, Megaphone, Link2, ShieldCheck, X, GitMerge, Store, LineChart, RefreshCw, PackageCheck, FileText, CalendarRange, BrainCircuit, Gauge, Wand2, ListChecks, Target, Video, Radar, ScrollText, Lightbulb } from 'lucide-react';
import { useStore } from '@/src/store/useStore';
import { useAuth } from '@/src/contexts/AuthContext';

export function Sidebar() {
  const { viewMode, setViewMode, sidebarOpen, setSidebarOpen, isModuleEnabled } = useStore();
  const { user, logout } = useAuth();
  const mod = (key: string) => isModuleEnabled(key);

  return (
    <>
    {/* Overlay no mobile quando o menu está aberto */}
    {sidebarOpen && (
      <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />
    )}
    <div
      className={`fixed lg:static inset-y-0 left-0 z-40 flex h-full w-[240px] flex-col border-r transition-transform duration-200 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}
    >
      {/* Botão fechar (mobile) */}
      <button onClick={() => setSidebarOpen(false)} className="lg:hidden absolute top-4 right-3 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
      <div
        className="flex h-16 items-center px-6 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-2)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-md shadow-lg"
            style={{
              background: 'linear-gradient(135deg, var(--color-flow), var(--color-intelligence))',
              boxShadow: '0 6px 18px rgba(34, 211, 182, 0.28)',
            }}
          >
            <Layers className="h-5 w-5" style={{ color: '#041310' }} />
          </div>
          <span className="text-lg font-bold text-slate-100 tracking-tight">Zapp<span style={{ color: 'var(--color-zf-teal)' }}>Flow</span><span className="text-slate-500 font-medium">.ai</span></span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        <div className="px-4 pb-2">
          <p className="px-2 text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Workspace</p>
          <nav className="space-y-1">
             <NavItem icon={<MessageSquare />} label="Atendimento" active={viewMode === 'kanban'} onClick={() => setViewMode('kanban')} />
             {mod('rie') && <NavItem icon={<Gauge />} label="Revenue Intelligence" active={viewMode === 'rie'} onClick={() => setViewMode('rie')} />}
             {mod('estudio') && <NavItem icon={<Wand2 />} label="Estúdio de Criação" active={viewMode === 'studio'} onClick={() => setViewMode('studio')} />}
             {mod('execucao') && <NavItem icon={<ListChecks />} label="Tarefas" active={viewMode === 'tarefas'} onClick={() => setViewMode('tarefas')} />}
             {mod('prospect') && <NavItem icon={<Target />} label="Prospect AI" active={viewMode === 'prospect'} onClick={() => setViewMode('prospect')} />}
             {mod('diretor') && <NavItem icon={<BrainCircuit />} label="Diretor IA" active={viewMode === 'diretor'} onClick={() => setViewMode('diretor')} />}
             {mod('agenda') && <NavItem icon={<Calendar />} label="Agenda" active={viewMode === 'agenda'} onClick={() => setViewMode('agenda')} />}
             {mod('reservas') && <NavItem icon={<CalendarCheck />} label="Reservas" active={viewMode === 'reservas'} onClick={() => setViewMode('reservas')} />}
             {mod('assinaturas') && <NavItem icon={<RefreshCw />} label="Assinaturas" active={viewMode === 'assinaturas'} onClick={() => setViewMode('assinaturas')} />}
             {mod('catalogo') && <NavItem icon={<ShoppingBag />} label="Catálogo" active={viewMode === 'catalog'} onClick={() => setViewMode('catalog')} />}
             {mod('vendas') && <NavItem icon={<ShoppingCart />} label="Vendas" active={viewMode === 'vendas'} onClick={() => setViewMode('vendas')} />}
             {mod('compras') && <NavItem icon={<PackageCheck />} label="Compras" active={viewMode === 'compras'} onClick={() => setViewMode('compras')} variant="supply" />}
             {mod('orcamentos') && <NavItem icon={<FileText />} label="Orçamentos" active={viewMode === 'orcamentos'} onClick={() => setViewMode('orcamentos')} />}
             {mod('eventos') && <NavItem icon={<CalendarRange />} label="Eventos & Grupos" active={viewMode === 'eventos'} onClick={() => setViewMode('eventos')} />}
             {mod('loja') && <NavItem icon={<Store />} label="Loja Virtual" active={viewMode === 'storefront'} onClick={() => setViewMode('storefront')} />}
             {mod('campanhas') && <NavItem icon={<Megaphone />} label="Campanhas" active={viewMode === 'campanhas'} onClick={() => setViewMode('campanhas')} />}
             {mod('cadencias') && <NavItem icon={<GitMerge />} label="Cadências" active={viewMode === 'cadencias'} onClick={() => setViewMode('cadencias')} />}
             {mod('vms') && <NavItem icon={<Video />} label="Vision VMS" active={viewMode === 'vision'} onClick={() => setViewMode('vision')} />}
             {mod('radar') && <NavItem icon={<Radar />} label="Radar de Execução IA" active={viewMode === 'radar'} onClick={() => setViewMode('radar')} />}
             <NavItem icon={<Webhook />} label="Canais e I.A." active={viewMode === 'channels'} onClick={() => setViewMode('channels')} />
             {mod('areas') && <NavItem icon={<Users2 />} label="Áreas de Atend." active={viewMode === 'areas'} onClick={() => setViewMode('areas')} />}
             <NavItem icon={<Users />} label="Contatos" active={viewMode === 'contacts'} onClick={() => setViewMode('contacts')} />
             {mod('integracoes') && <NavItem icon={<Link2 />} label="Integrações" active={viewMode === 'integrations'} onClick={() => setViewMode('integrations')} />}
             <NavItem icon={<BarChart3 />} label="Dashboard" active={viewMode === 'dashboard'} onClick={() => setViewMode('dashboard')} />
             <NavItem icon={<LineChart />} label="Relatórios" active={viewMode === 'reports'} onClick={() => setViewMode('reports')} />
             <NavItem icon={<ScrollText />} label="Manifesto da Marca" active={viewMode === 'manifesto'} onClick={() => setViewMode('manifesto')} />
             <NavItem icon={<Lightbulb />} label="Escuta Ativa" active={viewMode === 'escuta'} onClick={() => setViewMode('escuta')} />
             <NavItem icon={<Settings />} label="Configurações" active={viewMode === 'settings'} onClick={() => setViewMode('settings')} />
             {user?.email === 'eldastito@gmail.com' && (
               <NavItem icon={<ShieldCheck />} label="Admin Master" active={viewMode === 'admin'} onClick={() => setViewMode('admin')} />
             )}
             {user?.email === 'eldastito@gmail.com' && (
               <NavItem icon={<Radar />} label="Radar — Consultor" active={viewMode === 'radar_consultant'} onClick={() => setViewMode('radar_consultant')} />
             )}
          </nav>
        </div>
        
        <div className="px-4 pt-4">
          <p className="px-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Instâncias</p>
          <div className="space-y-1">
             <InstanceItem name="WhatsApp Comercial" status="online" />
             <InstanceItem name="Instagram Direct" status="offline" />
           </div>
        </div>
      </div>

      <div
        className="border-t p-4"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-2)' }}
      >
        <div className="flex items-center gap-3 rounded-lg p-2 hover:bg-slate-800 transition-colors cursor-pointer border border-transparent hover:border-slate-700">
          <div className="relative shadow-sm">
             <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.name || 'Admin'}`} alt="Operator" className="h-9 w-9 rounded-full bg-slate-800 border border-slate-700" />
             <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-slate-950 bg-emerald-500" />
          </div>
          <div className="flex-1 overflow-hidden">
            <p className="truncate text-sm font-semibold text-slate-100">{user?.name || 'Administrador'}</p>
            <p className="truncate text-xs text-slate-500 capitalize">{user?.role || 'Admin'}</p>
          </div>
        </div>

        <div className="mt-4 flex justify-between px-2 text-slate-500">
          <button onClick={() => setViewMode('settings')} className="hover:text-slate-300 transition-colors" title="Configurações">
             <Settings className="h-4 w-4" />
          </button>
          <button className="hover:text-slate-300 transition-colors" title="Notificações">
             <Bell className="h-4 w-4" />
          </button>
          <button onClick={logout} className="hover:text-rose-400 transition-colors" title="Sair">
             <LogOut className="h-4 w-4 text-rose-500 hover:text-rose-400" />
          </button>
        </div>
      </div>
    </div>
    </>
  );
}

function NavItem({ icon, label, active, onClick, variant }: {
  icon: React.ReactNode, label: string, active?: boolean, onClick?: () => void,
  /** 'supply' aplica destaque âmbar quando ativo (módulo de Compras/Supply). */
  variant?: 'supply',
}) {
  // Usa as classes zf-nav-item / zf-nav-item-active / zf-nav-item-supply do
  // Design System v1.1 (src/index.css). Compras/Supply ganha destaque âmbar
  // quando ativo (regra da paleta: âmbar é reservado a Supply).
  const cls = [
    'w-full zf-nav-item',
    variant === 'supply' ? 'zf-nav-item-supply' : '',
    active ? 'zf-nav-item-active' : '',
  ].filter(Boolean).join(' ');
  return (
    <button onClick={onClick} className={cls}>
      {React.cloneElement(icon as React.ReactElement, { className: 'h-4 w-4 text-inherit' })}
      {label}
    </button>
  );
}

function InstanceItem({ name, status }: { name: string, status: 'online' | 'offline' }) {
  return (
    <div className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-900 cursor-pointer">
       <span className="truncate pr-2">{name}</span>
       <span className={`h-2 w-2 flex-shrink-0 rounded-full ${status === 'online' ? 'bg-emerald-500' : 'bg-red-500'}`} />
    </div>
  );
}
