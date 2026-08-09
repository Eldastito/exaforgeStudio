import React, { useState, useEffect } from 'react';
import { toast, confirmDialog } from '@/src/lib/toast';
import { ShieldCheck, Lock, Unlock, Trash2, Bell, AlertTriangle, Activity, Building2, Bot, Users as UsersIcon, DollarSign, UserPlus, Copy, Send, Gift, SlidersHorizontal, TrendingUp, CheckCircle2, Clock, XCircle, Layers, Plus, ArrowRight, Minus } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { useVisibleLimit, ShowMore } from '@/src/components/ShowMore';

export function AdminMasterView() {
  const [organizations, setOrganizations] = useState<any[]>([]);
  const orgsPage = useVisibleLimit(organizations);
  const [plans, setPlans] = useState<any[]>([]);
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
    fetch('/api/admin/plans')
      .then(res => res.json())
      .then(data => setPlans(Array.isArray(data) ? data : []))
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

  const handleUpdatePlan = async (id: string, planId: string) => {
    if (!planId) return;
    setLoadingId(id);
    try {
      const res = await fetch(`/api/admin/organizations/${id}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId })
      });
      if (res.ok) { toast.success('Plano atribuído.'); loadData(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao atribuir plano.'); }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleToggleFalaTu = async (id: string, enabled: boolean) => {
    setLoadingId(id);
    try {
      const res = await fetch(`/api/admin/organizations/${id}/falatu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (res.ok) { toast.success(enabled ? 'FalaTu liberado para a empresa.' : 'FalaTu desligado para a empresa.'); loadData(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao alterar o FalaTu.'); }
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
                <th className="px-6 py-4 font-semibold text-zinc-300">Plano</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">Billing Status</th>
                <th className="px-6 py-4 font-semibold text-zinc-300">FalaTu</th>
                <th className="px-6 py-4 font-semibold text-zinc-300 text-right">Ações de Risco</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {orgsPage.visible.map(org => (
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
                        value={org.plan_id || ''}
                        onChange={(e) => handleUpdatePlan(org.organization_id, e.target.value)}
                        disabled={loadingId === org.organization_id}
                      >
                         <option value="" disabled>— sem plano —</option>
                         {plans.map(p => (
                           <option key={p.id} value={p.id}>{p.name || p.id}</option>
                         ))}
                      </select>
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
                  <td className="px-6 py-4">
                      {/* Rollout opt-in do FalaTu (ADR-151 F2): flag por org. */}
                      <button
                        onClick={() => handleToggleFalaTu(org.organization_id, !Number(org.falatu_enabled))}
                        disabled={loadingId === org.organization_id}
                        className={`px-2.5 py-1 text-xs font-semibold rounded-full border transition-colors ${
                          Number(org.falatu_enabled)
                            ? 'bg-violet-500/10 text-violet-300 border-violet-500/30 hover:bg-violet-500/20'
                            : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20 hover:text-zinc-300'
                        }`}
                      >
                        {Number(org.falatu_enabled) ? 'Ligado' : 'Desligado'}
                      </button>
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
                    <td colSpan={10} className="px-6 py-8 text-center text-zinc-500">
                       Nenhuma organização encontrada.
                    </td>
                 </tr>
              )}
            </tbody>
          </table>
          <ShowMore page={orgsPage} noun="empresas" />
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

      <UsersManagementPanel />

      <UpgradeRecommendationsPanel />

      <BlueprintsPanel />

      <AuditLogsPanel />
    </div>
  );
}

/**
 * ADR-153 Fatia 3.3 — Master Admin evolui blueprints de nicho (v1→v2)
 * com preview de diff. Blueprint publicado é IMUTÁVEL (G-153-5); pra
 * corrigir/expandir um preset, cria-se nova versão como draft, revisa
 * o diff campo a campo, publica, e re-atribui orgs opt-in.
 *
 * Fluxo desta tela:
 *   1. Lista todas as versões por key (v3 draft, v2 published, v1 deprecated).
 *   2. Botão "Nova versão" clona config da versão base + abre editor de
 *      módulos (hidden/required/optional) via checkboxes CSV simples.
 *   3. Preview de diff mostra +/- por módulo e mudanças escalares.
 *   4. Botão "Publicar" transiciona draft → published (imutável).
 *
 * Fora do escopo: editor completo de config (limits, features, pricing).
 * O admin edita esses via API se necessário. UI cobre o caso 80% (evoluir
 * módulos exibidos/obrigatórios do nicho).
 */
function BlueprintsPanel() {
  const [blueprints, setBlueprints] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [savingNext, setSavingNext] = useState(false);
  const [diffing, setDiffing] = useState<any | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/blueprints');
      const d = await r.json();
      setBlueprints(Array.isArray(d?.blueprints) ? d.blueprints : []);
    } catch { setBlueprints([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Agrupa por key, mais recente primeiro
  const byKey = blueprints.reduce<Record<string, any[]>>((acc, b) => {
    (acc[b.key] = acc[b.key] || []).push(b);
    return acc;
  }, {});
  for (const k in byKey) byKey[k].sort((a, b) => b.version - a.version);

  const openEditor = (source: any) => {
    setEditing({
      sourceId: source.id,
      sourceKey: source.key,
      sourceVersion: source.version,
      name: source.name,
      requiredModules: (source.config?.requiredModules || []).join(', '),
      optionalModules: (source.config?.optionalModules || []).join(', '),
      hiddenModules: (source.config?.hiddenModules || []).join(', '),
      minimumPlanId: source.minimumPlanId || '',
      defaultPlanId: source.defaultPlanId || '',
    });
    setDiffing(null);
  };

  const csv = (s: string) => s.split(',').map((x: string) => x.trim()).filter(Boolean);

  const saveNext = async () => {
    if (!editing) return;
    setSavingNext(true);
    try {
      const body = {
        edits: {
          name: editing.name,
          minimumPlanId: editing.minimumPlanId || undefined,
          defaultPlanId: editing.defaultPlanId || undefined,
          config: {
            requiredModules: csv(editing.requiredModules),
            optionalModules: csv(editing.optionalModules),
            hiddenModules: csv(editing.hiddenModules),
          },
        },
      };
      const r = await fetch(`/api/admin/blueprints/${editing.sourceId}/next-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { toast.error(`Falha: ${d?.error || r.status}`); return; }
      toast.success(`Nova versão criada: ${d.key} v${d.version} (draft).`);
      const diffRes = await fetch(`/api/admin/blueprints/${editing.sourceId}/diff?targetId=${d.id}`);
      const diff = await diffRes.json();
      setDiffing({ newBp: d, diff });
      setEditing(null);
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao criar próxima versão');
    } finally { setSavingNext(false); }
  };

  const publish = async (id: string) => {
    if (!(await confirmDialog('Publicar essa versão? Após publicar, o config fica IMUTÁVEL (só corrige via nova versão).', {}))) return;
    setPublishing(id);
    try {
      const r = await fetch(`/api/admin/blueprints/${id}/publish`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { toast.error(`Falha: ${d?.error || r.status}`); return; }
      toast.success(`Blueprint publicado: ${d.key} v${d.version}.`);
      setDiffing(null);
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao publicar');
    } finally { setPublishing(null); }
  };

  const statusPill = (s: string) => {
    const map: Record<string, string> = {
      published: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      draft: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
      deprecated: 'bg-zinc-700/30 text-zinc-400 border-zinc-700/50',
    };
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${map[s] || map.draft}`}>{s}</span>;
  };

  return (
    <div className="mt-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
      <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Layers className="w-5 h-5 text-violet-400" />
            Vertical Blueprints
          </h3>
          <p className="text-sm text-zinc-400 mt-1">
            Presets de nicho (Clínica Multi, Chaveiro Autônomo, etc.). Publicados são IMUTÁVEIS —
            corrigir/evoluir = nova versão. Orgs migram opt-in via /api/admin/organizations/:id/blueprint.
          </p>
        </div>
        <Button onClick={load} size="sm" variant="secondary">Atualizar</Button>
      </div>

      {loading && <div className="text-zinc-500 text-sm py-4 text-center">Carregando…</div>}

      {!loading && Object.keys(byKey).length === 0 && (
        <div className="text-zinc-500 text-sm py-4 text-center">Nenhum blueprint cadastrado.</div>
      )}

      <div className="space-y-3">
        {(Object.entries(byKey) as [string, any[]][]).map(([key, versions]) => {
          const latest = versions[0];
          const expanded = expandedKey === key;
          return (
            <div key={key} className="bg-zinc-950/40 border border-zinc-800 rounded p-3">
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-zinc-100 font-medium">{latest.name} <span className="text-zinc-500 text-xs">({key})</span></div>
                  <div className="text-xs text-zinc-500">
                    {versions.length} versão(ões) · última: v{latest.version} {statusPill(latest.status)}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setExpandedKey(expanded ? null : key)}>
                    {expanded ? 'Ocultar' : 'Ver versões'}
                  </Button>
                  <Button size="sm" onClick={() => openEditor(latest)}>+ Nova versão</Button>
                </div>
              </div>

              {expanded && (
                <div className="mt-3 space-y-1 border-t border-zinc-800 pt-2">
                  {versions.map((v: any) => (
                    <div key={v.id} className="flex justify-between items-center text-xs py-1">
                      <div className="flex gap-2 items-center">
                        <span className="font-mono text-zinc-400">v{v.version}</span>
                        {statusPill(v.status)}
                        <span className="text-zinc-500">criado {new Date(v.createdAt).toLocaleString()}</span>
                      </div>
                      {v.status === 'draft' && (
                        <Button size="sm" onClick={() => publish(v.id)} disabled={publishing === v.id}>
                          {publishing === v.id ? 'Publicando…' : 'Publicar'}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Editor modal-like inline */}
      {editing && (
        <div className="mt-4 border border-violet-500/30 bg-violet-500/5 rounded p-4 space-y-3">
          <div className="flex justify-between items-center">
            <h4 className="text-zinc-100 font-medium">Nova versão de {editing.sourceKey} (baseada em v{editing.sourceVersion})</h4>
            <button onClick={() => setEditing(null)} className="text-zinc-500 hover:text-zinc-300 text-xs">Cancelar</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-400 space-y-1">
              <span>Nome</span>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400 space-y-1">
              <span>Plano mínimo</span>
              <input value={editing.minimumPlanId} onChange={(e) => setEditing({ ...editing, minimumPlanId: e.target.value })}
                placeholder="growth" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 font-mono" />
            </label>
          </div>
          <label className="text-xs text-zinc-400 space-y-1 block">
            <span>Módulos obrigatórios (CSV)</span>
            <textarea rows={2} value={editing.requiredModules} onChange={(e) => setEditing({ ...editing, requiredModules: e.target.value })}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 font-mono" />
          </label>
          <label className="text-xs text-zinc-400 space-y-1 block">
            <span>Módulos opcionais (CSV)</span>
            <textarea rows={2} value={editing.optionalModules} onChange={(e) => setEditing({ ...editing, optionalModules: e.target.value })}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 font-mono" />
          </label>
          <label className="text-xs text-zinc-400 space-y-1 block">
            <span>Módulos escondidos — NUNCA mostrar pra org (CSV)</span>
            <textarea rows={2} value={editing.hiddenModules} onChange={(e) => setEditing({ ...editing, hiddenModules: e.target.value })}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 font-mono" />
          </label>
          <div className="flex justify-end">
            <Button onClick={saveNext} disabled={savingNext}>
              {savingNext ? 'Criando…' : 'Criar draft + ver diff'}
            </Button>
          </div>
        </div>
      )}

      {/* Diff viewer */}
      {diffing && (
        <div className="mt-4 border border-emerald-500/30 bg-emerald-500/5 rounded p-4 space-y-3">
          <div className="flex justify-between items-center">
            <h4 className="text-zinc-100 font-medium">
              Diff: v{diffing.diff?.source?.version} → v{diffing.diff?.target?.version} ({diffing.newBp.key})
            </h4>
            <button onClick={() => setDiffing(null)} className="text-zinc-500 hover:text-zinc-300 text-xs">Fechar</button>
          </div>

          <DiffSection label="Módulos obrigatórios" added={diffing.diff.diff.requiredAdded} removed={diffing.diff.diff.requiredRemoved} />
          <DiffSection label="Módulos opcionais" added={diffing.diff.diff.optionalAdded} removed={diffing.diff.diff.optionalRemoved} />
          <DiffSection label="Módulos escondidos" added={diffing.diff.diff.hiddenAdded} removed={diffing.diff.diff.hiddenRemoved} />
          <DiffSection label="Upgrades comerciais" added={diffing.diff.diff.commercialUpgradesAdded} removed={diffing.diff.diff.commercialUpgradesRemoved} />

          {diffing.diff.diff.scalarChanges?.length > 0 && (
            <div className="text-xs">
              <div className="text-zinc-400 mb-1">Mudanças escalares:</div>
              {diffing.diff.diff.scalarChanges.map((c: any, i: number) => (
                <div key={i} className="flex items-center gap-2 font-mono text-zinc-300">
                  <span className="text-zinc-500">{c.field}:</span>
                  <span className="line-through text-rose-300">{String(c.from ?? '—')}</span>
                  <ArrowRight className="w-3 h-3 text-zinc-500" />
                  <span className="text-emerald-300">{String(c.to ?? '—')}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end pt-2 border-t border-emerald-500/20">
            <Button onClick={() => publish(diffing.newBp.id)} disabled={publishing === diffing.newBp.id}>
              {publishing === diffing.newBp.id ? 'Publicando…' : `Publicar v${diffing.newBp.version} (fica imutável)`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffSection({ label, added, removed }: { label: string; added: string[]; removed: string[] }) {
  if (!added?.length && !removed?.length) return null;
  return (
    <div className="text-xs">
      <div className="text-zinc-400 mb-1">{label}:</div>
      <div className="flex flex-wrap gap-1 pl-2">
        {added?.map((m) => (
          <span key={`a-${m}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 font-mono">
            <Plus className="w-3 h-3" /> {m}
          </span>
        ))}
        {removed?.map((m) => (
          <span key={`r-${m}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 font-mono">
            <Minus className="w-3 h-3" /> {m}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * ADR-153 Fatia 7.6 — Master Admin visualiza o funil consolidado de
 * recomendações de upgrade de TODAS as orgs. Casos de uso:
 *   1. "Quem aceitou upgrade e ainda não pagou?" — filtra por status=accepted;
 *      admin pode ligar/processar checkout manual (até Fase 5 automatizar Asaas).
 *   2. "Meu motor de recomendação está publicando demais?" — vê ratio
 *      accepted/pending/dismissed no cabeçalho.
 *   3. "Quanto de MRR incremental há em pending?" — soma uplift em BRL.
 *
 * Tudo read-only (sem "resetar cooldown" ou "aceitar por eles" — LGPD §14 diz
 * que apenas o dono da org decide). Se admin quiser processar upgrade, faz por
 * fora via /api/admin/organizations/:id/plan (fluxo existente).
 */
function UpgradeRecommendationsPanel() {
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [status, setStatus] = useState<string>('accepted');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (status) params.set('status', status);
      const [rItems, rSummary] = await Promise.all([
        fetch(`/api/admin/upgrade-recommendations?${params.toString()}`).then(r => r.json()),
        fetch(`/api/admin/upgrade-recommendations/summary`).then(r => r.json()),
      ]);
      setItems(Array.isArray(rItems?.items) ? rItems.items : []);
      setSummary(rSummary && !rSummary.error ? rSummary : null);
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao carregar recomendações');
      setItems([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [status]);

  const brl = (v?: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const relTime = (d?: string) => {
    if (!d) return '—';
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (days <= 0) return 'hoje';
    if (days === 1) return 'ontem';
    return `há ${days}d`;
  };
  const cooldownRemaining = (until?: string) => {
    if (!until) return '—';
    const ms = new Date(until).getTime() - Date.now();
    if (ms <= 0) return 'expirou';
    const days = Math.ceil(ms / 86400000);
    return `${days}d restante(s)`;
  };
  const statusPill = (s: string) => {
    const map: Record<string, { color: string; icon: any; label: string }> = {
      accepted: { color: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', icon: CheckCircle2, label: 'aceita — aguardando checkout' },
      pending: { color: 'bg-sky-500/10 text-sky-300 border-sky-500/30', icon: Clock, label: 'pendente' },
      dismissed: { color: 'bg-amber-500/10 text-amber-300 border-amber-500/30', icon: XCircle, label: 'dispensada' },
      expired: { color: 'bg-zinc-700/30 text-zinc-400 border-zinc-700/50', icon: XCircle, label: 'expirada' },
    };
    const cfg = map[s] || map.pending;
    const Icon = cfg.icon;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${cfg.color}`}>
        <Icon className="w-3 h-3" /> {cfg.label}
      </span>
    );
  };

  return (
    <div className="mt-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
      <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-emerald-400" />
            Recomendações de Upgrade (funil consolidado)
          </h3>
          <p className="text-sm text-zinc-400 mt-1">
            Aceitas aguardando checkout, pendentes e histórico de dispensadas — todas as orgs.
            Use pra processar upgrade manual até Fase 5 automatizar via Asaas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm rounded px-2 py-1"
          >
            <option value="accepted">Aceitas (aguardando checkout)</option>
            <option value="pending">Pendentes</option>
            <option value="dismissed">Dispensadas</option>
            <option value="expired">Expiradas</option>
            <option value="">Todas</option>
          </select>
          <Button onClick={load} size="sm" variant="secondary">Atualizar</Button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded p-3">
            <div className="text-xs text-zinc-400">Aceitas aguardando checkout</div>
            <div className="text-xl font-semibold text-emerald-300">{summary.acceptedAwaitingCheckout || 0}</div>
          </div>
          <div className="bg-sky-500/5 border border-sky-500/20 rounded p-3">
            <div className="text-xs text-zinc-400">Pendentes</div>
            <div className="text-xl font-semibold text-sky-300">{summary.byStatus?.pending || 0}</div>
          </div>
          <div className="bg-amber-500/5 border border-amber-500/20 rounded p-3">
            <div className="text-xs text-zinc-400">Dispensadas (cooldown)</div>
            <div className="text-xl font-semibold text-amber-300">{summary.byStatus?.dismissed || 0}</div>
          </div>
          <div className="bg-indigo-500/5 border border-indigo-500/20 rounded p-3">
            <div className="text-xs text-zinc-400">MRR incremental em pendentes</div>
            <div className="text-xl font-semibold text-indigo-300">{brl(summary.totalPendingUplift)}</div>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-zinc-300">
          <thead className="bg-zinc-900 border-b border-zinc-800">
            <tr>
              <th className="px-3 py-2 font-medium text-zinc-400">Empresa</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Alvo</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Score</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Ganho/mês</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Status</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Rejeições</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Cooldown</th>
              <th className="px-3 py-2 font-medium text-zinc-400">Atualizado</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-zinc-500">Carregando…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                Nenhuma recomendação {status ? `com status "${status}"` : 'no ledger'} agora.
              </td></tr>
            )}
            {!loading && items.map((it: any) => (
              <tr key={it.id} className="border-b border-zinc-800/60">
                <td className="px-3 py-2">
                  <div className="text-zinc-100">{it.organizationName || <span className="text-zinc-500">(sem nome)</span>}</div>
                  <div className="text-xs font-mono text-zinc-500">{it.organizationId}</div>
                </td>
                <td className="px-3 py-2">
                  {it.targetModuleKey && <div>módulo <span className="text-white">{it.targetModuleKey}</span></div>}
                  <div className="text-zinc-400">plano <span className="text-white">{it.targetPlanId || '—'}</span></div>
                </td>
                <td className="px-3 py-2 tabular-nums">{it.score || 0}/100</td>
                <td className="px-3 py-2 tabular-nums">
                  {it.impactAmount && it.impactUnit === 'BRL' ? brl(it.impactAmount) : '—'}
                </td>
                <td className="px-3 py-2">{statusPill(it.status)}</td>
                <td className="px-3 py-2 tabular-nums">{it.rejectionCount || 0}×</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{cooldownRemaining(it.cooldownUntil)}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{relTime(it.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-500 mt-3">
        Read-only. Master Admin não aceita/dispensa em nome do dono (LGPD §14). Pra aplicar upgrade
        manual: fluxo existente em <span className="font-mono">/api/admin/organizations/:id/plan</span>.
      </p>
    </div>
  );
}

// Gerenciador de USUÁRIOS (ADR-090). Master Admin lista, busca, reseta senha e
// remove usuários de qualquer org — sem precisar de SSH pra resolver conta
// travada por email fictício sem recuperação de senha.
function UsersManagementPanel() {
  const [users, setUsers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const load = async (search = q) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (search.trim()) params.set('q', search.trim());
      const r = await fetch(`/api/admin/users?${params.toString()}`);
      const d = await r.json();
      setUsers(Array.isArray(d?.users) ? d.users : []);
      setTotal(Number(d?.total || 0));
    } catch { setUsers([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(''); }, []);

  const handleReset = async (id: string) => {
    if (newPassword.length < 8) {
      toast.error('A senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    try {
      const r = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast.error(d?.error === 'cannot_reset_master_admin_here'
          ? 'Master admin não pode resetar a própria senha por aqui.'
          : `Falha: ${d?.error || r.status}`);
        return;
      }
      toast.success('Senha redefinida. Peça pro usuário logar com a nova.');
      setResettingId(null);
      setNewPassword('');
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao redefinir senha');
    }
  };

  const handleDelete = async (u: any) => {
    if (!(await confirmDialog(
      `Remover o usuário ${u.email}? Ele não conseguirá mais logar. (Soft delete — histórico preservado.)`,
      { danger: true, confirmText: 'Remover' }
    ))) return;
    try {
      const r = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast.error(d?.error === 'cannot_delete_master_admin'
          ? 'Master admin não pode ser removido.'
          : `Falha: ${d?.error || r.status}`);
        return;
      }
      toast.success('Usuário removido.');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="mt-8 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <UsersIcon className="w-5 h-5 text-sky-400" />
            Usuários
          </h3>
          <p className="text-sm text-zinc-400 mt-1">Busca, reset de senha e soft-delete de qualquer usuário. Usa quando cliente perdeu acesso.</p>
        </div>
        <div className="flex gap-2 items-center">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
            placeholder="buscar por email, nome ou empresa..."
            className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none min-w-[280px]"
          />
          <Button onClick={() => load()} className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100">Buscar</Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-400 border-b border-zinc-800">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Nome</th>
              <th className="px-3 py-2 font-medium">Empresa</th>
              <th className="px-3 py-2 font-medium">Papel</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-zinc-500">Carregando…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-zinc-500">
                {q ? `Nenhum usuário para "${q}"` : 'Nenhum usuário cadastrado ainda.'}
              </td></tr>
            ) : users.map((u) => (
              <React.Fragment key={u.id}>
                <tr className="border-b border-zinc-800/70 hover:bg-zinc-800/30">
                  <td className="px-3 py-2 text-zinc-100 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2 text-zinc-300">{u.name || '—'}</td>
                  <td className="px-3 py-2 text-zinc-300">{u.org_name || '—'}</td>
                  <td className="px-3 py-2 text-zinc-400">{u.role || '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wider ${
                      u.global_status === 'deleted' ? 'bg-red-500/10 text-red-400' :
                      u.global_status === 'blocked' ? 'bg-amber-500/10 text-amber-400' :
                      'bg-emerald-500/10 text-emerald-400'
                    }`}>{u.global_status || 'active'}</span>
                  </td>
                  <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
                    <button
                      onClick={() => { setResettingId(resettingId === u.id ? null : u.id); setNewPassword(''); }}
                      className="text-xs px-2 py-1 rounded bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/40"
                    >
                      <Lock className="w-3 h-3 inline mr-1" /> Redefinir senha
                    </button>
                    {u.global_status !== 'deleted' && (
                      <button
                        onClick={() => handleDelete(u)}
                        className="text-xs px-2 py-1 rounded bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
                      >
                        <Trash2 className="w-3 h-3 inline mr-1" /> Remover
                      </button>
                    )}
                  </td>
                </tr>
                {resettingId === u.id && (
                  <tr className="bg-zinc-950/60"><td colSpan={6} className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-zinc-400">Nova senha p/ {u.email}:</span>
                      <input
                        type="text"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="mínimo 8 caracteres"
                        className="flex-1 max-w-md bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100"
                      />
                      <Button onClick={() => handleReset(u.id)} className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs">Confirmar</Button>
                      <Button onClick={() => { setResettingId(null); setNewPassword(''); }} variant="outline" className="text-xs border-zinc-700 bg-zinc-800 text-zinc-300">Cancelar</Button>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">A senha antiga é descartada. Peça pro usuário logar com a nova imediatamente e trocar em Perfil.</p>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {total > users.length && (
        <p className="text-xs text-zinc-500 mt-2">Mostrando {users.length} de {total}. Use a busca pra afunilar.</p>
      )}
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
  { key: 'execucao', label: 'Execução / Tarefas' }, { key: 'prospect', label: 'Prospect AI' },
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
  const logsPage = useVisibleLimit(logs);
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
                {logsPage.visible.map(log => (
                   <tr key={log.id} className="border-b border-zinc-800/50">
                      <td className="py-3 font-mono text-xs">{new Date(log.created_at).toLocaleString()}</td>
                      <td className="py-3 text-zinc-200">{log.event_type}</td>
                      <td className="py-3">{log.actor_name || 'System'}</td>
                      <td className="py-3 font-mono text-xs">{log.organization_id}</td>
                   </tr>
                ))}
             </tbody>
          </table>
          <ShowMore page={logsPage} noun="registros" />
       </div>
    </div>
  );
}

