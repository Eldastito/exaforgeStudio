import React, { useState, useEffect } from 'react';
import { toast, confirmDialog } from '@/src/lib/toast';
import { ShieldCheck, Plus, Copy, Trash2, Save, ChevronDown, ChevronRight, Lock } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

// RBAC granular (ADR-095 Bloco 3): editor de perfis de acesso. O dono define,
// por módulo, um único nível (Sem acesso / Ver / Operar / Total). "Operar" cobre
// o caso "lê e grava, mas não exclui". O perfil Dono é imutável.

type Level = 'none' | 'read' | 'write' | 'full';
type ModuleMeta = { key: string; label: string };
type Profile = { id: string; name: string; systemKey: string | null; isSystem: boolean; usersCount: number; permissions: Record<string, Level> };

const LEVEL_OPTIONS: { value: Level; label: string }[] = [
  { value: 'none', label: 'Sem acesso' },
  { value: 'read', label: 'Ver' },
  { value: 'write', label: 'Operar' },
  { value: 'full', label: 'Total' },
];

const LEVEL_HINT = 'Ver = só leitura · Operar = cria e edita (não exclui) · Total = tudo, inclusive excluir';

export function PermissionProfilesPanel({ onProfilesChanged }: { onProfilesChanged?: () => void }) {
  const [modules, setModules] = useState<ModuleMeta[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Record<string, Level>>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [mRes, pRes] = await Promise.all([
        apiFetch('/api/permissions/modules'),
        apiFetch('/api/permissions/profiles'),
      ]);
      const m = await mRes.json().catch(() => ({}));
      const p = await pRes.json().catch(() => ({}));
      setModules(m.modules || []);
      setProfiles(p.profiles || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const permsOf = (prof: Profile) => draft[prof.id] || prof.permissions;

  const setLevel = (profId: string, mod: string, level: Level) => {
    setDraft(prev => {
      const base = prev[profId] || profiles.find(p => p.id === profId)!.permissions;
      return { ...prev, [profId]: { ...base, [mod]: level } };
    });
    setDirty(prev => ({ ...prev, [profId]: true }));
  };

  const save = async (prof: Profile) => {
    try {
      const res = await apiFetch(`/api/permissions/profiles/${prof.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: permsOf(prof) }),
      });
      if (res.ok) {
        toast.success(`Perfil "${prof.name}" salvo.`);
        setDirty(prev => ({ ...prev, [prof.id]: false }));
        setDraft(prev => { const n = { ...prev }; delete n[prof.id]; return n; });
        await load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Não foi possível salvar o perfil.');
      }
    } catch { toast.error('Não foi possível salvar o perfil.'); }
  };

  const createProfile = async () => {
    const name = (window.prompt('Nome do novo perfil (ex.: Caixa, Estoquista):') || '').trim();
    if (!name) return;
    try {
      const res = await apiFetch('/api/permissions/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, permissions: {} }),
      });
      if (res.ok) {
        const created = await res.json().catch(() => null);
        toast.success(`Perfil "${name}" criado. Ajuste os níveis por módulo.`);
        await load();
        if (created?.id) setExpanded(created.id);
        onProfilesChanged?.();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Não foi possível criar o perfil.');
      }
    } catch { toast.error('Não foi possível criar o perfil.'); }
  };

  const duplicateProfile = async (prof: Profile) => {
    try {
      const res = await apiFetch(`/api/permissions/profiles/${prof.id}/duplicate`, { method: 'POST' });
      if (res.ok) { toast.success(`Perfil duplicado a partir de "${prof.name}".`); await load(); onProfilesChanged?.(); }
      else toast.error('Não foi possível duplicar o perfil.');
    } catch { toast.error('Não foi possível duplicar o perfil.'); }
  };

  const deleteProfile = async (prof: Profile) => {
    if (prof.usersCount > 0) { toast.error('Reatribua os usuários deste perfil antes de excluí-lo.'); return; }
    if (!(await confirmDialog(`Excluir o perfil "${prof.name}"?`, { danger: true, confirmText: 'Excluir' }))) return;
    try {
      const res = await apiFetch(`/api/permissions/profiles/${prof.id}`, { method: 'DELETE' });
      if (res.ok) { toast.success('Perfil excluído.'); await load(); onProfilesChanged?.(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.error || 'Não foi possível excluir.'); }
    } catch { toast.error('Não foi possível excluir o perfil.'); }
  };

  if (loading) return <div className="text-zinc-500 text-sm py-6">Carregando perfis…</div>;

  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
      <div className="flex items-start justify-between mb-1 gap-4">
        <h3 className="text-lg font-medium text-zinc-100 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-indigo-400" /> Perfis de Acesso
        </h3>
        <Button onClick={createProfile} className="bg-indigo-600 hover:bg-indigo-700 text-white shrink-0">
          <Plus className="w-4 h-4 mr-1" /> Criar perfil
        </Button>
      </div>
      <p className="text-xs text-zinc-500 mb-4">
        Defina o que cada função enxerga e pode fazer, por módulo. {LEVEL_HINT}.
      </p>

      <div className="space-y-3">
        {profiles.map(prof => {
          const isOwner = prof.systemKey === 'owner';
          const isOpen = expanded === prof.id;
          const perms = permsOf(prof);
          return (
            <div key={prof.id} className="border border-zinc-800 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : prof.id)}
                className="w-full flex items-center justify-between px-4 py-3 bg-zinc-950/60 hover:bg-zinc-800/30 transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  {isOpen ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
                  <span className="font-medium text-zinc-200">{prof.name}</span>
                  {prof.isSystem && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400">Modelo</span>
                  )}
                  {isOwner && <Lock className="w-3.5 h-3.5 text-zinc-500" aria-label="Imutável" />}
                </div>
                <span className="text-xs text-zinc-500">{prof.usersCount} usuário(s)</span>
              </button>

              {isOpen && (
                <div className="px-4 py-4 border-t border-zinc-800">
                  {isOwner && (
                    <p className="text-xs text-amber-400/80 mb-3">O perfil Dono tem acesso total e não pode ser alterado.</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {modules.map(mod => (
                      <div key={mod.key} className="flex items-center justify-between gap-2 bg-zinc-950/40 border border-zinc-800/60 rounded-lg px-3 py-2">
                        <span className="text-sm text-zinc-300 truncate">{mod.label}</span>
                        <select
                          value={perms[mod.key] || 'none'}
                          disabled={isOwner}
                          onChange={e => setLevel(prof.id, mod.key, e.target.value as Level)}
                          className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 disabled:opacity-50"
                        >
                          {LEVEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>

                  {!isOwner && (
                    <div className="flex items-center gap-2 mt-4">
                      <Button onClick={() => save(prof)} disabled={!dirty[prof.id]} className="bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">
                        <Save className="w-4 h-4 mr-1" /> Salvar
                      </Button>
                      <button onClick={() => duplicateProfile(prof)} className="inline-flex items-center gap-1.5 text-xs text-zinc-300 border border-zinc-700 rounded-lg px-3 py-2 hover:border-indigo-500/50 hover:text-white transition-colors">
                        <Copy className="w-3.5 h-3.5" /> Duplicar
                      </button>
                      {!prof.isSystem && (
                        <button onClick={() => deleteProfile(prof)} className="inline-flex items-center gap-1.5 text-xs text-red-400 border border-red-900/50 rounded-lg px-3 py-2 hover:bg-red-950/30 transition-colors ml-auto">
                          <Trash2 className="w-3.5 h-3.5" /> Excluir
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
