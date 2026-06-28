import React, { useState, useEffect } from 'react';
import { Calendar as CalendarIcon, Clock, Plus, X, BellRing, Bell, Pencil, Trash2, Settings2 } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useStore } from '@/src/store/useStore';
import { EmptyState } from '@/src/components/EmptyState';
import { apiFetch } from '@/src/lib/api';

export function AgendaView() {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', scheduled_start: '', contact_id: '', customer_email: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const { contacts } = useStore();

  // ISO -> valor do input datetime-local (YYYY-MM-DDTHH:MM) em horário local.
  const toLocalInput = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const openNew = () => { setEditingId(null); setForm({ title: '', description: '', scheduled_start: '', contact_id: '', customer_email: '' }); setShowModal(true); };
  const openEdit = (a: any) => {
    setEditingId(a.id);
    setForm({ title: a.title || '', description: a.description || '', scheduled_start: toLocalInput(a.scheduled_start), contact_id: a.contact_id || '', customer_email: a.customer_email || '' });
    setShowModal(true);
  };
  const cancelAppointment = async (a: any) => {
    if (!window.confirm(`Cancelar o agendamento "${a.title}"? Se estiver no Google Calendar, o evento também será removido.`)) return;
    try {
      await apiFetch(`/api/appointments/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
      loadAppointments();
    } catch {}
  };
  const [reminder, setReminder] = useState<{ enabled: boolean; hours: number; message: string } | null>(null);

  type AgendaConfig = { openHour: number; closeHour: number; slotMin: number; days: number[]; capacity: number };
  const [agenda, setAgenda] = useState<AgendaConfig | null>(null);
  const [savingAgenda, setSavingAgenda] = useState(false);
  // ISO de cada dia (1=seg .. 7=dom) na ordem da semana brasileira.
  const WEEK_DAYS: { iso: number; label: string }[] = [
    { iso: 1, label: 'Seg' }, { iso: 2, label: 'Ter' }, { iso: 3, label: 'Qua' },
    { iso: 4, label: 'Qui' }, { iso: 5, label: 'Sex' }, { iso: 6, label: 'Sáb' }, { iso: 7, label: 'Dom' },
  ];

  const loadAppointments = () => {
    apiFetch('/api/appointments')
      .then(r => r.json())
      .then(data => setAppointments(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  const loadReminder = () => apiFetch('/api/appointments/reminder-settings').then(r => r.json()).then(setReminder).catch(() => {});
  const loadAgenda = () => apiFetch('/api/appointments/agenda-settings').then(r => r.json()).then(setAgenda).catch(() => {});

  useEffect(() => {
    loadAppointments();
    loadReminder();
    loadAgenda();
  }, []);

  const saveReminder = async (patch: Partial<{ enabled: boolean; hours: number; message: string }>) => {
    const next = { enabled: reminder?.enabled || false, hours: reminder?.hours || 24, message: reminder?.message || '', ...patch };
    setReminder(next);
    await apiFetch('/api/appointments/reminder-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    }).catch(() => {});
  };

  // Salva a configuração da agenda e adota o que o servidor devolve (já normalizado).
  const saveAgenda = async (patch: Partial<AgendaConfig>) => {
    if (!agenda) return;
    const next = { ...agenda, ...patch };
    setAgenda(next);
    setSavingAgenda(true);
    try {
      const r = await apiFetch('/api/appointments/agenda-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      const saved = await r.json();
      if (saved && typeof saved.openHour === 'number') setAgenda(saved);
    } catch {} finally { setSavingAgenda(false); }
  };

  const toggleDay = (iso: number) => {
    if (!agenda) return;
    const has = agenda.days.includes(iso);
    const days = has ? agenda.days.filter(d => d !== iso) : [...agenda.days, iso].sort((a, b) => a - b);
    if (!days.length) return; // pelo menos um dia
    saveAgenda({ days });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { ...form, scheduled_start: new Date(form.scheduled_start).toISOString() };
      if (editingId) {
        await apiFetch(`/api/appointments/${editingId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: payload.title, description: payload.description, scheduled_start: payload.scheduled_start }),
        });
      } else {
        await apiFetch('/api/appointments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
      }
      setShowModal(false);
      setEditingId(null);
      setForm({ title: '', description: '', scheduled_start: '', contact_id: '', customer_email: '' });
      loadAppointments();
    } catch(e) { }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <CalendarIcon className="w-6 h-6 text-emerald-400" />
            Agenda Central
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Visão geral de agendamentos e entregas</p>
        </div>
        <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={openNew}>
          <Plus className="w-4 h-4 mr-2" />
          Novo Agendamento
        </Button>
      </div>

      {/* Lembretes automáticos */}
      {reminder && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100 flex items-center gap-2"><BellRing className="w-4 h-4 text-emerald-400" /> Lembretes automáticos</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Envia um lembrete pelo WhatsApp{' '}
                <input type="number" min="1" value={reminder.hours}
                  onChange={e => setReminder({ ...reminder, hours: parseInt(e.target.value, 10) || 24 })}
                  onBlur={e => saveReminder({ hours: parseInt(e.target.value, 10) || 24 })}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 text-zinc-200 text-center" /> horas antes do agendamento.
              </p>
            </div>
            <button onClick={() => saveReminder({ enabled: !reminder.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${reminder.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${reminder.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {reminder.enabled && (
            <textarea
              className="mt-3 w-full h-16 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
              placeholder="Mensagem. Use {nome}, {titulo} e {quando}. Ex.: Olá {nome}! Lembrete do seu agendamento {titulo} em {quando}."
              value={reminder.message}
              onChange={e => setReminder({ ...reminder, message: e.target.value })}
              onBlur={e => saveReminder({ message: e.target.value })}
            />
          )}
        </div>
      )}

      {/* Funcionamento da agenda — a IA só oferece horários livres dentro destas regras */}
      {agenda && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Settings2 className="w-4 h-4 text-emerald-400" /> Funcionamento da agenda</p>
              <p className="text-xs text-zinc-500 mt-0.5 max-w-2xl">
                A IA usa estas regras para oferecer <span className="text-zinc-300">apenas horários livres</span>, do mais cedo primeiro, e nunca marcar dois clientes no mesmo dia e horário.
              </p>
            </div>
            {savingAgenda && <span className="text-[10px] text-zinc-500 shrink-0">salvando…</span>}
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Abre às</span>
              <div className="flex items-center gap-1">
                <input type="number" min={0} max={23} value={agenda.openHour}
                  onChange={e => setAgenda({ ...agenda, openHour: parseInt(e.target.value, 10) || 0 })}
                  onBlur={e => saveAgenda({ openHour: parseInt(e.target.value, 10) || 0 })}
                  className="w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm" />
                <span className="text-xs text-zinc-500">h</span>
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Fecha às</span>
              <div className="flex items-center gap-1">
                <input type="number" min={1} max={24} value={agenda.closeHour}
                  onChange={e => setAgenda({ ...agenda, closeHour: parseInt(e.target.value, 10) || 0 })}
                  onBlur={e => saveAgenda({ closeHour: parseInt(e.target.value, 10) || 0 })}
                  className="w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm" />
                <span className="text-xs text-zinc-500">h</span>
              </div>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Duração</span>
              <select value={agenda.slotMin} onChange={e => saveAgenda({ slotMin: parseInt(e.target.value, 10) })}
                className="w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm">
                {[15, 20, 30, 45, 60, 90, 120].map(m => (
                  <option key={m} value={m}>{m >= 60 ? `${m / 60}h${m % 60 ? ` ${m % 60}min` : ''}` : `${m} min`}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Por horário</span>
              <input type="number" min={1} max={99} value={agenda.capacity}
                onChange={e => setAgenda({ ...agenda, capacity: parseInt(e.target.value, 10) || 1 })}
                onBlur={e => saveAgenda({ capacity: parseInt(e.target.value, 10) || 1 })}
                className="w-full min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 text-sm" />
            </label>
          </div>

          <div className="mt-4">
            <span className="text-xs text-zinc-400">Dias de atendimento</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {WEEK_DAYS.map(d => {
                const on = agenda.days.includes(d.iso);
                return (
                  <button key={d.iso} type="button" onClick={() => toggleDay(d.iso)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${on ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {appointments.length === 0 ? (
          <EmptyState
            icon={<CalendarIcon className="w-6 h-6" />}
            title="Nenhum agendamento programado"
            description="Quando a IA marcar um horário com um cliente pelo WhatsApp (ou você criar manualmente), ele aparece aqui. Ative os lembretes automáticos para reduzir faltas."
          />
        ) : (
          appointments.map(a => (
            <div key={a.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 flex align-middle justify-between">
              <div>
                 <h3 className="font-semibold text-zinc-100">{a.title}</h3>
                 <p className="text-sm text-zinc-400 max-w-xl line-clamp-2 break-words">{a.description}</p>
                 <div className="flex gap-4 mt-2 text-xs text-zinc-500 font-mono">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {a.scheduled_start ? format(new Date(a.scheduled_start), "PPpp", { locale: ptBR }) : 'Sem data definida'}
                    </span>
                 </div>
              </div>
              <div className="flex flex-col items-end justify-center gap-1.5">
                 <div className="flex items-center gap-2">
                   {a.google_event_link && (
                     <a href={a.google_event_link} target="_blank" rel="noreferrer" title="Ver no Google Calendar" className="text-blue-400 hover:text-blue-300 text-[10px] underline">no Google</a>
                   )}
                   <span className="text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-300 px-2 py-1 rounded">
                      {a.status}
                   </span>
                 </div>
                 {a.reminder_status === 'sent' && (
                   <span className="text-[10px] inline-flex items-center gap-1 text-emerald-400"><Bell className="w-3 h-3" /> lembrete enviado</span>
                 )}
                 {a.status !== 'cancelled' && (
                   <div className="flex items-center gap-2 mt-1">
                     <button onClick={() => openEdit(a)} title="Remarcar" className="text-zinc-400 hover:text-indigo-400"><Pencil className="w-4 h-4" /></button>
                     <button onClick={() => cancelAppointment(a)} title="Cancelar" className="text-zinc-400 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                   </div>
                 )}
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[400px] max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100">{editingId ? 'Remarcar agendamento' : 'Novo Agendamento'}</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => setShowModal(false)}><X className="w-5 h-5"/></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Contato</label>
                <select required={!editingId} disabled={!!editingId} className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 disabled:opacity-60"
                  value={form.contact_id} onChange={(e) => setForm({...form, contact_id: e.target.value})}>
                   <option value="">Selecione um contato</option>
                   {Object.values(contacts).map(c => (
                     <option key={c.id} value={c.id}>{c.name}</option>
                   ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Título</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Data e Hora</label>
                <input required type="datetime-local" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.scheduled_start} onChange={(e) => setForm({...form, scheduled_start: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">E-mail do cliente <span className="text-zinc-600">(opcional — para confirmação)</span></label>
                <input type="email" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                  placeholder="cliente@email.com" value={form.customer_email} onChange={(e) => setForm({...form, customer_email: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Descrição</label>
                <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 h-20 resize-none"
                  value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => { setShowModal(false); setEditingId(null); }}>Cancelar</Button>
                <Button type="submit" variant="default" className="bg-emerald-600 hover:bg-emerald-700 text-white">{editingId ? 'Salvar' : 'Agendar'}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
