import React from 'react';
import { Layers, MessageSquare, Users, BarChart3, Settings, LogOut, Bell, Webhook, Calendar, ShoppingBag, ShoppingCart, Megaphone, Link2, ShieldCheck, X, GitMerge } from 'lucide-react';
import { useStore } from '@/src/store/useStore';
import { useAuth } from '@/src/contexts/AuthContext';

export function Sidebar() {
  const { viewMode, setViewMode, sidebarOpen, setSidebarOpen } = useStore();
  const { user, logout } = useAuth();

  return (
    <>
    {/* Overlay no mobile quando o menu está aberto */}
    {sidebarOpen && (
      <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />
    )}
    <div className={`fixed lg:static inset-y-0 left-0 z-40 flex h-full w-[240px] flex-col border-r border-slate-800 bg-slate-950 transition-transform duration-200 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      {/* Botão fechar (mobile) */}
      <button onClick={() => setSidebarOpen(false)} className="lg:hidden absolute top-4 right-3 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
      <div className="flex h-16 items-center px-6 border-b border-slate-800 bg-slate-900/40">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 shadow-lg shadow-indigo-600/20">
            <Layers className="h-5 w-5 text-white" />
          </div>
          <span className="text-lg font-bold text-slate-100 tracking-tight">Zappflow<span className="text-indigo-400">.ai</span></span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        <div className="px-4 pb-2">
          <p className="px-2 text-xs font-bold uppercase tracking-widest text-slate-500 mb-3">Workspace</p>
          <nav className="space-y-1">
             <NavItem icon={<MessageSquare />} label="Atendimento" active={viewMode === 'kanban'} onClick={() => setViewMode('kanban')} />
             <NavItem icon={<Calendar />} label="Agenda" active={viewMode === 'agenda'} onClick={() => setViewMode('agenda')} />
             <NavItem icon={<ShoppingBag />} label="Catálogo" active={viewMode === 'catalog'} onClick={() => setViewMode('catalog')} />
             <NavItem icon={<ShoppingCart />} label="Vendas" active={viewMode === 'vendas'} onClick={() => setViewMode('vendas')} />
             <NavItem icon={<Megaphone />} label="Campanhas" active={viewMode === 'campanhas'} onClick={() => setViewMode('campanhas')} />
             <NavItem icon={<GitMerge />} label="Cadências" active={viewMode === 'cadencias'} onClick={() => setViewMode('cadencias')} />
             <NavItem icon={<Webhook />} label="Canais e I.A." active={viewMode === 'channels'} onClick={() => setViewMode('channels')} />
             <NavItem icon={<Users />} label="Contatos" active={viewMode === 'contacts'} onClick={() => setViewMode('contacts')} />
             <NavItem icon={<Link2 />} label="Integrações" active={viewMode === 'integrations'} onClick={() => setViewMode('integrations')} />
             <NavItem icon={<BarChart3 />} label="Dashboard" active={viewMode === 'dashboard'} onClick={() => setViewMode('dashboard')} />
             <NavItem icon={<Settings />} label="Configurações" active={viewMode === 'settings'} onClick={() => setViewMode('settings')} />
             {user?.email === 'eldastito@gmail.com' && (
               <NavItem icon={<ShieldCheck />} label="Admin Master" active={viewMode === 'admin'} onClick={() => setViewMode('admin')} />
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

      <div className="border-t border-slate-800 p-4 bg-slate-900/30">
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

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active?: boolean, onClick?: () => void }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${active ? 'bg-indigo-600/10 text-indigo-400 border border-indigo-500/20' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200 border border-transparent'}`}>
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
