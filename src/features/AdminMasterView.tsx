import React, { useState, useEffect } from 'react';
import { toast, confirmDialog } from '@/src/lib/toast';
import { ShieldCheck, Lock, Unlock, Trash2, Bell, AlertTriangle, Activity, Building2, Bot, Users as UsersIcon, DollarSign, UserPlus, Copy, Send, Gift, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/src/components/ui/button';

export function AdminMasterView() {
  const [organizations, setOrganizations] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [securityIssues, setSecurityIssues] = useState<any[] | null>(null);
  const [loadingSecurity, setLoadingSecurity] = useState(false);

  const loadData = () => {
    fetch('/api/admin/organizations')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setOrganizations(data);
        } else {
          setOrganizations([]);
          console.error('Invalid data received:', data);
        }
      })
      .catch(console.error);
    fetch('/api/admin/overview')
      .then(res => res.json())
      .then(data => setOverview(data && !data.error ? data : null))
      .catch(console.error);
  };

  useEffect(() => {
    loadData();
  }, []);

  const brl = (v?: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const num = (v?: number) => Number(v || 0).toLocaleString('pt-BR');
  const relTime = (d?: string) => {
    if (!d) return 'nunca';
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (days <= 0) return 'hoje';
    if (days === 1) return 'ontem';
    return `há ${days}d`;
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    if (!(await confirmDialog(`Tem certeza que deseja alterar o status para ${status}?`, {}))) return;
    setLoadingId(id);
    try {
      await fetch(`/api/admin/organizations/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      loadData();
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleUpdateBillingStatus = async (id: string, billing_status: string) => {
    setLoadingId(id);
    try {
      await fetch(`/api/admin/organizations/${id}/billing-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billing_status })
      });
      loadData();
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleSoftDelete = async (id: string) => {
    if (!(await confirmDialog('Tem certeza que deseja remover esta empresa (Soft Delete)?', { danger: true, confirmText: 'Remover' }))) return;
    setLoadingId(id);
    try {
      await fetch(`/api/admin/organizations/${id}`, { method: 'DELETE' });
      loadData();
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleRunSecurityCheck = async () => {
    setLoadingSecurity(true);
    try {
      const res = await fetch('/api/admin/security-check');
      const data = await res.json();
      setSecurityIssues(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingSecurity(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight text-white flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-red-500" />
          Master Admin
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Gestão de empresas, financeiro e auditoria (Acesso Restrito)</p>
      </div>

      {/* SaaS Overview */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <OverviewCard icon={<Building2 className="w-5 h-5 text-indigo-400" />} label="Empresas ativas"
            value={`${num(overview.activeOrgs)}/${num(overview.totalOrgs)}`}
            sub={`${num(overview.blockedOrgs)} bloqueada(s) · ${num(overview.pastDueOrgs)} inadimplente(s)`} />
          <OverviewCard icon={<Bot className="w-5 h-5 text-emerald-400" />} label="Respostas de IA (30d)"
            value={num(overview.aiLast30d)}
            sub={`${num(overview.aiLast24h)} nas últimas 24h · ${num(overview.aiTotal)} no total`} />
          <OverviewCard icon={<DollarSign className="w-5 h-5 text-rose-400" />} label="Custo de IA (30d)"
            value={brl(overview.aiCost30d)}
            sub={`${num(overview.aiTokens30d)} tokens · ${brl(overview.aiCostTotal)} no total`} />
          <OverviewCard icon={<UsersIcon className="w-5 h-5 text-sky-400" />} label="Contatos na base"
            value={num(overview.totalContacts)}
            sub={`${num(overview.totalUsers)} usuário(s) no SaaS`} />
          <OverviewCard icon={<DollarSign className="w-5 h-5 text-amber-400" />} label="Receita total (SaaS)"
            value={brl(overview.totalRevenue)}
            sub="Pedidos faturados de todas as empresas" />
        </div>
      )}

      <CreateCortesiaPanel />

      <PlansLimitsPanel />

      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-zinc-900 border-b border-zinc-800">
              <tr>
                <th className="px-6 py-4 font-semibold text-zinc-300">Empresa (Org ID)</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Uso de IA (30d)</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Custo IA (30d)</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Base / Receita</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Atividade</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Status</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Billing Status</th>
                <th className="px-6 py-4 font-semibold text-zinc-300 text-right">Ações de Risco</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {organizations.map(org => (
                <tr key={org.organization_id} className="hover:bg-zinc-900/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-medium text-zinc-100">{org.business_name || 'Sem Nome'}</div>
                    <div className="text-xs text-zinc-500 font-mono mt-0.5">{org.organization_id}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5 text-zinc-100 font-semibold">
                      <Bot className="w-3.5 h-3.5 text-emerald-400" /> {num(org.ai_30d)}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">{num(org.ai_total)} no total</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-rose-300 font-semibold">{brl(org.ai_cost_30d)}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{num(org.ai_tokens_30d)} tokens</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-zinc-200">{num(org.contact_count)} contato(s)</div>
                    <div className="text-xs text-emerald-400/80 mt-0.5">{brl(org.revenue)}</div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-xs ${org.last_activity && (Date.now() - new Date(org.last_activity).getTime()) < 7 * 86400000 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {relTime(org.last_activity)}
                    </span>
                    <div className="text-xs text-zinc-600 mt-0.5">{num(org.user_count)} usuário(s)</div>
                  </td>
                  <td className="px-6 py-4">
                     <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${
                        (org.status || 'active') === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                        org.status === 'blocked' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                        org.status === 'past_due' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                        'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
                     }`}>
                       {(org.status || 'ACTIVE').toUpperCase()}
                     </span>
                  </td>
                  <td className="px-6 py-4">
                      <select 
                        className="bg-zinc-950 border border-zinc-800 rounded text-xs p-1 text-zinc-300"
                        value={org.billing_status || 'active'}
                        onChange={(e) => handleUpdateBillingStatus(org.organization_id, e.target.value)}
                        disabled={loadingId === org.organization_id}
                      >
                         <option value="active">Ativo (Pago)</option>
                         <option value="trialing">Trial</option>
                         <option value="past_due">Atrasado</option>
                         <option value="suspended">Suspenso</option>
                         <option value="blocked">Bloqueado</option>
                         <option value="cancelled">Cancelado</option>
                      </select>
                  </td>
                  <td className="px-6 py-4 text-right flex items-center justify-end gap-2">
                     {org.status === 'blocked' ? (
                        <Button 
                          variant="ghost" size="sm" 
                          onClick={() => handleUpdateStatus(org.organization_id, 'active')}
                          disabled={loadingId === org.organization_id}
                          className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-400/10"
                        >
                          <Unlock className="w-4 h-4 mr-1.5" /> Desbloquear
                        </Button>
                     ) : (
                        <Button 
                          variant="ghost" size="sm" 
                          onClick={() => handleUpdateStatus(org.organization_id, 'blocked')}
                          disabled={loadingId === org.organization_id}
                          className="text-amber-400 hover:text-amber-300 hover:bg-amber-400/10"
                        >
                          <Lock className="w-4 h-4 mr-1.5" /> Bloquear (Inadimplência)
                        </Button>
                     )}
                     
                     <Button 
                       variant="ghost" size="sm" 
                       onClick={() => handleSoftDelete(org.organization_id)}
                       disabled={loadingId === org.organization_id}
                       className="text-red-400 hover:text-red-300 hover:bg-red-400/10"
                     >
                       <Trash2 className="w-4 h-4 mr-1.5" /> Soft Delete
                     </Button>
                  </td>
                </tr>
              ))}
              {organizations.length === 0 && (
                 <tr>
                    <td colSpan={8} className="px-6 py-8 text-center text-zinc-500">
                       Nenhuma organização encontrada.
                    </td>
                 </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Global Notifications Panel */}
      <div className="mt-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-4">
          <Bell className="w-5 h-5 text-indigo-400" />
          Aviso Global (Notificação Sistema)
        </h3>
        <p className="text-sm text-zinc-400 mb-4">Dispara uma notificação para o painel de TODOS os clientes simultaneamente.</p>
        <div className="flex gap-4">
           <input type="text" id="notif-title" placeholder="Título (Ex: Manutenção Programada)" className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 outline-none" />
           <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={async () => {
              const title = (document.getElementById('notif-title') as HTMLInputElement).value;
              if(!title) return;
              try {
                await fetch('/api/admin/notifications/global', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ title, message: 'Veja detalhes no painel.', type: 'alert' })
                });
                toast.success('Aviso enviado com sucesso!');
                (document.getElementById('notif-title') as HTMLInputElement).value = '';
              } catch(e) {}
           }}>
             Enviar Aviso Global
           </Button>
        </div>
      </div>

      {/* Security Check Panel */}
      <div className="mt-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        <div className="flex justify-between items-center mb-6">
           <div>
              <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                Security Check (Auditoria Automática)
              </h3>
              <p className="text-sm text-zinc-400 mt-1">Verifica variáveis, CORS expostos, tenant leakage, e outros riscos do SaaS.</p>
           </div>
           <Button onClick={handleRunSecurityCheck} disabled={loadingSecurity} className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100">
             <Activity className="w-4 h-4 mr-2" />
             {loadingSecurity ? 'Avaliando...' : 'Rodar Auditoria de Segurança'}
           </Button>
        </div>

        {securityIssues && (
           <div className="space-y-4 max-h-[300px] overflow-y-auto">
              {securityIssues.length === 0 ? (
                 <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-sm text-center">
                    Nenhum risco detectado. O sistema está seguro conforme os testes atuais.
                 </div>
              ) : (
                 securityIssues.map((issue: any) => (
                    <div key={issue.id} className="p-4 bg-zinc-950 border border-zinc-800 rounded-lg flex flex-col gap-2">
                       <div className="flex items-center justify-between">
                          <span className="font-semibold text-zinc-200">{issue.title}</span>
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider
                             ${issue.severity === 'critical' ? 'bg-red-500/10 text-red-400 border border-red-500/20' : ''}
                             ${issue.severity === 'high' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : ''}
                             ${issue.severity === 'medium' ? 'bg-yellow-500/10 text-yellow-500 border border-yellow-500/20' : ''}
                             ${issue.severity === 'low' ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20' : ''}
                          `}>
                            {issue.severity} {issue.severity === 'critical' && '🚨'}
                          </span>
                       </div>
                       <p className="text-sm text-zinc-400">{issue.description}</p>
                       <p className="text-sm text-indigo-400 bg-indigo-500/10 p-2 rounded"><strong>Ação recomendada:</strong> {issue.recommendation}</p>
                    </div>
                 ))
              )}
           </div>
        )}
      </div>

      <AuditLogsPanel />
    </div>
  );
}

