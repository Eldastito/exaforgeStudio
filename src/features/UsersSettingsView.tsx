import React, { useState, useEffect } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Users, UserPlus, Trash, Shield, Lock, Unlock } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

export function UsersSettingsView() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');

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

  useEffect(() => {
    fetchData();
  }, []);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole })
      });
      if (res.ok) {
        setInviteEmail('');
        fetchData();
        alert('Convite enviado!');
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

      {/* Invites List */}
      {invites.length > 0 && (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden mt-8">
          <h4 className="px-4 py-3 border-b border-zinc-800 text-sm font-medium text-zinc-300 bg-zinc-950">Convites Pendentes</h4>
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-zinc-800/50">
              {invites.map(i => (
                <tr key={i.id} className="hover:bg-zinc-800/20">
                  <td className="px-4 py-3 text-zinc-400">{i.email}</td>
                  <td className="px-4 py-3 capitalize text-zinc-500">{i.role}</td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">Expira em: {new Date(i.expires_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
