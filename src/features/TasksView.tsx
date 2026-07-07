import React, { useEffect, useState, useCallback } from 'react';
import { ListChecks, Plus, Loader2, Sparkles, Calendar, User as UserIcon, X, MessageSquarePlus, Flag } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

type Update = { id: string; kind: string; text: string; created_at: string; author_name?: string };
type Resource = { id: string; kind: 'material' | 'financeiro'; label: string; quantity?: number; amount?: number };
type Task = {
  id: string; title: string; description?: string; assigned_to?: string | null;
  assignee?: { name: string; avatar_url?: string | null } | null;
  priority: 'baixa' | 'media' | 'alta'; status: 'a_fazer' | 'fazendo' | 'feito' | 'cancelada';
  due_at?: string | null; source?: string; contact?: { name: string } | null; ref_label?: string | null;
  created_at: string; updates?: Update[]; resources?: Resource[]; budget_amount?: number; allocated_total?: number;
};
type OrgUser = { id: string; name?: string; email?: string };

const COLUMNS: { id: Task['status']; label: string }[] = [
  { id: 'a_fazer', label: 'A fazer' },
  { id: 'fazendo', label: 'Fazendo' },
  { id: 'feito', label: 'Feito' },
];
const PRIO: Record<string, { label: string; cls: string }> = {
  alta: { label: 'Alta', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  media: { label: 'Média', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  baixa: { label: 'Baixa', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
};
const fmt = (iso?: string | null) => { if (!iso) return ''; try { return new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; } };
const brl = (n?: number) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const isOverdue = (t: Task) => !!t.due_at && t.status !== 'feito' && new Date(t.due_at.includes('T') ? t.due_at : t.due_at.replace(' ', 'T') + 'Z').getTime() < Date.now();

export function TasksView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [filterUser, setFilterUser] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Task | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const q = filterUser ? `?assignedTo=${filterUser}` : '';
    apiFetch(`/api/tasks${q}`).then(r => r.json()).then(d => setTasks(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  }, [filterUser]);
  const loadUsers = () => apiFetch('/api/users').then(r => r.json()).then(d => setUsers(Array.isArray(d) ? d : [])).catch(() => {});
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadUsers(); }, []);

  const move = async (id: string, status: Task['status']) => {
    try {
      const r = await apiFetch(`/api/tasks/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      load();
      if (detail?.id === id) setDetail(await (await apiFetch(`/api/tasks/${id}`)).json());
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="zf-kicker mb-1">Execução Delegada</p>
          <h2 className="zf-page-title flex items-center gap-2">
            <ListChecks className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Tarefas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Delegue, acompanhe e entregue — com a IA assessorando a equipe.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={filterUser} onChange={e => setFilterUser(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-teal-400">
            <option value="">Todos os responsáveis</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
          <Button onClick={() => setCreating(true)} className="zf-button zf-button-primary">
            <Plus className="w-4 h-4 mr-1" /> Nova tarefa
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {COLUMNS.map(col => {
            const items = tasks.filter(t => t.status === col.id);
            return (
              <div key={col.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center justify-between mb-3 px-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{col.label}</span>
                  <span className="text-xs text-zinc-600">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.length === 0 && <p className="text-[11px] text-zinc-600 px-1 py-4 text-center">Nenhuma tarefa.</p>}
                  {items.map(t => (
                    <div key={t.id} onClick={() => setDetail(t)}
                      className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 p-3 hover:border-indigo-500/40 transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm text-zinc-100 font-medium line-clamp-2">{t.title}</p>
                        <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border ${PRIO[t.priority].cls}`}>{PRIO[t.priority].label}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                        <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3" /> {t.assignee?.name || 'Sem dono'}</span>
                        {t.due_at && <span className={`inline-flex items-center gap-1 ${isOverdue(t) ? 'text-red-400' : ''}`}><Calendar className="w-3 h-3" /> {fmt(t.due_at)}</span>}
                        {t.source === 'ric' && <span className="text-fuchsia-400">do RIC</span>}
                        {t.contact?.name && <span className="text-sky-400">· {t.contact.name}</span>}
                      </div>
                      <div className="mt-2 flex gap-1" onClick={e => e.stopPropagation()}>
                        {col.id === 'a_fazer' && <CardBtn onClick={() => move(t.id, 'fazendo')}>Iniciar</CardBtn>}
                        {col.id === 'fazendo' && <><CardBtn onClick={() => move(t.id, 'feito')}>Concluir</CardBtn><CardBtn onClick={() => move(t.id, 'a_fazer')} ghost>Voltar</CardBtn></>}
                        {col.id === 'feito' && <CardBtn onClick={() => move(t.id, 'fazendo')} ghost>Reabrir</CardBtn>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && <CreateModal users={users} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {detail && <DetailDrawer task={detail} users={users} onClose={() => setDetail(null)} onRefresh={load} />}
    </div>
  );
}

function CardBtn({ children, onClick, ghost }: { children: React.ReactNode; onClick: () => void; ghost?: boolean }) {
  return <button onClick={onClick} className={`text-[10px] px-2 py-1 rounded-md font-medium transition-colors ${ghost ? 'text-zinc-400 hover:text-zinc-200 border border-zinc-800' : 'bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/30'}`}>{children}</button>;
}

function CreateModal({ users, onClose, onCreated }: { users: OrgUser[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [priority, setPriority] = useState('media');
  const [due, setDue] = useState('');
  const [refLabel, setRefLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim()) { toast.error('Informe um título.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, assignedTo: assignedTo || null, priority, dueAt: due ? new Date(due).toISOString() : null, refLabel: refLabel || null }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha ao criar.');
      toast.success('Tarefa criada! 📋');
      onCreated();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[460px] p-6">
        <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-3"><Plus className="w-5 h-5 text-indigo-400" /> Nova tarefa</h3>
        <label className="text-xs text-zinc-400 mb-1 block">Título *</label>
        <input value={title} onChange={e => setTitle(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 mb-3 outline-none focus:border-indigo-500" placeholder="Ex.: Ligar para o cliente sobre o orçamento" />
        <label className="text-xs text-zinc-400 mb-1 block">Descrição</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full h-20 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 mb-3 resize-none outline-none focus:border-indigo-500" placeholder="Detalhes da tarefa (opcional)" />
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Responsável</label>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500">
              <option value="">Sem dono</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Prioridade</label>
            <select value={priority} onChange={e => setPriority(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500">
              <option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Prazo</label>
            <input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500 [color-scheme:dark]" />
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Referência</label>
            <input value={refLabel} onChange={e => setRefLabel(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500" placeholder="Ex.: Orçamento #41" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={submit} disabled={busy} className="zf-button zf-button-primary">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}Criar
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetailDrawer({ task, users, onClose, onRefresh }: {
  task: Task; users: OrgUser[]; onClose: () => void; onRefresh: () => void;
}) {
  const [full, setFull] = useState<Task>(task);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [assist, setAssist] = useState('');
  const [assisting, setAssisting] = useState(false);
  const [rKind, setRKind] = useState<'material' | 'financeiro'>('material');
  const [rLabel, setRLabel] = useState('');
  const [rQty, setRQty] = useState('1');
  const [rAmount, setRAmount] = useState('');

  const refresh = () => apiFetch(`/api/tasks/${task.id}`).then(r => r.json()).then(d => { if (d && d.id) setFull(d); }).catch(() => {});
  useEffect(() => { refresh(); }, [task.id]);
  const apply = (d: any) => { if (d && d.id) setFull(d); onRefresh(); };

  const reassign = async (userId: string) => {
    try { const r = await apiFetch(`/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignedTo: userId || null }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); } catch (e: any) { toast.error(e.message); }
  };
  const move = async (s: Task['status']) => {
    try { const r = await apiFetch(`/api/tasks/${task.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); } catch (e: any) { toast.error(e.message); }
  };
  const addNote = async () => {
    if (!note.trim()) return; setBusy(true);
    try { const r = await apiFetch(`/api/tasks/${task.id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: note }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); setNote(''); apply(d); } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const runAssist = async () => {
    setAssisting(true); setAssist('');
    try { const r = await apiFetch(`/api/tasks/${task.id}/assist`, { method: 'POST' }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); setAssist(d.assist || ''); } catch (e: any) { toast.error(e.message); } finally { setAssisting(false); }
  };
  const addResource = async () => {
    const label = rLabel.trim();
    const amount = parseFloat(rAmount.replace(',', '.')) || 0;
    if (rKind === 'financeiro' && amount <= 0) { toast.error('Informe o valor da verba.'); return; }
    if (!label) { toast.error('Descreva o recurso.'); return; }
    try {
      const r = await apiFetch(`/api/tasks/${task.id}/resources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: rKind, label, quantity: parseFloat(rQty.replace(',', '.')) || 1, amount }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); setRLabel(''); setRQty('1'); setRAmount('');
    } catch (e: any) { toast.error(e.message); }
  };
  const removeResource = async (rid: string) => {
    try { const r = await apiFetch(`/api/tasks/${task.id}/resources/${rid}`, { method: 'DELETE' }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); } catch (e: any) { toast.error(e.message); }
  };
  const cancelTask = async () => { await move('cancelada'); onClose(); };

  const t = full;
  const resources = t.resources || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-[440px] bg-zinc-900 border-l border-zinc-800 overflow-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2 mb-3">
          <h3 className="text-lg font-semibold text-zinc-100">{t.title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        {t.description && <p className="text-sm text-zinc-400 whitespace-pre-wrap mb-3">{t.description}</p>}

        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2">
            <span className="text-zinc-500 block mb-1">Responsável</span>
            <select value={t.assigned_to || ''} onChange={e => reassign(e.target.value)} className="w-full bg-transparent text-zinc-200 outline-none">
              <option value="">Sem dono</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2">
            <span className="text-zinc-500 block mb-1 flex items-center gap-1"><Flag className="w-3 h-3" /> Prioridade</span>
            <span className="text-zinc-200">{PRIO[t.priority].label}</span>
          </div>
        </div>
        {t.due_at && <p className="text-xs text-zinc-500 mb-3 inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Prazo: {fmt(t.due_at)}</p>}

        {/* Mover */}
        <div className="flex gap-2 mb-4">
          {(['a_fazer', 'fazendo', 'feito'] as const).map(s => (
            <button key={s} onClick={() => move(s)} className={`flex-1 text-[11px] py-1.5 rounded-md border ${t.status === s ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
              {s === 'a_fazer' ? 'A fazer' : s === 'fazendo' ? 'Fazendo' : 'Feito'}
            </button>
          ))}
        </div>

        {/* Recursos alocados */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Recursos alocados</p>
            {(t.allocated_total || 0) > 0 && <span className="text-xs font-semibold text-emerald-400">{brl(t.allocated_total)}</span>}
          </div>
          <div className="space-y-1.5 mb-2">
            {resources.length === 0 && <p className="text-[11px] text-zinc-600">Nenhum recurso alocado.</p>}
            {resources.map((r: any) => (
              <div key={r.id} className="flex items-center gap-2 text-xs rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
                <span className={`text-[9px] px-1.5 py-0.5 rounded border ${r.kind === 'financeiro' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-sky-300 border-sky-500/30 bg-sky-500/10'}`}>{r.kind === 'financeiro' ? 'Verba' : 'Material'}</span>
                <span className="flex-1 text-zinc-200 truncate">{r.label}{r.kind === 'material' && r.quantity ? ` ×${r.quantity}` : ''}</span>
                {r.kind === 'financeiro' && <span className="text-emerald-400">{brl(r.amount)}</span>}
                <button onClick={() => removeResource(r.id)} className="text-zinc-600 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={rKind} onChange={e => setRKind(e.target.value as any)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none">
              <option value="material">Material</option><option value="financeiro">Verba</option>
            </select>
            <input value={rLabel} onChange={e => setRLabel(e.target.value)} placeholder={rKind === 'material' ? 'Ex.: Ração 10kg' : 'Ex.: Transporte'} className="flex-1 min-w-[100px] bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500" />
            {rKind === 'material'
              ? <input value={rQty} onChange={e => setRQty(e.target.value)} className="w-14 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none" placeholder="qtd" />
              : <input value={rAmount} onChange={e => setRAmount(e.target.value)} className="w-20 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none" placeholder="R$" />}
            <button onClick={addResource} className="px-2 py-1 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700"><Plus className="w-3.5 h-3.5" /></button>
          </div>
        </div>

        {/* IA assessora */}
        <button onClick={runAssist} disabled={assisting} className="w-full flex items-center justify-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 py-2 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 disabled:opacity-60 mb-2">
          {assisting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} IA: como entregar isso?
        </button>
        {assist && <div className="mb-4 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 text-xs text-indigo-100 whitespace-pre-wrap">{assist}</div>}

        {/* Trilha de atividade */}
        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Acompanhamento</p>
        <div className="space-y-2 mb-3">
          {(t.updates || []).length === 0 && <p className="text-[11px] text-zinc-600">Sem atualizações ainda.</p>}
          {(t.updates || []).map(u => (
            <div key={u.id} className="text-[11px] text-zinc-400 border-l-2 border-zinc-800 pl-2">
              <span className="text-zinc-200">{u.text}</span>
              <span className="block text-zinc-600">{u.author_name || 'Sistema'} · {fmt(u.created_at)}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && addNote()} placeholder="Adicionar uma nota…" className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500" />
          <button onClick={addNote} disabled={busy || !note.trim()} className="px-3 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"><MessageSquarePlus className="w-4 h-4" /></button>
        </div>

        <button onClick={cancelTask} className="mt-4 text-[11px] text-red-400/70 hover:text-red-400">Cancelar tarefa</button>
      </div>
    </div>
  );
}