// Lista de módulos opcionais (espelho do backend) para liberar na conta cortesia.
const OPTIONAL_MODULES: { key: string; label: string }[] = [
  { key: 'agenda', label: 'Agenda' }, { key: 'catalogo', label: 'Catálogo' }, { key: 'vendas', label: 'Vendas' },
  { key: 'loja', label: 'Loja Virtual' }, { key: 'pagamentos', label: 'Pagamentos' }, { key: 'campanhas', label: 'Campanhas' },
  { key: 'cadencias', label: 'Cadências' }, { key: 'areas', label: 'Áreas de Atend.' }, { key: 'integracoes', label: 'Integrações' },
  { key: 'reservas', label: 'Reservas' }, { key: 'assinaturas', label: 'Assinaturas' }, { key: 'compras', label: 'Compras' },
  { key: 'orcamentos', label: 'Orçamentos' }, { key: 'eventos', label: 'Eventos' }, { key: 'diretor', label: 'Diretor IA' },
  { key: 'estudio', label: 'Estúdio de Criação' }, { key: 'rie', label: 'Revenue Intelligence' },
];

function CreateCortesiaPanel() {
  const [businessName, setBusinessName] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [planId, setPlanId] = useState('cortesia');
  const [plans, setPlans] = useState<any[]>([]);
  const [modules, setModules] = useState<string[]>(OPTIONAL_MODULES.map(m => m.key)); // tudo liberado por padrão
  const [sendWhatsapp, setSendWhatsapp] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ link: string; whatsappSent: boolean; whatsappError?: string } | null>(null);
  const [invites, setInvites] = useState<any[]>([]);

  const loadInvites = () => fetch('/api/admin/org-invites').then(r => r.json()).then(d => setInvites(Array.isArray(d) ? d : [])).catch(() => {});
  useEffect(() => {
    fetch('/api/plans').then(r => r.json()).then(d => setPlans(Array.isArray(d) ? d : [])).catch(() => {});
    loadInvites();
  }, []);

  const toggleModule = (k: string) => setModules(m => m.includes(k) ? m.filter(x => x !== k) : [...m, k]);

  const create = async () => {
    if (!businessName.trim()) { toast.error('Informe o nome da empresa.'); return; }
    if (sendWhatsapp && !recipientPhone.trim()) { toast.error('Informe o WhatsApp para enviar o link.'); return; }
    setBusy(true); setResult(null);
    try {
      const res = await fetch('/api/admin/org-invites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName, recipientName, recipientPhone, planId, modules, sendWhatsapp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao criar convite.');
      setResult({ link: data.link, whatsappSent: data.whatsappSent, whatsappError: data.whatsappError });
      if (data.whatsappSent) toast.success('Convite criado e enviado pelo WhatsApp!');
      else toast.success('Convite criado. Copie o link e compartilhe.');
      setBusinessName(''); setRecipientName(''); setRecipientPhone('');
      loadInvites();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const revoke = async (id: string) => {
    if (!(await confirmDialog('Revogar este convite? O link deixa de funcionar.', { danger: true, confirmText: 'Revogar' }))) return;
    await fetch(`/api/admin/org-invites/${id}`, { method: 'DELETE' }).catch(() => {});
    loadInvites();
  };

  const copy = (txt: string) => { try { navigator.clipboard.writeText(txt); toast.success('Link copiado!'); } catch {} };

  return (
    <div className="mb-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-1">
        <Gift className="w-5 h-5 text-emerald-400" /> Criar conta (Cortesia)
      </h3>
      <p className="text-sm text-zinc-400 mb-5">Gera uma empresa nova com acesso definido e envia o link de ativação pelo WhatsApp.</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Nome da empresa *</label>
          <input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="Ex.: Padaria do João"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Nome do responsável</label>
          <input value={recipientName} onChange={e => setRecipientName(e.target.value)} placeholder="Ex.: João"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500" />
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">WhatsApp (DDI+DDD+número)</label>
          <input value={recipientPhone} onChange={e => setRecipientPhone(e.target.value)} placeholder="5521999998888"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500" />
        </div>
      </div>

      <div className="mt-3">
        <label className="text-xs text-zinc-400 mb-1 block">Plano</label>
        <select value={planId} onChange={e => setPlanId(e.target.value)}
          className="w-full md:w-72 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500">
          <option value="cortesia">Cortesia (grátis, acesso liberado)</option>
          {plans.filter(p => p.id !== 'cortesia').map(p => (
            <option key={p.id} value={p.id}>{p.name} — R$ {Number(p.price || 0).toFixed(0)}/mês</option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        <span className="text-xs text-zinc-400">Módulos liberados</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {OPTIONAL_MODULES.map(m => {
            const on = modules.includes(m.key);
            return (
              <button key={m.key} type="button" onClick={() => toggleModule(m.key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${on ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-zinc-300 flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={sendWhatsapp} onChange={e => setSendWhatsapp(e.target.checked)} className="accent-emerald-500" />
          Enviar o link pelo WhatsApp
        </label>
        <Button onClick={create} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          {sendWhatsapp ? <Send className="w-4 h-4 mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}
          {busy ? 'Gerando...' : (sendWhatsapp ? 'Gerar e enviar' : 'Gerar convite')}
        </Button>
      </div>

      {result && (
        <div className="mt-4 p-3 rounded-lg bg-zinc-950 border border-zinc-800">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-zinc-400">Link de ativação:</span>
            <code className="text-xs text-indigo-300 break-all flex-1 min-w-0">{result.link}</code>
            <button onClick={() => copy(result.link)} className="text-zinc-400 hover:text-indigo-300 shrink-0" title="Copiar"><Copy className="w-4 h-4" /></button>
          </div>
          <p className={`text-xs mt-2 ${result.whatsappSent ? 'text-emerald-400' : 'text-amber-400'}`}>
            {result.whatsappSent ? '✓ Enviado pelo WhatsApp.' : (result.whatsappError ? `WhatsApp não enviado: ${result.whatsappError} Copie o link e envie manualmente.` : 'Copie o link e envie manualmente.')}
          </p>
        </div>
      )}

      {invites.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Convites recentes</p>
          <div className="space-y-1.5">
            {invites.map(inv => (
              <div key={inv.id} className="flex items-center justify-between gap-3 text-sm bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <span className="text-zinc-200">{inv.business_name || 'Sem nome'}</span>
                  {inv.recipient_phone && <span className="text-zinc-500 text-xs ml-2">{inv.recipient_phone}</span>}
                  {inv.created_org_name && <span className="text-emerald-400 text-xs ml-2">→ {inv.created_org_name}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    inv.status === 'accepted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                    inv.status === 'revoked' ? 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20' :
                    'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>{inv.status}</span>
                  {inv.status === 'pending' && (
                    <button onClick={() => revoke(inv.id)} className="text-zinc-500 hover:text-rose-400" title="Revogar"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const PLAN_FIELDS: { k: string; label: string }[] = [
  { k: 'ai_monthly_limit', label: 'Respostas IA/mês' },
  { k: 'contacts_limit', label: 'Contatos' },
  { k: 'channels_limit', label: 'Canais' },
  { k: 'users_limit', label: 'Usuários' },
  { k: 'trial_days', label: 'Dias de trial' },
  { k: 'studio_images_monthly', label: 'Imagens/mês (Estúdio)' },
  { k: 'studio_videos_monthly', label: 'Vídeos/mês (Estúdio)' },
];

function PlansLimitsPanel() {
  const [plans, setPlans] = useState<any[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  useEffect(() => { fetch('/api/admin/plans').then(r => r.json()).then(d => setPlans(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  const setField = (id: string, path: string, value: any) => setPlans(ps => ps.map(p => {
    if (p.id !== id) return p;
    if (path === 'name') return { ...p, name: value };
    if (path === 'price') return { ...p, price: value };
    return { ...p, features: { ...(p.features || {}), [path]: value } };
  }));

  const save = async (p: any) => {
    setSavingId(p.id);
    try {
      const f = p.features || {};
      const features: any = {};
      PLAN_FIELDS.forEach(x => { features[x.k] = f[x.k]; });
      const res = await fetch(`/api/admin/plans/${p.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name, price: p.price, features }),
      });
      if (!res.ok) throw new Error();
      toast.success('Plano atualizado!');
    } catch { toast.error('Falha ao salvar o plano.'); } finally { setSavingId(null); }
  };

  return (
    <div className="mb-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-1"><SlidersHorizontal className="w-5 h-5 text-indigo-400" /> Planos & Limites</h3>
      <p className="text-sm text-zinc-400 mb-5">Edite o preço e os limites de cada plano — incluindo imagens/vídeos do Estúdio. Vale para as contagens a partir do salvamento.</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {plans.length === 0 && <p className="text-sm text-zinc-500">Carregando planos…</p>}
        {plans.map(p => (
          <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex items-center gap-2 mb-3">
              <input value={p.name || ''} onChange={e => setField(p.id, 'name', e.target.value)}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100" />
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-xs text-zinc-500">R$</span>
                <input type="number" value={p.price ?? 0} onChange={e => setField(p.id, 'price', e.target.value)}
                  className="w-20 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100" />
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PLAN_FIELDS.map(f => (
                <label key={f.k} className="flex flex-col gap-1">
                  <span className="text-[10px] text-zinc-500">{f.label}</span>
                  <input type="number" min={0} value={p.features?.[f.k] ?? ''} placeholder="—"
                    onChange={e => setField(p.id, f.k, e.target.value)}
                    className="w-full min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-100" />
                </label>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <Button size="sm" onClick={() => save(p)} disabled={savingId === p.id} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                {savingId === p.id ? 'Salvando…' : 'Salvar'}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-400">{icon} {label}</div>
      <div className="text-2xl font-bold text-zinc-100 mt-2">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-1">{sub}</div>}
    </div>
  );
}

function AuditLogsPanel() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
     fetch('/api/audit')
       .then(res => res.json())
       .then(data => setLogs(Array.isArray(data) ? data : []))
       .catch(console.error);
  }, []);

  return (
    <div className="mt-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
       <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-4">
         <Activity className="w-5 h-5 text-indigo-400" />
         Logs de Auditoria Recentes
       </h3>
       <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-zinc-400">
             <thead>
                <tr className="border-b border-zinc-800">
                   <th className="py-2">Data</th>
                   <th className="py-2">Ação</th>
                   <th className="py-2">Usuário</th>
                   <th className="py-2">Org</th>
                </tr>
             </thead>
             <tbody>
                {logs.map(log => (
                   <tr key={log.id} className="border-b border-zinc-800/50">
                      <td className="py-3 font-mono text-xs">{new Date(log.created_at).toLocaleString()}</td>
                      <td className="py-3 text-zinc-200">{log.event_type}</td>
                      <td className="py-3">{log.actor_name || 'System'}</td>
                      <td className="py-3 font-mono text-xs">{log.organization_id}</td>
                   </tr>
                ))}
             </tbody>
          </table>
       </div>
    </div>
  );
}

