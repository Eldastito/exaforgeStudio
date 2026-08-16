import React, { useEffect, useState, useCallback } from 'react';
import { ListChecks, Plus, Loader2, Sparkles, Calendar, User as UserIcon, X, MessageSquarePlus, Flag, Paperclip, Camera, Check, Repeat, Pause, Play, Trash2 } from 'lucide-react';
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
  result?: { label: string | null; baseline: number | null; final: number | null; delta: number | null; evidenceUrl: string | null } | null;
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
  const [completing, setCompleting] = useState<Task | null>(null);
  const [recurTick, setRecurTick] = useState(0);

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

      <RecurrenceRulesPanel users={users} refreshKey={recurTick} />

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
                      {(t.result?.final != null || t.result?.evidenceUrl) && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
                          {t.result?.final != null && t.result?.baseline != null && <span className="text-emerald-300">{t.result.label || 'Resultado'}: {t.result.baseline} → {t.result.final}{t.result.delta > 0 ? ` (-${t.result.delta})` : ''}</span>}
                          {t.result?.evidenceUrl && <a href={t.result.evidenceUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300"><Paperclip className="w-3 h-3" /> evidência</a>}
                        </div>
                      )}
                      <div className="mt-2 flex gap-1" onClick={e => e.stopPropagation()}>
                        {col.id === 'a_fazer' && <CardBtn onClick={() => move(t.id, 'fazendo')}>Iniciar</CardBtn>}
                        {col.id === 'fazendo' && <><CardBtn onClick={() => setCompleting(t)}>Concluir</CardBtn><CardBtn onClick={() => move(t.id, 'a_fazer')} ghost>Voltar</CardBtn></>}
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

      {creating && <CreateModal users={users} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); setRecurTick(t => t + 1); }} />}
      {completing && <CompleteTaskModal task={completing} onClose={() => setCompleting(null)} onDone={() => { setCompleting(null); load(); }} />}
      {detail && <DetailDrawer task={detail} users={users} onClose={() => setDetail(null)} onRefresh={load} />}
    </div>
  );
}

function CardBtn({ children, onClick, ghost }: { children: React.ReactNode; onClick: () => void; ghost?: boolean }) {
  return <button onClick={onClick} className={`text-[10px] px-2 py-1 rounded-md font-medium transition-colors ${ghost ? 'text-zinc-400 hover:text-zinc-200 border border-zinc-800' : 'bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/30'}`}>{children}</button>;
}

