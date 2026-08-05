import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Image as ImageIcon, Briefcase, Users, CreditCard, LayoutGrid, Rocket, Check, Sparkles, ShieldCheck, Lock, BrainCircuit, Crosshair, Home, AlertTriangle, Scale, Loader2, UserCheck, Download } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { toast, confirmDialog } from '@/src/lib/toast';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';

import { UsersSettingsView } from './UsersSettingsView';

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('empresa');
  // Deep-link vindo do SetupChecklist (ex.: "Cadastrar gestor" → aba Usuários).
  const settingsTab = useStore(s => s.settingsTab);
  const setSettingsTab = useStore(s => s.setSettingsTab);
  useEffect(() => {
    if (settingsTab) { setActiveTab(settingsTab); setSettingsTab(null); }
  }, [settingsTab, setSettingsTab]);
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
          {/* ADR-153 F1.3 — placeholder da nova aba "Plano e Expansões" (F4.2 detalha
              o conteúdo com comparação de plano + add-ons compatíveis + CTA de upgrade). */}
          <button onClick={() => setActiveTab('planoexpansoes')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'planoexpansoes' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Rocket className="w-4 h-4" /> Plano e Expansões
          </button>
          <button onClick={() => setActiveTab('seguranca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'seguranca' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <ShieldCheck className="w-4 h-4" /> Segurança (2FA)
          </button>
          <button onClick={() => setActiveTab('privacidade')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'privacidade' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Lock className="w-4 h-4" /> Privacidade (LGPD)
          </button>
          <button onClick={() => setActiveTab('governanca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'governanca' ? 'bg-teal-500/10 text-teal-300 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Scale className="w-4 h-4" /> Governança de IA
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

          {activeTab === 'modulos' && <ModulesPanel onUpgrade={() => setActiveTab('planoexpansoes')} />}
          {activeTab === 'planoexpansoes' && <PlanoExpansoesPanel onGoToCobranca={() => setActiveTab('cobranca')} />}
          {activeTab === 'seguranca' && <SecurityPanel />}
          {activeTab === 'privacidade' && <LgpdPanel />}
          {activeTab === 'governanca' && <GovernancePanel />}
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

// ADR-153 F7.4 — Card individual de recomendação de upgrade (sinal
// business_signals domain='plan' publicado pelo PlanFitSignalPublisher/F7.1).
// Renderiza título humanizado (mapeado por signal_type), evidência formatada
// (used/limit/pct), badge de severity, CTA "Ver em Cobrança" e Dispensar.
// G-153-3: nenhum upgrade é executado no clique — leva pra tela de aceite.
const PlanFitCard: React.FC<{
  signal: any;
  dismissing: boolean;
  onDismiss: () => void;
  onGoToCobranca: () => void;
}> = ({ signal, dismissing, onDismiss, onGoToCobranca }) => {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const METRIC_LABEL: Record<string, string> = {
    plan_near_limit_ai: 'Uso de IA (respostas do mês)',
    plan_near_limit_contacts: 'Base de contatos',
    plan_near_limit_channels: 'Canais conectados',
    plan_near_limit_users: 'Usuários da equipe',
    plan_module_gap: 'Módulo do seu nicho fora do plano',
  };
  const SEV_STYLE: Record<string, { bg: string; text: string; label: string }> = {
    attention: { bg: 'bg-amber-500/15 border-amber-500/30', text: 'text-amber-300', label: 'atenção' },
    risk: { bg: 'bg-orange-500/15 border-orange-500/30', text: 'text-orange-300', label: 'risco' },
    critical: { bg: 'bg-red-500/15 border-red-500/30', text: 'text-red-300', label: 'crítico' },
    info: { bg: 'bg-blue-500/15 border-blue-500/30', text: 'text-blue-300', label: 'info' },
  };
  const ev = signal.evidence || {};
  const sev = SEV_STYLE[signal.severity] || SEV_STYLE.info;
  const title = ev.moduleKey
    ? `Módulo "${ev.moduleKey}" faz sentido pro seu Blueprint`
    : (METRIC_LABEL[signal.signal_type] || signal.signal_type);
  const brl = (n: number) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const uplift = ev.estimatedUpliftMonthly ?? signal.impact_amount ?? null;
  const scoreBreak = ev.scoreBreakdown || null;
  const score = scoreBreak?.total ?? null;
  return (
    <div className={`rounded-xl border p-4 ${sev.bg}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${sev.text} ${sev.bg}`}>
              {sev.label}
            </span>
            {score != null && (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded bg-zinc-800 text-zinc-300`}>
                score {score}/100
              </span>
            )}
            <p className="text-sm font-semibold text-zinc-100">{title}</p>
          </div>
          {ev.used != null && ev.limit != null && signal.signal_type !== 'plan_module_gap' && (
            <p className="text-xs text-zinc-400">
              Uso: <b className="text-zinc-200">{Number(ev.used).toLocaleString('pt-BR')} de {Number(ev.limit).toLocaleString('pt-BR')}</b>
              {ev.pctInt != null && <span className={`ml-2 ${sev.text}`}>({ev.pctInt}%)</span>}
            </p>
          )}
          {ev.upgradeTargetPlan && (
            <p className="text-xs text-zinc-400 mt-1">
              Sugestão: upgrade pro plano <b className="text-teal-300">{ev.upgradeTargetPlan}</b>
              {ev.upgradeTargetLimit != null && ev.upgradeTargetLimit > 0 && (
                <> — {Number(ev.upgradeTargetLimit).toLocaleString('pt-BR')} de teto</>
              )}
              {ev.upgradeTargetLimit === 0 && <> — sem limite</>}
            </p>
          )}
          {uplift != null && uplift > 0 && (
            <p className="text-xs text-zinc-400 mt-1">
              Ganho estimado: <b className="text-emerald-300">{brl(uplift)}/mês</b>
              <span className="text-zinc-500 italic ml-1">(estimativa; §16 PRD)</span>
            </p>
          )}
        </div>
      </div>

      {/* Breakdown do score — expandível pra explicabilidade (PRD §16) */}
      {scoreBreak && (
        <div className="mt-3">
          <button
            onClick={() => setShowBreakdown(!showBreakdown)}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 underline decoration-dotted"
          >
            {showBreakdown ? 'Ocultar' : 'Ver'} breakdown do score
          </button>
          {showBreakdown && (
            <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-zinc-400">
              <span>Necessidade operacional: <b className="text-zinc-200">{scoreBreak.necessidade_operacional}/30</b></span>
              <span>Uso próximo ao limite: <b className="text-zinc-200">{scoreBreak.uso_proximo_limite}/20</b></span>
              <span>Ganho financeiro: <b className="text-zinc-200">{scoreBreak.ganho_financeiro_provavel}/20</b></span>
              <span>Recorrência: <b className="text-zinc-200">{scoreBreak.recorrencia_necessidade}/15</b></span>
              <span>Adequação vertical: <b className="text-zinc-200">{scoreBreak.adequacao_vertical}/10</b></span>
              <span>Confiança dos dados: <b className="text-zinc-200">{scoreBreak.confianca_dados}/5</b></span>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onGoToCobranca}
          className={`text-xs font-medium ${sev.text} hover:opacity-80`}
        >
          Ver planos em Cobrança →
        </button>
        <span className="text-zinc-700">·</span>
        <button
          onClick={onDismiss}
          disabled={dismissing}
          className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
        >
          {dismissing ? 'Dispensando…' : 'Dispensar (não me mostre este mês)'}
        </button>
      </div>
    </div>
  );
};

// ADR-153 F4.2 — Aba "Plano e Expansões" (PRD §11.3). Fonte única do "onde
// estou / quanto uso / próximo passo comercial". Consome:
//   - GET /api/plans/current  (plano + status + uso × limites)
//   - GET /api/plans          (grade completa pra comparação de upgrade)
//   - GET /api/plans/bundles  (bundles verticais — F2.2)
//   - GET /api/plans/addons   (add-ons disponíveis + ativos)
//   - GET /api/signals?domain=plan (recomendação IA — F7.4)
//   - useStore.entitlements   (blueprint da org via /api/entitlements/me — F1.3)
//
// NÃO faz checkout aqui — Cobrança ainda é a tela de assinatura real (F5.3
// vai unificar). Motor de score/frequência (§14-16 do PRD) fica em F7.2/F7.3;
// F7.4 renderiza os sinais que o publisher F7.1 já emite. G-153-3 preservada:
// nenhum upgrade é executado só com clique no CTA — leva pra tela de cobrança.
function PlanoExpansoesPanel({ onGoToCobranca }: { onGoToCobranca: () => void }) {
  const entitlements = useStore(s => s.entitlements);
  const vertical = useStore(s => s.vertical);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [bundles, setBundles] = useState<PlanBundleT[]>([]);
  const [addons, setAddons] = useState<{ available: any[]; active: any[] } | null>(null);
  // ADR-153 F7.4 — sinais domain='plan' publicados pelo PlanFitSignalPublisher
  // (F7.1). Fonte da recomendação inteligente na aba. Sinal aberto com
  // severity + evidence completa. F7.2 vai adicionar score/uplift em BRL.
  const [planSignals, setPlanSignals] = useState<any[]>([]);
  const [dismissingSignal, setDismissingSignal] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPlanSignals = () => {
    apiFetch('/api/signals?domain=plan&status=open')
      .then(r => r.json())
      .then(d => setPlanSignals(Array.isArray(d?.signals) ? d.signals : []))
      .catch(() => setPlanSignals([]));
  };

  useEffect(() => {
    Promise.all([
      fetch('/api/plans/current').then(r => r.json()).catch(() => null),
      fetch('/api/plans').then(r => r.json()).catch(() => []),
      fetch('/api/plans/bundles').then(r => r.json()).catch(() => ({ bundles: [] })),
      apiFetch('/api/plans/addons').then(r => r.json()).catch(() => null),
    ]).then(([cur, ps, bd, ad]) => {
      setSnap(cur && !cur.error ? cur : null);
      setPlans(Array.isArray(ps) ? ps : []);
      setBundles(Array.isArray(bd?.bundles) ? bd.bundles : []);
      setAddons(ad && !ad.error ? ad : null);
    }).finally(() => setLoading(false));
    loadPlanSignals();
  }, []);

  const dismissSignal = async (signalId: string) => {
    setDismissingSignal(signalId);
    try {
      const r = await apiFetch(`/api/signals/${signalId}/dismiss`, { method: 'POST' });
      if (!r.ok) { toast.error('Não foi possível dispensar a recomendação.'); return; }
      toast.success('Recomendação dispensada.');
      loadPlanSignals();
    } catch (e) { toast.error('Erro ao dispensar.'); }
    finally { setDismissingSignal(null); }
  };

  const brl = (n: number) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Ordem tier — pra "próximos níveis" (skip current + skip cortesia).
  const TIER_ORDER = ['autonomo', 'start', 'growth', 'scale', 'enterprise'];
  const currentTierIdx = snap?.plan ? TIER_ORDER.indexOf(snap.plan.id) : -1;
  const upgrades = plans
    .filter(p => p.id !== 'cortesia' && TIER_ORDER.indexOf(p.id) > currentTierIdx)
    .sort((a, b) => TIER_ORDER.indexOf(a.id) - TIER_ORDER.indexOf(b.id));

  // Bundles filtrados pra vertical da org (blueprint hint).
  const recommendedBundles = bundles.filter(b =>
    !b.verticalHints || b.verticalHints.length === 0 || (vertical && b.verticalHints.includes(vertical))
  );

  // Blueprint da org (derivado dos entitlements — qualquer decision tem
  // source.verticalBlueprint que veio da F1.4).
  const blueprintLabel = entitlements
    ? Object.values(entitlements)[0]?.source?.verticalBlueprint || null
    : null;

  // Add-ons DISPONÍVEIS que ligam módulos NÃO escondidos pelo blueprint
  // (evita sugerir clínica pra chaveiro). Sem blueprint: mostra todos.
  const hiddenSet = new Set<string>(
    entitlements
      ? Object.values(entitlements).filter((d: any) => d.state === 'hidden').map((d: any) => d.resource)
      : []
  );
  const relevantAddons = (addons?.available || []).filter((a: any) => !hiddenSet.has(a.key));

  // Contagem por estado (pra mostrar "expansões disponíveis" no header).
  const stateCount = { available_to_buy: 0, available_to_enable: 0, active: 0 };
  if (entitlements) {
    for (const d of Object.values(entitlements) as any[]) {
      if (d.state in stateCount) (stateCount as any)[d.state]++;
    }
  }

  const statusChip = (status: string) => {
    const styles: Record<string, string> = {
      trialing: 'bg-blue-500/20 text-blue-300',
      active: 'bg-emerald-500/20 text-emerald-300',
      past_due: 'bg-amber-500/20 text-amber-300',
      suspended: 'bg-orange-500/20 text-orange-300',
      blocked: 'bg-red-500/20 text-red-300',
      cancelled: 'bg-zinc-500/20 text-zinc-300',
    };
    return <span className={`text-[10px] px-2 py-0.5 rounded ${styles[status] || 'bg-zinc-500/20 text-zinc-300'}`}>{status}</span>;
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <h2 className="zf-page-title flex items-center gap-2">
            <Rocket className="w-6 h-6 text-teal-300" /> Plano e Expansões
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Onde você está e o próximo passo do produto. Cobrança fica em <b>Cobrança</b>.</p>
        </div>
      </div>

      {loading ? (
        <p className="text-zinc-500 text-sm">Carregando…</p>
      ) : (
        <div className="space-y-6">
          {/* 1. Plano atual + blueprint + status */}
          {snap?.plan && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Seu produto atual</p>
                  <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                    {snap.plan.name} {statusChip(snap.billingStatus)}
                  </h3>
                  <p className="text-sm text-zinc-400 mt-1">
                    {brl(snap.plan.price)}/mês
                    {snap.trialDaysLeft != null && snap.billingStatus === 'trialing' && (
                      <> · Trial: <b className="text-blue-300">{snap.trialDaysLeft} dia{snap.trialDaysLeft === 1 ? '' : 's'} restantes</b></>
                    )}
                  </p>
                  {blueprintLabel && (
                    <p className="text-xs text-zinc-500 mt-2">
                      Blueprint: <span className="text-teal-300 font-mono">{blueprintLabel}</span>
                    </p>
                  )}
                </div>
                <div className="text-right text-xs text-zinc-500">
                  <p>Ativos: <b className="text-emerald-300">{stateCount.active}</b></p>
                  <p>Podem ligar: <b className="text-zinc-300">{stateCount.available_to_enable}</b></p>
                  <p>Expansões: <b className="text-indigo-300">{stateCount.available_to_buy}</b></p>
                </div>
              </div>
            </div>
          )}

          {/* 2. Uso × Limites */}
          {snap && (
            <div>
              <p className="text-sm font-semibold text-zinc-200 mb-3">Uso do plano</p>
              <div className="space-y-2">
                <UsageBar label="Respostas de IA (este mês)" used={snap.usage.ai_this_month} limit={snap.limits?.ai_monthly_limit} />
                <UsageBar label="Contatos" used={snap.usage.contacts} limit={snap.limits?.contacts_limit} />
                <UsageBar label="Canais" used={snap.usage.channels} limit={snap.limits?.channels_limit} />
                <UsageBar label="Usuários" used={snap.usage.users} limit={snap.limits?.users_limit} />
              </div>
            </div>
          )}

          {/* 3. Bundles verticais recomendados (F2.2) */}
          {recommendedBundles.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-emerald-300 mb-2">🎯 Bundles recomendados para o seu nicho</p>
              <p className="text-xs text-zinc-500 mb-3">Combinações prontas de plano + add-ons, com desconto sobre a compra avulsa.</p>
              <div className="space-y-3">
                {recommendedBundles.map(b => (
                  <div key={b.key} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-zinc-100">{b.name}</p>
                        <p className="text-xs text-zinc-400 mt-1">{b.description}</p>
                        <p className="text-xs text-zinc-500 mt-2">
                          Plano <b>{b.basePlan}</b> + add-ons: {b.addons.join(', ')}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-emerald-300">{brl(b.priceMonthly)}/mês</p>
                        {b.priceAnnualMonth != null && (
                          <p className="text-xs text-zinc-500">{brl(b.priceAnnualMonth)}/mês no anual</p>
                        )}
                        <p className="text-xs text-emerald-400 mt-1">
                          Economia de {brl(b.bundleDiscount.savingsMonthly)} ({b.bundleDiscount.savingsPercent}%)
                        </p>
                      </div>
                    </div>
                    <button onClick={onGoToCobranca} className="mt-3 text-xs text-emerald-300 hover:text-emerald-200 font-medium">
                      Contratar em Cobrança →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 4. Próximos níveis (upgrade path) */}
          {upgrades.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-zinc-200 mb-2">🚀 Próximos níveis</p>
              <p className="text-xs text-zinc-500 mb-3">Planos superiores comparados ao seu. Escolha em <b>Cobrança</b>.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {upgrades.slice(0, 4).map(p => {
                  const currentMods = new Set<string>(snap?.plan?.features?.modules || []);
                  const newMods = (p.features?.modules || []).filter((m: string) => !currentMods.has(m));
                  return (
                    <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-semibold text-zinc-100">{p.name}</p>
                        <p className="text-sm text-teal-300">{brl(p.price)}/mês</p>
                      </div>
                      {newMods.length > 0 && (
                        <p className="text-xs text-zinc-400">
                          Adiciona: <span className="text-zinc-300">{newMods.slice(0, 5).join(', ')}</span>
                          {newMods.length > 5 && <span className="text-zinc-500"> +{newMods.length - 5}</span>}
                        </p>
                      )}
                      <p className="text-xs text-zinc-500 mt-2">
                        IA: {p.features?.ai_monthly_limit === 0 ? 'ilimitado' : p.features?.ai_monthly_limit?.toLocaleString('pt-BR')} · Usuários: {p.features?.users_limit === 0 ? 'ilimitado' : p.features?.users_limit}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 5. Add-ons compatíveis */}
          {relevantAddons.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-zinc-200 mb-2">➕ Add-ons compatíveis</p>
              <p className="text-xs text-zinc-500 mb-3">Módulos que você pode contratar avulso, respeitando seu Blueprint.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {relevantAddons.map((a: any) => (
                  <div key={a.key} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-zinc-100">{a.key}</p>
                      <p className="text-sm text-teal-300">{brl(a.price)}/mês</p>
                    </div>
                    <button onClick={onGoToCobranca} className="mt-2 text-xs text-teal-300 hover:text-teal-200 font-medium">
                      Contratar em Cobrança →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 6. Add-ons ATIVOS (informativo) */}
          {addons?.active && addons.active.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-zinc-200 mb-2">Add-ons ativos</p>
              <div className="flex flex-wrap gap-2">
                {addons.active.map((a: any) => (
                  <span key={a.key} className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-300">
                    {a.key} · {brl(a.price)}/mês
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 7. Recomendação IA — sinais domain='plan' (ADR-153 F7.4) */}
          <div>
            <p className="text-sm font-semibold text-indigo-300 mb-2 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4" /> Recomendação inteligente
            </p>
            {planSignals.length === 0 ? (
              <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
                <p className="text-xs text-zinc-400">
                  Nada urgente por aqui. O motor (ADR-153 F7) varre uso × limites do seu plano periodicamente — quando algo passar de 80%, aparece um card aqui com evidência e sugestão. Nunca contrata nada por conta própria (G-153-3).
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {planSignals.map((s: any) => (
                  <PlanFitCard
                    key={s.id}
                    signal={s}
                    dismissing={dismissingSignal === s.id}
                    onDismiss={() => dismissSignal(s.id)}
                    onGoToCobranca={onGoToCobranca}
                  />
                ))}
                <p className="text-[11px] text-zinc-500 italic px-2">
                  A IA nunca contrata sozinha (G-153-3). Todo upgrade exige clique explícito em Cobrança.
                  {/* F7.3 — cooldown por rejeição (LGPD §14). Backend aplica sozinho no dismiss. */}
                  <br />
                  Ao dispensar, essa sugestão fica pausada por 30 dias (90d na 2ª, 180d nas seguintes). Uso ≥100% ignora a pausa — não deixamos você travado sem avisar.
                </p>
              </div>
            )}
          </div>

          {/* CTA final */}
          <div className="pt-2 border-t border-zinc-800 flex items-center justify-between">
            <p className="text-xs text-zinc-500">
              Quer trocar de plano ou contratar? Vá em <b>Cobrança</b> pra escolher método de pagamento e aceite.
            </p>
            <Button onClick={onGoToCobranca} className="zf-button zf-button-primary">
              <CreditCard className="w-4 h-4 mr-2" /> Ir para Cobrança
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

// Tipo pro bundle vindo de /api/plans/bundles (F2.2).
type PlanBundleT = {
  key: string;
  name: string;
  description: string;
  basePlan: string;
  addons: string[];
  priceMonthly: number;
  priceAnnualMonth: number | null;
  verticalHints: string[];
  bundleDiscount: { avulsoTotal: number; savingsMonthly: number; savingsPercent: number };
};

// ADR-153 F1.3: usa o mesmo shape de EntitlementDecision do backend.
type EntitlementItem = {
  resource: string;
  label: string;
  desc: string;
  state: 'active' | 'available_to_enable' | 'available_to_buy' | 'hidden' | 'suspended' | 'deprecated' | 'pilot_only';
  upgradeTargetPlan: string | null;
  addonPrice: number | null;
  addon: boolean;
};

// Rótulos + descrições dos módulos (fonte visível pro dono). Deveria vir do
// backend em uma fatia futura (por ex., /api/entitlements/me poderia incluir
// meta.moduleMeta), mas por ora mantemos aqui pra não expandir o payload da
// rota. Segue os mesmos rótulos do ModuleService.MODULE_META no backend.
const MODULE_META: Record<string, { label: string; desc: string }> = {
  agenda: { label: 'Agenda', desc: 'Agendamentos e horários (Google Calendar).' },
  catalogo: { label: 'Catálogo', desc: 'Produtos e serviços.' },
  vendas: { label: 'Vendas', desc: 'Pedidos e fechamento de vendas.' },
  loja: { label: 'Loja Virtual', desc: 'Vitrine online para o cliente comprar.' },
  pagamentos: { label: 'Pagamentos', desc: 'Recebimento por PIX / gateway.' },
  campanhas: { label: 'Campanhas', desc: 'Disparos segmentados.' },
  cadencias: { label: 'Cadências', desc: 'Sequências de follow-up automático.' },
  areas: { label: 'Áreas de Atendimento', desc: 'Vários profissionais num número.' },
  integracoes: { label: 'Integrações', desc: 'Google Workspace e outras conexões.' },
  reservas: { label: 'Reservas', desc: 'Reservas por período com controle de disponibilidade.' },
  assinaturas: { label: 'Assinaturas', desc: 'Cobrança recorrente.' },
  compras: { label: 'Compras', desc: 'Reposição inteligente por IA.' },
  orcamentos: { label: 'Orçamentos', desc: 'Orçamento rastreável com follow-up até a validade.' },
  eventos: { label: 'Eventos & Grupos', desc: 'Pipeline consultivo de eventos.' },
  diretor: { label: 'Diretor Executivo IA', desc: 'Conselheiro de gestão com dados reais.' },
  estudio: { label: 'Estúdio de Criação', desc: 'IA gera imagens e vídeos de campanha.' },
  rie: { label: 'Revenue Intelligence', desc: 'Índice, drivers e plano de ação.' },
  execucao: { label: 'Execução / Tarefas', desc: 'Delegação com Coordenador IA.' },
  prospect: { label: 'Prospect AI', desc: 'Prospecção B2B ativa.' },
  vms: { label: 'Vision VMS', desc: 'Monitoramento de câmeras (add-on).' },
  radar: { label: 'Radar de Execução IA', desc: 'Diagnóstico de maturidade em IA.' },
  clinica: { label: 'Clínica', desc: 'Prontuário, agenda clínica, portal do paciente.' },
  retail: { label: 'Retail Ops', desc: 'Operação de rede de lojas.' },
  retail_floor: { label: 'Atendimento de Loja', desc: 'Lista da vez, cronômetro, conciliação PDV.' },
  copiloto: { label: 'Comigo (Copiloto)', desc: 'Balcão de vendas + precificação + fiado.' },
  escola: { label: 'Escola', desc: 'Resumo diário do aluno pela família.' },
  valor: { label: 'Painel de Valor', desc: 'Impacto medido do ZappFlow no negócio.' },
};

// ADDONs (definidos em verticals.ts do backend) — marcados visualmente.
const ADDON_MODULES = new Set(['vms', 'radar', 'prospect', 'clinica', 'retail', 'escola', 'retail_floor']);

function ModulesPanel({ onUpgrade }: { onUpgrade?: () => void }) {
  const loadEntitlements = useStore(s => s.loadEntitlements);
  const [items, setItems] = useState<EntitlementItem[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/entitlements/me')
      .then(r => r.json())
      .then((d: { entitlements?: Record<string, any> }) => {
        const raw = d?.entitlements || {};
        const list: EntitlementItem[] = Object.entries(raw)
          .filter(([, dec]: [string, any]) => dec?.state && MODULE_META[dec.resource])
          .map(([, dec]: [string, any]) => ({
            resource: dec.resource,
            label: MODULE_META[dec.resource].label,
            desc: MODULE_META[dec.resource].desc,
            state: dec.state,
            upgradeTargetPlan: dec.upgradeTargetPlan || null,
            addonPrice: dec.addonPrice ?? null,
            addon: ADDON_MODULES.has(dec.resource),
          }));
        setItems(list);
        setEnabled(new Set(list.filter(m => m.state === 'active').map(m => m.resource)));
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
      // Envia só os toggleáveis (active + available_to_enable) que estão ligados.
      const payload = items
        .filter(m => (m.state === 'active' || m.state === 'available_to_enable') && enabled.has(m.resource))
        .map(m => m.resource);
      await apiFetch('/api/analytics/settings/modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled_modules: payload }),
      });
      await loadEntitlements(); // atualiza o menu lateral + entitlements do store na hora
      toast.success('Módulos atualizados!');
    } catch (e) { toast.error('Falha ao salvar os módulos.'); }
    finally { setSaving(false); }
  };

  // ADR-153 §11.2 — 3 seções: Seus recursos + Disponíveis no plano + Expansões.
  // Estados `hidden`/`suspended` não aparecem aqui (por design — hidden é o que a
  // vertical/blueprint não recomenda, suspended é problema de billing).
  const ativos = (items || []).filter(m => m.state === 'active');
  const disponiveis = (items || []).filter(m => m.state === 'available_to_enable');
  const expansoes = (items || []).filter(m => m.state === 'available_to_buy');

  const Row: React.FC<{ m: EntitlementItem }> = ({ m }) => {
    const on = enabled.has(m.resource);
    return (
      <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div>
          <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">{m.label}{m.addon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">add-on</span>}</p>
          <p className="text-xs text-zinc-500">{m.desc}</p>
        </div>
        <button onClick={() => toggle(m.resource)}
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
          {/* Seus recursos (ativos) */}
          {ativos.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-emerald-300 mb-2">✅ Seus recursos</p>
              <p className="text-xs text-zinc-500 mb-3">Módulos que já estão ligados na sua conta. Desligue o que não usar.</p>
              <div className="space-y-2">{ativos.map(m => <Row key={m.resource} m={m} />)}</div>
            </div>
          )}

          {/* Disponível no seu plano (podem ligar sem pagar) */}
          {disponiveis.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-zinc-200 mb-2">➕ Recursos disponíveis no seu plano</p>
              <p className="text-xs text-zinc-500 mb-3">Ligue quando quiser — já estão no seu plano.</p>
              <div className="space-y-2">{disponiveis.map(m => <Row key={m.resource} m={m} />)}</div>
            </div>
          )}

          {/* Expansões — link pra Plano e Expansões (F4.2 detalha). */}
          {expansoes.length > 0 && (
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
              <p className="text-sm font-semibold text-indigo-300 flex items-center gap-2 mb-2">
                <Lock className="w-4 h-4" /> Expansões recomendadas ({expansoes.length})
              </p>
              <p className="text-xs text-zinc-500 mb-3">
                Recursos disponíveis via upgrade ou add-on. Veja detalhes em <b>Plano e Expansões</b>.
              </p>
              {onUpgrade && (
                <button onClick={onUpgrade} className="text-xs text-indigo-300 hover:text-indigo-200 font-medium">
                  Ver Plano e Expansões →
                </button>
              )}
            </div>
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
  const [consentMode, setConsentMode] = useState<'simples' | 'avancado'>('simples');

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
    comunicacoes: 'Comunicações', compartilhamento: 'Compartilhamento', dados_sensiveis: 'Dados sensíveis',
  };

  // Modo simples: 3 chaves em linguagem do dono, mapeadas às categorias.
  const SIMPLE_TOGGLES: { key: string; label: string; hint: string }[] = [
    { key: 'dados_pessoais', label: 'Coleto dados pra atender', hint: 'Nome, telefone, endereço etc. — o básico pra vender e entregar.' },
    { key: 'marketing', label: 'Mando marketing/promoções', hint: 'Campanhas, ofertas e novidades pelos canais do cliente.' },
    { key: 'perfilamento', label: 'Faço perfilamento de compra', hint: 'Uso o histórico pra recomendar e personalizar (ex.: recompra).' },
  ];
  const toggleSimple = (key: string) => {
    const has = consentConfig!.categories.includes(key);
    saveConsent({ categories: has ? consentConfig!.categories.filter(c => c !== key) : [...consentConfig!.categories, key] });
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
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-medium text-zinc-100">📋 Consentimento</p>
              <div className="inline-flex rounded-lg border border-zinc-800 overflow-hidden text-xs">
                <button onClick={() => setConsentMode('simples')} className={`px-3 py-1 ${consentMode === 'simples' ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-400 hover:text-zinc-200'}`}>Simples</button>
                <button onClick={() => setConsentMode('avancado')} className={`px-3 py-1 ${consentMode === 'avancado' ? 'bg-teal-500/15 text-teal-300' : 'text-zinc-400 hover:text-zinc-200'}`}>Avançado</button>
              </div>
            </div>

            {consentMode === 'simples' ? (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Marque o que o seu negócio faz com os dados dos clientes. A gente cuida das categorias por trás.</p>
                {SIMPLE_TOGGLES.map(t => {
                  const on = consentConfig.categories.includes(t.key);
                  return (
                    <div key={t.key} className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                      <div><p className="text-sm text-zinc-200">{t.label}</p><p className="text-[11px] text-zinc-500">{t.hint}</p></div>
                      <button onClick={() => toggleSimple(t.key)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${on ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  );
                })}
                {consentConfig.categories.includes('dados_sensiveis') && (
                  <p className="text-[11px] text-amber-400/80">⚠️ Seu segmento trata <strong>dados sensíveis</strong> (ex.: saúde) — base legal reforçada. Veja o modo avançado.</p>
                )}
                <p className="text-[11px] text-zinc-500">Precisa de banner, versão de política ou mais categorias? Use o modo <strong>Avançado</strong>.</p>
              </div>
            ) : (
            <>
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
            </>
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

// Governança de IA (ADR-130) — política vigente + auditoria de decisões que afetam pessoas.
function GovernancePanel() {
  const [pol, setPol] = useState<any | null>(null);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [rehab, setRehab] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/ai-governance').then(r => r.json()).catch(() => null),
      apiFetch('/api/ai-governance/decisions').then(r => r.json()).catch(() => ({})),
      apiFetch('/api/ai-governance/rehabilitation').then(r => r.json()).catch(() => ({})),
    ]).then(([p, d, rb]) => { setPol(p); setDecisions(Array.isArray(d?.decisions) ? d.decisions : []); setRehab(Array.isArray(rb?.items) ? rb.items : []); }).finally(() => setLoading(false));
  }, []);

  const exportReport = async (format: 'csv' | 'pdf') => {
    try {
      const r = await apiFetch(`/api/ai-governance/decisions/export?format=${format}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao exportar.');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `governanca-ia.${format}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Relatório ${format.toUpperCase()} exportado.`);
    } catch (e: any) { toast.error(e.message || 'Falha ao exportar.'); }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
  if (!pol) return <div className="text-sm text-zinc-500">Não consegui carregar a política de governança.</div>;

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="zf-page-title flex items-center gap-2"><Scale className="w-5 h-5 text-teal-300" /> Governança de IA</h2>
          <p className="text-zinc-400 text-sm mt-1">Como a IA do ZappFlow decide com responsabilidade: a IA sugere, você decide — com registro e sem viés.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => exportReport('csv')} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1.5 inline-flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> CSV</button>
          <button onClick={() => exportReport('pdf')} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1.5 inline-flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> PDF</button>
        </div>
      </div>

      {/* Princípios */}
      <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-100 mb-2">Princípios</h3>
        <ul className="space-y-1">
          {pol.principios.map((p: string, i: number) => <li key={i} className="text-[13px] text-zinc-300 flex items-start gap-1.5"><Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-400" />{p}</li>)}
        </ul>
      </div>

      {/* Controles por área */}
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-100 mb-2">Controles vigentes</h3>
        <div className="space-y-2">
          {pol.controles.map((c: any, i: number) => (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
              <div className="text-[13px] font-medium text-teal-300">{c.area}</div>
              <div className="text-[12px] text-zinc-400 mt-0.5">{c.como}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Sugestões que afetam pessoas + checklist */}
      <div className="mt-4 rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4">
        <h3 className="text-sm font-medium text-indigo-100 mb-1 flex items-center gap-2"><UserCheck className="w-4 h-4" /> Decisões que afetam pessoas</h3>
        <p className="text-[12px] text-zinc-400 mb-2">A IA só sugere. Aplicar exige <strong>humano + motivo</strong>, com base no <strong>comportamento</strong> (nunca em característica pessoal).</p>
        <div className="space-y-1.5">
          {pol.peopleAffecting.map((p: any) => (
            <div key={p.kind} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
              <div className="text-[13px] text-zinc-100">{p.label}</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">Base: {p.basis}</div>
              <div className="text-[11px] text-zinc-400 mt-0.5">{p.fairnessNote}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-indigo-500/15 pt-2">
          <div className="text-[11px] uppercase tracking-wide text-indigo-300/80 mb-1">Checklist de fairness</div>
          <ul className="space-y-0.5">{pol.checklistFairness.map((c: string, i: number) => <li key={i} className="text-[12px] text-zinc-300 flex items-start gap-1.5"><span className="text-indigo-400">→</span>{c}</li>)}</ul>
        </div>
      </div>

      {/* Trilha de reabilitação — restrições antigas ainda ativas, candidatas a revisão */}
      {rehab.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <h3 className="text-sm font-medium text-amber-100 mb-1 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Revisões pendentes (reabilitação)</h3>
          <p className="text-[12px] text-zinc-400 mb-2">Toda restrição é revisável: estas estão ativas há mais de 30 dias. Vale revisar se ainda fazem sentido — a pessoa pode ser reabilitada.</p>
          <div className="space-y-1.5">
            {rehab.map((r: any, i: number) => (
              <div key={i} className="flex items-start justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] text-zinc-100">{r.subjectName || r.subjectId} <span className="text-[11px] text-amber-300/90">· {r.label}</span></div>
                  {r.reason && <div className="text-[11px] text-zinc-500 mt-0.5">Motivo original: {r.reason}</div>}
                </div>
                <div className="text-[11px] text-amber-300/80 shrink-0 text-right">há {r.daysActive} dias</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500 mt-2">Para revisar, vá em <strong>Fiado</strong> e retire da lista negra / libere as vendas quando for o caso.</p>
        </div>
      )}

      {/* Auditoria de decisões */}
      <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-medium text-zinc-100 mb-2">Últimas decisões registradas</h3>
        {decisions.length === 0 ? (
          <div className="text-[13px] text-zinc-500">Nenhuma decisão registrada ainda.</div>
        ) : (
          <div className="space-y-1.5">
            {decisions.map((d: any) => (
              <div key={d.id} className="flex items-start justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] text-zinc-100">{d.kind} <span className={`text-[11px] ${d.decision === 'applied' ? 'text-amber-300' : 'text-zinc-500'}`}>· {d.decision === 'applied' ? 'aplicada' : 'dispensada'}</span></div>
                  {d.reason && <div className="text-[11px] text-zinc-500 mt-0.5">Motivo: {d.reason}</div>}
                </div>
                <div className="text-right shrink-0">
                  {d.suggested_by === 'ai' && <span className="text-[10px] rounded-full border border-indigo-500/40 text-indigo-300 px-1.5 py-0.5">sugerida pela IA</span>}
                  <div className="text-[10px] text-zinc-600 mt-0.5">{String(d.created_at || '').slice(0, 10)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
