import React, { useState, useEffect } from 'react';
import { ShieldCheck, Lock, Unlock, Trash2, Bell, AlertTriangle, Activity } from 'lucide-react';
import { Button } from '@/src/components/ui/button';

export function AdminMasterView() {
  const [organizations, setOrganizations] = useState<any[]>([]);
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
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleUpdateStatus = async (id: string, status: string) => {
    if (!window.confirm(`Tem certeza que deseja alterar o status para ${status}?`)) return;
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
    if (!window.confirm('Tem certeza que deseja remover esta empresa (Soft Delete)?')) return;
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

      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-zinc-900 border-b border-zinc-800">
              <tr>
                <th className="px-6 py-4 font-semibold text-zinc-300">Empresa (Org ID)</th>
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
                    <td colSpan={4} className="px-6 py-8 text-center text-zinc-500">
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
                alert('Aviso enviado com sucesso!');
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