// Concluir com RESULTADO medido + EVIDÊNCIA (ADR-134).
function CompleteTaskModal({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const hasMetric = !!(task.result?.label || task.result?.baseline != null);
  const [finalVal, setFinalVal] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData(); body.append('file', file);
      const r = await apiFetch('/api/uploads/image', { method: 'POST', body });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Falha no upload.');
      setEvidenceUrl(d.url);
      toast.success('Evidência anexada. 📎');
    } catch (e: any) { toast.error(e.message); } finally { setUploading(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const resultFinal = finalVal.trim() ? Number(finalVal.replace(/\./g, '').replace(',', '.')) : null;
      const r = await apiFetch(`/api/tasks/${task.id}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resultFinal, evidenceUrl: evidenceUrl || null }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha.');
      toast.success('Concluída com resultado. ✅');
      onDone();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[440px] p-6">
        <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-1"><Check className="w-5 h-5 text-emerald-400" /> Concluir tarefa</h3>
        <p className="text-[13px] text-zinc-400 mb-4 line-clamp-2">{task.title}</p>

        {hasMetric && (
          <div className="mb-4">
            <label className="text-xs text-zinc-400 mb-1 block">{task.result?.label || 'Resultado'}{task.result?.baseline != null ? ` — começou em ${task.result.baseline}` : ''}</label>
            <input value={finalVal} onChange={e => setFinalVal(e.target.value)} inputMode="decimal" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500" placeholder="Valor final (ex.: 420)" />
          </div>
        )}

        <label className="text-xs text-zinc-400 mb-1 block">Evidência (foto/relatório) <span className="text-zinc-600">— opcional</span></label>
        <div className="flex items-center gap-2 mb-4">
          <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1.5">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />} {evidenceUrl ? 'Trocar foto' : 'Anexar foto'}
            <input type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          </label>
          {evidenceUrl && <a href={evidenceUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:text-sky-300 inline-flex items-center gap-1"><Paperclip className="w-3 h-3" /> ver</a>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={submit} disabled={busy || uploading} className="zf-button zf-button-primary">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}Concluir
          </Button>
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Primeira data de ocorrência (calendário local, sem tz) — espelha o motor. */
function firstOccurrenceDate(freq: string, interval: number, byWeekday: number[], dayOfMonth: number, startsOn: string): { y: number; mo: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return null;
  const [y, m, d0] = startsOn.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d0);
  const iv = Math.max(1, interval);
  for (let i = 0; i < 400; i++) {
    const cur = new Date(start + i * 86400000);
    const cy = cur.getUTCFullYear(), cm = cur.getUTCMonth() + 1, cd = cur.getUTCDate(), wd = cur.getUTCDay();
    let match = false;
    if (freq === 'daily') match = i % iv === 0;
    else if (freq === 'weekly') {
      const wds = byWeekday.length ? byWeekday : [new Date(start).getUTCDay()];
      if (wds.includes(wd)) {
        const wStart = Math.floor(start / 86400000) - new Date(start).getUTCDay();
        const wCur = Math.floor(cur.getTime() / 86400000) - wd;
        match = Math.round((wCur - wStart) / 7) % iv === 0;
      }
    } else if (freq === 'monthly') {
      const dim = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
      const dom = Math.min(Math.max(1, dayOfMonth || d0), dim);
      if (cd === dom) { const months = (cy - y) * 12 + (cm - m); match = months >= 0 && months % iv === 0; }
    }
    if (match) return { y: cy, mo: cm, d: cd };
  }
  return null;
}

function ruleSummary(r: any): string {
  const iv = Math.max(1, Number(r.interval) || 1);
  const at = ` às ${r.local_time || '09:00'}`;
  if (r.frequency === 'daily') return (iv === 1 ? 'Todo dia' : `A cada ${iv} dias`) + at;
  if (r.frequency === 'weekly') {
    let wds: number[] = []; try { wds = JSON.parse(r.by_weekday || '[]'); } catch { wds = []; }
    const dias = wds.length ? wds.map(n => WEEKDAYS[n]).join(', ') : '—';
    return (iv === 1 ? 'Toda semana' : `A cada ${iv} semanas`) + ` (${dias})` + at;
  }
  return (iv === 1 ? 'Todo mês' : `A cada ${iv} meses`) + ` no dia ${r.day_of_month || '?'}` + at;
}

// Regras recorrentes (ADR-171): lista + pausar/retomar/encerrar. Colapsável.
function RecurrenceRulesPanel({ users, refreshKey }: { users: OrgUser[]; refreshKey?: number }) {
  const [rules, setRules] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const load = () => apiFetch('/api/tasks/recurrence').then(r => r.json()).then(d => { setRules(Array.isArray(d?.rules) ? d.rules : []); setLoaded(true); }).catch(() => setLoaded(true));
  useEffect(() => { load(); }, [refreshKey]);
  const userName = (id: string) => users.find(u => u.id === id)?.name || users.find(u => u.id === id)?.email || 'Sem dono';
  const op = async (id: string, path: string, method = 'POST') => {
    try {
      const r = await apiFetch(`/api/tasks/recurrence/${id}${path}`, { method });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      toast.success('Regra atualizada.'); load();
    } catch (e: any) { toast.error(e.message); }
  };
  const active = rules.filter(r => r.status !== 'completed');
  if (loaded && active.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-indigo-200">
        <Repeat className="w-4 h-4" /> Tarefas recorrentes <span className="text-indigo-300/70">({active.length})</span>
        <span className="ml-auto text-indigo-300/60 text-xs">{open ? 'ocultar' : 'ver'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          {active.map(r => (
            <div key={r.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-zinc-100 truncate flex items-center gap-2">
                  {r.title}
                  {r.status === 'paused' && <span className="text-[10px] rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5">pausada</span>}
                </div>
                <div className="text-[11px] text-zinc-500">{ruleSummary(r)} · {userName(r.assigned_to)}{r.next_run_at ? ` · próxima: ${fmt(r.next_run_at)}` : ''}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {r.status === 'active'
                  ? <button onClick={() => op(r.id, '/pause')} title="Pausar" className="rounded border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800"><Pause className="w-3.5 h-3.5" /></button>
                  : <button onClick={() => op(r.id, '/resume')} title="Retomar" className="rounded border border-emerald-500/40 p-1.5 text-emerald-300 hover:bg-emerald-500/10"><Play className="w-3.5 h-3.5" /></button>}
                <button onClick={() => { if (confirm('Encerrar esta recorrência? As tarefas já criadas continuam.')) op(r.id, '', 'DELETE'); }} title="Encerrar" className="rounded border border-zinc-700 p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateModal({ users, onClose, onCreated }: { users: OrgUser[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [priority, setPriority] = useState('media');
  const [due, setDue] = useState('');
  const [refLabel, setRefLabel] = useState('');
  const [resultLabel, setResultLabel] = useState('');
  const [resultBaseline, setResultBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  // Recorrência (ADR-171)
  const today = new Date().toISOString().slice(0, 10);
  const [repeat, setRepeat] = useState(false);
  const [frequency, setFrequency] = useState('weekly');
  const [interval, setIntervalN] = useState('1');
  const [byWeekday, setByWeekday] = useState<number[]>([new Date().getDay()]);
  const [dayOfMonth, setDayOfMonth] = useState(String(new Date().getDate()));
  const [localTime, setLocalTime] = useState('09:00');
  const [startsOn, setStartsOn] = useState(today);
  const [endMode, setEndMode] = useState<'never' | 'date' | 'count'>('never');
  const [endsOn, setEndsOn] = useState('');
  const [maxOccurrences, setMaxOccurrences] = useState('10');

  const toggleWeekday = (n: number) => setByWeekday(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n].sort());

  const summary = (() => {
    const iv = Math.max(1, parseInt(interval, 10) || 1);
    const at = ` às ${localTime}`;
    let base = '';
    if (frequency === 'daily') base = iv === 1 ? 'Todo dia' : `A cada ${iv} dias`;
    else if (frequency === 'weekly') {
      const dias = (byWeekday.length ? byWeekday : [new Date(startsOn + 'T00:00').getDay()]).map(n => WEEKDAYS[n]).join(', ');
      base = (iv === 1 ? 'Toda semana' : `A cada ${iv} semanas`) + ` (${dias})`;
    } else base = (iv === 1 ? 'Todo mês' : `A cada ${iv} meses`) + ` no dia ${dayOfMonth || '?'}`;
    const first = firstOccurrenceDate(frequency, iv, byWeekday, parseInt(dayOfMonth, 10) || 0, startsOn);
    const firstStr = first ? `${String(first.d).padStart(2, '0')}/${String(first.mo).padStart(2, '0')}/${first.y}` : '—';
    return { text: base + at, first: firstStr };
  })();

  const submit = async () => {
    if (!title.trim()) { toast.error('Informe um título.'); return; }
    setBusy(true);
    try {
      if (repeat) {
        const payload: any = {
          title, description, assignedTo: assignedTo || null, priority,
          frequency, interval: Math.max(1, parseInt(interval, 10) || 1),
          localTime, startsOn, timezone: 'America/Sao_Paulo',
        };
        if (frequency === 'weekly') payload.byWeekday = byWeekday;
        if (frequency === 'monthly') payload.dayOfMonth = parseInt(dayOfMonth, 10) || new Date(startsOn + 'T00:00').getDate();
        if (endMode === 'date' && endsOn) payload.endsOn = endsOn;
        if (endMode === 'count') payload.maxOccurrences = Math.max(1, parseInt(maxOccurrences, 10) || 1);
        const r = await apiFetch('/api/tasks/recurrence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!r.ok) throw new Error((await r.json()).error || 'Falha ao criar a recorrência.');
        toast.success('Tarefa recorrente criada! 🔁');
      } else {
        const baselineNum = resultBaseline.trim() ? Number(resultBaseline.replace(/\./g, '').replace(',', '.')) : null;
        const r = await apiFetch('/api/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, assignedTo: assignedTo || null, priority, dueAt: due ? new Date(due).toISOString() : null, refLabel: refLabel || null, resultLabel: resultLabel.trim() || null, resultBaseline: baselineNum }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Falha ao criar.');
        toast.success('Tarefa criada! 📋');
      }
      onCreated();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const field = "w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[460px] p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-3"><Plus className="w-5 h-5 text-indigo-400" /> Nova tarefa</h3>
        <label className="text-xs text-zinc-400 mb-1 block">Título *</label>
        <input value={title} onChange={e => setTitle(e.target.value)} className={`${field} mb-3`} placeholder="Ex.: Conferir o malote das lojas" />
        <label className="text-xs text-zinc-400 mb-1 block">Descrição</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} className={`${field} h-20 mb-3 resize-none`} placeholder="Detalhes da tarefa (opcional)" />
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Responsável</label>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className={field}>
              <option value="">Sem dono</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Prioridade</label>
            <select value={priority} onChange={e => setPriority(e.target.value)} className={field}>
              <option value="alta">Alta</option><option value="media">Média</option><option value="baixa">Baixa</option>
            </select>
          </div>
        </div>

        {/* Toggle Repetir (ADR-171) — começa DESLIGADO (§10.3) */}
        <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
          <input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} className="accent-indigo-500" />
          <span className="text-sm text-zinc-200 flex items-center gap-1.5"><Repeat className="w-4 h-4 text-indigo-400" /> Repetir tarefa</span>
        </label>

        {!repeat ? (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Prazo</label>
                <input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className={`${field} [color-scheme:dark]`} />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Referência</label>
                <input value={refLabel} onChange={e => setRefLabel(e.target.value)} className={field} placeholder="Ex.: Orçamento #41" />
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 mb-4">
              <div className="text-[11px] text-zinc-400 mb-2">Resultado a medir <span className="text-zinc-600">(opcional)</span></div>
              <div className="grid grid-cols-2 gap-3">
                <input value={resultLabel} onChange={e => setResultLabel(e.target.value)} className={field} placeholder="O que medir (ex.: Divergência R$)" />
                <input value={resultBaseline} onChange={e => setResultBaseline(e.target.value)} inputMode="decimal" className={field} placeholder="Valor inicial (ex.: 3.200)" />
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-3 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Frequência</label>
                <select value={frequency} onChange={e => setFrequency(e.target.value)} className={field}>
                  <option value="daily">Diária</option><option value="weekly">Semanal</option><option value="monthly">Mensal</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">A cada</label>
                <input type="number" min={1} value={interval} onChange={e => setIntervalN(e.target.value)} className={field} />
              </div>
            </div>
            {frequency === 'weekly' && (
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Dias da semana</label>
                <div className="flex gap-1">
                  {WEEKDAYS.map((w, n) => (
                    <button key={n} type="button" onClick={() => toggleWeekday(n)}
                      className={`w-9 h-8 rounded text-[11px] border ${byWeekday.includes(n) ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-200' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>{w}</button>
                  ))}
                </div>
              </div>
            )}
            {frequency === 'monthly' && (
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Dia do mês</label>
                <input type="number" min={1} max={31} value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} className={field} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Horário</label>
                <input type="time" value={localTime} onChange={e => setLocalTime(e.target.value)} className={`${field} [color-scheme:dark]`} />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Início</label>
                <input type="date" value={startsOn} onChange={e => setStartsOn(e.target.value)} className={`${field} [color-scheme:dark]`} />
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Término</label>
              <div className="flex items-center gap-2 flex-wrap">
                <select value={endMode} onChange={e => setEndMode(e.target.value as any)} className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100">
                  <option value="never">Sem término</option><option value="date">Até a data</option><option value="count">Após N vezes</option>
                </select>
                {endMode === 'date' && <input type="date" value={endsOn} onChange={e => setEndsOn(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 [color-scheme:dark]" />}
                {endMode === 'count' && <input type="number" min={1} value={maxOccurrences} onChange={e => setMaxOccurrences(e.target.value)} className="w-24 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" />}
              </div>
            </div>
            <div className="text-[12px] text-indigo-200/90 border-t border-indigo-500/20 pt-2">
              🔁 {summary.text}, a partir de {startsOn.split('-').reverse().join('/')}.
              <div className="text-zinc-400 text-[11px] mt-0.5">Primeiro disparo: <strong>{summary.first}</strong> às {localTime} (horário de São Paulo).</div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={submit} disabled={busy} className="zf-button zf-button-primary">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}{repeat ? 'Criar recorrência' : 'Criar'}
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
