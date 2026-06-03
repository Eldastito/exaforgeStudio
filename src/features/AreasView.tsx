import React, { useEffect, useState } from 'react';
import { Users2, Plus, X, Pencil, Trash2, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { EmptyState } from '@/src/components/EmptyState';

type Area = {
  id: string; name: string; description: string; persona: string;
  assigned_user_id: string | null; active: boolean;
};
type OrgUser = { id: string; name: string; email: string };

const inputClass = 'w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100';

export function AreasView() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Area | null>(null);
  const [showModal, setShowModal] = useState(false);

  const load = () => {
    apiFetch('/api/areas').then(r => r.json()).then(d => setAreas(Array.isArray(d) ? d : [])).catch(console.error).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    apiFetch('/api/users').then(r => r.json()).then(d => setUsers(Array.isArray(d?.users) ? d.users : [])).catch(() => {});
  }, []);

  const userName = (id: string | null) => users.find(u => u.id === id)?.name || (id ? '—' : 'Sem atendente');

  const openNew = () => { setEditing(null); setShowModal(true); };
  const openEdit = (a: Area) => { setEditing(a); setShowModal(true); };

  const toggleActive = async (a: Area) => {
    setAreas(list => list.map(x => x.id === a.id ? { ...x, active: !x.active } : x));
    try { await apiFetch(`/api/areas/${a.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !a.active }) }); }
    catch { load(); }
  };

  const remove = async (a: Area) => {
    if (!window.confirm(`Excluir a área "${a.name}"? As conversas dela voltam ao menu na próxima mensagem.`)) return;
    setAreas(list => list.filter(x => x.id !== a.id));
    try { await apiFetch(`/api/areas/${a.id}`, { method: 'DELETE' }); } catch { load(); }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
              <Users2 className="w-6 h-6 text-indigo-400" /> Áreas de Atendimento
            </h2>
            <p className="text-zinc-400 text-sm mt-1 max-w-2xl">
              Vários profissionais no mesmo WhatsApp. Com 2 ou mais áreas ativas, a IA dá as boas-vindas, mostra um menu e direciona cada conversa para a área certa — respondendo como aquele profissional e atribuindo ao atendente responsável.
            </p>
          </div>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={openNew}>
            <Plus className="w-4 h-4 mr-2" /> Nova área
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-zinc-400 py-10 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>
        ) : areas.length === 0 ? (
          <EmptyState icon={<Users2 className="w-6 h-6" />} title="Nenhuma área ainda"
            description="Crie uma área para cada profissional/setor (ex.: Dra. Ana — Nutrição). Com 2+ áreas, a IA passa a oferecer o menu de escolha no início da conversa."
            actionLabel="Criar primeira área" onAction={openNew} />
        ) : (
          <>
            {areas.filter(a => a.active).length < 2 && (
              <p className="mb-4 text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                O menu de áreas só aparece para o cliente quando há <strong>2 ou mais áreas ativas</strong>. Hoje há {areas.filter(a => a.active).length}.
              </p>
            )}
            <div className="space-y-2">
              {areas.map((a, i) => (
                <div key={a.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100 truncate">
                      <span className="text-zinc-500 mr-1">{i + 1}.</span>{a.name}
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {a.description ? a.description + ' · ' : ''}Atendente: {userName(a.assigned_user_id)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button onClick={() => toggleActive(a)}
                      className={`text-xs px-2 py-1 rounded border ${a.active ? 'border-emerald-500/40 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>
                      {a.active ? 'Ativa' : 'Inativa'}
                    </button>
                    <button onClick={() => openEdit(a)} title="Editar" className="text-zinc-400 hover:text-indigo-400"><Pencil className="w-4 h-4" /></button>
                    <button onClick={() => remove(a)} title="Excluir" className="text-zinc-400 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showModal && (
        <AreaModal
          area={editing}
          users={users}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function AreaModal({ area, users, onClose, onSaved }: {
  area: Area | null; users: OrgUser[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(area?.name || '');
  const [description, setDescription] = useState(area?.description || '');
  const [persona, setPersona] = useState(area?.persona || '');
  const [assigned, setAssigned] = useState(area?.assigned_user_id || '');
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const generatePersona = async () => {
    if (!name.trim() && !description.trim()) { toast.error('Preencha o nome ou a descrição da área primeiro.'); return; }
    setAiLoading(true);
    try {
      const res = await apiFetch('/api/areas/ai/persona', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao gerar com a IA.'); return; }
      if (d.persona) setPersona(d.persona);
      toast.success('Persona gerada pela IA. Revise e ajuste como quiser. ✨');
    } catch { toast.error('Erro ao gerar com a IA'); }
    finally { setAiLoading(false); }
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Informe o nome da área.'); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim(), persona: persona.trim(), assigned_user_id: assigned || null };
      const url = area ? `/api/areas/${area.id}` : '/api/areas';
      const res = await apiFetch(url, { method: area ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao salvar.'); return; }
      toast.success(area ? 'Área atualizada.' : 'Área criada.');
      onSaved();
    } catch { toast.error('Erro ao salvar área.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">{area ? 'Editar área' : 'Nova área de atendimento'}</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Nome da área / profissional</label>
            <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Dra. Ana — Nutrição" autoFocus />
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Descrição curta (aparece no menu)</label>
            <input className={inputClass} value={description} onChange={e => setDescription(e.target.value)} placeholder="Ex.: avaliações e planos alimentares" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-zinc-400 flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-indigo-300" /> Persona / instruções da IA nesta área</label>
              <button type="button" onClick={generatePersona} disabled={aiLoading}
                className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-50">
                {aiLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} {aiLoading ? 'Gerando...' : 'Gerar com IA'}
              </button>
            </div>
            <textarea className={`${inputClass} h-28 resize-none`} value={persona} onChange={e => setPersona(e.target.value)}
              placeholder="Como a IA deve se comportar ao atender por esta área: nome, tom, o que oferece, o que NÃO faz, como encaminhar. Ex.: 'Você é a assistente da Dra. Ana, nutricionista. Tom acolhedor. Explique como funciona a consulta e ofereça agendar...'" />
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Atendente responsável</label>
            <select className={inputClass} value={assigned} onChange={e => setAssigned(e.target.value)}>
              <option value="">Sem atendente (só etiqueta a conversa)</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
            <p className="text-[11px] text-zinc-500 mt-1">A conversa direcionada a esta área é atribuída a este atendente no Atendimento.</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (area ? 'Salvar' : 'Criar área')}
          </Button>
        </div>
      </div>
    </div>
  );
}
