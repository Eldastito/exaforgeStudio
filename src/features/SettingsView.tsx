import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Image as ImageIcon, Briefcase, Users, CreditCard, LayoutGrid, Rocket, Check, Sparkles, ShieldCheck, Lock, BrainCircuit, Crosshair, Home, AlertTriangle } from 'lucide-react';
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
        <h3 className="zf-data-label mb-4 px-3">Configurações</h3>
        <nav className="space-y-1">
          {/* Quick-Start saiu das abas (ADR-093 §1) — virou card de onboarding no Dashboard. */}
          <button onClick={() => setActiveTab('empresa')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'empresa' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Briefcase className="w-4 h-4" /> Empresa
          </button>
          <button onClick={() => setActiveTab('atendimento')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'atendimento' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <BrainCircuit className="w-4 h-4" /> Atendimento (IA)
          </button>
          <button onClick={() => setActiveTab('usuarios')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'usuarios' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Users className="w-4 h-4" /> Usuários e Permissões
          </button>
  <button onClick={() => setActiveTab('cobranca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'cobranca' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <CreditCard className="w-4 h-4" /> Cobrança e Plano
          </button>
          <button onClick={() => setActiveTab('modulos')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'modulos' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <LayoutGrid className="w-4 h-4" /> Módulos
          </button>
          <button onClick={() => setActiveTab('seguranca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'seguranca' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <ShieldCheck className="w-4 h-4" /> Segurança (2FA)
          </button>
          <button onClick={() => setActiveTab('privacidade')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'privacidade' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Lock className="w-4 h-4" /> Privacidade (LGPD)
          </button>
          <button onClick={() => setActiveTab('radar')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'radar' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Crosshair className="w-4 h-4" /> Radar
          </button>
          <button onClick={() => setActiveTab('landing')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'landing' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Home className="w-4 h-4" /> Painel Padrão
          </button>
        </nav>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl">
          
          {activeTab === 'empresa' && (
            <>
              <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
                <div>
                  <h2 className="zf-page-title flex items-center gap-2">
                    <SettingsIcon className="w-6 h-6 text-teal-300" />
                    Dados da Empresa
                  </h2>
                  <p className="text-zinc-400 text-sm mt-1">Configurações gerais e dados para geração de relatórios.</p>
                </div>
                <Button onClick={handleSubmit} disabled={loading} className="zf-button zf-button-primary">
                  <Save className="w-4 h-4 mr-2" />
                  {loading ? 'Salvando...' : 'Salvar'}
                </Button>
              </div>

              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Nome Fantasia</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
                  value={form.business_name} onChange={e => setForm({...form, business_name: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Razão Social</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
                  value={form.legal_name} onChange={e => setForm({...form, legal_name: e.target.value})} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">CNPJ / CPF</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
                  value={form.cnpj_cpf} onChange={e => setForm({...form, cnpj_cpf: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Telefone Comercial</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
                  value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">E-mail</label>
                <input type="email" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
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
                <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
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
              <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none" 
                value={form.address} onChange={e => setForm({...form, address: e.target.value})} />
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Rodapé de Relatórios</label>
              <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-teal-400 outline-none min-h-[80px]" 
                value={form.report_footer} onChange={e => setForm({...form, report_footer: e.target.value})} placeholder="Ex: Este documento é confidencial..." />
            </div>

          </form>
          </div>
          </>
          )}

          {activeTab === 'atendimento' && <AiAttendancePanel />}
          {activeTab === 'cobranca' && <BillingPanel />}

          {activeTab === 'modulos' && <ModulesPanel onUpgrade={() => setActiveTab('cobranca')} />}
          {activeTab === 'seguranca' && <SecurityPanel />}
          {activeTab === 'privacidade' && <LgpdPanel />}
          {activeTab === 'radar' && <RadarSettingsPanel />}
          {activeTab === 'landing' && <DefaultLandingPanel />}

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
  paymentProvider?: string | null;
  hasSubscription?: boolean;
  usage: { ai_this_month: number; contacts: number; channels: number; users: number };
  limits: any;
};
type Invoice = { id: string; status: string; value: number; dueDate: string; invoiceUrl: string };

function BillingPanel() {
  const loadOrgConfigForSidebar = useStore(s => s.loadOrgConfig);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<{ key: string; label: string; used: number; limit: number; pct: number; level: string }[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [cpfCnpj, setCpfCnpj] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [perf, setPerf] = useState<any | null>(null);
  const [consumption, setConsumption] = useState<any | null>(null);
  const [buyingTopup, setBuyingTopup] = useState(false);
  const [addons, setAddons] = useState<{ available: any[]; active: any[] } | null>(null);
  const [addonBusy, setAddonBusy] = useState<string | null>(null);

  const loadPerf = () => apiFetch('/api/analytics/performance-fee').then(r => r.ok ? r.json() : null).then(d => setPerf(d && !d.error ? d : null)).catch(() => setPerf(null));
  const loadConsumption = () => apiFetch('/api/plans/consumption').then(r => r.json()).then(d => setConsumption(d && !d.error ? d : null)).catch(() => setConsumption(null));
  const loadAddons = () => apiFetch('/api/plans/addons').then(r => r.json()).then(d => setAddons(d && !d.error ? d : null)).catch(() => setAddons(null));

  const contractAddon = async (key: string) => {
    setAddonBusy(key);
    try {
      const r = await apiFetch('/api/plans/addons/contract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d?.error || 'Não foi possível contratar.'); return; }
      toast.success('Add-on contratado!'); loadAddons(); loadOrgConfigForSidebar();
    } catch (e) { toast.error('Erro ao contratar.'); }
    finally { setAddonBusy(null); }
  };
  const cancelAddon = async (key: string) => {
    if (!(await confirmDialog('Cancelar este add-on? O módulo perde o acesso.', {}))) return;
    setAddonBusy(key);
    try { await apiFetch('/api/plans/addons/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }); loadAddons(); loadOrgConfigForSidebar(); }
    catch (e) { toast.error('Erro ao cancelar.'); }
    finally { setAddonBusy(null); }
  };

  const buyTopup = async () => {
    setBuyingTopup(true);
    try {
      const r = await apiFetch('/api/plans/consumption/topup', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d?.error || 'Não foi possível comprar o pacote.'); return; }
      toast.success('Pacote extra adicionado!');
      loadConsumption();
    } catch (e) { toast.error('Erro ao comprar o pacote.'); }
    finally { setBuyingTopup(false); }
  };
  const toggleAutoTopup = async (enabled: boolean) => {
    try { await apiFetch('/api/plans/consumption/auto-topup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }); loadConsumption(); }
    catch (e) { toast.error('Erro ao salvar a preferência.'); }
  };

  const load = () => {
    Promise.all([
      fetch('/api/plans').then(r => r.json()).catch(() => []),
      fetch('/api/plans/current').then(r => r.json()).catch(() => null),
      fetch('/api/plans/alerts').then(r => r.json()).catch(() => ({ alerts: [] })),
    ]).then(([ps, sn, al]) => {
      setPlans(Array.isArray(ps) ? ps : []);
      setSnap(sn && !sn.error ? sn : null);
      setAlerts(Array.isArray(al?.alerts) ? al.alerts : []);
      if (sn?.hasSubscription) apiFetch('/api/plans/billing/invoices').then(r => r.json()).then(d => setInvoices(Array.isArray(d?.invoices) ? d.invoices : [])).catch(() => {});
    });
    loadPerf();
    loadConsumption();
    loadAddons();
  };
  useEffect(() => { load(); }, []);

  const togglePerfConsent = async (enabled: boolean) => {
    try { await apiFetch('/api/analytics/performance-fee/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }); loadPerf(); }
    catch (e) { toast.error('Erro ao salvar a preferência.'); }
  };
  const brl = (n: number) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const subscribe = async () => {
    if (!cpfCnpj.trim()) { toast.error('Informe o CPF ou CNPJ do responsável.'); return; }
    setSubscribing(true);
    try {
      const r = await apiFetch('/api/plans/billing/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cpfCnpj: cpfCnpj.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d?.error || 'Não foi possível ativar a assinatura.'); return; }
      if (Array.isArray(d.invoices)) setInvoices(d.invoices);
      toast.success('Assinatura ativada! Veja a fatura abaixo para pagar.');
      load();
    } catch (e) { toast.error('Erro ao ativar a assinatura.'); }
    finally { setSubscribing(false); }
  };

  const cancelSubscription = async () => {
    if (!(await confirmDialog('Cancelar assinatura? A conta entra em modo somente-leitura ao fim do período pago.', {}))) return;
    setCancelling(true);
    try { await apiFetch('/api/plans/billing/cancel', { method: 'POST' }); load(); toast.success('Assinatura cancelada.'); }
    catch (e) { toast.error('Erro ao cancelar.'); }
    finally { setCancelling(false); }
  };

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
      {/* Painel de Valor Gerado (ADR-091 Bloco C, Scale+) — modo beta: mostra, não cobra */}
      {perf && (
        <div className="bg-gradient-to-br from-emerald-500/10 to-zinc-900/50 border border-emerald-500/20 rounded-xl p-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">💚 Valor gerado pelo ZappFlow <span className="text-[11px] text-zinc-400">(este mês)</span></h2>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30">MODO BETA — não cobrado</span>
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div><p className="text-xs text-zinc-500">Margem recuperada (comprovada)</p><p className="text-2xl font-bold text-emerald-300">{brl(perf.incrementalGain)}</p></div>
            <div><p className="text-xs text-zinc-500">Receita recuperada</p><p className="text-2xl font-bold text-zinc-100">{brl(perf.recoveredRevenue)}</p></div>
            <div><p className="text-xs text-zinc-500">Taxa de sucesso ({perf.feePercent}%)</p><p className="text-2xl font-bold text-zinc-100">{brl(perf.fee)}</p></div>
          </div>
          {perf.drivers?.length > 0 && (
            <div className="mt-4 space-y-1.5">
              {perf.drivers.map((d: any) => (
                <div key={d.key} className="flex items-center justify-between text-sm">
                  <span className="text-zinc-400">{d.label} <span className="text-zinc-600">({d.orders} pedido{d.orders !== 1 ? 's' : ''})</span></span>
                  <span className="text-zinc-200">{brl(d.recoveredMargin)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-zinc-500 mt-3">
            Ganho medido pela <strong>margem recuperada</strong> diretamente atribuída aos mecanismos do ZappFlow (cada pedido conta uma vez).
            {!perf.marginProven && ' Margem estimada em 30% (cadastre o custo dos produtos para o cálculo real).'}
            {perf.estimated?.reposicao > 0 && <> Economia estimada de reposição (à parte, não entra na taxa): <strong>{brl(perf.estimated.reposicao)}</strong>.</>}
          </p>
          <div className="mt-4 flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div>
              <p className="text-sm text-zinc-200">Autorizar a taxa de sucesso de {perf.feePercent}%</p>
              <p className="text-[11px] text-zinc-500">Opcional e revogável. Enquanto desligado (ou nos 6 primeiros meses), é só demonstrativo — nada é cobrado.</p>
            </div>
            <button onClick={() => togglePerfConsent(!perf.consented)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${perf.consented ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${perf.consented ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      )}

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

        {/* Alertas de uso */}
        {alerts.length > 0 && (
          <div className="mt-5 space-y-2">
            {alerts.map(a => (
              <div key={a.key} className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${a.level === 'exceeded' ? 'bg-red-500/10 border-red-500/30 text-red-300' : a.level === 'critical' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300'}`}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>
                  <strong>{a.label}:</strong>{' '}
                  {a.level === 'exceeded'
                    ? `Limite atingido (${a.used.toLocaleString('pt-BR')} / ${a.limit.toLocaleString('pt-BR')}). Considere fazer upgrade do plano.`
                    : `${a.pct}% do limite usado (${a.used.toLocaleString('pt-BR')} / ${a.limit.toLocaleString('pt-BR')}).`}
                </span>
              </div>
            ))}
          </div>
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

      {/* Consumo excedente de IA (ADR-091 §4, Bloco D) */}
      {consumption && consumption.allowance > 0 && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-white mb-1">Consumo de IA no mês</h3>
          <p className="text-sm text-zinc-400 mb-4">
            {consumption.used.toLocaleString('pt-BR')} de {consumption.allowance.toLocaleString('pt-BR')} ações
            {consumption.topupActions > 0 && <span className="text-emerald-300"> (inclui +{consumption.topupActions.toLocaleString('pt-BR')} de pacotes extras)</span>}.
          </p>
          <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden mb-4">
            <div className={`h-full ${consumption.pct >= 100 ? 'bg-red-500' : consumption.pct >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, consumption.pct)}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {consumption.package ? (
              <Button onClick={buyTopup} disabled={buyingTopup} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                {buyingTopup ? 'Adicionando…' : `Comprar +${consumption.package.actions.toLocaleString('pt-BR')} ações (R$ ${consumption.package.price})`}
              </Button>
            ) : <span className="text-xs text-zinc-500">Plano sem pacote extra (Enterprise é negociado).</span>}
            {consumption.package && (
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <span>Recompra automática ao chegar em 90%</span>
                <button onClick={() => toggleAutoTopup(!consumption.autoTopupEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${consumption.autoTopupEnabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${consumption.autoTopupEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </label>
            )}
          </div>
        </div>
      )}

      {/* Assinatura (ASAAS) — só quando há plano escolhido e não é cortesia */}
      {snap?.plan && snap.plan.id !== 'cortesia' && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-white mb-1">Assinatura</h3>
          {snap.hasSubscription ? (
            <>
              <p className="text-sm text-zinc-400 mb-4">Suas faturas do ZappFlow. O pagamento é confirmado automaticamente.</p>
              {invoices.length === 0 ? (
                <p className="text-sm text-zinc-500">Nenhuma fatura ainda.</p>
              ) : (
                <div className="space-y-2">
                  {invoices.map(inv => (
                    <div key={inv.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-sm">
                      <div>
                        <span className="text-zinc-200">R$ {Number(inv.value).toFixed(2)}</span>
                        <span className="text-zinc-500 ml-2">venc. {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('pt-BR') : '—'}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${['CONFIRMED','RECEIVED','RECEIVED_IN_CASH'].includes(inv.status) ? 'bg-emerald-500/15 text-emerald-300' : inv.status === 'OVERDUE' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}>{inv.status}</span>
                        {inv.invoiceUrl && !['CONFIRMED','RECEIVED','RECEIVED_IN_CASH'].includes(inv.status) && (
                          <a href={inv.invoiceUrl} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200 text-xs font-medium">Pagar →</a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={cancelSubscription} disabled={cancelling} className="mt-4 text-xs text-red-300/80 hover:text-red-300">
                {cancelling ? 'Cancelando…' : 'Cancelar assinatura'}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-400 mb-3">Ative a assinatura recorrente do plano <strong className="text-zinc-200">{snap.plan.name}</strong> (R$ {snap.plan.price.toFixed(2)}/mês) para continuar após o teste. Pagamento por Pix, boleto ou cartão.</p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-zinc-400">CPF ou CNPJ do responsável
                  <input className="mt-1 block w-64 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Só números" value={cpfCnpj} onChange={e => setCpfCnpj(e.target.value)} />
                </label>
                <Button onClick={subscribe} disabled={subscribing} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  {subscribing ? 'Ativando…' : 'Ativar assinatura'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Add-ons (ADR-091 §5, Bloco D) */}
      {addons && (addons.available.length > 0 || addons.active.length > 0) && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-semibold text-white mb-1">Add-ons</h3>
          <p className="text-sm text-zinc-400 mb-4">Recursos avulsos além do seu plano, cobrados na fatura mensal. Precisa de vários? Considere o plano superior.</p>
          {addons.active.length > 0 && (
            <div className="space-y-2 mb-4">
              {addons.active.map((a: any) => (
                <div key={a.key} className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <div><p className="text-sm text-zinc-100">{a.label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 ml-1">ativo</span></p><p className="text-[11px] text-zinc-500">R$ {Number(a.price).toFixed(0)}/mês</p></div>
                  <button onClick={() => cancelAddon(a.key)} disabled={addonBusy === a.key} className="text-xs text-red-300/80 hover:text-red-300">{addonBusy === a.key ? '…' : 'Cancelar'}</button>
                </div>
              ))}
            </div>
          )}
          {addons.available.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {addons.available.map((a: any) => (
                <div key={a.key} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div><p className="text-sm text-zinc-200">{a.label}</p><p className="text-[11px] text-zinc-500">R$ {Number(a.price).toFixed(0)}/mês</p></div>
                  <Button onClick={() => contractAddon(a.key)} disabled={addonBusy === a.key} className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 h-auto">{addonBusy === a.key ? '…' : 'Contratar'}</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
                {p.features?.price_annual_month ? (
                  <p className="text-[11px] text-emerald-300/80 mt-0.5">ou R$ {Number(p.features.price_annual_month).toFixed(0)}/mês no plano anual</p>
                ) : null}
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

type ModuleOverviewItem = { key: string; label: string; desc: string; section: 'recommended' | 'available' | 'upgrade'; enabled: boolean; recommended: boolean };

function ModulesPanel({ onUpgrade }: { onUpgrade?: () => void }) {
  const loadOrgConfig = useStore(s => s.loadOrgConfig);
  const [items, setItems] = useState<ModuleOverviewItem[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/analytics/modules-overview')
      .then(r => r.json())
      .then((d: { items?: ModuleOverviewItem[] }) => {
        const list = Array.isArray(d?.items) ? d.items : [];
        setItems(list);
        // Só os módulos DENTRO do teto do plano (recomendados/disponíveis) podem
        // estar ligados; os de upgrade nunca entram no override.
        setEnabled(new Set(list.filter(m => m.section !== 'upgrade' && m.enabled).map(m => m.key)));
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (key: string) => {
    setEnabled(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  };

  const save = async () => {
    if (!items) return;
    setSaving(true);
    try {
      // Envia apenas o que está dentro do teto do plano e ligado.
      const payload = items.filter(m => m.section !== 'upgrade' && enabled.has(m.key)).map(m => m.key);
      await apiFetch('/api/analytics/settings/modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled_modules: payload }),
      });
      await loadOrgConfig(); // atualiza o menu lateral na hora
      toast.success('Módulos atualizados!');
    } catch (e) { toast.error('Falha ao salvar os módulos.'); }
    finally { setSaving(false); }
  };

  const recommended = (items || []).filter(m => m.section === 'recommended');
  const available = (items || []).filter(m => m.section === 'available');
  const upgrade = (items || []).filter(m => m.section === 'upgrade');

  const Row = ({ m }: { m: ModuleOverviewItem }) => {
    const on = enabled.has(m.key);
    return (
      <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
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
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <h2 className="zf-page-title flex items-center gap-2">
            <LayoutGrid className="w-6 h-6 text-teal-300" /> Módulos
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Ative só o que faz sentido pro seu negócio. Atendimento, Contatos e Relatórios estão sempre ativos.</p>
        </div>
        <Button onClick={save} disabled={saving || loading} className="zf-button zf-button-primary">
          <Save className="w-4 h-4 mr-2" /> {saving ? 'Salvando...' : 'Salvar'}
        </Button>
      </div>

      {loading || !items ? (
        <p className="text-zinc-500 text-sm">Carregando…</p>
      ) : (
        <div className="space-y-6">
          {/* Recomendados para o seu negócio */}
          {recommended.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-emerald-300 mb-2">✅ Recomendados para o seu negócio</p>
              <p className="text-xs text-zinc-500 mb-3">Ligados por padrão conforme a sua categoria. Desligue o que não usar.</p>
              <div className="space-y-2">{recommended.map(m => <Row key={m.key} m={m} />)}</div>
            </div>
          )}

          {/* Disponível no seu plano */}
          {available.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-zinc-200 mb-2">➕ Disponível no seu plano</p>
              <p className="text-xs text-zinc-500 mb-3">Não vêm ligados por padrão, mas o seu plano permite. Ligue se quiser.</p>
              <div className="space-y-2">{available.map(m => <Row key={m.key} m={m} />)}</div>
            </div>
          )}

          {/* Requer upgrade (colapsado) */}
          {upgrade.length > 0 && (
            <details className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-indigo-300 flex items-center gap-2">
                <Lock className="w-4 h-4" /> Requer upgrade de plano ({upgrade.length})
              </summary>
              <p className="text-xs text-zinc-500 mt-2 mb-3">Disponíveis em planos superiores. {onUpgrade && 'Veja em Cobrança e Plano.'}</p>
              <div className="space-y-2">
                {upgrade.map(m => (
                  <div key={m.key} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 opacity-80">
                    <div>
                      <p className="text-sm font-medium text-zinc-300 flex items-center gap-2">{m.label}{m.recommended && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">sugerido p/ você</span>}</p>
                      <p className="text-xs text-zinc-500">{m.desc}</p>
                    </div>
                    <Lock className="w-4 h-4 text-zinc-600 flex-shrink-0" />
                  </div>
                ))}
              </div>
              {onUpgrade && (
                <button onClick={onUpgrade} className="mt-3 text-xs text-indigo-300 hover:text-indigo-200 font-medium">
                  Ver planos e fazer upgrade →
                </button>
              )}
            </details>
          )}
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
        <h2 className="zf-page-title flex items-center gap-2">
          <Rocket className="w-6 h-6 text-teal-300" /> Quick-Start
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
              className="zf-button zf-button-primary"
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
        <h2 className="zf-page-title flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-teal-300" /> Verificação em duas etapas (2FA)
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
            <Button onClick={startSetup} disabled={busy} className="zf-button zf-button-primary">{busy ? 'Aguarde…' : 'Ativar 2FA'}</Button>
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
  const [consentConfig, setConsentConfig] = useState<{ categories: string[]; bannerText: string; policyVersion: string } | null>(null);
  const [consentSummary, setConsentSummary] = useState<{ type: string; granted: number; revoked: number }[]>([]);
  const [newCategory, setNewCategory] = useState('');

  useEffect(() => {
    apiFetch('/api/lgpd/settings').then(r => r.json()).then(setSettings).catch(() => {});
    apiFetch('/api/lgpd/consent-config').then(r => r.json()).then(setConsentConfig).catch(() => {});
    apiFetch('/api/lgpd/consent-summary').then(r => r.json()).then(d => setConsentSummary(d.summary || [])).catch(() => {});
  }, []);

  const save = async (patch: Partial<{ enabled: boolean; days: number }>) => {
    const next = { enabled: settings?.enabled || false, days: settings?.days || 365, ...patch };
    setSettings(next);
    await apiFetch('/api/lgpd/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
  };

  const saveConsent = async (patch: Partial<{ categories: string[]; bannerText: string; policyVersion: string }>) => {
    const next = { ...consentConfig!, ...patch };
    setConsentConfig(next);
    await apiFetch('/api/lgpd/consent-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
  };

  const CATEGORY_LABELS: Record<string, string> = {
    marketing: 'Marketing', dados_pessoais: 'Dados pessoais', perfilamento: 'Perfilamento',
    comunicacoes: 'Comunicações', compartilhamento: 'Compartilhamento',
  };

  return (
    <>
      <div className="mb-6 border-b border-zinc-800 pb-4">
        <h2 className="zf-page-title flex items-center gap-2">
          <Lock className="w-6 h-6 text-teal-300" /> Privacidade & LGPD
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Política de retenção de dados, consentimento granular e direitos do titular.</p>
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

        {consentConfig && (
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <p className="text-sm font-medium text-zinc-100">📋 Consentimento granular</p>
            <p className="text-xs text-zinc-500">Configure as categorias de consentimento rastreadas por contato. Use em Contatos para registrar/revogar.</p>

            <div className="flex flex-wrap gap-2">
              {consentConfig.categories.map(cat => (
                <span key={cat} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300">
                  {CATEGORY_LABELS[cat] || cat}
                  <button onClick={() => saveConsent({ categories: consentConfig.categories.filter(c => c !== cat) })}
                    className="text-indigo-400 hover:text-indigo-200 ml-1">&times;</button>
                </span>
              ))}
              <span className="inline-flex items-center gap-1">
                <input type="text" value={newCategory} onChange={e => setNewCategory(e.target.value)}
                  placeholder="Nova categoria..."
                  className="w-28 text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newCategory.trim()) {
                      saveConsent({ categories: [...consentConfig.categories, newCategory.trim().toLowerCase().replace(/\s+/g, '_')] });
                      setNewCategory('');
                    }
                  }} />
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-zinc-400">
              <span>Versão da política:</span>
              <input type="text" value={consentConfig.policyVersion}
                onChange={e => setConsentConfig({ ...consentConfig, policyVersion: e.target.value })}
                onBlur={e => saveConsent({ policyVersion: e.target.value || '1.0' })}
                className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" />
            </div>

            <div>
              <p className="text-xs text-zinc-400 mb-1">Texto do banner/aviso de consentimento (exibido na loja e formulários):</p>
              <textarea rows={2} value={consentConfig.bannerText}
                onChange={e => setConsentConfig({ ...consentConfig, bannerText: e.target.value })}
                onBlur={e => saveConsent({ bannerText: e.target.value })}
                placeholder="Ex.: Ao continuar, você concorda com nossa política de privacidade..."
                className="w-full text-xs bg-zinc-950 border border-zinc-800 rounded p-2 text-zinc-300 resize-none" />
            </div>

            {consentSummary.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-zinc-500 mb-1">Resumo de consentimentos:</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {consentSummary.map(s => (
                    <div key={s.type} className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-xs">
                      <p className="text-zinc-300 font-medium">{CATEGORY_LABELS[s.type] || s.type}</p>
                      <p className="text-emerald-400">{s.granted} ativo(s)</p>
                      <p className="text-zinc-500">{s.revoked} revogado(s)</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-zinc-800 pt-4">
          <p className="text-sm font-medium text-zinc-100">👤 Direitos do titular</p>
          <p className="text-xs text-zinc-500 mt-1">
            Em <b>Contatos</b>, cada cliente tem as ações <b>Exportar dados</b> (portabilidade, baixa um JSON),
            <b> Esquecer</b> (anonimiza os dados pessoais) e <b>Consentimentos</b> (visualiza/gerencia consentimentos granulares).
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
  autoTaskOnVisionEvent?: boolean;
};
function AiAttendancePanel() {
  const [cfg, setCfg] = useState<AiAttendance | null>(null);
  const visionEnabled = useStore(s => s.isModuleEnabled('vms'));

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
        <h2 className="zf-page-title flex items-center gap-2">
          <BrainCircuit className="w-6 h-6 text-teal-300" /> Atendimento (IA)
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
                  Quando a IA repassa um atendimento para um humano, o ZappFlow cria automaticamente uma <b>tarefa interna</b> (com o resumo da conversa) na aba <b>Tarefas</b>, para a equipe assumir e nada se perder. Requer o módulo de Tarefas ativo.
                </p>
              </div>
              <Toggle on={!!cfg.autoTaskOnHandoff} onClick={() => save({ autoTaskOnHandoff: !cfg.autoTaskOnHandoff })} />
            </div>
          </div>

          {/* Maestro — tarefa automática em evento crítico do Vision VMS */}
          {visionEnabled && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">📹 Maestro — tarefa em evento crítico do Vision VMS</p>
                  <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
                    Quando o Vision VMS detecta um evento de severidade <b>alta</b> ou <b>crítica</b> (ex.: gateway offline, botão de pânico) e ele ainda não foi revisado, o ZappFlow cria automaticamente uma <b>tarefa interna</b> na aba <b>Tarefas</b> e envia uma <b>notificação in-app</b> (sino no topo) para a equipe, para agir mesmo sem estar com o Vision VMS aberto.
                  </p>
                </div>
                <Toggle on={!!cfg.autoTaskOnVisionEvent} onClick={() => save({ autoTaskOnVisionEvent: !cfg.autoTaskOnVisionEvent })} />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

type RadarAutoSend = {
  autoSendEnabled: boolean;
  autoSendChannel: 'whatsapp' | 'email';
};
function RadarSettingsPanel() {
  const [cfg, setCfg] = useState<RadarAutoSend | null>(null);

  useEffect(() => {
    apiFetch('/api/radar/settings').then(r => r.json()).then(setCfg).catch(() => {});
  }, []);

  const save = async (patch: Partial<RadarAutoSend>) => {
    if (!cfg) return;
    const next = { ...cfg, ...patch };
    setCfg(next); // otimista
    try {
      const res = await apiFetch('/api/radar/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      const d = await res.json().catch(() => ({}));
      // Fonte da verdade é o backend — se o servidor não persistiu, volta pro
      // estado real (evita "salvou na UI mas não no banco").
      if (res.ok && (typeof d?.autoSendEnabled === 'boolean' || typeof d?.autoSendChannel === 'string')) {
        setCfg({
          autoSendEnabled: !!d.autoSendEnabled,
          autoSendChannel: (d.autoSendChannel === 'email' ? 'email' : 'whatsapp'),
        });
      } else if (!res.ok) {
        // Reverte o otimismo em erro
        setCfg(cfg);
      }
    } catch {
      setCfg(cfg);
    }
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
        <h2 className="zf-page-title flex items-center gap-2">
          <Crosshair className="w-6 h-6 text-teal-300" /> Radar
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Envio automatico do relatorio de diagnostico quando uma sessao e aprovada.</p>
      </div>

      {!cfg ? (
        <div className="text-sm text-zinc-500">Carregando...</div>
      ) : (
        <div className="space-y-6">
          {/* Auto-envio do relatorio */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-400" /> Envio automatico do relatorio
                </p>
                <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
                  Quando uma sessao do Radar de Execucao IA for aprovada ou publicada, o relatorio em PDF sera enviado automaticamente para o contato da sessao pelo canal escolhido abaixo. O envio e best-effort e nunca bloqueia a aprovacao.
                </p>
              </div>
              <Toggle on={cfg.autoSendEnabled} onClick={() => save({ autoSendEnabled: !cfg.autoSendEnabled })} />
            </div>

            {cfg.autoSendEnabled && (
              <div className="mt-4 flex items-center gap-4">
                <span className="text-xs text-zinc-400">Canal de envio:</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="radarChannel"
                    checked={cfg.autoSendChannel === 'whatsapp'}
                    onChange={() => save({ autoSendChannel: 'whatsapp' })}
                    className="accent-emerald-500"
                  />
                  <span className="text-sm text-zinc-200">WhatsApp</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="radarChannel"
                    checked={cfg.autoSendChannel === 'email'}
                    onChange={() => save({ autoSendChannel: 'email' })}
                    className="accent-emerald-500"
                  />
                  <span className="text-sm text-zinc-200">Email</span>
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const LANDING_OPTIONS: { value: string; label: string }[] = [
  { value: 'kanban', label: 'Kanban (Pipeline)' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'rie', label: 'Inteligência de Receita (RIC)' },
  { value: 'radar', label: 'Radar de Execução' },
  { value: 'channels', label: 'Canais / Conversas' },
  { value: 'catalog', label: 'Catálogo' },
  { value: 'vendas', label: 'Vendas' },
  { value: 'studio', label: 'Fashion Studio' },
  { value: 'diretor', label: 'Visão Diretor' },
];

function DefaultLandingPanel() {
  const [current, setCurrent] = useState('kanban');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/analytics/settings')
      .then(r => r.json())
      .then(s => { if (s?.default_landing_view) setCurrent(s.default_landing_view); })
      .catch(() => {});
  }, []);

  const pick = async (view: string) => {
    setCurrent(view);
    setSaving(true);
    await apiFetch('/api/analytics/settings/default-landing', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view }),
    }).catch(() => {});
    setSaving(false);
  };

  return (
    <>
      <div className="mb-6 border-b border-zinc-800 pb-4">
        <h2 className="zf-page-title flex items-center gap-2">
          <Home className="w-6 h-6 text-teal-300" /> Painel Padrão
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Escolha a tela que abre automaticamente ao entrar no sistema.</p>
      </div>
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {LANDING_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => pick(opt.value)}
              disabled={saving}
              className={`rounded-xl border px-4 py-3 text-left text-sm font-medium transition-colors ${current === opt.value ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
            >
              <span className="flex items-center gap-2">
                {current === opt.value && <Check className="w-4 h-4 text-indigo-400" />}
                {opt.label}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-xs text-zinc-600">A escolha individual do usuario (clique na sidebar) prevalece. O padrao se aplica quando o usuario nao escolheu uma vista manualmente.</p>
      </div>
    </>
  );
}
