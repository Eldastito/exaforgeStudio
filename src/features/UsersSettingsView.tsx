import React, { useState, useEffect } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { UserPlus, Lock, Unlock, MessageSquare, Trash2, Plus, Copy, Check } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

export function UsersSettingsView() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Gestores do Zapp (números de WhatsApp autorizados a usar a IA de gestão)
  const [managers, setManagers] = useState<any[]>([]);
  const [mgrNumber, setMgrNumber] = useState('');
  const [mgrName, setMgrName] = useState('');

  const fetchData = async () => {
    try {
      const res = await apiFetch('/api/users');
      const data = await res.json();
      setUsers(data.users || []);
      setInvites(data.invites || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchManagers = async () => {
    try {
      const res = await apiFetch('/api/managers');
      if (res.ok) setManagers(await res.json());
    } catch (e) {
      console.error(e);
    }
  };

  const addManager = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/managers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: mgrNumber, name: mgrName })
      });
      if (res.ok) {
        setMgrNumber('');
        setMgrName('');
        fetchManagers();
      } else {
        const err = await res.json();
        alert(err.error || 'Erro ao cadastrar gestor');
      }
    } catch (e) {
      alert('Erro ao cadastrar gestor');
    }
  };

  const removeManager = async (id: string) => {
    if (!confirm('Remover este gestor do Zapp?')) return;
    try {
      const res = await apiFetch(`/api/managers/${id}`, { method: 'DELETE' });
      if (res.ok) fetchManagers();
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchData();
    fetchManagers();
  }, []);

  // Como o app não envia e-mail, o link de convite precisa ser compartilhado
  // manualmente. O link abre a tela de cadastro já com o código preenchido.
  const buildInviteLink = (token: string, email: string) =>
    `${window.location.origin}/?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email || '')}`;

  const copyText = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(prev => (prev === id ? null : prev)), 2000);
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole })
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({} as any));
        const email = data.email || inviteEmail;
        setInviteEmail('');
        await fetchData();
        if (data.token) {
          const link = buildInviteLink(data.token, email);
          await copyText(link, 'new');
          alert(`Convite criado! O link foi copiado para a área de transferência.\n\nComo o app não envia e-mail, envie este link para a pessoa:\n\n${link}`);
        } else {
          alert('Convite criado!');
        }
      } else {
        const error = await res.json();
        alert(error.error || 'Erro ao convidar');
      }
    } catch(e) {
      alert('Erro ao enviar convite');
    }
  };

  const changeStatus = async (id: string, status: string) => {
    try {
      const res = await apiFetch(`/api/users/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  if (user?.role !== 'owner' && user?.role !== 'admin') {
    return <div className="text-zinc-500 text-center py-12">Você não tem permissão para ver esta página.</div>;
  }

  return (
    <div className="space-y-8">
      {/* Invite Form */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-medium text-zinc-100 mb-4 flex items-center gap-2"><UserPlus className="w-5 h-5"/> Convidar Usuário</h3>
        <form onSubmit={handleInvite} className="flex items-end gap-4">
          <div className="flex-1">
            <label className="text-xs font-medium text-zinc-400 mb-1 block">E-mail</label>
            <input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} 
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" />
          </div>
          <div className="w-48">
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Perfil de Acesso</label>
            <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} 
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100">
              <option value="admin">Administrador</option>
              <option value="manager">Gerente</option>
              <option value="agent">Atendente</option>
              <option value="viewer">Visualizador</option>
            </select>
          </div>
          <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white">Enviar Convite</Button>
        </form>
      </div>

      {/* Users List */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-950 border-b border-zinc-800 text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Usuário</th>
              <th className="px-4 py-3 font-medium">Perfil</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Último Acesso</th>
              <th className="px-4 py-3 font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-zinc-800/20">
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-200">{u.name || 'Sem nome'}</div>
                  <div className="text-xs text-zinc-500">{u.email}</div>
                </td>
                <td className="px-4 py-3 capitalize text-zinc-300">{u.role}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${u.global_status === 'active' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-500'}`}>
                    {u.global_status}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-500 text-xs">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Nunca'}
                </td>
                <td className="px-4 py-3 flex gap-2">
                  {u.id !== user.id && (
                    <>
                      {u.global_status === 'active' ? (
                        <button onClick={() => changeStatus(u.id, 'blocked')} className="text-red-400 hover:text-red-300 transition-colors" title="Bloquear">
                          <Lock className="w-4 h-4"/>
                        </button>
                      ) : (
                        <button onClick={() => changeStatus(u.id, 'active')} className="text-emerald-400 hover:text-emerald-300 transition-colors" title="Desbloquear">
                          <Unlock className="w-4 h-4"/>
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Gestores do Zapp (IA por WhatsApp) */}
      <div className="bg-zinc-900/50 border border-indigo-800/40 rounded-xl p-6">
        <h3 className="text-lg font-medium text-zinc-100 mb-1 flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-indigo-400" /> Gestores do Zapp (IA por WhatsApp)
        </h3>
        <p className="text-xs text-zinc-500 mb-4">
          Números autorizados a conversar com o assistente de gestão pelo WhatsApp (por texto ou áudio).
          Para ativar, a pessoa envia uma mensagem começando com <strong className="text-indigo-300">"Zapp"</strong>.
          Use o formato internacional só com dígitos: DDI + DDD + número (ex.: <code className="text-indigo-300">5521999998888</code>).
        </p>
        <form onSubmit={addManager} className="flex flex-col md:flex-row md:items-end gap-3 mb-5">
          <div className="flex-1">
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Número (WhatsApp)</label>
            <input
              type="text" required value={mgrNumber} onChange={e => setMgrNumber(e.target.value)}
              placeholder="5521999998888"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Nome (opcional)</label>
            <input
              type="text" value={mgrName} onChange={e => setMgrName(e.target.value)}
              placeholder="Ex: Eldas (Dono), Sócio João"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100"
            />
          </div>
          <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Plus className="w-4 h-4 mr-1" /> Adicionar
          </Button>
        </form>

        {managers.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhum gestor cadastrado ainda.</p>
        ) : (
          <div className="divide-y divide-zinc-800/50 border border-zinc-800 rounded-lg overflow-hidden">
            {managers.map(m => (
              <div key={m.id} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-800/20">
                <div>
                  <div className="font-medium text-zinc-200">{m.name || 'Sem nome'}</div>
                  <div className="text-xs text-zinc-500 font-mono">{m.identifier}</div>
                </div>
                <button onClick={() => removeManager(m.id)} className="text-red-400 hover:text-red-300 transition-colors" title="Remover">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invites List */}
      {invites.length > 0 && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden mt-8">
          <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950">
            <h4 className="text-sm font-medium text-zinc-300">Convites Pendentes</h4>
            <p className="text-xs text-zinc-500 mt-0.5">O app não envia e-mail. Copie o link e envie para a pessoa (WhatsApp, e-mail, etc.) — ele abre o cadastro com o código já preenchido.</p>
          </div>
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-zinc-800/50">
              {invites.map(i => (
                <tr key={i.id} className="hover:bg-zinc-800/20">
                  <td className="px-4 py-3 text-zinc-400">{i.email}</td>
                  <td className="px-4 py-3 capitalize text-zinc-500">{i.role}</td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">Expira em: {new Date(i.expires_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    {i.token && (
                      <button
                        type="button"
                        onClick={() => copyText(buildInviteLink(i.token, i.email), i.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-indigo-500/50 hover:text-white"
                        title="Copiar link de convite"
                      >
                        {copiedId === i.id
                          ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copiado!</>
                          : <><Copy className="w-3.5 h-3.5" /> Copiar link</>}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
