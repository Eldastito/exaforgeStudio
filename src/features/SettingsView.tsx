import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Image as ImageIcon, Briefcase, Users, CreditCard, LayoutGrid } from 'lucide-react';
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
          <button onClick={() => setActiveTab('empresa')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'empresa' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Briefcase className="w-4 h-4" /> Empresa
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

          {activeTab === 'cobranca' && <BillingPanel />}

          {activeTab === 'modulos' && <ModulesPanel />}

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
  { key: 'catalogo', label: 'Catálogo', desc: 'Produtos e serviços.' },
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
