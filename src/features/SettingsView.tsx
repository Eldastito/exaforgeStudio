import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Image as ImageIcon, Briefcase, Users, CreditCard, LayoutGrid, Rocket, Check, Sparkles, ShieldCheck, Lock, BrainCircuit } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { toast, confirmDialog } from '@/src/lib/toast';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';

import { UsersSettingsView } from './UsersSettingsView';

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('empresa');
  const [form, setForm] = useState({
    business_name: '',
    legal_name: '',
    cnpj_cpf: '',
    address: '',
    phone: '',
    email: '',
    logo_url: '',
    primary_color: '#6366f1',
    report_footer: ''
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/analytics/settings')
      .then(res => res.json())
      .then(data => {
        if (data.business_name) {
          setForm(data);
        }
      })
      .catch(console.error);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/analytics/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      toast.success('Configurações salvas com sucesso!');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 overflow-hidden bg-zinc-950">
      {/* Config Sidebar */}
      <div className="w-64 border-r border-zinc-800 bg-zinc-900/30 p-4 overflow-y-auto">
        <h3 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4 px-3">Configurações</h3>
        <nav className="space-y-1">
          <button onClick={() => setActiveTab('quickstart')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'quickstart' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Rocket className="w-4 h-4" /> Quick-Start
          </button>
          <button onClick={() => setActiveTab('empresa')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'empresa' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Briefcase className="w-4 h-4" /> Empresa
          </button>
          <button onClick={() => setActiveTab('atendimento')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'atendimento' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <BrainCircuit className="w-4 h-4" /> Atendimento (IA)
          </button>
          <button onClick={() => setActiveTab('usuarios')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'usuarios' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Users className="w-4 h-4" /> Usuários e Permissões
          </button>
  <button onClick={() => setActiveTab('cobranca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'cobranca' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <CreditCard className="w-4 h-4" /> Cobrança e Plano
          </button>
          <button onClick={() => setActiveTab('modulos')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'modulos' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <LayoutGrid className="w-4 h-4" /> Módulos
          </button>
          <button onClick={() => setActiveTab('seguranca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'seguranca' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <ShieldCheck className="w-4 h-4" /> Segurança (2FA)
          </button>
          <button onClick={() => setActiveTab('privacidade')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'privacidade' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Lock className="w-4 h-4" /> Privacidade (LGPD)
          </button>
        </nav>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl">
          
          {activeTab === 'empresa' && (
            <>
              <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
                    <SettingsIcon className="w-6 h-6 text-indigo-400" />
                    Dados da Empresa
                  </h2>
                  <p className="text-zinc-400 text-sm mt-1">Configurações gerais e dados para geração de relatórios.</p>
                </div>
                <Button onClick={handleSubmit} disabled={loading} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Save className="w-4 h-4 mr-2" />
                  {loading ? 'Salvando...' : 'Salvar'}
                </Button>
              </div>

              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Nome Fantasia</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.business_name} onChange={e => setForm({...form, business_name: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Razão Social</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.legal_name} onChange={e => setForm({...form, legal_name: e.target.value})} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">CNPJ / CPF</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.cnpj_cpf} onChange={e => setForm({...form, cnpj_cpf: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Telefone Comercial</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">E-mail</label>
                <input type="email" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.email} onChange={e => setForm({...form, email: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Cor Principal (Relatórios)</label>
                <div className="flex gap-2">
                  <input type="color" className="bg-zinc-950 border border-zinc-800 rounded p-1 w-12 h-10" 
                    value={form.primary_color} onChange={e => setForm({...form, primary_color: e.target.value})} />
                  <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 outline-none font-mono" 
                    value={form.primary_color} onChange={e => setForm({...form, primary_color: e.target.value})} />
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Logomarca (URL ou Arquivo)</label>
              <div className="flex items-center gap-4">
                <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.logo_url} onChange={e => setForm({...form, logo_url: e.target.value})} placeholder="https://..." />
                
                <label className="cursor-pointer bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm py-2.5 px-4 rounded-lg transition-colors border border-zinc-700 font-medium">
                  Pesquisar
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setForm({ ...form, logo_url: reader.result as string });
                        };
                        reader.readAsDataURL(file);
                      }
                    }} 
                  />
                </label>

                {form.logo_url ? (
                  <img src={form.logo_url} alt="Logo preview" className="w-10 h-10 object-contain rounded bg-white p-1" />
                ) : (
                  <div className="w-10 h-10 rounded border border-zinc-800 flex items-center justify-center bg-zinc-950">
                    <ImageIcon className="w-4 h-4 text-zinc-600" />
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Endereço Completo</label>
              <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                value={form.address} onChange={e => setForm({...form, address: e.target.value})} />
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Rodapé de Relatórios</label>
              <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none min-h-[80px]" 
                value={form.report_footer} onChange={e => setForm({...form, report_footer: e.target.value})} placeholder="Ex: Este documento é confidencial..." />
            </div>

          </form>
          </div>
          </>
          )}

          {activeTab === 'atendimento' && <AiAttendancePanel />}
          {activeTab === 'cobranca' && <BillingPanel />}

          {activeTab === 'modulos' && <ModulesPanel />}
          {activeTab === 'quickstart' && <QuickStartPanel />}
          {activeTab === 'seguranca' && <SecurityPanel />}
          {activeTab === 'privacidade' && <LgpdPanel />}

          {activeTab === 'usuarios' && (
             <UsersSettingsView />
          )}
        </div>
      </div>
    </div>
  );
}

type Plan = { id: string; name: string; price: number; features: any };
type Snapshot = {
  plan: Plan | null;
  billingStatus: string;
  orgStatus: string;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  usage: { ai_this_month: number; contacts: number; channels: number; users: number };
  limits: any;
};

function BillingPanel() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);

  const load = () => {
    Promise.all([
      fetch('/api/plans').then(r => r.json()).catch(() => []),
      fetch('/api/plans/current').then(r => r.json()).catch(() => null),
    ]).then(([ps, sn]) => {
      setPlans(Array.isArray(ps) ? ps : []);
      setSnap(sn && !sn.error ? sn : null);
    });
  };
  useEffect(() => { load(); }, []);

  const choose = async (planId: string) => {
    if (snap?.plan?.id === planId) return;
    if (!(await confirmDialog('Confirmar troca de plano?', {}))) return;
    setSelecting(planId);
    try {
      await fetch('/api/plans/select', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      load();
    } finally { setSelecting(null); }
  };

  const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
    active:    { label: 'Ativo',         cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
    trialing:  { label: 'Em teste',      cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
    past_due:  { label: 'Atrasado',      cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    suspended: { label: 'Suspenso',      cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
    blocked:   { label: 'Bloqueado',     cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
    cancelled: { label: 'Cancelado',     cls: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30' },
  };
  const badge = STATUS_BADGE[snap?.billingStatus || 'active'] || STATUS_BADGE.active;

  return (
    <div className="space-y-6">
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white flex items-center gap-2"><CreditCard className="w-5 h-5 text-indigo-400" /> Plano e Uso</h2>
            <p className="text-zinc-400 text-sm mt-1">Plano atual, status e consumo no mês.</p>
          </div>
          <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${badge.cls}`}>{badge.label.toUpperCase()}</span>
        </div>

        {snap?.plan ? (
          <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
            <InfoCard label="Plano atual" value={snap.plan.name} sub={`R$ ${snap.plan.price.toFixed(2)} / mês`} />
            <InfoCard label="Status" value={badge.label} sub={
              snap.trialDaysLeft != null
                ? (snap.trialDaysLeft > 0 ? `${snap.trialDaysLeft} dia(s) de teste restantes` : 'Trial encerrado')
                : '—'
            } />
            <InfoCard label="Período atual" value={snap.currentPeriodEnd ? new Date(snap.currentPeriodEnd).toLocaleDateString('pt-BR') : '—'} sub="Próximo ciclo de cobrança" />
          </div>
        ) : (
          <p className="mt-4 text-sm text-amber-300/80 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
            Você ainda não escolheu um plano. Escolha abaixo para iniciar seu período de teste.
          </p>
        )}

        {/* Uso vs Limites */}
        {snap && (
          <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            <UsageBar label="Respostas de IA (este mês)" used={snap.usage.ai_this_month} limit={snap.limits.ai_monthly_limit} />
            <UsageBar label="Contatos na base" used={snap.usage.contacts} limit={snap.limits.contacts_limit} />
            <UsageBar label="Canais conectados" used={snap.usage.channels} limit={snap.limits.channels_limit} />
            <UsageBar label="Usuários" used={snap.usage.users} limit={snap.limits.users_limit} />
          </div>
        )}
      </div>

      {/* Planos disponíveis */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-white mb-1">Planos disponíveis</h3>
        <p className="text-sm text-zinc-400 mb-5">Troque de plano a qualquer momento. A primeira escolha inicia seu período de teste gratuito.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map(p => {
            const isCurrent = snap?.plan?.id === p.id;
            return (
              <div key={p.id} className={`p-5 rounded-xl border ${isCurrent ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
                <div className="flex items-baseline justify-between">
                  <h4 className="text-lg font-bold text-zinc-100">{p.name}</h4>
                  {isCurrent && <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">Atual</span>}
                </div>
                <p className="text-2xl font-bold text-white mt-2">R$ {p.price.toFixed(0)}<span className="text-sm font-normal text-zinc-500">/mês</span></p>
                <ul className="mt-4 space-y-1.5 text-sm text-zinc-400">
                  <li>• <strong className="text-zinc-200">{(p.features?.ai_monthly_limit || 0).toLocaleString('pt-BR')}</strong> respostas de IA / mês</li>
                  <li>• Até <strong className="text-zinc-200">{(p.features?.contacts_limit || 0).toLocaleString('pt-BR')}</strong> contatos</li>
                  <li>• <strong className="text-zinc-200">{p.features?.channels_limit || 0}</strong> canal(is) conectado(s)</li>
                  <li>• <strong className="text-zinc-200">{p.features?.users_limit || 0}</strong> usuário(s)</li>
                  <li>• <strong className="text-zinc-200">{p.features?.trial_days || 14}</strong> dias de teste grátis</li>
                </ul>
                <Button
                  onClick={() => choose(p.id)}
                  disabled={isCurrent || selecting === p.id}
                  className={`w-full mt-5 ${isCurrent ? 'bg-zinc-800 text-zinc-500' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}
                >
                  {selecting === p.id ? 'Selecionando...' : isCurrent ? 'Plano atual' : (snap?.plan ? 'Trocar para este plano' : 'Iniciar teste grátis')}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InfoCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-zinc-100 mt-1">{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit?: number }) {
  const l = limit || 0;
  const pct = l > 0 ? Math.min(100, Math.round((used / l) * 100)) : 0;
  const over = l > 0 && used >= l;
  const near = l > 0 && pct >= 80 && !over;
  const bar = over ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-indigo-500';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-sm text-zinc-300">{label}</p>
        <p className={`text-xs ${over ? 'text-red-400' : 'text-zinc-400'}`}>
          {used.toLocaleString('pt-BR')}{l > 0 ? ` / ${l.toLocaleString('pt-BR')}` : ' / ∞'}
        </p>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full ${bar} transition-all`} style={{ width: `${pct || (l === 0 ? 0 : 0)}%` }} />
      </div>
    </div>
  );
}

// Lista de módulos OPCIONAIS (espelha OPTIONAL_MODULES do backend) + rótulos.
const OPTIONAL_MODULES: { key: string; label: string; desc: string }[] = [
  { key: 'agenda', label: 'Agenda', desc: 'Agendamentos e horários (Google Calendar).' },
  { key: 'reservas', label: 'Reservas', desc: 'Reservas por período com controle de disponibilidade (quartos, mesas, aluguéis).' },
  { key: 'assinaturas', label: 'Assinaturas', desc: 'Cobrança recorrente (mensalidades, planos, clubes).' },
  { key: 'compras', label: 'Compras', desc: 'Reposição inteligente: a IA detecta estoque crítico e gera lista de compra para aprovação.' },
  { key: 'orcamentos', label: 'Orçamentos', desc: 'Orçamentos como objeto rastreável: enviado/aceito/recusado + follow-up automático até a validade.' },
  { key: 'eventos', label: 'Eventos & Grupos', desc: 'Pipeline de consultas consultivas (casamento, convenção, day use, corporativo). A IA detecta na conversa e cria a consulta.' },
  { key: 'diretor', label: 'Diretor Executivo IA', desc: 'Conselheiro de gestão: pergunte em linguagem natural ("onde estou perdendo dinheiro?") e receba resposta com dados reais + briefing diário.' },
  { key: 'catalogo', label: 'Catálogo', desc: 'Produtos e serviços.' },
  { key: 'estudio', label: 'Estúdio de Criação', desc: 'IA gera imagens (e em breve vídeos) de campanha com a identidade da marca.' },
  { key: 'vendas', label: 'Vendas', desc: 'Pedidos e fechamento de vendas.' },
  { key: 'loja', label: 'Loja Virtual', desc: 'Vitrine online para o cliente comprar.' },
  { key: 'pagamentos', label: 'Pagamentos', desc: 'Recebimento por PIX / gateway.' },
  { key: 'campanhas', label: 'Campanhas', desc: 'Disparos segmentados.' },
  { key: 'cadencias', label: 'Cadências', desc: 'Sequências de follow-up automático.' },
  { key: 'areas', label: 'Áreas de Atendimento', desc: 'Vários profissionais num número.' },
  { key: 'integracoes', label: 'Integrações', desc: 'Google Workspace e outras conexões.' },
];

function ModulesPanel() {
  const loadOrgConfig = useStore(s => s.loadOrgConfig);
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/analytics/settings')
      .then(r => r.json())
      .then(s => {
        let mods: string[] | null = null;
        if (typeof s?.enabled_modules === 'string' && s.enabled_modules) {
          try { const a = JSON.parse(s.enabled_modules); if (Array.isArray(a)) mods = a; } catch {}
        } else if (Array.isArray(s?.enabled_modules)) mods = s.enabled_modules;
        // null (legado) = todos ligados: refletimos isso marcando tudo.
        setEnabled(mods ?? OPTIONAL_MODULES.map(m => m.key));
      })
      .catch(() => setEnabled(OPTIONAL_MODULES.map(m => m.key)))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (key: string) => {
    setEnabled(prev => {
      const cur = prev ?? [];
      return cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key];
    });
  };

  const save = async () => {
    if (!enabled) return;
    setSaving(true);
    try {
      await apiFetch('/api/analytics/settings/modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled_modules: enabled }),
      });
      await loadOrgConfig(); // atualiza o menu lateral na hora
      toast.success('Módulos atualizados!');
    } catch (e) { toast.error('Falha ao salvar os módulos.'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <LayoutGrid className="w-6 h-6 text-indigo-400" /> Módulos
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Ative só o que faz sentido pro seu negócio. Atendimento, Contatos e Relatórios estão sempre ativos.</p>
        </div>
        <Button onClick={save} disabled={saving || loading} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          <Save className="w-4 h-4 mr-2" /> {saving ? 'Salvando...' : 'Salvar'}
        </Button>
      </div>

      {loading || !enabled ? (
        <p className="text-zinc-500 text-sm">Carregando…</p>
      ) : (
        <div className="space-y-2">
          {OPTIONAL_MODULES.map(m => {
            const on = enabled.includes(m.key);
            return (
              <div key={m.key} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div>
                  <p className="text-sm font-medium text-zinc-100">{m.label}</p>
                  <p className="text-xs text-zinc-500">{m.desc}</p>
                </div>
                <button onClick={() => toggle(m.key)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}


// ============================================================================
// QuickStartPanel — aplica um pacote completo de áreas + cadências + automações
// + FAQ inicial em segundos, por vertical. Pitch da venda: "abre, clica, sai
// vendendo". Idempotente (não duplica o que já existe).
// ============================================================================
function QuickStartPanel() {
  const [packs, setPacks] = useState<any[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const [report, setReport] = useState<any>(null);
  const [skipFaq, setSkipFaq] = useState(false);

  useEffect(() => {
    apiFetch('/api/quickstart/packs').then(r => r.json()).then(d => setPacks(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const apply = async (vertical: string, label: string) => {
    if (!confirm(`Aplicar o setup pronto de ${label}?\n\nO sistema vai criar áreas, cadências, automações e a base de conhecimento inicial.\n\nIdempotente: o que já existe não é alterado.`)) return;
    setApplying(vertical);
    setReport(null);
    try {
      const res = await apiFetch('/api/quickstart/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vertical, skipFaq }),
      });
      const d = await res.json();
      if (d?.success) setReport({ ...d.report, vertical, label });
      else alert(d?.error || 'Falha ao aplicar.');
    } catch (e: any) { alert(e.message || 'Falha ao aplicar.'); }
    finally { setApplying(null); }
  };

  return (
    <>
      <div className="mb-6 border-b border-zinc-800 pb-4">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <Rocket className="w-6 h-6 text-indigo-400" /> Quick-Start
        </h2>
        <p className="text-zinc-400 text-sm mt-1">
          Aplique um <b>setup pronto</b> da sua vertical em segundos: áreas de atendimento com personas
          consultivas, cadências de follow-up, automações de recuperação e uma base inicial de FAQ.
          <span className="text-emerald-400"> Idempotente</span> — não duplica o que já existe.
        </p>
      </div>

      <label className="flex items-center gap-2 mb-4 text-xs text-zinc-400">
        <input type="checkbox" checked={skipFaq} onChange={e => setSkipFaq(e.target.checked)} className="w-4 h-4 accent-indigo-600" />
        Não criar a FAQ inicial (usar se você já tem sua própria base de conhecimento).
      </label>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {packs.map((p) => (
          <div key={p.vertical} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <p className="text-sm font-semibold text-zinc-100">{p.label}</p>
            </div>
            <p className="text-xs text-zinc-400 mb-3">Inclui:</p>
            <ul className="text-xs text-zinc-300 space-y-1 mb-4 flex-1">
              <li>✅ {p.summary.areas} áreas com persona da IA</li>
              <li>✅ {p.summary.cadences} cadências de follow-up</li>
              <li>✅ {p.summary.automations} automações pré-ativadas</li>
              <li>✅ {p.summary.faq} FAQ inicial no RAG</li>
            </ul>
            <Button
              disabled={applying != null}
              onClick={() => apply(p.vertical, p.label)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {applying === p.vertical ? 'Aplicando…' : `Aplicar ${p.label}`}
            </Button>
          </div>
        ))}
        {packs.length === 0 && <p className="text-sm text-zinc-500">Carregando…</p>}
      </div>

      {report && (
        <div className="mt-6 rounded-xl border border-emerald-700/40 bg-emerald-500/5 p-4">
          <p className="text-sm font-medium text-emerald-300 flex items-center gap-2">
            <Check className="w-4 h-4" /> Setup de {report.label} aplicado!
          </p>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <ReportLine label="Áreas" created={report.areas.created} skipped={report.areas.skipped} />
            <ReportLine label="Cadências" created={report.cadences.created} skipped={report.cadences.skipped} />
            <ReportLine label="Automações" created={report.automations.applied} skipped={0} />
            <ReportLine label="FAQ" created={report.faq.created} skipped={report.faq.skipped} />
          </div>
          <p className="text-[11px] text-zinc-400 mt-3">
            👉 Agora vá em <b>Atendimento</b> para ver as áreas, em <b>Cadências</b> para refinar mensagens e em <b>Canais</b> para revisar a FAQ. As automações estão visíveis em <b>Campanhas › Recuperação de vendas</b>.
          </p>
        </div>
      )}
    </>
  );
}

function ReportLine({ label, created, skipped }: { label: string; created: number; skipped: number }) {
  return (
    <div className="rounded bg-zinc-900/60 border border-zinc-800 p-2">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="text-sm text-zinc-200">{created} criado(s)</p>
      {skipped > 0 && <p className="text-[10px] text-zinc-500">{skipped} já existia(m)</p>}
    </div>
  );
}

// ============================================================================
// SecurityPanel — 2FA (TOTP) self-service por usuário: ativar/desativar.
// ============================================================================
function SecurityPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [step, setStep] = useState<'idle' | 'setup'>('idle');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadStatus = () => apiFetch('/api/mfa/status').then(r => r.json()).then(d => setEnabled(!!d.enabled)).catch(() => setEnabled(false));
  useEffect(() => { loadStatus(); }, []);

  const startSetup = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await apiFetch('/api/mfa/setup', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha ao iniciar.');
      setQr(d.qr); setSecret(d.secret); setStep('setup'); setBackupCodes(null);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const confirm = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await apiFetch('/api/mfa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Código inválido.');
      setBackupCodes(d.backupCodes || []); setStep('idle'); setCode(''); loadStatus();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const disable = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await apiFetch('/api/mfa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha ao desativar.');
      setPassword(''); loadStatus();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="mb-6 border-b border-zinc-800 pb-4">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-indigo-400" /> Verificação em duas etapas (2FA)
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Adicione uma camada extra de segurança ao seu login com um app autenticador (Google Authenticator, Authy, 1Password).</p>
      </div>

      {err && <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{err}</div>}

      {backupCodes && (
        <div className="mb-6 rounded-xl border border-amber-600/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium text-amber-300">Guarde seus códigos de backup</p>
          <p className="text-xs text-zinc-400 mt-1 mb-3">Cada código funciona uma vez se você perder o acesso ao app. Guarde em local seguro — não serão mostrados de novo.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {backupCodes.map(c => <span key={c} className="font-mono text-sm text-center bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200">{c}</span>)}
          </div>
        </div>
      )}

      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        {enabled === null && <p className="text-sm text-zinc-500">Carregando…</p>}

        {enabled === true && (
          <div>
            <p className="text-sm text-emerald-400 flex items-center gap-2 mb-4"><Check className="w-4 h-4" /> 2FA está <b>ativo</b> na sua conta.</p>
            <p className="text-sm text-zinc-400 mb-2">Para desativar, confirme sua senha:</p>
            <div className="flex gap-2 max-w-sm">
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Sua senha" className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100" />
              <Button onClick={disable} disabled={busy || !password} className="bg-red-600 hover:bg-red-700 text-white">Desativar</Button>
            </div>
          </div>
        )}

        {enabled === false && step === 'idle' && (
          <div>
            <p className="text-sm text-zinc-400 mb-4">Sua conta está protegida apenas por senha. Ative o 2FA para exigir um código a cada login.</p>
            <Button onClick={startSetup} disabled={busy} className="bg-indigo-600 hover:bg-indigo-700 text-white">{busy ? 'Aguarde…' : 'Ativar 2FA'}</Button>
          </div>
        )}

        {enabled === false && step === 'setup' && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-300">1. Escaneie o QR code no seu app autenticador:</p>
            {qr && <img src={qr} alt="QR Code 2FA" className="w-44 h-44 rounded-lg border border-zinc-800 bg-white p-2" />}
            <p className="text-xs text-zinc-500">Ou digite manualmente a chave: <span className="font-mono text-zinc-300 break-all">{secret}</span></p>
            <p className="text-sm text-zinc-300">2. Digite o código de 6 dígitos gerado:</p>
            <div className="flex gap-2 max-w-xs">
              <input type="text" inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} placeholder="000000" className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-center text-lg tracking-widest text-zinc-100" />
              <Button onClick={confirm} disabled={busy || code.length < 6} className="bg-emerald-600 hover:bg-emerald-700 text-white">Confirmar</Button>
            </div>
            <button onClick={() => { setStep('idle'); setErr(''); }} className="text-xs text-zinc-500 hover:text-zinc-300">Cancelar</button>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================================
// LgpdPanel — política de retenção de dados (opt-in) + atalho aos direitos do titular.
// ============================================================================
function LgpdPanel() {
  const [settings, setSettings] = useState<{ enabled: boolean; days: number } | null>(null);

  useEffect(() => { apiFetch('/api/lgpd/settings').then(r => r.json()).then(setSettings).catch(() => {}); }, []);

  const save = async (patch: Partial<{ enabled: boolean; days: number }>) => {
    const next = { enabled: settings?.enabled || false, days: settings?.days || 365, ...patch };
    setSettings(next);
    await apiFetch('/api/lgpd/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
  };

  return (
    <>
      <div className="mb-6 border-b border-zinc-800 pb-4">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <Lock className="w-6 h-6 text-indigo-400" /> Privacidade & LGPD
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Política de retenção de dados e direitos do titular (acesso, portabilidade e esquecimento).</p>
      </div>

      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-5">
        {settings && (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-zinc-100">🗑️ Retenção automática de dados</p>
              <p className="text-xs text-zinc-500 mt-1">
                Apaga o conteúdo de mensagens de atendimentos <b>já encerrados</b> com mais de{' '}
                <input type="number" min={30} value={settings.days}
                  onChange={e => setSettings({ ...settings, days: parseInt(e.target.value, 10) || 365 })}
                  onBlur={e => save({ days: parseInt(e.target.value, 10) || 365 })}
                  className="w-20 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" /> dias.
                Pedidos e valores são mantidos (sem dado pessoal) para histórico.
              </p>
            </div>
            <button onClick={() => save({ enabled: !settings.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        )}

        <div className="border-t border-zinc-800 pt-4">
          <p className="text-sm font-medium text-zinc-100">👤 Direitos do titular</p>
          <p className="text-xs text-zinc-500 mt-1">
            Em <b>Contatos</b>, cada cliente tem as ações <b>Exportar dados</b> (portabilidade, baixa um JSON) e
            <b> Esquecer</b> (anonimiza os dados pessoais e apaga o conteúdo das conversas). Use quando o titular solicitar.
          </p>
        </div>

        <div className="border-t border-zinc-800 pt-4 text-xs text-zinc-500">
          <p>🔒 Medidas de segurança ativas: isolamento por organização (multi-tenant), segredos cifrados em repouso (AES-256-GCM), 2FA opcional, senhas com hash bcrypt e HTTPS forçado. Detalhes em <code>docs/LGPD-PRIVACIDADE.md</code>.</p>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// AiAttendancePanel — comportamento da IA: memória de relacionamento, saudação
// de retorno e re-engajamento de conversas paradas (carrinho abandonado).
// ============================================================================
type AiAttendance = {
  memoryEnabled: boolean; greetEnabled: boolean; greetMinDays: number;
  abandonedEnabled: boolean; abandonedHours: number; abandonedMessage: string;
  autoTaskOnHandoff?: boolean;
};
function AiAttendancePanel() {
  const [cfg, setCfg] = useState<AiAttendance | null>(null);

  useEffect(() => { apiFetch('/api/analytics/ai-attendance-settings').then(r => r.json()).then(setCfg).catch(() => {}); }, []);

  const save = async (patch: Partial<AiAttendance>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next);
    await apiFetch('/api/analytics/ai-attendance-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    }).catch(() => {});
  };

  const Toggle = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );

  return (
    <>
      <div className="mb-6 border-b border-zinc-800 pb-4">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <BrainCircuit className="w-6 h-6 text-indigo-400" /> Atendimento (IA)
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Como a IA lembra dos seus clientes e reengaja conversas paradas.</p>
      </div>

      {!cfg ? (
        <div className="text-sm text-zinc-500">Carregando…</div>
      ) : (
        <div className="space-y-6">
          {/* Memória de relacionamento */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Sparkles className="w-4 h-4 text-emerald-400" /> Memória do cliente</p>
                <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
                  A IA lembra de conversas anteriores e guarda detalhes que geram conexão (nome do pet, filho, preferências, contexto que o cliente compartilhou) para usar com naturalidade no próximo contato. Você vê e pode apagar essa memória em <b>Contatos</b>.
                </p>
              </div>
              <Toggle on={cfg.memoryEnabled} onClick={() => save({ memoryEnabled: !cfg.memoryEnabled })} />
            </div>
          </div>

          {/* Saudação de retorno */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">👋 Saudação de retorno</p>
                <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
                  Quando um cliente que já falou com a gente volta após{' '}
                  <input type="number" min={1} max={365} value={cfg.greetMinDays}
                    onChange={e => setCfg({ ...cfg, greetMinDays: parseInt(e.target.value, 10) || 7 })}
                    onBlur={e => save({ greetMinDays: parseInt(e.target.value, 10) || 7 })}
                    className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" /> dias parado,
                  a IA abre com uma saudação calorosa de retorno ("que bom te ver de novo, faz X dias…") e puxa um detalhe da memória.
                </p>
              </div>
              <Toggle on={cfg.greetEnabled} onClick={() => save({ greetEnabled: !cfg.greetEnabled })} />
            </div>
          </div>

          {/* Re-engajamento (carrinho abandonado) */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">🛒 Re-engajamento de conversa parada</p>
                <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
                  Se um cliente com intenção de compra (em <i>proposta</i> ou <i>qualificado</i>) ficar{' '}
                  <input type="number" min={1} max={168} value={cfg.abandonedHours}
                    onChange={e => setCfg({ ...cfg, abandonedHours: parseInt(e.target.value, 10) || 4 })}
                    onBlur={e => save({ abandonedHours: parseInt(e.target.value, 10) || 4 })}
                    className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" /> horas sem responder,
                  a IA manda <b>um</b> lembrete amigável. (Não encerra o atendimento — só cutuca uma vez.)
                </p>
              </div>
              <Toggle on={cfg.abandonedEnabled} onClick={() => save({ abandonedEnabled: !cfg.abandonedEnabled })} />
            </div>
            {cfg.abandonedEnabled && (
              <textarea
                className="mt-4 w-full h-20 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
                placeholder="Mensagem do lembrete. Use {nome}. Ex.: Oi {nome}! Vi que ficamos no meio de uma conversa 😊 Posso te ajudar a finalizar?"
                value={cfg.abandonedMessage}
                onChange={e => setCfg({ ...cfg, abandonedMessage: e.target.value })}
                onBlur={e => save({ abandonedMessage: e.target.value })}
              />
            )}
          </div>

          {/* Maestro — tarefa automática no repasse para humano */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">🧭 Maestro — tarefa no repasse para humano</p>
                <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
                  Quando a IA repassa um atendimento para um humano, o ZapFlow cria automaticamente uma <b>tarefa interna</b> (com o resumo da conversa) na aba <b>Tarefas</b>, para a equipe assumir e nada se perder. Requer o módulo de Tarefas ativo.
                </p>
              </div>
              <Toggle on={!!cfg.autoTaskOnHandoff} onClick={() => save({ autoTaskOnHandoff: !cfg.autoTaskOnHandoff })} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
